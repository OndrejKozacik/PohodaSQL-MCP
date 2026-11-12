// node --test test/exec.test.js  – čisté funkce z src/exec.js; PowerShell ani databáze se nespouští (běh nahrazuje falešný pomocník)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, cell, checkQuery, formatHeader, formatSets, normalizeLogin, normalizeResult, probeLogin, runQuery } from '../src/exec.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pohoda-mcp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return dir;
};
const readAudit = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('cell: NULL, escapování a zkrácení', () => {
  assert.equal(cell(null), 'NULL');
  assert.equal(cell(undefined), 'NULL');
  assert.equal(cell(0), '0');
  assert.equal(cell('a|b'), 'a\\|b');
  assert.equal(cell('a\r\nb\nc'), 'a b c');
  assert.equal(cell('x'.repeat(200)), 'x'.repeat(200));
  assert.equal(cell('x'.repeat(201)), `${'x'.repeat(200)}…`);
  // svislítko na hranici zkrácení: escape sekvence zůstane celá
  const edge = cell(`${'x'.repeat(199)}||`);
  assert.equal(edge, `${'x'.repeat(199)}\\|…`);
  assert.ok(!/\\(…|$)/.test(cell(`${'|'.repeat(300)}`)));
  assert.equal(cell('|'.repeat(300)), `${'\\|'.repeat(200)}…`);
  // znak mimo BMP se nepůlí
  assert.equal(cell(`${'x'.repeat(199)}😀y`), `${'x'.repeat(199)}…`);
});

test('normalizeResult: tvary JSON z PS 5.1', () => {
  // přesně to, co vrací ps\Run-Query.ps1 (ověřeno v PS 5.1) pro 0×0, 0×2, 1×1, 1×3, 3×1
  assert.deepEqual(normalizeResult({ ok: true, sets: [], messages: [] }), { sets: [], messages: [] });
  assert.deepEqual(normalizeResult({ sets: [{ cols: ['a', 'b'], rows: [], total: 0 }], messages: [] }).sets, [{ cols: ['a', 'b'], rows: [], total: 0 }]);
  assert.deepEqual(normalizeResult({ sets: [{ cols: ['a'], rows: [['0.50']], total: 1 }] }).sets, [{ cols: ['a'], rows: [['0.50']], total: 1 }]);
  assert.deepEqual(normalizeResult({ sets: [{ cols: ['a', 'b', 'c'], rows: [['1', null, '3']], total: 1 }] }).sets[0].rows, [['1', null, '3']]);
  assert.deepEqual(normalizeResult({ sets: [{ cols: ['a'], rows: [['1'], ['2'], ['3']], total: 5 }] }).sets[0], { cols: ['a'], rows: [['1'], ['2'], ['3']], total: 5 });
  // obrana: jednoprvková pole vrácená jako samotná hodnota
  assert.deepEqual(normalizeResult({ sets: { cols: 'a', rows: ['1', '2'], total: 2 }, messages: 'ahoj' }), { sets: [{ cols: ['a'], rows: [['1'], ['2']], total: 2 }], messages: ['ahoj'] });
  assert.deepEqual(normalizeResult({ sets: [{ cols: ['a'], rows: [[null]] }] }).sets[0], { cols: ['a'], rows: [[null]], total: 1 });
  assert.deepEqual(normalizeResult({}), { sets: [], messages: [] });
  assert.deepEqual(normalizeResult(null), { sets: [], messages: [] });
});

test('formatSets: tabulky, NULL, počet řádků', () => {
  const out = formatSets({ sets: [{ cols: ['a', 'b|c'], rows: [['1', null], ['x|y', '2']], total: 5 }], messages: [] }, { maxChars: 10_000 });
  assert.equal(typeof out, 'string');
  assert.equal(out, '**Výsledek 1** – 5 řádků (zobrazeno prvních 2)\n\n| a | b\\|c |\n|---|---|\n| 1 | NULL |\n| x\\|y | 2 |');
  assert.match(formatSets({ sets: [{ cols: ['a'], rows: [['1']], total: 1 }] }, { maxChars: 10_000 }), /^\*\*Výsledek 1\*\* – 1 řádků\n\n\| a \|\n\|---\|\n\| 1 \|$/);
  assert.match(formatSets({ sets: [{ cols: ['a'], rows: [], total: 0 }] }, { maxChars: 10_000 }), /0 řádků\n\n\| a \|\n\|---\|$/);
  assert.match(formatSets({ sets: [], messages: ['hotovo'] }, { maxChars: 10_000 }), /^_Skript nevrátil žádný result set.*\n\n\*\*Zprávy \(PRINT\):\*\*\nhotovo$/);
});

test('formatSets: limit znaků – zobrazí se tolik řádků, kolik se vejde', () => {
  const rows = Array.from({ length: 500 }, (_, i) => [String(i), 'x'.repeat(40)]);
  const maxChars = 3000;
  const out = formatSets({ sets: [{ cols: ['i', 't'], rows, total: 500 }, { cols: ['z'], rows: [['1']], total: 1 }], messages: [] }, { maxChars });
  const shown = Number(/zobrazeno prvních (\d+) – víc se nevejde do limitu 3000 znaků/.exec(out)?.[1]);
  assert.ok(shown > 20 && shown < 500, `zobrazeno ${shown}`);
  assert.equal(out.split('\n').filter((l) => l.endsWith(`${'x'.repeat(40)} |`)).length, shown);
  assert.match(out, /\*\*Výsledek 2\*\* – 1 řádků _\(tabulka vynechána\)_\n\n_Vynechané tabulky \(1\) se nevešly do limitu 3000 znaků/);
  assert.ok(out.length <= maxChars + 400, `délka ${out.length}`);
  // i mnoho velkých setů zůstane u limitu
  const many = formatSets({ sets: Array.from({ length: 50 }, () => ({ cols: ['i', 't'], rows, total: 500 })), messages: Array.from({ length: 30 }, () => 'm'.repeat(2000)) }, { maxChars });
  assert.ok(many.length <= maxChars + 4000, `délka ${many.length}`);
  assert.match(many, /Vynechané tabulky \(49\)/);
  // řádek širší než limit: žádný řádek, ale hlavička s vysvětlením
  const wide = formatSets({ sets: [{ cols: ['a'], rows: [['y'.repeat(150)], ['2']], total: 2 }] }, { maxChars: 300 });
  assert.match(wide, /zobrazeno prvních 0 – víc se nevejde/);
  // hlavička širší než limit: tabulka se vynechá
  const cols = Array.from({ length: 400 }, (_, i) => `sloupec${i}`);
  assert.match(formatSets({ sets: [{ cols, rows: [cols], total: 1 }] }, { maxChars: 1000 }), /tabulka vynechána/);
});

