// Textová brána pro pohoda_run_query. Je to POJISTKA, ne ochrana: rozhodující je read-only login a ROLLBACK transakce.
// Na rozdíl od tools\Invoke-PohodaQuery.ps1 (jediný SELECT) musí propustit vzory výkazů:
// SELECT ... INTO #tmp, CREATE TABLE #tmp, UPDATE #tmp, DECLARE/WHILE, víc result setů, GO.
//
// Brána není parser T-SQL. Pracuje nad tokeny (slova, interpunkce, řetězce; komentáře se zahodí) a hlídá jen známé vzory:
// - zakázaná slova se posuzují podle kontextu (`AS Tran` je alias, `BEGIN TRAN` příkaz); identifikátory v [] / "" nejsou klíčová slova,
// - cíle zápisu (INSERT/INTO/UPDATE/DELETE/TRUNCATE/CREATE/DROP) musí být #dočasné tabulky nebo @proměnné,
// - vícedílné názvy (db.schema.tab, db..tab, srv.db.schema.tab) se hledají jen za FROM/JOIN/APPLY a v čárkovém seznamu hned za FROM;
//   seznam za JOIN ... ON a názvy v jiných místech (např. volání funkce db.dbo.fn() ve výběru sloupců) se nekontrolují,
//   naopak `TRIM(x FROM dbo.FA.Sloupec)` a `CROSS APPLY t.XmlSloupec.nodes('…')` se odmítnou chybně (pomůže dvoudílný zápis),
// - alias v UPDATE/DELETE se přijme jen s vazbou na #/@ objekt ve vlastní klauzuli FROM téhož příkazu (viz aliasIsTemp),
// - řádek GO uvnitř víceřádkového řetězce/komentáře se odmítá, protože runner (ps\Run-Query.ps1) dělí dávky bez ohledu na ně,
// - dávka (část mezi řádky GO) musí začínat povoleným příkazem – holé volání procedury bez EXEC jinak nejde poznat,
// - seznam databází serveru (sys.databases, sys.sysdatabases, sysdatabases, sys.master_files, sys.sysaltfiles, HAS_DBACCESS,
//   DB_NAME(<argument>)) se odmítá kdekoli v kódu: názvy dalších databází (obsahují IČO firem) se nemají dostat k modelu.
//   `DB_NAME()` bez argumentu (aktuální databáze) je povolené. I tohle je jen pojistka a nepokrývá každou cestu k názvům –
//   skutečné řešení je oprava oprávnění loginu: odebrat mu přístup do cizích databází, případně `DENY VIEW ANY DATABASE`.

const RE_WORD = /[\p{L}\p{N}_@#$]/u;
// řídicí znaky, které SQL Server bere jako mezeru, ale běžný text je neobsahuje (TAB, LF, CR jsou v pořádku)
const RE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085]/;
// Řádek GO jako oddělovač dávek: `GO`, `GO;`, `GO -- komentář`. Musí odpovídat regexu v ps\Run-Query.ps1.
const RE_GO_LINE = /^[ \t]*GO[ \t]*;?[ \t]*(?:--[^\n]*)?$/i;
const RE_GO_COUNT = /^[ \t]*GO[ \t]+\d+/i;

/**
 * Rozdělí text na tokeny mimo komentáře. Typy: 'w' slovo/identifikátor (q = byl v [] nebo ""), 's' řetězec, 'p' znak interpunkce.
 * Každý token nese pozici ve vstupu (pos, end) a číslo řádku (line, od 0, počítá se jen podle \n).
 * @returns {{tokens: Array<{t: string, v: string, q?: boolean, pos: number, end: number, line: number}>, control: number[], masked: Set<number>}}
 *   control = pozice řídicích znaků mimo řetězce/komentáře, masked = řádky, jejichž začátek leží uvnitř řetězce/komentáře/[názvu]
 */
