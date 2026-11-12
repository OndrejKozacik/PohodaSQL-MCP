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
// Text výjimky z JSON.parse se nikam nevrací (na starších Node obsahuje úryvek vstupu, tedy i data) – jen pevná zpráva.
const BAD_JSON = 'výstup pomocníka nejde přečíst';
// Starý ps\Run-Query.ps1 s novým serverem (nebo naopak): PowerShell odmítne neznámý parametr dřív, než skript něco zapíše.
const RE_HELPER_MISMATCH = /AllowedDatabases|cannot be found that matches parameter/i;
const HELPER_MISMATCH = 'ps\\Run-Query.ps1 je jiné verze než server – sestav a nainstaluj balíček znovu.';

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
    try { return readJsonFile(outFile); } catch { throw new Error(`Kontrola vrátila neplatný JSON: ${BAD_JSON}.`); }
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

// Kódy důvodů z kontroly loginu (ps\Run-Query.ps1 je ASCII-only, český text se doplňuje tady).
const LOGIN_REASONS = {
  sysadmin: 'člen serverové role sysadmin',
  control_server: 'oprávnění CONTROL SERVER',
  db_owner: 'člen role db_owner',
  db_datawriter: 'člen role db_datawriter',
  db_ddladmin: 'člen role db_ddladmin',
  perm_INSERT: 'oprávnění INSERT v databázi',
  perm_UPDATE: 'oprávnění UPDATE v databázi',
  perm_DELETE: 'oprávnění DELETE v databázi',
  perm_ALTER: 'oprávnění ALTER v databázi',
  perm_CONTROL: 'oprávnění CONTROL v databázi',
  db_securityadmin: 'člen role db_securityadmin (smí měnit oprávnění)',
  db_accessadmin: 'člen role db_accessadmin (smí spravovat přístup do databáze)',
  perm_db_other: 'další oprávnění v databázi mimo čtení (např. EXECUTE nebo CREATE)',
  perm_server_other: 'další oprávnění na serveru mimo čtení',
  schema_write: 'oprávnění zápisu nebo EXECUTE na úrovni schématu',
  object_write: 'oprávnění zápisu (INSERT/UPDATE/DELETE/ALTER) k některé tabulce nebo pohledu',
  proc_execute: 'oprávnění EXECUTE k některé uložené proceduře',
  unknown: 'některou kontrolu oprávnění se nepodařilo vyhodnotit (bere se jako možnost zápisu)',
};
const MAX_LOGIN_REASONS = 30;

/**
 * Výsledek kontroly loginu z pomocníka → { writable, reasons (česky), otherDatabases (počet | null), otherWritableDatabases
 * (v kolika z nich smí login zapisovat; počet | null) } pro výstup a audit, a zvlášť `names` a `writableNames` (názvy dalších
 * dostupných databází) – ty smí jen na stderr serveru, nikdy do výstupu pro model.
 * Chybějící nebo poškozený výsledek = null (volající běh odmítne). `writable` je false jen při výslovném false bez důvodů.
 */
export function normalizeLogin(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.writable !== 'boolean') return null;
  const arr = (v) => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);
  const reasons = arr(raw.reasons).slice(0, MAX_LOGIN_REASONS).map((c) => LOGIN_REASONS[String(c)] ?? `důvod „${String(c).replace(/[^\w-]/g, '?').slice(0, 40)}“`);
  const writable = raw.writable || reasons.length > 0;
  if (writable && !reasons.length) reasons.push('důvod pomocník neuvedl');
  const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  return {
    login: { writable, reasons, otherDatabases: count(raw.otherDatabases), otherWritableDatabases: count(raw.otherWritableDatabases) },
    names: arr(raw.otherDatabaseNames).map(String),
    writableNames: arr(raw.otherWritableDatabaseNames).map(String),
  };
}

// naposledy ohlášená sada dalších dostupných databází (klíč server + databáze) – na stderr se píše jen při změně
const reportedOtherDatabases = new Map();

/**
 * Názvy dalších databází, do kterých login smí, jen na stderr serveru: poprvé když nějaké jsou, pak jen když se změní sada názvů
 * (ne jen počet – jedna databáze může ubýt a jiná přibýt) nebo sada těch, ve kterých login smí zapisovat.
 */