test('formatSets: nejvýš 50 result setů a 20 zpráv', () => {
  const sets = Array.from({ length: 53 }, (_, i) => ({ cols: ['a'], rows: [[String(i)]], total: 1 }));
  const messages = Array.from({ length: 25 }, (_, i) => `zpráva ${i}`);
  const out = formatSets({ sets, messages }, { maxChars: 60_000 });
  assert.match(out, /\*\*Výsledek 50\*\*/);
  assert.doesNotMatch(out, /\*\*Výsledek 51\*\*/);
  assert.match(out, /_\+3 dalších result setů nezobrazeno/);
  assert.match(out, /zpráva 19\n_\+5 dalších zpráv_$/);
  assert.doesNotMatch(out, /zpráva 20/);
  const long = formatSets({ sets: [], messages: ['m'.repeat(900)] }, { maxChars: 60_000 });
  assert.ok(long.endsWith(`${'m'.repeat(500)}…`));
});

test('formatHeader: ROLLBACK jen když ho pomocník potvrdil', () => {
  const ctx = { db: 'StwPh_12345678_2026', server: '127.0.0.1,1433', ms: 12, notes: [] };
  assert.equal(formatHeader(ctx, { rolledBack: true }), 'Databáze: StwPh_12345678_2026 na 127.0.0.1,1433 · 12 ms · transakce vrácena (ROLLBACK)\n');
  for (const res of [{ rolledBack: false, rollbackError: 'spojení přerušeno' }, { rolledBack: null }, {}, { rolledBack: 'true' }]) {
    const h = formatHeader(ctx, res);
    assert.doesNotMatch(h, /transakce vrácena \(ROLLBACK\)/);
    assert.match(h, /\*\*POZOR: vrácení transakce \(ROLLBACK\) se nepodařilo potvrdit\*\*/);
  }
  assert.match(formatHeader(ctx, { rolledBack: false, rollbackError: 'spojení přerušeno' }), /spojení přerušeno/);
  assert.match(formatHeader({ ...ctx, notes: ['Poznámka.'] }, { rolledBack: true }), /\(ROLLBACK\)\nPoznámka\.\n$/);
});

test('audit: oříznutí SQL a rotace souboru', (t) => {
  const dir = tmp(t);
  const cfg = { auditLog: path.join(dir, 'log', 'dotazy.jsonl') };
  audit(cfg, { tool: 'run_query', sql: 'SELECT 1' });
  audit(cfg, { tool: 'run_query', sql: 'x'.repeat(25_000), sha: 'abc' });
  let rec = readAudit(cfg.auditLog);
  assert.equal(rec.length, 2);
  assert.equal(rec[0].sql, 'SELECT 1');
  assert.equal(rec[0].sqlLen, undefined);
  assert.ok(!Number.isNaN(Date.parse(rec[0].ts)));
  assert.equal(rec[1].sql.length, 20_000);
  assert.equal(rec[1].sqlLen, 25_000);
  // rotace: nad 5 MB se soubor přejmenuje na .1 a starší .1 se přepíše
  fs.writeFileSync(`${cfg.auditLog}.1`, 'stary\n');
  fs.writeFileSync(cfg.auditLog, `${'a'.repeat(5 * 1024 * 1024 + 10)}\n`);
  audit(cfg, { tool: 'run_query', sql: 'SELECT 2' });
  rec = readAudit(cfg.auditLog);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].sql, 'SELECT 2');
  assert.ok(fs.statSync(`${cfg.auditLog}.1`).size > 5 * 1024 * 1024);
  // audit nikdy nevyhodí výjimku
  assert.doesNotThrow(() => audit({ auditLog: path.join(dir, 'log', 'dotazy.jsonl', 'nelze', 'x.jsonl') }, { sql: 'SELECT 3' }));
});

