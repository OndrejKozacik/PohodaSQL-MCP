// node --test test/exec.test.js  – čisté funkce z src/exec.js; PowerShell ani databáze se nespouští (běh nahrazuje falešný pomocník)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, cell, checkQuery, formatHeader, formatSets, normalizeResult, runQuery } from '../src/exec.js';

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
  const okRes = { ok: true, sets: [{ cols: ['a'], rows: [['1']], total: 1 }], messages: [], rolledBack: true, rollbackError: null };
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
  await assert.rejects(runQuery(cfg, { sql: 'SELECT 1' }, { run: fakeRun('{"ok":tr') }), /neplatný JSON/);
  once();
  assert.match(last().error, /neplatný JSON/);
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
  await runQuery(cfg, { sql: longSql }, { run: fakeRun({ ok: true, sets: [], messages: [], rolledBack: true }) });
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
    fs.writeFileSync(out, JSON.stringify({ ok: true, sets: [], messages: [], rolledBack: true }));
    return { code: 0, stderr: '' };
  };
  await runQuery(cfg, { sql: 'SELECT 1' }, { run });
  assert.equal(fs.existsSync(tempDir), false);
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