export function lex(sql) {
  const tokens = [];
  const control = [];
  const masked = new Set();
  const n = sql.length;
  let i = 0;
  let line = 0;
  // posun přes úsek [from, to): spočítá řádky; je-li inside, označí řádky začínající uvnitř úseku
  const span = (from, to, inside) => {
    for (let k = from; k < to; k++) if (sql[k] === '\n') { line++; if (inside && k + 1 < to) masked.add(line); }
  };
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '-' && d === '-') { while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++; continue; } // i samotné CR ukončuje komentář
    if (c === '/' && d === '*') {
      const start = i;
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      i = Math.min(i, n);
      if (depth > 0) masked.add(-1); // neukončený komentář
      span(start, i, true); continue;
    }
    if (c === "'") {
      const start = i; const l0 = line;
      let closed = false;
      i++;
      while (i < n) { if (sql[i] === "'" && sql[i + 1] === "'") i += 2; else if (sql[i] === "'") { i++; closed = true; break; } else i++; }
      i = Math.min(i, n);
      if (!closed) masked.add(-1);
      span(start, i, true);
      tokens.push({ t: 's', v: "''", pos: start, end: i, line: l0 }); continue;
    }
    if (c === '[' || c === '"') {
      const close = c === '[' ? ']' : '"';
      const start = i; const l0 = line;
      let name = ''; i++;
      while (i < n) { if (sql[i] === close && sql[i + 1] === close) { name += close; i += 2; } else if (sql[i] === close) { i++; break; } else name += sql[i++]; }
      i = Math.min(i, n);
      span(start, i, true);
      tokens.push({ t: 'w', v: name, q: true, pos: start, end: i, line: l0 }); continue;
    }
    if (RE_WORD.test(c)) {
      const start = i;
      while (i < n && RE_WORD.test(sql[i])) i++;
      tokens.push({ t: 'w', v: sql.slice(start, i), pos: start, end: i, line }); continue;
    }
    if (RE_CONTROL.test(c)) control.push(i);
    tokens.push({ t: 'p', v: c, pos: i, end: i + 1, line }); i++;
  }
  return { tokens, control, masked };
}