const makeCfg = (dir, over = {}) => {
  const credentialFile = path.join(dir, 'prihlaseni.txt'); // jen aby soubor existoval; falešný pomocník ho nečte
  fs.writeFileSync(credentialFile, '');
  return {
    auditLog: path.join(dir, 'dotazy.jsonl'),
    agentDir: dir,
    runQuery: { enabled: true, allowedDatabases: ['StwPh_12345678_2026'], server: '127.0.0.1,1433', credentialFile, maxRowsPerSet: 200, maxRowsHard: 2000, maxChars: 60_000, timeoutSec: 60, ...over },
  };
};
// výsledek kontroly loginu tak, jak ho vrací ps\Run-Query.ps1 pro login jen s db_datareader
const READER = { writable: false, reasons: [], otherDatabases: 0, otherWritableDatabases: 0, otherDatabaseNames: [], otherWritableDatabaseNames: [] };
// falešný pomocník: zapíše obsah do -OutFile (nebo nic)
const fakeRun = (content, calls = []) => async (args) => {
  calls.push(args);
  if (content !== undefined) fs.writeFileSync(args[args.indexOf('-OutFile') + 1], typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return { code: content === undefined ? 1 : 0, stderr: content === undefined ? 'spadlo to' : '' };
};

test('runQuery: úspěch – jeden auditní záznam, hlavička podle rolledBack', async (t) => {
  const dir = tmp(t);
  const cfg = makeCfg(dir);
  const calls = [];
  const okRes = { ok: true, sets: [{ cols: ['a'], rows: [['1']], total: 1 }], messages: [], rolledBack: true, rollbackError: null, login: READER };
  const r = await runQuery(cfg, { sql: 'USE x;\nSELECT 1 AS a' }, { run: fakeRun(okRes, calls) });
  assert.equal(r.sets, 1);
  assert.match(r.text, /^Databáze: StwPh_12345678_2026 na 127\.0\.0\.1,1433 · \d+ ms · transakce vrácena \(ROLLBACK\)\nPříkazy `USE \.\.\.` byly odstraněny/);
  assert.match(r.text, /\| a \|\n\|---\|\n\| 1 \|$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('-Database') + 1], 'StwPh_12345678_2026');
  let rec = readAudit(cfg.auditLog);
  assert.equal(rec.length, 1);
  assert.deepEqual(rec[0].sets, [1]);
  assert.equal(rec[0].rolledBack, true);
  assert.equal(rec[0].sql, 'USE x;\nSELECT 1 AS a');
  assert.match(rec[0].sha, /^[0-9a-f]{12}$/);

  const r2 = await runQuery(cfg, { sql: 'SELECT 1 AS a' }, { run: fakeRun({ ...okRes, rolledBack: false, rollbackError: 'transakce už neexistuje' }) });
  assert.doesNotMatch(r2.text, /transakce vrácena \(ROLLBACK\)/);
  assert.match(r2.text, /POZOR: vrácení transakce \(ROLLBACK\) se nepodařilo potvrdit\*\* – transakce už neexistuje/);
  rec = readAudit(cfg.auditLog);
  assert.equal(rec.length, 2);
  assert.equal(rec[1].rolledBack, false);
});

test('runQuery: audit na všech chybových cestách', async (t) => {
  const dir = tmp(t);
  const cfg = makeCfg(dir);
  const last = () => readAudit(cfg.auditLog).at(-1);
  const count = () => (fs.existsSync(cfg.auditLog) ? readAudit(cfg.auditLog).length : 0);
  const neverRun = async () => { throw new Error('pomocník se neměl spustit'); };
  let n = 0;
  const once = () => assert.equal(count(), ++n, 'právě jeden nový auditní záznam');

  // nepovolená databáze
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1', database: 'StwPh_87654321' }, { run: neverRun }), /není povolená/);
  once();
  assert.equal(last().db, 'StwPh_87654321');
  assert.deepEqual(last().refused, ['Databáze není povolená.']);

  // odmítnutí bránou
  await assert.rejects(runQuery(cfg, { sql: 'DELETE FROM dbo.FA' }, { run: neverRun }), /Dotaz odmítnut kontrolou textu/);
  once();
  assert.match(last().refused[0], /DELETE do trvalé tabulky/);

  // vypnutý nástroj
  await assert.rejects(runQuery(makeCfg(dir, { enabled: false }), { sql: 'SELECT 1' }, { run: neverRun }), /vypnuté/);
  once();
  assert.match(last().error, /vypnuté/);

  // chybí soubor s přihlášením
  await assert.rejects(runQuery(makeCfg(dir, { credentialFile: path.join(dir, 'neni.txt') }), { sql: 'SELECT 1' }, { run: neverRun }), /nenalezen/);
  fs.writeFileSync(path.join(dir, 'prihlaseni.txt'), '');
  once();

  // timeout / chyba spuštění
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1' }, { run: async () => { throw new Error('PowerShell neodpověděl do 90 s (proces byl ukončen).'); } }), /neodpověděl/);
  once();
  assert.match(last().error, /neodpověděl do 90 s/);

  // pád pomocníka – výstupní soubor chybí
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1' }, { run: fakeRun(undefined) }), /Běh nevrátil výsledek \(exit 1\)\. spadlo to/);
  once();
  assert.match(last().error, /Běh nevrátil výsledek/);

  // nevalidní JSON
  // text výjimky z JSON.parse (na starších Node s úryvkem vstupu) se nevrací modelu ani do auditu – jen pevná zpráva
  const badJson = '{"ok":true,"sets":[{"cols":["Firma"],"rows":[["TAJNY_UDAJ_Z_DAT"]]}],"x":tr';
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1' }, { run: fakeRun(badJson) }), (e) => e.message === 'Běh vrátil neplatný JSON: výstup pomocníka nejde přečíst.');
  once();
  assert.equal(last().error, 'Běh vrátil neplatný JSON: výstup pomocníka nejde přečíst.');
  assert.ok(!fs.readFileSync(cfg.auditLog, 'utf8').includes('TAJNY_UDAJ_Z_DAT'));
  // starý ps\\Run-Query.ps1 + nový server: PowerShell odmítne neznámý parametr, výstupní soubor nevznikne
  for (const stderr of [
    "Run-Query.ps1 : A parameter cannot be found that matches parameter name 'AllowedDatabases'.",
    'Run-Query.ps1 : Nelze najít parametr odpovídající názvu parametru AllowedDatabases.',
    "A parameter cannot be found that matches parameter name 'Probe'.",
  ]) {
    await assert.rejects(runQuery(cfg, { sql: 'SELECT 1' }, { run: async () => ({ code: 1, stderr }) }), (e) => e.message === 'Běh nevrátil výsledek (exit 1): ps\\Run-Query.ps1 je jiné verze než server – sestav a nainstaluj balíček znovu.', stderr);
    once();
    assert.match(last().error, /jiné verze než server – sestav a nainstaluj balíček znovu\./);
  }
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1' }, { run: fakeRun('null') }), /neplatný JSON/);
  once();

  // chyba SQL
  const sqlErr = { ok: false, error: 'Dávka 1/1, řádek 3: Invalid column name', rolledBack: true, rollbackError: null };
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1' }, { run: fakeRun(sqlErr) }), (e) => /Chyba SQL \(StwPh_12345678_2026 na 127\.0\.0\.1,1433\): Dávka 1\/1, řádek 3/.test(e.message) && !/ROLLBACK nepotvrzen/.test(e.message));
  once();
  assert.equal(last().error, 'Dávka 1/1, řádek 3: Invalid column name');
  assert.equal(last().rolledBack, true);
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1' }, { run: fakeRun({ ...sqlErr, rolledBack: false, rollbackError: 'zombie' }) }), /\[ROLLBACK nepotvrzen: zombie; spojení je zavřené\]/);
  once();
  assert.equal(last().rolledBack, false);

  // dlouhé SQL: v auditu oříznuté, hash z celého textu
  const longSql = `SELECT 1 /* ${'x'.repeat(30_000)} */`;
  await runQuery(cfg, { sql: longSql }, { run: fakeRun({ ok: true, sets: [], messages: [], rolledBack: true, login: READER }) });
  once();
  assert.equal(last().sql.length, 20_000);
  assert.equal(last().sqlLen, longSql.length);
  const { createHash } = await import('node:crypto');
  assert.equal(last().sha, createHash('sha256').update(longSql).digest('hex').slice(0, 12));
});

