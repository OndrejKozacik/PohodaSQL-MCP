// Textová brána pro pohoda_run_query. Je to POJISTKA, ne ochrana: rozhodující je read-only login a ROLLBACK transakce.
// Na rozdíl od tools\Invoke-PohodaQuery.ps1 (jediný SELECT) musí propustit vzory výkazů:
// SELECT ... INTO #tmp, CREATE TABLE #tmp, UPDATE #tmp, DECLARE/WHILE, víc result setů, GO.

/** Text bez komentářů a řetězců; [ident] a "ident" zůstanou jako slovo (dočasné #tabulky se zachovají). */
export function skeleton(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '-' && d === '-') { while (i < n && sql[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && d === '*') {
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      out += ' '; continue;
    }
    if (c === "'") {
      i++;
      while (i < n) { if (sql[i] === "'" && sql[i + 1] === "'") i += 2; else if (sql[i] === "'") { i++; break; } else i++; }
      out += " '' "; continue;
    }
    if (c === '[' || c === '"') {
      const close = c === '[' ? ']' : '"';
      let name = ''; i++;
      while (i < n) { if (sql[i] === close && sql[i + 1] === close) { name += close; i += 2; } else if (sql[i] === close) { i++; break; } else name += sql[i++]; }
      out += name.startsWith('#') ? ` ${name.replace(/\W/g, (ch) => (ch === '#' ? '#' : '_'))} ` : ` Q_${name.replace(/\W/g, '_')} `;
      continue;
    }
    out += c; i++;
  }
  return out;
}

const FORBIDDEN = [
  'EXEC', 'EXECUTE', 'MERGE', 'GRANT', 'DENY', 'REVOKE', 'BACKUP', 'RESTORE', 'SHUTDOWN', 'KILL', 'RECONFIGURE', 'CHECKPOINT',
  'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE', 'BULK', 'USE', 'WAITFOR', 'DBCC', 'ALTER',
  'COMMIT', 'ROLLBACK', 'SAVE', 'TRANSACTION', 'TRAN',
];
const RE_FORBIDDEN = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`, 'gi');
const RE_SYSPROC = /\b(xp|sp)_\w+/gi;
const isTemp = (t) => /^(#(?!#)|@)/.test(t ?? '');

/**
 * @returns {{ok: boolean, errors: string[], notes: string[], sql: string}} sql = text bez řádků `USE ...` (jako v runneru golden testů)
 */
export function checkSql(sqlIn) {
  const errors = [];
  const notes = [];
  let sql = String(sqlIn ?? '');
  if (!sql.trim()) return { ok: false, errors: ['Prázdný dotaz.'], notes, sql };
  if (sql.length > 200_000) return { ok: false, errors: ['Dotaz je delší než 200 000 znaků.'], notes, sql };

  const stripped = sql.replace(/^[ \t]*USE[ \t]+[^\r\n]*$/gim, '');
  if (stripped !== sql) { notes.push('Řádky `USE ...` byly odstraněny – databázi určuje parametr `database`.'); sql = stripped; }

  const flat = skeleton(sql).replace(/\s+/g, ' ');

  for (const m of flat.matchAll(RE_FORBIDDEN)) errors.push(`Zakázané klíčové slovo: ${m[1].toUpperCase()}`);
  for (const m of flat.matchAll(RE_SYSPROC)) errors.push(`Zakázaná systémová procedura: ${m[0]}`);

  const need = (re, what, targetIdx) => {
    for (const m of flat.matchAll(re)) {
      if (!isTemp(m[targetIdx])) errors.push(`${what} do trvalé tabulky/aliasu „${m[targetIdx] ?? '?'}“ – povolené jsou jen #dočasné tabulky a @tabulkové proměnné.`);
    }
  };
  need(/\bINSERT\s+(INTO\s+)?(\S+)/gi, 'INSERT', 2);
  need(/\bINTO\s+(\S+)/gi, 'INTO (SELECT INTO / OUTPUT INTO)', 1);
  need(/\bUPDATE\s+(?!STATISTICS)(\S+)/gi, 'UPDATE', 1);
  need(/\bDELETE\s+(?:FROM\s+)?(\S+)/gi, 'DELETE', 1);
  need(/\bTRUNCATE\s+TABLE\s+(\S+)/gi, 'TRUNCATE', 1);
  for (const m of flat.matchAll(/\bCREATE\s+(\S+)\s+(\S+)/gi)) {
    if (!(m[1].toUpperCase() === 'TABLE' && isTemp(m[2]))) errors.push(`CREATE ${m[1].toUpperCase()} ${m[2]} – povolené je jen CREATE TABLE #dočasná.`);
  }
  for (const m of flat.matchAll(/\bDROP\s+(\S+)\s+(?:IF\s+EXISTS\s+)?(\S+)/gi)) {
    if (!(m[1].toUpperCase() === 'TABLE' && isTemp(m[2]))) errors.push(`DROP ${m[1].toUpperCase()} ${m[2]} – povolené je jen DROP TABLE #dočasná.`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], notes, sql };
}