function reportOtherDatabases(server, db, login, names, writableNames, warn) {
  if (login.otherDatabases === null) return;
  const key = `${server}|${db}`;
  const state = `${login.otherDatabases}:${names.join('|')}#${login.otherWritableDatabases ?? 0}:${writableNames.join('|')}`;
  if (state === (reportedOtherDatabases.get(key) ?? '0:#0:')) return;
  reportedOtherDatabases.set(key, state);
  const writable = login.otherWritableDatabases
    ? ` POZOR: v ${login.otherWritableDatabases} z nich má login oprávnění zapisovat: ${writableNames.join(', ')}.`
    : '';
  warn(login.otherDatabases
    ? `[pohoda-mcp] UPOZORNĚNÍ – SQL login se kromě povolených databází dostane do dalších ${login.otherDatabases} (zjištěno z ${db}): ${names.join(', ')}.${writable} Doporučení: nech loginu přístup jen do povolených databází.`
    : `[pohoda-mcp] SQL login se už nedostane do žádné databáze mimo povolené (zjištěno z ${db}).`);
}

const warnStderr = (line) => console.error(line);
const fail = (message, extra) => Object.assign(new Error(message), { auditExtra: extra });

const loginRefusedMessage = (db, server, login, state = 'Skript se nespustil.') => `Běh odmítnut: SQL login smí zapisovat (${db} na ${server}) – ${login.reasons.join(', ')}. ${state} pohoda_run_query je určený pro login, který smí jen číst: vytvoř login jen s rolí db_datareader, nejlépe s přístupem jen do povolených databází, a ulož ho do souboru s přihlášením. Vědomě to lze povolit nastavením runQuery.allowWritableLogin = true v config.json nebo proměnnou POHODA_ALLOW_WRITABLE_LOGIN=1; ochranou pak zůstává jen textová brána a ROLLBACK.`;

/**
 * Jedno spuštění ps\Run-Query.ps1 (běh skriptu, nebo jen kontrola loginu při `probe`). Vrací JSON pomocníka, ve kterém je `login`
 * už nahrazený tvarem z normalizeLogin – názvy dalších databází se tady oddělí a dál se nedostanou.
 */
async function invokeHelper(rq, db, { sql, perSet, probe = false }, run, warn) {
  const badServer = validateSqlServer(rq.server);
  if (badServer) throw new Error(`${badServer} Nastav POHODA_SQL_SERVER nebo runQuery.server v config.json.`);
  if (!fs.existsSync(rq.credentialFile)) {
    throw new Error(`Soubor s přihlášením k SQL nenalezen: ${rq.credentialFile}. Vytvoř ho v PowerShellu: Get-Credential | Export-Clixml <cesta> (read-only SQL login) a cestu nastav proměnnou POHODA_CREDENTIAL_FILE nebo runQuery.credentialFile v config.json.`);
  }
  return withTemp(async (dir) => {
    const outFile = path.join(dir, 'vysledek.json');
    const args = [
      path.join(projectRoot, 'ps', 'Run-Query.ps1'), '-Database', db, '-OutFile', outFile,
      '-CredentialFile', rq.credentialFile, '-Server', rq.server, '-TimeoutSec', String(rq.timeoutSec),
      '-AllowedDatabases', rq.allowedDatabases.join(';'),
    ];
    if (probe) args.push('-Probe');
    else {
      const sqlFile = path.join(dir, 'dotaz.sql');
      fs.writeFileSync(sqlFile, BOM + sql, 'utf8');
      args.push('-SqlFile', sqlFile, '-MaxRowsPerSet', String(perSet));
      if (rq.allowWritableLogin === true) args.push('-AllowWritableLogin');
    }
    const r = await run(args, (rq.timeoutSec + 30) * 1000);
    if (!fs.existsSync(outFile)) {
      if (RE_HELPER_MISMATCH.test(r.stderr ?? '')) throw new Error(`Běh nevrátil výsledek (exit ${r.code}): ${HELPER_MISMATCH}`);
      throw new Error(`Běh nevrátil výsledek (exit ${r.code}). ${r.stderr}`.trim());
    }
    let res;
    try { res = readJsonFile(outFile); } catch { throw new Error(`Běh vrátil neplatný JSON: ${BAD_JSON}.`); }
    if (!res || typeof res !== 'object') throw new Error('Běh vrátil neplatný JSON: chybí objekt s výsledkem.');
    const norm = normalizeLogin(res.login);
    res.login = norm ? norm.login : null;
    if (norm) reportOtherDatabases(rq.server, db, norm.login, norm.names, norm.writableNames, warn);
    return res;
  });
}