test('runQuery: SQL se pomocníkovi předá s BOM a dočasná složka se uklidí', async (t) => {
  const dir = tmp(t);
  const cfg = makeCfg(dir);
  let tempDir;
  const run = async (args) => {
    const out = args[args.indexOf('-OutFile') + 1];
    tempDir = path.dirname(out);
    assert.equal(fs.readFileSync(args[args.indexOf('-SqlFile') + 1], 'utf8'), '﻿SELECT 1'); // BOM kvůli PS 5.1
    fs.writeFileSync(out, JSON.stringify({ ok: true, sets: [], messages: [], rolledBack: true, login: READER }));
    return { code: 0, stderr: '' };
  };
  await runQuery(cfg, { sql: 'SELECT 1' }, { run });
  assert.equal(fs.existsSync(tempDir), false);
});

// ===== kontrola oprávnění SQL loginu (preflight) =====
const OTHER_NAMES = ['TajnaDb_A', 'TajnaDb_B'];
const WRITER = { writable: true, reasons: ['db_datawriter', 'perm_INSERT'], otherDatabases: 2, otherWritableDatabases: 1, otherDatabaseNames: OTHER_NAMES, otherWritableDatabaseNames: ['TajnaDb_B'] };
const OK_SET = { ok: true, sets: [{ cols: ['a'], rows: [['1']], total: 1 }], messages: [], rolledBack: true, rollbackError: null };
const noNames = (s, label) => { for (const n of OTHER_NAMES) assert.ok(!String(s).includes(n), `${label}: obsahuje název jiné databáze`); };

test('normalizeLogin: kódy důvodů česky, názvy databází zvlášť, poškozený výsledek = null', () => {
  assert.deepEqual(normalizeLogin(READER), { login: { writable: false, reasons: [], otherDatabases: 0, otherWritableDatabases: 0 }, names: [], writableNames: [] });
  assert.deepEqual(normalizeLogin(WRITER), { login: { writable: true, reasons: ['člen role db_datawriter', 'oprávnění INSERT v databázi'], otherDatabases: 2, otherWritableDatabases: 1 }, names: OTHER_NAMES, writableNames: ['TajnaDb_B'] });
  const all = normalizeLogin({ writable: true, reasons: ['sysadmin', 'control_server', 'db_owner', 'db_ddladmin', 'perm_UPDATE', 'perm_DELETE', 'perm_ALTER', 'perm_CONTROL'] }).login;
  assert.deepEqual(all.reasons, ['člen serverové role sysadmin', 'oprávnění CONTROL SERVER', 'člen role db_owner', 'člen role db_ddladmin', 'oprávnění UPDATE v databázi', 'oprávnění DELETE v databázi', 'oprávnění ALTER v databázi', 'oprávnění CONTROL v databázi']);
  assert.equal(all.otherDatabases, null);
  // PS může jednoprvkové pole vrátit jako samotnou hodnotu; neznámý kód se vypíše bezpečně
  assert.deepEqual(normalizeLogin({ writable: true, reasons: 'db_owner', otherDatabases: 1, otherWritableDatabases: 1, otherDatabaseNames: 'X', otherWritableDatabaseNames: 'X' }), { login: { writable: true, reasons: ['člen role db_owner'], otherDatabases: 1, otherWritableDatabases: 1 }, names: ['X'], writableNames: ['X'] });
  // starší pomocník bez počtu zapisovatelných databází: null (nezjištěno), ne 0
  assert.equal(normalizeLogin({ writable: false, otherDatabases: 2 }).login.otherWritableDatabases, null);
  assert.equal(normalizeLogin({ writable: false, otherDatabases: 2, otherWritableDatabases: '1' }).login.otherWritableDatabases, null);
  assert.deepEqual(normalizeLogin({ writable: true, reasons: ['novy|kod\n'] }).login.reasons, ['důvod „novy?kod?“']);
  // rozpor (důvody bez writable, writable bez důvodů) se bere jako zapisující login
  assert.equal(normalizeLogin({ writable: false, reasons: ['db_owner'] }).login.writable, true);
  assert.deepEqual(normalizeLogin({ writable: true, reasons: [] }).login.reasons, ['důvod pomocník neuvedl']);
  assert.equal(normalizeLogin({ writable: false, otherDatabases: null }).login.otherDatabases, null);
  assert.equal(normalizeLogin({ writable: false, otherDatabases: '3' }).login.otherDatabases, null);
  for (const bad of [undefined, null, 'x', 1, [], {}, { writable: 0 }, { writable: 'false' }, { reasons: [] }]) assert.equal(normalizeLogin(bad), null, JSON.stringify(bad));
});

