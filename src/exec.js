// Spouštění PowerShell pomocníků (kontrola dotazu, read-only běh). Nic z potomka nesmí na stdout serveru (JSON-RPC) – výstup se čte ze souboru.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectRoot, validateSqlServer } from './config.js';
import { checkSql } from './sqlgate.js';

const BOM = '﻿';

function runPowerShell(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`PowerShell neodpověděl do ${Math.round(timeoutMs / 1000)} s.`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pohoda-mcp-'));
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

/** Statická kontrola proti schématu (tools\Test-PohodaQuery.ps1 agenta). schema 'obecny' / undefined = bez -Firma. */
export async function checkQuery(cfg, sql, schema) {
  const checker = path.join(cfg.agentDir, 'tools', 'Test-PohodaQuery.ps1');
  if (!fs.existsSync(checker)) throw new Error(`Kontrola nenalezena: ${checker}`);
  const firma = schema && schema !== 'obecny' ? schema : '';
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

function audit(cfg, entry) {
  try {
    fs.mkdirSync(path.dirname(cfg.auditLog), { recursive: true });
    fs.appendFileSync(cfg.auditLog, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch { /* audit nesmí shodit dotaz */ }
}

const cell = (v) => (v === null ? 'NULL' : String(v).replace(/\|/g, '\\|').slice(0, 200));

function formatSets(rq, result, limits) {
  const parts = [];
  let chars = 0;
  let truncated = false;
  result.sets.forEach((s, i) => {
    const shown = s.rows.length;
    const head = `**Výsledek ${i + 1}** – ${s.total} řádků${s.total > shown ? ` (zobrazeno prvních ${shown})` : ''}`;
    const table = [`| ${s.cols.map(cell).join(' | ')} |`, `|${s.cols.map(() => '---').join('|')}|`, ...s.rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
    const block = `${head}\n\n${table}`;
    if (chars + block.length > limits.maxChars) { truncated = true; parts.push(`${head}\n\n_(tabulka vynechána – překročen limit ${limits.maxChars} znaků výstupu; zúži dotaz nebo agreguj)_`); }
    else { parts.push(block); chars += block.length; }
  });
  if (result.messages?.length) parts.push(`**Zprávy (PRINT):**\n${result.messages.slice(0, 20).join('\n')}`);
  if (!result.sets.length) parts.unshift('_Skript nevrátil žádný result set (použij SELECT, ne PRINT)._');
  return { text: parts.join('\n\n'), truncated };
}

/** Read-only běh na povolené DB: textová brána → PowerShell pomocník (transakce + ROLLBACK, ApplicationIntent=ReadOnly). */
export async function runQuery(cfg, { sql, database, maxRows }) {
  const rq = cfg.runQuery;
  if (!rq.enabled) throw new Error('pohoda_run_query je vypnuté (config.json: runQuery.enabled = false).');
  const db = database || rq.allowedDatabases[0];
  if (!rq.allowedDatabases.includes(db)) {
    throw new Error(`Databáze „${db}“ není povolená. Povolené: ${rq.allowedDatabases.join(', ')}. Další DB se povolují jen v config.json (runQuery.allowedDatabases).`);
  }
  const gate = checkSql(sql);
  const sha = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 12);
  if (!gate.ok) {
    audit(cfg, { tool: 'run_query', db, sha, sql, refused: gate.errors });
    throw new Error(`Dotaz odmítnut kontrolou textu:\n- ${gate.errors.join('\n- ')}\nPovolené: SELECT (i SELECT INTO #tmp), CREATE/INSERT/UPDATE/DELETE/DROP jen nad #dočasnými tabulkami, DECLARE, WHILE, více result setů.`);
  }
  const badServer = validateSqlServer(rq.server);
  if (badServer) throw new Error(`${badServer} Nastav POHODA_SQL_SERVER nebo runQuery.server v config.json.`);
  if (!fs.existsSync(rq.credentialFile)) {
    throw new Error(`Soubor s přihlášením k SQL nenalezen: ${rq.credentialFile}. Vytvoř ho v PowerShellu: Get-Credential | Export-Clixml <cesta> (read-only SQL login) a cestu nastav proměnnou POHODA_CREDENTIAL_FILE nebo runQuery.credentialFile v config.json.`);
  }
  const perSet = Math.min(Math.max(maxRows ?? rq.maxRowsPerSet, 1), rq.maxRowsHard);
  const t0 = Date.now();
  return withTemp(async (dir) => {
    const sqlFile = path.join(dir, 'dotaz.sql');
    const outFile = path.join(dir, 'vysledek.json');
    fs.writeFileSync(sqlFile, BOM + gate.sql, 'utf8');
    const args = [
      path.join(projectRoot, 'ps', 'Run-Query.ps1'), '-SqlFile', sqlFile, '-Database', db, '-OutFile', outFile,
      '-CredentialFile', rq.credentialFile, '-Server', rq.server, '-MaxRowsPerSet', String(perSet), '-TimeoutSec', String(rq.timeoutSec),
    ];
    const r = await runPowerShell(args, (rq.timeoutSec + 30) * 1000);
    if (!fs.existsSync(outFile)) throw new Error(`Běh nevrátil výsledek (exit ${r.code}). ${r.stderr}`.trim());
    const res = readJsonFile(outFile);
    const ms = Date.now() - t0;
    if (!res.ok) {
      audit(cfg, { tool: 'run_query', db, sha, sql, ms, error: String(res.error).slice(0, 300) });
      throw new Error(`Chyba SQL (${db} na ${rq.server}): ${res.error}`);
    }
    res.sets = (Array.isArray(res.sets) ? res.sets : [res.sets]).filter(Boolean).map((s) => ({ ...s, cols: [].concat(s.cols), rows: [].concat(s.rows).map((row) => [].concat(row)) }));
    // ConvertTo-Json z PS 5.1 zplošťuje jednoprvková pole – řádek s jedním sloupcem a jednořádkový set je potřeba narovnat
    res.sets.forEach((s) => { if (s.cols.length === 1) s.rows = s.rows.map((row) => (Array.isArray(row) ? row : [row])); });
    audit(cfg, { tool: 'run_query', db, sha, sql, ms, sets: res.sets.map((s) => s.total) });
    const out = formatSets(rq, res, { maxChars: rq.maxChars });
    return { text: `Databáze: ${db} na ${rq.server} · ${ms} ms · transakce vrácena (ROLLBACK)\n${gate.notes.length ? `${gate.notes.join(' ')}\n` : ''}\n${out.text}`, sets: res.sets.length };
  });
}