/** Hlavička odpovědi: „transakce vrácena“ jen když to pomocník potvrdil (rolledBack === true), jinak výrazné varování. */
export function formatHeader({ db, server, ms, notes = [] }, res) {
  const base = `Databáze: ${db} na ${server} · ${ms} ms`;
  const head = res?.rolledBack === true
    ? `${base} · transakce vrácena (ROLLBACK)`
    : `${base}\n**POZOR: vrácení transakce (ROLLBACK) se nepodařilo potvrdit** – ${res?.rollbackError ? String(res.rollbackError).slice(0, 300) : 'pomocník stav nevrátil'}. Spojení je zavřené (SQL Server tím otevřenou transakci ruší), přesto stav ověř.`;
  // běh se zapisujícím loginem jde jen při vědomém povolení (runQuery.allowWritableLogin)
  const login = res?.login?.writable === true
    ? `\n**POZOR: login smí zapisovat (${(res.login.reasons ?? []).join(', ')}); ochranou zůstává jen textová brána a ROLLBACK.**`
    : '';
  return `${head}${login}\n${notes.length ? `${notes.join(' ')}\n` : ''}`;
}

/**
 * Read-only běh na povolené DB: textová brána → PowerShell pomocník (kontrola oprávnění loginu, transakce + ROLLBACK,
 * ApplicationIntent=ReadOnly). Login, který smí zapisovat, pomocník odmítne ještě před spuštěním skriptu (pokud to nastavení
 * runQuery.allowWritableLogin výslovně nepovoluje). Každé volání zanechá právě jeden auditní záznam – i odmítnutí, timeout a pád pomocníka.
 * @param {{run?: typeof runPowerShell, warn?: (line: string) => void}} [deps] jen pro testy: náhrada spouštění PowerShellu a zápisu na stderr
 */
export async function runQuery(cfg, { sql, database, maxRows }, { run = runPowerShell, warn = warnStderr } = {}) {
  const rq = cfg.runQuery;
  const t0 = Date.now();
  const text = String(sql ?? '');
  const db = String(database || rq.allowedDatabases?.[0] || '');
  const sha = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  const log = (extra) => audit(cfg, { tool: 'run_query', db: db.slice(0, 128), sha, sql: text, ms: Date.now() - t0, ...extra });
  try {
    if (!rq.enabled) throw new Error('pohoda_run_query je vypnuté (config.json: runQuery.enabled = false).');
    if (!rq.allowedDatabases.includes(db)) {
      throw fail(`Databáze „${db}“ není povolená. Povolené: ${rq.allowedDatabases.join(', ')}. Další DB se povolují jen v config.json (runQuery.allowedDatabases).`, { refused: ['Databáze není povolená.'] });
    }
    const gate = checkSql(text);
    if (!gate.ok) {
      throw fail(`Dotaz odmítnut kontrolou textu:\n- ${gate.errors.join('\n- ')}\nPovolené: SELECT (i SELECT INTO #tmp), CREATE/INSERT/UPDATE/DELETE/DROP jen nad #dočasnými tabulkami, DECLARE, WHILE, více result setů.`, { refused: gate.errors });
    }
    const perSet = Math.min(Math.max(maxRows ?? rq.maxRowsPerSet, 1), rq.maxRowsHard);
    const result = await invokeHelper(rq, db, { sql: gate.sql, perSet }, run, warn);
    const ms = Date.now() - t0;
    const login = result.login;
    if (result.loginRefused) {
      const l = login ?? { writable: true, reasons: ['důvod pomocník neuvedl'], otherDatabases: null, otherWritableDatabases: null };
      throw fail(loginRefusedMessage(db, rq.server, l), { loginRefused: true, reasons: l.reasons, rolledBack: null });
    }
    if (!result.ok) {
      if (result.stage === 'preflight') {
        throw fail(`Kontrola oprávnění SQL loginu selhala (${db} na ${rq.server}): ${result.error}. Skript se nespustil.`, { error: `Kontrola loginu: ${String(result.error).slice(0, 280)}`, rolledBack: null });
      }
      // rolledBack: false = Rollback() selhal (typicky proto, že transakci už zrušil server), null = transakce vůbec nezačala
      const rb = result.rolledBack === false ? ` [ROLLBACK nepotvrzen: ${String(result.rollbackError ?? 'neznámý důvod').slice(0, 300)}; spojení je zavřené]` : '';
      // skript, který skončil chybou, mohl běžet se zapisujícím loginem (vědomé povolení) – v auditu to musí být vidět
      const writableLogin = result.stage === 'run' && login?.writable ? { writableLogin: login.reasons } : {};
      throw fail(`Chyba SQL (${db} na ${rq.server}): ${result.error}${rb}`, { error: String(result.error).slice(0, 300), rolledBack: result.rolledBack ?? null, ...writableLogin });
    }
    // obrana pro případ jiné verze pomocníka: bez výsledku kontroly loginu, nebo se zapisujícím loginem bez povolení, se výsledek nevydá
    if (!login) throw new Error('Běh nevrátil výsledek kontroly oprávnění SQL loginu (ps\\Run-Query.ps1 je jiné verze než server); výsledek se nevydá.');
    if (login.writable && rq.allowWritableLogin !== true) {
      // tady už skript v transakci proběhl (pomocník ho neměl spustit) – říct to a uvést stav ROLLBACKu
      const state = `Pomocník skript přesto spustil; výsledek se nevydá (${result.rolledBack === true ? 'transakce vrácena, ROLLBACK' : 'ROLLBACK nepotvrzen, spojení je zavřené'}).`;
      throw fail(loginRefusedMessage(db, rq.server, login, state), { loginRefused: true, reasons: login.reasons, rolledBack: result.rolledBack ?? null });
    }
    const res = normalizeResult(result);
    const out = `${formatHeader({ db, server: rq.server, ms, notes: gate.notes }, result)}\n${formatSets(res, { maxChars: rq.maxChars })}`;
    log({ sets: res.sets.map((s) => s.total), rolledBack: result.rolledBack === true, ...(login.writable ? { writableLogin: login.reasons } : {}) });
    return { text: out, sets: res.sets.length };
  } catch (e) {
    log(e?.auditExtra ?? { error: String(e?.message ?? e).slice(0, 300) });
    throw e;
  }
}