test('formatHeader: varování, když login smí zapisovat', () => {
  const ctx = { db: 'StwPh_12345678_2026', server: '127.0.0.1,1433', ms: 12, notes: ['Poznámka.'] };
  const login = { writable: true, reasons: ['člen role db_datawriter', 'oprávnění INSERT v databázi'], otherDatabases: 0 };
  assert.equal(
    formatHeader(ctx, { rolledBack: true, login }),
    'Databáze: StwPh_12345678_2026 na 127.0.0.1,1433 · 12 ms · transakce vrácena (ROLLBACK)\n**POZOR: login smí zapisovat (člen role db_datawriter, oprávnění INSERT v databázi); ochranou zůstává jen textová brána a ROLLBACK.**\nPoznámka.\n',
  );
  assert.doesNotMatch(formatHeader(ctx, { rolledBack: true, login: { writable: false, reasons: [], otherDatabases: 5 } }), /POZOR/);
});

test('runQuery: login, který smí zapisovat, se odmítne – chyba s důvody, audit, žádné názvy jiných databází', async (t) => {
  const dir = tmp(t);
  const cfg = makeCfg(dir, { server: 'srv-odmitnuti', allowedDatabases: ['StwPh_12345678_2026', 'DbB'] });
  const calls = [];
  const warned = [];
  const refused = { ok: false, loginRefused: true, login: WRITER, rolledBack: null, rollbackError: null };
  let err;
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1 AS a' }, { run: fakeRun(refused, calls), warn: (l) => warned.push(l) }), (e) => { err = e; return true; });
  assert.match(err.message, /^Běh odmítnut: SQL login smí zapisovat \(StwPh_12345678_2026 na srv-odmitnuti\) – člen role db_datawriter, oprávnění INSERT v databázi\. Skript se nespustil\./);
  assert.match(err.message, /db_datareader/);
  assert.match(err.message, /runQuery\.allowWritableLogin = true/);
  assert.match(err.message, /POHODA_ALLOW_WRITABLE_LOGIN=1/);
  assert.doesNotMatch(err.message, /Chyba SQL|undefined/);
  noNames(err.message, 'chyba');
  // pomocník dostal seznam povolených databází a NEdostal povolení zapisujícího loginu
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('-AllowedDatabases') + 1], 'StwPh_12345678_2026;DbB');
  assert.ok(!calls[0].includes('-AllowWritableLogin'));
  assert.ok(!calls[0].includes('-Probe'));
  const rec = readAudit(cfg.auditLog);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].loginRefused, true);
  assert.deepEqual(rec[0].reasons, ['člen role db_datawriter', 'oprávnění INSERT v databázi']);
  assert.equal(rec[0].sets, undefined);
  noNames(fs.readFileSync(cfg.auditLog, 'utf8'), 'audit');
  // názvy šly jen na stderr serveru
  assert.equal(warned.length, 1);
  for (const n of OTHER_NAMES) assert.ok(warned[0].includes(n));

  // obrana: kdyby pomocník skript přesto spustil (ok: true), výsledek se nevydá
  await assert.rejects(
    runQuery(cfg, { sql: 'SELECT 1 AS a' }, { run: fakeRun({ ...OK_SET, login: WRITER }), warn: () => {} }),
    (e) => /Běh odmítnut: SQL login smí zapisovat .*Pomocník skript přesto spustil; výsledek se nevydá \(transakce vrácena, ROLLBACK\)\./.test(e.message) && !/Skript se nespustil/.test(e.message) && !/\| a \|/.test(e.message),
  );
  assert.equal(readAudit(cfg.auditLog).at(-1).loginRefused, true);
  // … a stejně tak výsledek bez kontroly loginu nebo s poškozenou kontrolou
  for (const login of [undefined, null, { writable: 'false' }, 'x']) {
    await assert.rejects(runQuery(cfg, { sql: 'SELECT 1 AS a' }, { run: fakeRun({ ...OK_SET, login }), warn: () => {} }), /nevrátil výsledek kontroly oprávnění SQL loginu/, JSON.stringify(login));
  }
  // odmítnutí bez podrobností
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1 AS a' }, { run: fakeRun({ ok: false, loginRefused: true }), warn: () => {} }), /SQL login smí zapisovat .* – důvod pomocník neuvedl\./);
  assert.equal(readAudit(cfg.auditLog).length, 7);
});

test('runQuery: allowWritableLogin – běh proběhne s varováním v hlavičce', async (t) => {
  const dir = tmp(t);
  const cfg = makeCfg(dir, { server: 'srv-povoleno', allowWritableLogin: true });
  const calls = [];
  const r = await runQuery(cfg, { sql: 'SELECT 1 AS a' }, { run: fakeRun({ ...OK_SET, login: WRITER }, calls), warn: () => {} });
  assert.ok(calls[0].includes('-AllowWritableLogin'));
  assert.match(r.text, /^Databáze: StwPh_12345678_2026 na srv-povoleno · \d+ ms · transakce vrácena \(ROLLBACK\)\n\*\*POZOR: login smí zapisovat \(člen role db_datawriter, oprávnění INSERT v databázi\); ochranou zůstává jen textová brána a ROLLBACK\.\*\*\n/);
  assert.match(r.text, /\| a \|\n\|---\|\n\| 1 \|$/);
  noNames(r.text, 'výstup');
  const rec = readAudit(cfg.auditLog);
  assert.equal(rec.length, 1);
  assert.deepEqual(rec[0].writableLogin, ['člen role db_datawriter', 'oprávnění INSERT v databázi']);
  assert.equal(rec[0].loginRefused, undefined);
  noNames(fs.readFileSync(cfg.auditLog, 'utf8'), 'audit');
  // login jen pro čtení: bez varování a bez záznamu writableLogin, i když je přepsání povolené
  const ro = await runQuery(cfg, { sql: 'SELECT 1 AS a' }, { run: fakeRun({ ...OK_SET, login: READER }), warn: () => {} });
  assert.doesNotMatch(ro.text, /POZOR/);
  assert.equal(readAudit(cfg.auditLog).at(-1).writableLogin, undefined);
  // jen výslovné true povoluje
  for (const allowWritableLogin of [undefined, false, 'true', 1]) {
    const c = makeCfg(dir, { server: 'srv-povoleno', allowWritableLogin });
    const args = [];
    await assert.rejects(runQuery(c, { sql: 'SELECT 1 AS a' }, { run: fakeRun({ ...OK_SET, login: WRITER }, args), warn: () => {} }), /Běh odmítnut/, String(allowWritableLogin));
    assert.ok(!args[0].includes('-AllowWritableLogin'), String(allowWritableLogin));
  }
});