/** Text bez komentářů a řetězců; [ident] a "ident" zůstanou jako slovo `Q_<jméno>` (dočasné #tabulky se zachovají). Jen pro ladění a testy. */
export function skeleton(sql) {
  return lex(String(sql ?? '')).tokens.map((k) => {
    if (k.t !== 'w' || !k.q) return k.v;
    return k.v.startsWith('#') ? k.v.replace(/[^\p{L}\p{N}_@#$]/gu, '_') : `Q_${k.v.replace(/[^\p{L}\p{N}_@$]/gu, '_')}`;
  }).join(' ');
}

/** Rozdělí text na dávky stejně jako ps\Run-Query.ps1 (řádky GO; bez ohledu na řetězce a komentáře). */
export function splitBatches(sql) {
  const out = [];
  let cur = [];
  for (const ln of String(sql ?? '').split('\n')) {
    if (RE_GO_LINE.test(ln.replace(/\r$/, ''))) { out.push(cur.join('\n')); cur = []; } else cur.push(ln);
  }
  out.push(cur.join('\n'));
  return out.filter((b) => b.trim());
}

// Slova zakázaná kdekoli (mimo identifikátory v závorkách/uvozovkách).
const FORBIDDEN = new Set([
  'EXEC', 'EXECUTE', 'GRANT', 'DENY', 'REVOKE', 'BACKUP', 'RESTORE', 'SHUTDOWN', 'KILL', 'RECONFIGURE', 'CHECKPOINT',
  'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE', 'WAITFOR', 'DBCC', 'ALTER', 'COMMIT', 'ROLLBACK',
  'UPDATETEXT', 'WRITETEXT', 'READTEXT', 'SETUSER', 'REVERT', 'IDENTITY_INSERT', 'TABLOCKX', 'XLOCK',
]);
// Čím smí začínat dávka. Cokoli jiného na začátku dávky SQL Server vyhodnotí jako volání procedury bez EXEC.
const BATCH_START = new Set([
  'SELECT', 'WITH', 'DECLARE', 'SET', 'IF', 'WHILE', 'BEGIN', 'END', 'CREATE', 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE',
  'PRINT', 'RETURN', 'OPEN', 'FETCH', 'CLOSE', 'DEALLOCATE', 'BREAK', 'CONTINUE', 'RAISERROR', 'THROW',
]);
// Slova, která ukončují příkaz UPDATE/DELETE, když chybí středník (pro hledání jeho vlastní klauzule FROM).
const STMT_STOP = new Set([
  'SELECT', 'UPDATE', 'DELETE', 'INSERT', 'MERGE', 'DECLARE', 'SET', 'IF', 'ELSE', 'WHILE', 'BEGIN', 'END', 'PRINT', 'FETCH', 'OPEN', 'CLOSE',
  'DEALLOCATE', 'CREATE', 'DROP', 'TRUNCATE', 'RETURN', 'BREAK', 'CONTINUE', 'RAISERROR', 'THROW', 'GOTO', 'EXEC', 'EXECUTE', 'USE', 'GO',
]);
// Slova, která za zdrojem tabulky nejsou alias.
const NOT_ALIAS = new Set([
  'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'ON', 'GROUP', 'ORDER', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT',
  'OPTION', 'WITH', 'FOR', 'PIVOT', 'UNPIVOT', 'SET', 'INTO', 'OUTPUT', 'WHEN', 'THEN', 'ELSE', 'END', 'WINDOW', 'TABLESAMPLE', ...STMT_STOP,
]);

// Systémové pohledy se seznamem databází serveru (za `sys.`) a jejich starší názvy použitelné i bez schématu.
const DB_LIST_VIEWS = new Set(['databases', 'sysdatabases', 'master_files', 'sysaltfiles']);
const DB_LIST_BARE = new Set(['sysdatabases', 'sysaltfiles']);
const DB_LIST_HINT = 'databázi určuje parametr `database`; seznam dalších databází na serveru model nedostane';

const up = (k) => (k && k.t === 'w' && !k.q ? k.v.toUpperCase() : '');
const isP = (k, ch) => !!k && k.t === 'p' && k.v === ch;
const show = (k) => (k ? (k.t === 'w' && k.q ? `[${k.v}]` : k.v) : '(konec)');

/** Přečte (vícedílný) název objektu od tokenu i: slovo (. slovo | .. slovo)*. parts obsahuje i prázdné díly (db..tab → 3). */
function readName(tk, i) {
  if (tk[i]?.t !== 'w') return null;
  const parts = [tk[i]];
  let j = i + 1;
  while (isP(tk[j], '.')) {
    let k = j + 1;
    while (isP(tk[k], '.')) { parts.push(null); k++; }
    if (tk[k]?.t !== 'w') break;
    parts.push(tk[k]); j = k + 1;
  }
  return { parts, end: j, text: parts.map((p) => (p ? show(p) : '')).join('.') };
}

const isHash = (k) => !!k && k.v.startsWith('#') && !k.v.startsWith('##');
const isTempDb = (k) => !!k && k.v.toLowerCase() === 'tempdb';
/** #dočasná tabulka, @proměnná, nebo tempdb..#x / tempdb.dbo.#x. `[@x]` je běžná tabulka, ne proměnná. */
function isTempName(name) {
  if (!name) return false;
  const p = name.parts;
  const last = p[p.length - 1];
  if (p.length === 1) return isHash(last) || (!last.q && last.v.startsWith('@') && !last.v.startsWith('@@'));
  return p.length === 3 && isTempDb(p[0]) && isHash(last);
}
/** Název sahá mimo aktuální databázi (3 a více dílů), kromě tempdb..#x. */
const isCrossDb = (name) => name.parts.length >= 3 && !isTempName(name);

/** Index tokenu za závorkou otevřenou na i (vyvážené závorky). */
function skipParens(tk, i) {
  let depth = 0;
  for (let j = i; j < tk.length; j++) {
    if (isP(tk[j], '(')) depth++;
    else if (isP(tk[j], ')') && --depth === 0) return j + 1;
  }
  return tk.length;
}

/**
 * Alias v UPDATE/DELETE: přijme se jen tehdy, když ve vlastní klauzuli FROM téhož příkazu (stejná úroveň závorek) je alias
 * navázán na #/@ objekt (`FROM|JOIN|APPLY|, <objekt> [AS] <alias>`) a žádný jiný výskyt aliasu tam není. Při pochybnosti odmítá.
 * @param {number} i index tokenu za cílem příkazu
 */
function aliasIsTemp(tk, i, alias, isUpdate) {
  let depth = 0;
  let caseDepth = 0;
  let from = -1;
  let bound = 0;
  if (isUpdate && up(tk[i]) !== 'SET') return false;
  for (let j = isUpdate ? i + 1 : i; j < tk.length; j++) {
    const k = tk[j];
    if (k.batch !== tk[i].batch) break;
    if (isP(k, '(')) { depth++; continue; }
    if (isP(k, ')')) { if (--depth < 0) break; continue; }
    if (depth > 0) continue;
    if (isP(k, ';')) break;
    const u = up(k);
    if (u === 'CASE') { caseDepth++; continue; }
    if (u === 'END' && caseDepth > 0) { caseDepth--; continue; }
    if (u === 'ELSE' && caseDepth > 0) continue;
    if (u === 'WITH' && isP(tk[j + 1], '(')) continue; // hinty tabulky
    if (STMT_STOP.has(u) || u === 'WITH') break;
    if (u === 'FROM' && from < 0) { from = j; continue; }
    if (from < 0 || k.t !== 'w' || k.v.toLowerCase() !== alias.v.toLowerCase()) continue;
    if (isP(tk[j + 1], '.') || isP(tk[j - 1], '.')) continue; // x.Sloupec
    if (k.v !== alias.v) return false; // jiná velikost písmen – při case-sensitive kolaci by to byl jiný objekt
    // zpětně: [AS] <název objektu>, před ním FROM/JOIN/APPLY/čárka
    let b = j - 1;
    if (up(tk[b]) === 'AS') b--;
    let start = b;
    if (tk[start]?.t !== 'w') return false;
    while (isP(tk[start - 1], '.')) { start--; while (isP(tk[start - 1], '.')) start--; if (tk[start - 1]?.t === 'w') start--; else return false; }
    const name = readName(tk, start);
    if (!name || name.end !== b + 1 || !isTempName(name)) return false;
    const before = tk[start - 1];
    if (!(isP(before, ',') || ['FROM', 'JOIN', 'APPLY'].includes(up(before)))) return false;
    bound++;
  }
  return bound > 0;
}

/**
 * @returns {{ok: boolean, errors: string[], notes: string[], sql: string}} sql = text bez příkazů `USE <db>` (databázi určuje parametr)
 */
export function checkSql(sqlIn) {
  const errors = [];
  const notes = [];
  let sql = String(sqlIn ?? '');
  if (!sql.trim()) return { ok: false, errors: ['Prázdný dotaz.'], notes, sql };
  if (sql.length > 200_000) return { ok: false, errors: ['Dotaz je delší než 200 000 znaků.'], notes, sql };

  // USE <db>[;] se odstraní jen jako samostatný příkaz mimo řetězce a komentáře; `OPTION (USE HINT(...))` ani `a, use AS b` se nedotkne
  let lx = lex(sql);
  const cuts = [];
  lx.tokens.forEach((k, i, tk) => {
    if (up(k) !== 'USE' || tk[i + 1]?.t !== 'w') return;
    const prev = tk[i - 1];
    const stmtStart = !prev || isP(prev, ';') || isP(prev, ')') || prev.t === 's' || (prev.t === 'w' && prev.line < k.line);
    if (!stmtStart || isP(tk[i + 2], '.') || isP(tk[i + 2], '(') || isP(tk[i + 2], '=') || ['AS', 'HINT'].includes(up(tk[i + 1]))) return;
    cuts.push([k.pos, isP(tk[i + 2], ';') ? tk[i + 2].end : tk[i + 1].end]);
  });
  if (cuts.length) {
    let out = '';
    let at = 0;
    for (const [a, b] of cuts) { out += sql.slice(at, a); at = b; }
    sql = out + sql.slice(at);
    notes.push('Příkazy `USE ...` byly odstraněny – databázi určuje parametr `database`.');
    lx = lex(sql);
    if (!lx.tokens.length) return { ok: false, errors: ['Po odstranění USE nezbyl žádný příkaz.'], notes, sql };
  }
  const tk = lx.tokens;
  if (!tk.length) return { ok: false, errors: ['Dotaz neobsahuje žádný příkaz (jen komentáře).'], notes, sql };

  if (lx.control.length) {
    const codes = [...new Set(lx.control.map((p) => `U+${sql.charCodeAt(p).toString(16).toUpperCase().padStart(4, '0')}`))];
    errors.push(`Řídicí znaky v kódu (${codes.join(', ')}) – SQL Server je čte jako mezery; nahraď je mezerou.`);
  }
  if (lx.masked.has(-1)) errors.push('Neukončený řetězec nebo komentář /* */.');

  // dávky: řádky GO (stejné dělení jako ps\Run-Query.ps1); GO uvnitř řetězce/komentáře by runner rozdělil jinak než brána → odmítnout
  const lines = sql.split('\n').map((l) => l.replace(/\r$/, ''));
  const goLines = [];
  lines.forEach((l, i) => {
    if (RE_GO_LINE.test(l)) {
      if (lx.masked.has(i)) errors.push(`Řádek ${i + 1}: GO uvnitř řetězce nebo komentáře – runner by na něm dávku rozdělil; přepiš text tak, aby řádek nezačínal GO.`);
      else goLines.push(i);
    } else if (RE_GO_COUNT.test(l) && !lx.masked.has(i)) {
      errors.push(`Řádek ${i + 1}: \`GO <počet>\` (opakování dávky) není povolené.`);
    }
  });
  const isGoLine = new Set(goLines);
  let gi = 0;
  for (const k of tk) {
    while (gi < goLines.length && goLines[gi] < k.line) gi++;
    k.batch = gi;
    k.go = isGoLine.has(k.line);
  }
  const code = tk.filter((k) => !k.go); // tokeny mimo řádky GO
  const seen = new Set();
  code.forEach((k) => {
    if (seen.has(k.batch) || isP(k, ';')) return;
    seen.add(k.batch);
    const u = up(k);
    if (BATCH_START.has(u) || FORBIDDEN.has(u) || isP(k, '(') || ['MERGE', 'USE', 'BULK', 'SAVE'].includes(u)) return;
    errors.push(`Dávka ${k.batch + 1} začíná „${show(k)}“ – to SQL Server vyhodnotí jako volání procedury bez EXEC, a to není povolené. Dávka musí začínat příkazem (SELECT, WITH, DECLARE, SET, IF, CREATE TABLE #…).`);
  });

  const t = code;
  for (let i = 0; i < t.length; i++) {
    const k = t[i];
    const u = up(k);
    const prev = up(t[i - 1]);
    const next = up(t[i + 1]);
    const afterComma = isP(t[i - 1], '(') || isP(t[i - 1], ',');

    if (k.t === 'w' && /^(sp|xp)_/i.test(k.v)) errors.push(`Zakázaná systémová procedura: ${k.v}`);
    if (isP(k, '{') && (next === 'CALL' || (isP(t[i + 1], '?') && up(t[i + 3]) === 'CALL'))) errors.push('Zakázané volání procedury: {call ...}');
    // seznam databází serveru: platí i pro názvy v [] / "" (proto před `if (!u)`), jako zdroj i kdekoli jinde v kódu
    if (k.t === 'w') {
      const lv = k.v.toLowerCase();
      const member = isP(t[i + 1], '.') && t[i + 2]?.t === 'w' ? t[i + 2].v.toLowerCase() : '';
      if (lv === 'sys' && DB_LIST_VIEWS.has(member)) errors.push(`Odkaz na seznam databází serveru („sys.${member}“) není povolený – ${DB_LIST_HINT}.`);
      else if (DB_LIST_BARE.has(lv) && !(t[i - 2]?.t === 'w' && t[i - 2].v.toLowerCase() === 'sys' && isP(t[i - 1], '.'))) errors.push(`Odkaz na seznam databází serveru („${lv}“) není povolený – ${DB_LIST_HINT}.`);
      else if (lv === 'has_dbaccess' && isP(t[i + 1], '(')) errors.push(`Funkce HAS_DBACCESS není povolená – ${DB_LIST_HINT}.`);
      else if (lv === 'db_name' && isP(t[i + 1], '(') && !isP(t[i + 2], ')')) errors.push(`DB_NAME s argumentem není povolené (jen DB_NAME() bez argumentu = aktuální databáze) – ${DB_LIST_HINT}.`);
    }
    if (!u) continue;

    if (FORBIDDEN.has(u)) errors.push(`Zakázané klíčové slovo: ${u === 'IDENTITY_INSERT' ? 'SET IDENTITY_INSERT' : u}`);
    else if ((u === 'TRAN' || u === 'TRANSACTION') && ['BEGIN', 'SAVE', 'DISTRIBUTED'].includes(prev)) errors.push(`Zakázané klíčové slovo: ${prev} ${u}`);
    else if (u === 'BULK' && next === 'INSERT') errors.push('Zakázané klíčové slovo: BULK INSERT');
    else if (u === 'USE' && !(next === 'HINT' && afterComma)) errors.push('Zakázané klíčové slovo: USE');
    else if ((u === 'ENABLE' || u === 'DISABLE') && next === 'TRIGGER') errors.push(`Zakázané klíčové slovo: ${u} TRIGGER`);
    else if (u === 'MERGE') {
      const joinHint = next === 'JOIN' && (afterComma || ['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER'].includes(prev));
      if (!joinHint && !(next === 'UNION' && afterComma)) errors.push('Zakázané klíčové slovo: MERGE');
    }

    // zdroje tabulek: vícedílný název míří do jiné databáze / na jiný server
    if (u === 'FROM' || u === 'JOIN' || u === 'APPLY') {
      let j = i + 1;
      for (;;) {
        // závorkovaný JOIN `FROM (db.dbo.A a JOIN ...)`: název hned za závorkou je také zdroj
        let open = j;
        while (isP(t[open], '(')) open++;
        if (open > j && t[open]?.t === 'w' && !['SELECT', 'VALUES', 'WITH'].includes(up(t[open]))) j = open;
        if (isP(t[j], '(')) j = skipParens(t, j);
        else {
          const name = readName(t, j);
          if (!name || NOT_ALIAS.has(up(t[j]))) break;
          if (isCrossDb(name)) errors.push(`Odkaz mimo aktuální databázi: „${name.text}“ – povolené jsou jen objekty zvolené databáze (schema.tabulka); jinou DB urči parametrem \`database\`.`);
          j = name.end;
          if (isP(t[j], '(')) j = skipParens(t, j); // tabulková funkce
        }
        if (u !== 'FROM') break; // čárkový seznam jen hned za FROM
        if (up(t[j]) === 'AS') j++;
        if (t[j]?.t === 'w' && !NOT_ALIAS.has(up(t[j]))) { j++; if (isP(t[j], '(')) j = skipParens(t, j); }
        if (up(t[j]) === 'WITH' && isP(t[j + 1], '(')) j = skipParens(t, j + 1);
        if (!isP(t[j], ',')) break;
        j++;
      }
    }

    // cíle zápisu
    const target = (j, what, allowAlias) => {
      const name = readName(t, j);
      if (isTempName(name)) return;
      if (allowAlias && name && name.parts.length === 1 && aliasIsTemp(t, name.end, name.parts[0], what === 'UPDATE')) return;
      errors.push(`${what} do trvalé tabulky/aliasu „${name ? name.text : show(t[j])}“ – povolené jsou jen #dočasné tabulky a @tabulkové proměnné${allowAlias ? ' (alias jen tehdy, když ho klauzule FROM téhož příkazu váže na #/@ objekt)' : ''}.`);
    };
    if (u === 'INSERT' && next !== 'INTO' && !(prev === 'BULK')) target(i + 1, 'INSERT', false);
    else if (u === 'INTO') target(i + 1, prev === 'INSERT' ? 'INSERT' : 'INTO (SELECT INTO / OUTPUT INTO)', false);
    else if (u === 'UPDATE') {
      if (next === 'STATISTICS') errors.push('Zakázané klíčové slovo: UPDATE STATISTICS');
      else target(i + 1, 'UPDATE', true);
    } else if (u === 'DELETE') target(next === 'FROM' ? i + 2 : i + 1, 'DELETE', true);
    else if (u === 'TRUNCATE') {
      if (next === 'TABLE') target(i + 2, 'TRUNCATE', false);
      else errors.push('Zakázané klíčové slovo: TRUNCATE');
    } else if (u === 'CREATE') {
      let j = i + 1;
      const kind = [];
      while (['UNIQUE', 'CLUSTERED', 'NONCLUSTERED'].includes(up(t[j]))) kind.push(up(t[j++]));
      const what = up(t[j]);
      let okCreate = false;
      let label = `${[...kind, what || show(t[j])].join(' ')} ${show(t[j + 1])}`;
      if (what === 'TABLE' && !kind.length) {
        const name = readName(t, j + 1);
        okCreate = isTempName(name) && isHash(name.parts[name.parts.length - 1]);
        if (name) label = `TABLE ${name.text}`;
      } else if (what === 'INDEX' && t[j + 1]?.t === 'w' && up(t[j + 2]) === 'ON') {
        const name = readName(t, j + 3);
        okCreate = isTempName(name) && isHash(name.parts[name.parts.length - 1]);
        label = `${[...kind, 'INDEX'].join(' ')} ${show(t[j + 1])} ON ${name ? name.text : show(t[j + 3])}`;
      }
      if (!okCreate) errors.push(`CREATE ${label} – povolené je jen CREATE TABLE #dočasná a CREATE INDEX … ON #dočasná.`);
    } else if (u === 'DROP') {
      if (next !== 'TABLE') errors.push(`DROP ${show(t[i + 1])} ${show(t[i + 2])} – povolené je jen DROP TABLE #dočasná.`);
      else {
        let j = i + 2;
        if (up(t[j]) === 'IF' && up(t[j + 1]) === 'EXISTS') j += 2;
        for (;;) { // seznam tabulek – každá položka musí být dočasná
          const name = readName(t, j);
          if (!(isTempName(name) && isHash(name.parts[name.parts.length - 1]))) errors.push(`DROP TABLE ${name ? name.text : show(t[j])} – povolené je jen DROP TABLE #dočasná.`);
          if (!name || !isP(t[name.end], ',')) break;
          j = name.end + 1;
        }
      }
    }
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], notes, sql };
}