/**
 * Jen kontrola oprávnění loginu na povolené DB (pohoda_status s probe=true) – žádný skript uživatele, žádná transakce.
 * Vrací { database, writable, reasons, otherDatabases, otherWritableDatabases }; názvy dalších databází nikdy. Zanechá jeden
 * auditní záznam (tool: login_probe) – i při vypnutém spouštění, kdy skončí chybou (pohoda_status ji ukáže v loginProbe.error).
 * @param {{run?: typeof runPowerShell, warn?: (line: string) => void}} [deps] jen pro testy
 */
export async function probeLogin(cfg, { database } = {}, { run = runPowerShell, warn = warnStderr } = {}) {
  const rq = cfg.runQuery;
  const t0 = Date.now();
  const db = String(database || rq.allowedDatabases?.[0] || '');
  const log = (extra) => audit(cfg, { tool: 'login_probe', db: db.slice(0, 128), ms: Date.now() - t0, ...extra });
  try {
    if (!rq.enabled) throw new Error('pohoda_run_query je vypnuté – kontrolu loginu nelze provést.');
    if (!rq.allowedDatabases.includes(db)) {
      throw fail(`Databáze „${db}“ není povolená. Povolené: ${rq.allowedDatabases.join(', ')}. Další DB se povolují jen v config.json (runQuery.allowedDatabases).`, { refused: ['Databáze není povolená.'] });
    }
    const result = await invokeHelper(rq, db, { probe: true }, run, warn);
    if (!result.ok) throw new Error(`Kontrola oprávnění SQL loginu selhala (${db} na ${rq.server}): ${result.error}`);
    if (!result.login) throw new Error('Běh nevrátil výsledek kontroly oprávnění SQL loginu (ps\\Run-Query.ps1 je jiné verze než server).');
    const out = { database: db, ...result.login };
    log({ writable: out.writable, reasons: out.reasons, otherDatabases: out.otherDatabases, otherWritableDatabases: out.otherWritableDatabases });
    return out;
  } catch (e) {
    log(e?.auditExtra ?? { error: String(e?.message ?? e).slice(0, 300) });
    throw e;
  }
}