test('runQuery: jiné dostupné databáze běh neblokují, do výstupu se nedostanou, na stderr jen při změně sady názvů', async (t) => {
  const dir = tmp(t);
  const cfg = makeCfg(dir, { server: 'srv-jine-db' });
  const warned = [];
  const warn = (l) => warned.push(l);
  const go = (login) => runQuery(cfg, { sql: 'SELECT 1 AS a' }, { run: fakeRun({ ...OK_SET, login }), warn });
  const visible = (n, names) => ({ writable: false, reasons: [], otherDatabases: n, otherDatabaseNames: names });

  // žádné jiné databáze: nic se nehlásí
  let r = await go(READER);
  assert.equal(warned.length, 0);
  // dvě jiné databáze: běh projde, hlavička se nemění, názvy jen na stderr
  r = await go(visible(2, OTHER_NAMES));
  assert.match(r.text, /^Databáze: StwPh_12345678_2026 na srv-jine-db · \d+ ms · transakce vrácena \(ROLLBACK\)\n\n\*\*Výsledek 1\*\*/);
  noNames(r.text, 'výstup');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /^\[pohoda-mcp\] UPOZORNĚNÍ – SQL login se kromě povolených databází dostane do dalších 2 \(zjištěno z StwPh_12345678_2026\): TajnaDb_A, TajnaDb_B\./);
  assert.doesNotMatch(warned[0], /POZOR:/);
  // stejná sada znovu: ticho
  await go(visible(2, OTHER_NAMES));
  await go(visible(2, OTHER_NAMES));
  assert.equal(warned.length, 1);
  // počet nezjištěn (null): ticho a poslední stav zůstává
  await go({ writable: false, reasons: [], otherDatabases: null, otherDatabaseNames: [] });
  await go(visible(2, OTHER_NAMES));
  assert.equal(warned.length, 1);
  // změna počtu: nový řádek
  await go(visible(3, [...OTHER_NAMES, 'TajnaDb_C']));
  assert.equal(warned.length, 2);
  assert.match(warned[1], /dalších 3 .*TajnaDb_C/);
  // stejný počet, jiná sada názvů (jedna databáze ubyla, jiná přibyla): nový řádek
  await go(visible(3, ['TajnaDb_A', 'TajnaDb_C', 'TajnaDb_D']));
  assert.equal(warned.length, 3);
  assert.match(warned[2], /dalších 3 .*TajnaDb_A, TajnaDb_C, TajnaDb_D\./);
  await go(visible(3, ['TajnaDb_A', 'TajnaDb_C', 'TajnaDb_D']));
  assert.equal(warned.length, 3);
  // stejná sada, ale v jedné z nich login nově smí zapisovat: nový řádek s názvem; do výstupu ani auditu názvy nejdou
  const writableElsewhere = { ...visible(3, ['TajnaDb_A', 'TajnaDb_C', 'TajnaDb_D']), otherWritableDatabases: 1, otherWritableDatabaseNames: ['TajnaDb_D'] };
  r = await go(writableElsewhere);
  assert.equal(warned.length, 4);
  assert.match(warned[3], /POZOR: v 1 z nich má login oprávnění zapisovat: TajnaDb_D\./);
  assert.doesNotMatch(r.text, /TajnaDb|POZOR/); // informativní: běh se neblokuje a hlavička se nemění
  await go(writableElsewhere);
  assert.equal(warned.length, 4);
  await go(READER);
  assert.equal(warned.length, 5);
  assert.match(warned[4], /už nedostane do žádné databáze mimo povolené/);
  // audit nikdy neobsahuje názvy
  const log = fs.readFileSync(cfg.auditLog, 'utf8');
  noNames(log, 'audit');
  assert.ok(!log.includes('TajnaDb_C'));
  assert.ok(!log.includes('TajnaDb_D'));
});

test('runQuery: selhání kontroly loginu – skript se nespustil, srozumitelná chyba', async (t) => {
  const dir = tmp(t);
  const cfg = makeCfg(dir, { server: 'srv-preflight' });
  const res = { ok: false, error: 'The server principal is not able to access the database', stage: 'preflight', rolledBack: null, rollbackError: null };
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1' }, { run: fakeRun(res) }), /Error: Kontrola oprávnění SQL loginu selhala \(StwPh_12345678_2026 na srv-preflight\): The server principal.*Skript se nespustil\.$/);
  const rec = readAudit(cfg.auditLog);
  assert.equal(rec.length, 1);
  assert.match(rec[0].error, /^Kontrola loginu: The server principal/);
  assert.equal(rec[0].rolledBack, null);
  // chyba připojení (stage connect) zůstává „Chyba SQL“
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1' }, { run: fakeRun({ ...res, stage: 'connect', error: 'Login failed' }) }), /Error: Chyba SQL \(.*\): Login failed$/);
});

