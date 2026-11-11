// Spouštění PowerShell pomocníků (kontrola dotazu, read-only běh). Nic z potomka nesmí na stdout serveru (JSON-RPC) – výstup se čte ze souboru.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectRoot, validateSqlServer } from './config.js';
import { checkSql } from './sqlgate.js';

const BOM = '﻿';
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
// plná cesta: `powershell.exe` z PATH by mohl být jiný program
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const AUDIT_MAX_BYTES = 5 * 1024 * 1024; // větší auditní soubor se přejmenuje na .1
const AUDIT_SQL_CHARS = 20_000;
const MAX_SETS = 50;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 500;
const MAX_CELL_CHARS = 200;

/** Ukončí proces i s potomky (Check-Query spouští další powershell). Chyby se ignorují. */
function killTree(child) {
  // child.kill() až po taskkill: kdyby rodič skončil dřív, taskkill /T by jeho potomky už nedohledal
  const fallback = () => { try { child.kill(); } catch { /* už neběží */ } };
  try {
    const k = spawn(path.join(SYSTEM32, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', fallback);
    k.on('exit', fallback);
  } catch { fallback(); }
}

function runPowerShell(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString(); });
    const timer = setTimeout(() => { killTree(child); reject(new Error(`PowerShell neodpověděl do ${Math.round(timeoutMs / 1000)} s (proces byl ukončen).`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

async function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pohoda-mcp-'));
  try {
    return await fn(dir);
  } finally {
    // úklid nesmí přepsat výsledek ani původní chybu (soubor může ještě držet ukončovaný PowerShell)
    try { await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* zůstane v %TEMP% */ }
  }
}

const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

/** Statická kontrola proti schématu (tools\Test-PohodaQuery.ps1 agenta). schema 'obecny' / undefined = bez -Firma. */
export async function checkQuery(cfg, sql, schema) {
  // název schématu jde na příkazový řádek PowerShellu – jen bezpečné znaky
  if (schema !== undefined && schema !== null && schema !== '' && !/^[\w-]{1,40}$/.test(String(schema))) {
    throw new Error(`Neplatný název schématu „${String(schema).slice(0, 60)}“ – povolená jsou písmena bez diakritiky, číslice, _ a - (nejvýš 40 znaků).`);
  }
  const checker = path.join(cfg.agentDir, 'tools', 'Test-PohodaQuery.ps1');
  if (!fs.existsSync(checker)) throw new Error(`Kontrola nenalezena: ${checker}`);
  const firma = schema && schema !== 'obecny' ? String(schema) : '';
  return withTemp(async (dir) => {
    const sqlFile = path.join(dir, 'dotaz.sql');
    const outFile = path.join(dir, 'kontrola.json');
    fs.writeFileSync(sqlFile, BOM + sql, 'utf8'); // BOM: kontrola jinak čte jako Windows-1250
    const args = [path.join(projectRoot, 'ps', 'Check-Query.ps1'), '-Checker', checker, '-SqlFile', sqlFile, '-OutFile', outFile];
    if (firma) args.push('-Firma', firma);
    const r = await runPowerShell(args, 120_000);
    if (!fs.existsSync(outFile)) throw new Error(`Kontrola nevrátila výsledek (exit ${r.code}). ${r.stderr}`.trim());
    return readJsonFile(outFile);
  });
}

/** Zápis do auditu (JSON Lines). SQL se ořízne na 20 000 znaků (sha je z celého textu); soubor nad 5 MB se přejmenuje na `.1`. */
export function audit(cfg, entry) {
  try {
    fs.mkdirSync(path.dirname(cfg.auditLog), { recursive: true });
    try {
      if (fs.statSync(cfg.auditLog).size > AUDIT_MAX_BYTES) fs.renameSync(cfg.auditLog, `${cfg.auditLog}.1`); // přepíše starší .1
    } catch { /* soubor ještě neexistuje nebo nejde přejmenovat – zapisuje se dál do něj */ }
    const e = { ts: new Date().toISOString(), ...entry };
    if (typeof e.sql === 'string' && e.sql.length > AUDIT_SQL_CHARS) { e.sqlLen = e.sql.length; e.sql = e.sql.slice(0, AUDIT_SQL_CHARS); }
    fs.appendFileSync(cfg.auditLog, `${JSON.stringify(e)}\n`, 'utf8');
  } catch { /* audit nesmí shodit dotaz */ }
}

/** Buňka markdown tabulky: NULL, jeden řádek, nejvýš 200 znaků (zkrácení značí …), `|` se escapuje až po zkrácení. */
export function cell(v) {
  if (v === null || v === undefined) return 'NULL';
  let s = String(v).replace(/\r\n|\r|\n/g, ' ');
  if (s.length > MAX_CELL_CHARS) {
    const cut = /[\uD800-\uDBFF]/.test(s[MAX_CELL_CHARS - 1]) ? MAX_CELL_CHARS - 1 : MAX_CELL_CHARS; // nepůlit znak mimo BMP
    s = `${s.slice(0, cut)}…`;
  }
  return s.replace(/\|/g, '\\|');
}

/**
 * Sjednotí tvar JSON z ps\Run-Query.ps1 na { sets: [{cols: [], rows: [[]], total}], messages: [] }.
 * PS 5.1 vrací pole správně i pro tvary 0×0, 1×1, 1×3 a 3×1 (ověřeno); tohle je jen obrana proti jiné verzi pomocníka,
 * která by jednoprvkové pole vrátila jako samotnou hodnotu.
 */
export function normalizeResult(res) {
  const arr = (v) => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);
  const sets = arr(res?.sets).filter((s) => s && typeof s === 'object').map((s) => {
    const rows = arr(s.rows).map((r) => (Array.isArray(r) ? r : [r]));
    return { cols: arr(s.cols), rows, total: Number.isFinite(s.total) ? s.total : rows.length };
  });
  return { sets, messages: arr(res?.messages).map(String) };
}

/**
 * Result sety jako markdown tabulky. Celý text se drží limitu limits.maxChars: když se tabulka nevejde celá,
 * zobrazí se tolik řádků, kolik se vejde. Nejvýš 50 result setů a 20 zpráv PRINT (zbytek jako „+N dalších“).
 * @param {{sets: Array<{cols: any[], rows: any[][], total: number}>, messages?: string[]}} result
 * @param {{maxChars: number}} limits
 * @returns {string}
 */
export function formatSets(result, limits) {
  const parts = [];
  let left = limits.maxChars;
  let omitted = 0;
  const sets = result.sets ?? [];
  sets.slice(0, MAX_SETS).forEach((s, i) => {
    const loaded = s.rows.length;
    const header = `| ${s.cols.map(cell).join(' | ')} |\n|${s.cols.map(() => '---').join('|')}|`;
    const lines = [];
    let size = header.length + 200; // rezerva na nadpis a poznámku
    if (size <= left) {
      for (const r of s.rows) {
        const line = `| ${r.map(cell).join(' | ')} |`;
        if (size + line.length + 1 > left) break;
        lines.push(line); size += line.length + 1;
      }
    }
    const title = `**Výsledek ${i + 1}** – ${s.total} řádků`;
    if (size > left) {
      parts.push(`${title} _(tabulka vynechána)_`);
      omitted++;
      return;
    }
    const cutByChars = lines.length < loaded;
    const note = cutByChars
      ? ` (zobrazeno prvních ${lines.length} – víc se nevejde do limitu ${limits.maxChars} znaků výstupu; zúži dotaz nebo agreguj)`
      : s.total > loaded ? ` (zobrazeno prvních ${loaded})` : '';
    parts.push(`${title}${note}\n\n${[header, ...lines].join('\n')}`);
    left -= size;
  });
  if (omitted) parts.push(`_Vynechané tabulky (${omitted}) se nevešly do limitu ${limits.maxChars} znaků výstupu; zúži dotaz nebo agreguj._`);
  if (sets.length > MAX_SETS) parts.push(`_+${sets.length - MAX_SETS} dalších result setů nezobrazeno (limit ${MAX_SETS}); rozděl skript._`);
  const messages = result.messages ?? [];
  if (messages.length) {
    const shown = messages.slice(0, MAX_MESSAGES).map((m) => (m.length > MAX_MESSAGE_CHARS ? `${m.slice(0, MAX_MESSAGE_CHARS)}…` : m));
    let text = shown.join('\n');
    const room = Math.max(left, 1000);
    if (text.length > room) text = `${text.slice(0, room)}…`;
    const more = messages.length > MAX_MESSAGES ? `\n_+${messages.length - MAX_MESSAGES} dalších zpráv_` : '';
    parts.push(`**Zprávy (PRINT):**\n${text}${more}`);
  }
  if (!sets.length) parts.unshift('_Skript nevrátil žádný result set (použij SELECT, ne PRINT)._');
  return parts.join('\n\n');
}

/** Hlavička odpovědi: „transakce vrácena“ jen když to pomocník potvrdil (rolledBack === true), jinak výrazné varování. */
export function formatHeader({ db, server, ms, notes = [] }, res) {
  const base = `Databáze: ${db} na ${server} · ${ms} ms`;
  const head = res?.rolledBack === true
    ? `${base} · transakce vrácena (ROLLBACK)`
    : `${base}\n**POZOR: vrácení transakce (ROLLBACK) se nepodařilo potvrdit** – ${res?.rollbackError ? String(res.rollbackError).slice(0, 300) : 'pomocník stav nevrátil'}. Spojení je zavřené (SQL Server tím otevřenou transakci ruší), přesto stav ověř.`;
  return `${head}\n${notes.length ? `${notes.join(' ')}\n` : ''}`;
}

/**
 * Read-only běh na povolené DB: textová brána → PowerShell pomocník (transakce + ROLLBACK, ApplicationIntent=ReadOnly).
 * Každé volání zanechá právě jeden auditní záznam – i odmítnutí, timeout a pád pomocníka.
 * @param {{run?: typeof runPowerShell}} [deps] jen pro testy: náhrada spouštění PowerShellu
 */
export async function runQuery(cfg, { sql, database, maxRows }, { run = runPowerShell } = {}) {
  const rq = cfg.runQuery;
  const t0 = Date.now();
  const text = String(sql ?? '');
  const db = String(database || rq.allowedDatabases?.[0] || '');
  const sha = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  const log = (extra) => audit(cfg, { tool: 'run_query', db: db.slice(0, 128), sha, sql: text, ms: Date.now() - t0, ...extra });
  const fail = (message, extra) => Object.assign(new Error(message), { auditExtra: extra });
  try {
    if (!rq.enabled) throw new Error('pohoda_run_query je vypnuté (config.json: runQuery.enabled = false).');
    if (!rq.allowedDatabases.includes(db)) {
      throw fail(`Databáze „${db}“ není povolená. Povolené: ${rq.allowedDatabases.join(', ')}. Další DB se povolují jen v config.json (runQuery.allowedDatabases).`, { refused: ['Databáze není povolená.'] });
    }
    const gate = checkSql(text);
    if (!gate.ok) {
      throw fail(`Dotaz odmítnut kontrolou textu:\n- ${gate.errors.join('\n- ')}\nPovolené: SELECT (i SELECT INTO #tmp), CREATE/INSERT/UPDATE/DELETE/DROP jen nad #dočasnými tabulkami, DECLARE, WHILE, více result setů.`, { refused: gate.errors });
    }
    const badServer = validateSqlServer(rq.server);
    if (badServer) throw new Error(`${badServer} Nastav POHODA_SQL_SERVER nebo runQuery.server v config.json.`);
    if (!fs.existsSync(rq.credentialFile)) {
      throw new Error(`Soubor s přihlášením k SQL nenalezen: ${rq.credentialFile}. Vytvoř ho v PowerShellu: Get-Credential | Export-Clixml <cesta> (read-only SQL login) a cestu nastav proměnnou POHODA_CREDENTIAL_FILE nebo runQuery.credentialFile v config.json.`);
    }
    const perSet = Math.min(Math.max(maxRows ?? rq.maxRowsPerSet, 1), rq.maxRowsHard);
    const result = await withTemp(async (dir) => {
      const sqlFile = path.join(dir, 'dotaz.sql');
      const outFile = path.join(dir, 'vysledek.json');
      fs.writeFileSync(sqlFile, BOM + gate.sql, 'utf8');
      const args = [
        path.join(projectRoot, 'ps', 'Run-Query.ps1'), '-SqlFile', sqlFile, '-Database', db, '-OutFile', outFile,
        '-CredentialFile', rq.credentialFile, '-Server', rq.server, '-MaxRowsPerSet', String(perSet), '-TimeoutSec', String(rq.timeoutSec),
      ];
      const r = await run(args, (rq.timeoutSec + 30) * 1000);
      if (!fs.existsSync(outFile)) throw new Error(`Běh nevrátil výsledek (exit ${r.code}). ${r.stderr}`.trim());
      let res;
      try { res = readJsonFile(outFile); } catch (e) { throw new Error(`Běh vrátil neplatný JSON: ${e.message}`); }
      if (!res || typeof res !== 'object') throw new Error('Běh vrátil neplatný JSON: chybí objekt s výsledkem.');
      return res;
    });
    const ms = Date.now() - t0;
    if (!result.ok) {
      // rolledBack: false = Rollback() selhal (typicky proto, že transakci už zrušil server), null = transakce vůbec nezačala
      const rb = result.rolledBack === false ? ` [ROLLBACK nepotvrzen: ${String(result.rollbackError ?? 'neznámý důvod').slice(0, 300)}; spojení je zavřené]` : '';
      throw fail(`Chyba SQL (${db} na ${rq.server}): ${result.error}${rb}`, { error: String(result.error).slice(0, 300), rolledBack: result.rolledBack ?? null });
    }
    const res = normalizeResult(result);
    const out = `${formatHeader({ db, server: rq.server, ms, notes: gate.notes }, result)}\n${formatSets(res, { maxChars: rq.maxChars })}`;
    log({ sets: res.sets.map((s) => s.total), rolledBack: result.rolledBack === true });
    return { text: out, sets: res.sets.length };
  } catch (e) {
    log(e?.auditExtra ?? { error: String(e?.message ?? e).slice(0, 300) });
    throw e;
  }
}