test('probeLogin: jen kontrola loginu (-Probe), počet jiných databází bez názvů, audit', async (t) => {
  const dir = tmp(t);
  const cfg = makeCfg(dir, { server: 'srv-probe', allowedDatabases: ['StwPh_12345678_2026', 'DbB'] });
  const calls = [];
  const warned = [];
  const p = await probeLogin(cfg, {}, { run: fakeRun({ ok: true, probe: true, login: WRITER }, calls), warn: (l) => warned.push(l) });
  assert.deepEqual(p, { database: 'StwPh_12345678_2026', writable: true, reasons: ['člen role db_datawriter', 'oprávnění INSERT v databázi'], otherDatabases: 2, otherWritableDatabases: 1 });
  // jen počty: žádné další pole (názvy) se do výsledku nedostane
  assert.deepEqual(Object.keys(p).sort(), ['database', 'otherDatabases', 'otherWritableDatabases', 'reasons', 'writable']);
  noNames(JSON.stringify(p), 'loginProbe');
  assert.ok(calls[0].includes('-Probe'));
  assert.ok(!calls[0].includes('-SqlFile'));
  assert.ok(!calls[0].includes('-AllowWritableLogin'));
  assert.equal(calls[0][calls[0].indexOf('-AllowedDatabases') + 1], 'StwPh_12345678_2026;DbB');
  assert.equal(warned.length, 1);
  // stderr: názvy všech dalších databází a zvlášť těch, kde login smí zapisovat
  assert.match(warned[0], /dalších 2 \(zjištěno z StwPh_12345678_2026\): TajnaDb_A, TajnaDb_B\. POZOR: v 1 z nich má login oprávnění zapisovat: TajnaDb_B\. Doporučení/);
  let rec = readAudit(cfg.auditLog);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].tool, 'login_probe');
  assert.equal(rec[0].writable, true);
  assert.equal(rec[0].otherDatabases, 2);
  assert.equal(rec[0].otherWritableDatabases, 1);
  assert.equal(rec[0].sql, undefined);
  noNames(fs.readFileSync(cfg.auditLog, 'utf8'), 'audit');

  const p2 = await probeLogin(cfg, { database: 'DbB' }, { run: fakeRun({ ok: true, probe: true, login: READER }, calls), warn: () => {} });
  assert.deepEqual(p2, { database: 'DbB', writable: false, reasons: [], otherDatabases: 0, otherWritableDatabases: 0 });
  assert.equal(calls[1][calls[1].indexOf('-Database') + 1], 'DbB');

  const neverRun = async () => { throw new Error('pomocník se neměl spustit'); };
  await assert.rejects(probeLogin(cfg, { database: 'StwPh_87654321' }, { run: neverRun }), /není povolená/);
  // vypnuté spouštění: přesná hláška (pohoda_status ji vrací v loginProbe.error), pomocník se nespustí, auditní záznam vznikne
  await assert.rejects(probeLogin(makeCfg(dir, { enabled: false }), {}, { run: neverRun }), (e) => e.message === 'pohoda_run_query je vypnuté – kontrolu loginu nelze provést.');
  assert.equal(readAudit(cfg.auditLog).at(-1).error, 'pohoda_run_query je vypnuté – kontrolu loginu nelze provést.');
  await assert.rejects(probeLogin(cfg, {}, { run: fakeRun({ ok: false, error: 'Login failed', stage: 'connect' }) }), /Error: Kontrola oprávnění SQL loginu selhala \(StwPh_12345678_2026 na srv-probe\): Login failed$/);
  await assert.rejects(probeLogin(cfg, {}, { run: fakeRun({ ok: true, probe: true }) }), /nevrátil výsledek kontroly/);
  rec = readAudit(cfg.auditLog);
  assert.equal(rec.length, 6);
  assert.match(rec.at(-2).error, /Login failed/);
});

test('checkQuery: kontrola názvu schématu', async (t) => {
  const cfg = { agentDir: tmp(t) }; // kontrola v této složce není → platný název skončí chybou „Kontrola nenalezena“
  for (const s of ['firma-a; rm', 'a b', '..\\x', 'x'.repeat(41), 'firma"', "a'b", 'ž', '-Firma x', '$(x)']) {
    await assert.rejects(checkQuery(cfg, 'SELECT 1', s), /Neplatný název schématu/, s);
  }
  for (const s of [undefined, null, '', 'obecny', 'firma-a', 'sk-12345678', 'x'.repeat(40)]) {
    await assert.rejects(checkQuery(cfg, 'SELECT 1', s), /Kontrola nenalezena/, String(s));
  }
});

test('normalizeLogin: nové kódy důvodů (schéma, objekty, procedury, ostatní oprávnění) a nevyhodnotitelná kontrola', () => {
  const texts = {
    db_securityadmin: 'člen role db_securityadmin (smí měnit oprávnění)',
    db_accessadmin: 'člen role db_accessadmin (smí spravovat přístup do databáze)',
    perm_db_other: 'další oprávnění v databázi mimo čtení (např. EXECUTE nebo CREATE)',
    perm_server_other: 'další oprávnění na serveru mimo čtení',
    schema_write: 'oprávnění zápisu nebo EXECUTE na úrovni schématu',
    object_write: 'oprávnění zápisu (INSERT/UPDATE/DELETE/ALTER) k některé tabulce nebo pohledu',
    proc_execute: 'oprávnění EXECUTE k některé uložené proceduře',
    unknown: 'některou kontrolu oprávnění se nepodařilo vyhodnotit (bere se jako možnost zápisu)',
  };
  for (const [code, text] of Object.entries(texts)) {
    // každý kód sám o sobě znamená zapisující login – i kdyby pomocník poslal writable: false
    for (const writable of [true, false]) assert.deepEqual(normalizeLogin({ writable, reasons: [code] }).login, { writable: true, reasons: [text], otherDatabases: null, otherWritableDatabases: null }, code);
  }
  // všechny kódy, které pomocník umí vrátit najednou, se vejdou a žádný nezůstane bez českého textu
  const all = ['sysadmin', 'control_server', 'db_owner', 'db_datawriter', 'db_ddladmin', 'db_securityadmin', 'db_accessadmin', 'perm_INSERT', 'perm_UPDATE', 'perm_DELETE', 'perm_ALTER', 'perm_CONTROL', 'perm_db_other', 'perm_server_other', 'schema_write', 'object_write', 'proc_execute', 'unknown'];
  const r = normalizeLogin({ writable: true, reasons: all }).login.reasons;
  assert.equal(r.length, all.length);
  assert.ok(r.every((t) => !t.startsWith('důvod „')), r.join(' | '));
  // kódy v pomocníkovi a texty tady se nesmí rozejít
  const ps = fs.readFileSync(new URL('../ps/Run-Query.ps1', import.meta.url), 'utf8');
  const codes = [...new Set([...ps.matchAll(/@r \+ '(\w+);'/g)].map((m) => m[1]))];
  assert.deepEqual(codes.sort(), [...all].sort());
});

test('runQuery: nové důvody a nevyhodnotitelná kontrola (unknown) běh odmítnou (fail closed)', async (t) => {
  const dir = tmp(t);
  const cfg = makeCfg(dir, { server: 'srv-nove-duvody' });
  const cases = {
    unknown: /– některou kontrolu oprávnění se nepodařilo vyhodnotit \(bere se jako možnost zápisu\)\. Skript se nespustil\./,
    object_write: /– oprávnění zápisu \(INSERT\/UPDATE\/DELETE\/ALTER\) k některé tabulce nebo pohledu\. Skript se nespustil\./,
    schema_write: /– oprávnění zápisu nebo EXECUTE na úrovni schématu\./,
    proc_execute: /– oprávnění EXECUTE k některé uložené proceduře\./,
    perm_db_other: /– další oprávnění v databázi mimo čtení/,
    perm_server_other: /– další oprávnění na serveru mimo čtení\./,
    db_securityadmin: /– člen role db_securityadmin/,
    db_accessadmin: /– člen role db_accessadmin/,
  };
  for (const [code, re] of Object.entries(cases)) {
    const login = { writable: true, reasons: [code], otherDatabases: 0, otherWritableDatabases: 0, otherDatabaseNames: [], otherWritableDatabaseNames: [] };
    // pomocník odmítl sám
    await assert.rejects(runQuery(cfg, { sql: 'SELECT 1 AS a' }, { run: fakeRun({ ok: false, loginRefused: true, login, rolledBack: null }), warn: () => {} }), (e) => /^Běh odmítnut: SQL login smí zapisovat/.test(e.message) && re.test(e.message), code);
    assert.equal(readAudit(cfg.auditLog).at(-1).loginRefused, true, code);
    // pomocník (jiné verze) skript spustil a hlásí writable: false s důvodem → výsledek se stejně nevydá
    await assert.rejects(runQuery(cfg, { sql: 'SELECT 1 AS a' }, { run: fakeRun({ ...OK_SET, login: { ...login, writable: false } }), warn: () => {} }), (e) => /Pomocník skript přesto spustil; výsledek se nevydá/.test(e.message) && !/\| a \|/.test(e.message), code);
  }
  // probe ukáže totéž
  const p = await probeLogin(cfg, {}, { run: fakeRun({ ok: true, probe: true, login: { writable: true, reasons: ['unknown'], otherDatabases: null, otherWritableDatabases: null } }), warn: () => {} });
  assert.deepEqual(p, { database: 'StwPh_12345678_2026', writable: true, reasons: ['některou kontrolu oprávnění se nepodařilo vyhodnotit (bere se jako možnost zápisu)'], otherDatabases: null, otherWritableDatabases: null });
});

test('runQuery: chyba skriptu při běhu se zapisujícím loginem – audit nese writableLogin', async (t) => {
  const dir = tmp(t);
  const cfg = makeCfg(dir, { server: 'srv-chyba-zapis', allowWritableLogin: true });
  const err = { ok: false, error: 'Dávka 1/1, řádek 1: Invalid column name', stage: 'run', rolledBack: true, rollbackError: null };
  const last = () => readAudit(cfg.auditLog).at(-1);
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1' }, { run: fakeRun({ ...err, login: WRITER }), warn: () => {} }), /^Error: Chyba SQL \(StwPh_12345678_2026 na srv-chyba-zapis\): Dávka 1\/1/);
  assert.deepEqual(last().writableLogin, ['člen role db_datawriter', 'oprávnění INSERT v databázi']);
  assert.equal(last().error, 'Dávka 1/1, řádek 1: Invalid column name');
  assert.equal(last().rolledBack, true);
  noNames(fs.readFileSync(cfg.auditLog, 'utf8'), 'audit');
  // login jen pro čtení, chybějící login (starší pomocník) a chyba mimo fázi run: bez writableLogin
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1' }, { run: fakeRun({ ...err, login: READER }), warn: () => {} }), /Chyba SQL/);
  assert.equal('writableLogin' in last(), false);
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1' }, { run: fakeRun(err), warn: () => {} }), /Chyba SQL/);
  assert.equal('writableLogin' in last(), false);
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1' }, { run: fakeRun({ ...err, stage: 'connect', rolledBack: null, login: WRITER }), warn: () => {} }), /Chyba SQL/);
  assert.equal('writableLogin' in last(), false);
});

test('checkQuery: text výjimky z JSON.parse se nikam nevkládá (statická kontrola zdroje)', () => {
  // běh ps\\Check-Query.ps1 tady nejde nahradit falešným pomocníkem, proto jen kontrola zdroje: obě čtení výstupu mají pevnou zprávu
  const src = fs.readFileSync(new URL('../src/exec.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /neplatný JSON: \$\{e\.message\}/);
  assert.equal([...src.matchAll(/readJsonFile\(outFile\)/g)].length, 2);
  assert.equal([...src.matchAll(/try \{ (?:return |res = )readJsonFile\(outFile\); \} catch \{/g)].length, 2);
});
