// node --test test/config.test.js  – načtení nastavení (config.json + proměnné prostředí), kontrola adresy SQL serveru
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, validateSqlServer, DEFAULT_SQL_SERVER, MODEL_DB } from '../src/config.js';

const withEnv = (vars, fn) => {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
};

// Každý test běží s čistým prostředím (žádná proměnná POHODA_* z okolí) a s vlastním config.json v dočasné složce.
const CLEAN = { POHODA_MCP_CONFIG: undefined, POHODA_AGENT_DIR: undefined, POHODA_RUN_QUERY: undefined, POHODA_SQL_SERVER: undefined, POHODA_ALLOWED_DATABASES: undefined, POHODA_CREDENTIAL_FILE: undefined };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pohoda-mcp-config-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const MISSING = path.join(tmp, 'neexistuje', 'config.json');
let seq = 0;
/** Načte konfiguraci: `file` = obsah config.json (objekt, nebo řetězec zapsaný beze změny), undefined = soubor neexistuje. */
const load = (file, env = {}) => {
  let configFile = MISSING;
  if (file !== undefined) {
    configFile = path.join(tmp, `config-${++seq}.json`);
    fs.writeFileSync(configFile, typeof file === 'string' ? file : JSON.stringify(file), 'utf8');
  }
  return withEnv({ ...CLEAN, POHODA_MCP_CONFIG: configFile, ...env }, () => loadConfig());
};
const assertClosed = (c, pattern, label) => {
  assert.equal(c.runQuery.enabled, false, `${label ?? ''} enabled`);
  assert.ok(c.configErrors.some((e) => pattern.test(e)), `${label ?? ''} chyby: ${JSON.stringify(c.configErrors)}`);
};

test('výchozí adresa SQL serveru je 127.0.0.1,1433', () => {
  withEnv({ ...CLEAN, POHODA_MCP_CONFIG: 'C:/neexistuje/config.json' }, () => {
    assert.equal(loadConfig().runQuery.server, DEFAULT_SQL_SERVER);
    assert.equal(DEFAULT_SQL_SERVER, '127.0.0.1,1433');
  });
});

test('POHODA_SQL_SERVER přepíše výchozí hodnotu; prázdná proměnná se ignoruje', () => {
  withEnv({ ...CLEAN, POHODA_SQL_SERVER: 'SRV01\\POHODA', POHODA_MCP_CONFIG: 'C:/neexistuje/config.json' }, () => {
    assert.equal(loadConfig().runQuery.server, 'SRV01\\POHODA');
  });
  withEnv({ ...CLEAN, POHODA_SQL_SERVER: '', POHODA_MCP_CONFIG: 'C:/neexistuje/config.json' }, () => {
    assert.equal(loadConfig().runQuery.server, DEFAULT_SQL_SERVER);
  });
});

test('kontrola formátu adresy', () => {
  for (const ok of ['127.0.0.1,1433', 'localhost', 'SRV01\\POHODA', 'srv01.firma.local,14330', '192.168.1.10', '[::1],1433']) {
    assert.equal(validateSqlServer(ok), null, ok);
  }
  for (const bad of ['', '   ', 'srv; Password=x', 'srv 01', "srv'--", 'a'.repeat(300)]) {
    assert.notEqual(validateSqlServer(bad), null, bad);
  }
});

test('kontrola formátu adresy – přísné tvary', () => {
  for (const ok of ['SRV01\\POHODA,1433', '[::1]', '[fe80::1]', '[2001:db8::10],14330', 'srv_01', 'srv-01.firma.local', 'srv,1', 'srv,65535', ' localhost ']) {
    assert.equal(validateSqlServer(ok), null, ok);
  }
  const bad = [
    'tcp:srv', 'tcp:srv,1433', 'admin:srv', 'ADMIN:srv', 'np:\\\\srv\\pipe\\sql\\query', 'lpc:srv',
    'srv,1433,x', 'srv,1433,1434', 'srv,', ',1433', 'srv,,1433', 'srv,abc', 'srv,0', 'srv,65536', 'srv,123456', 'srv,-1',
    '[[[', '[]', '[::1', '::1', '[::1]]', '[srv]', '[::1],', '[::1],0', '[::1]\\POHODA', '[zz::1]',
    'srv\\', '\\POHODA', 'srv\\a\\b', 'srv\\in st', 'srv/POHODA', 'srv:1433', 'srv=x', 'srv"x', 'šrv', 'srv\n,1433', null, undefined,
  ];
  for (const b of bad) {
    const r = validateSqlServer(b);
    assert.equal(typeof r, 'string', String(b));
    assert.ok(r.length < 400, String(b));
  }
});

test('bez config.json: výchozí hodnoty, žádná chyba', () => {
  const c = load(undefined);
  assert.deepEqual(c.configErrors, []);
  assert.equal(c.configFound, false);
  assert.equal(c.configFile, MISSING);
  assert.deepEqual(Object.keys(c).sort(), ['agentDir', 'auditLog', 'configErrors', 'configFile', 'configFound', 'runQuery']);
  assert.deepEqual(Object.keys(c.runQuery).sort(), ['allowedDatabases', 'credentialFile', 'enabled', 'maxChars', 'maxRowsHard', 'maxRowsPerSet', 'server', 'timeoutSec']);
  assert.deepEqual({ ...c.runQuery, credentialFile: null }, {
    enabled: true, server: DEFAULT_SQL_SERVER, credentialFile: null, allowedDatabases: [MODEL_DB], maxRowsPerSet: 200, maxRowsHard: 2000, maxChars: 60000, timeoutSec: 60,
  });
  assert.match(c.agentDir, /knowledge$/);
  assert.match(c.auditLog, /dotazy\.jsonl$/);
});

test('platný config.json se použije celý; configFound i pro {} a soubor s BOM', () => {
  const c = load({
    agentDir: 'C:/x/znalosti', auditLog: 'C:/x/audit.jsonl',
    runQuery: { enabled: false, server: 'SRV01\\POHODA,1433', credentialFile: 'C:/x/login.xml', allowedDatabases: [' DbA ', 'DbB'], maxRowsPerSet: 50, maxRowsHard: 500, maxChars: 1000, timeoutSec: 30 },
  });
  assert.deepEqual(c.configErrors, []);
  assert.equal(c.configFound, true);
  assert.equal(c.agentDir, 'C:/x/znalosti');
  assert.equal(c.auditLog, 'C:/x/audit.jsonl');
  assert.deepEqual(c.runQuery, { enabled: false, server: 'SRV01\\POHODA,1433', credentialFile: 'C:/x/login.xml', allowedDatabases: ['DbA', 'DbB'], maxRowsPerSet: 50, maxRowsHard: 500, maxChars: 1000, timeoutSec: 30 });

  const empty = load({});
  assert.equal(empty.configFound, true);
  assert.deepEqual(empty.configErrors, []);
  assert.equal(empty.runQuery.enabled, true);

  const bom = load('\uFEFF{"runQuery":{"timeoutSec":15}}');
  assert.deepEqual(bom.configErrors, []);
  assert.equal(bom.runQuery.timeoutSec, 15);
  assert.equal(bom.runQuery.enabled, true);
});

test('rozbitý JSON → chyba s cestou, spouštění vypnuté, jinak výchozí hodnoty', () => {
  for (const raw of ['{ "runQuery": { "enabled": true, ', '{"runQuery":{"allowedDatabases":["DbA"],}}', 'runQuery: {}', '']) {
    const c = load(raw);
    assert.equal(c.configFound, false, raw);
    assert.equal(c.configErrors.length, 1, raw);
    assert.ok(c.configErrors[0].includes(c.configFile), c.configErrors[0]);
    assert.match(c.configErrors[0], /není platný JSON: \S/);
    assert.equal(c.runQuery.enabled, false, raw);
    assert.deepEqual(c.runQuery.allowedDatabases, [MODEL_DB]);
    assert.equal(c.runQuery.server, DEFAULT_SQL_SERVER);
    assert.equal(c.runQuery.maxRowsHard, 2000);
  }
  // rozbitý soubor nepřebije ani výslovné zapnutí proměnnou prostředí
  assert.equal(load('{ rozbité', { POHODA_RUN_QUERY: '1' }).runQuery.enabled, false);
});

test('config.json, který není objekt, nebo runQuery jiného typu → chyba a vypnuto', () => {
  for (const raw of ['[]', 'null', '"text"', '42']) assertClosed(load(raw), /musí obsahovat objekt/, raw);
  for (const runQuery of [[], 'ano', 1, true]) assertClosed(load({ runQuery }), /runQuery musí být objekt/, JSON.stringify(runQuery));
});

test('runQuery.enabled musí být boolean – řetězec "false" je chyba a vypíná', () => {
  for (const enabled of ['false', 'true', 0, 1, 'ne', []]) {
    assertClosed(load({ runQuery: { enabled } }), /runQuery\.enabled musí být true nebo false/, JSON.stringify(enabled));
  }
  assert.equal(load({ runQuery: { enabled: true } }).runQuery.enabled, true);
  const off = load({ runQuery: { enabled: false } });
  assert.equal(off.runQuery.enabled, false);
  assert.deepEqual(off.configErrors, []);
});

test('runQuery.allowedDatabases: pole názvů, řetězec s čárkami se převede, prázdné/chybné → chyba', () => {
  assert.deepEqual(load({ runQuery: { allowedDatabases: 'DbA, DbB;DbC,' } }).runQuery.allowedDatabases, ['DbA', 'DbB', 'DbC']);
  assert.deepEqual(load({ runQuery: { allowedDatabases: 'DbA' } }).configErrors, []);
  for (const allowedDatabases of [[], '', ' , ', ['DbA', ''], ['DbA', 5], [' '], 5, { a: 1 }, true]) {
    const c = load({ runQuery: { allowedDatabases } });
    assertClosed(c, /runQuery\.allowedDatabases musí být/, JSON.stringify(allowedDatabases));
    assert.deepEqual(c.runQuery.allowedDatabases, [MODEL_DB]);
  }
});

test('číselné limity: kladná celá čísla v mezích, jinak chyba + výchozí hodnota + vypnuto', () => {
  const defaults = { maxRowsPerSet: 200, maxRowsHard: 2000, maxChars: 60000, timeoutSec: 60 };
  for (const key of Object.keys(defaults)) {
    for (const value of [0, -5, 1.5, '100', true, [], 1e12, 1e400]) {
      const c = load(`{"runQuery":{"${key}":${typeof value === 'number' && !Number.isFinite(value) ? '1e400' : JSON.stringify(value)}}}`);
      assertClosed(c, new RegExp(`runQuery\\.${key} musí být celé číslo`), `${key}=${value}`);
      assert.equal(c.runQuery[key], defaults[key], `${key}=${value}`);
    }
  }
  assertClosed(load({ runQuery: { timeoutSec: 601 } }), /timeoutSec/);
  assert.equal(load({ runQuery: { timeoutSec: 600 } }).runQuery.timeoutSec, 600);
  assertClosed(load({ runQuery: { maxRowsHard: 100001 } }), /maxRowsHard/);
  assert.equal(load({ runQuery: { maxRowsHard: 100000 } }).runQuery.maxRowsHard, 100000);
});

test('maxRowsPerSet nesmí přesáhnout maxRowsHard', () => {
  const c = load({ runQuery: { maxRowsPerSet: 500, maxRowsHard: 100 } });
  assertClosed(c, /maxRowsPerSet \(500\) nesmí být větší než runQuery\.maxRowsHard \(100\)/);
  assert.equal(c.runQuery.maxRowsPerSet, 100);
  // zadaný jen nižší strop: výchozí maxRowsPerSet se sníží bez chyby
  const low = load({ runQuery: { maxRowsHard: 50 } });
  assert.deepEqual(low.configErrors, []);
  assert.equal(low.runQuery.maxRowsPerSet, 50);
  assert.equal(low.runQuery.enabled, true);
});

test('server, credentialFile, agentDir a auditLog musí být řetězce; adresa serveru se kontroluje už při načtení', () => {
  for (const [key, re] of [['server', /runQuery\.server/], ['credentialFile', /runQuery\.credentialFile/]]) {
    for (const value of [5, true, [], {}, '', '  ']) assertClosed(load({ runQuery: { [key]: value } }), re, `${key}=${JSON.stringify(value)}`);
  }
  for (const key of ['agentDir', 'auditLog']) assertClosed(load({ [key]: 5 }), new RegExp(`${key} musí být`), key);
  // chybná hodnota v souboru je chyba, i když ji proměnná prostředí přebije
  assertClosed(load({ agentDir: 5 }, { POHODA_AGENT_DIR: 'C:/env/znalosti' }), /agentDir musí být/);
  assertClosed(load({ runQuery: { credentialFile: 5 } }, { POHODA_CREDENTIAL_FILE: 'C:/env/login.xml' }), /runQuery[.]credentialFile/);
  assertClosed(load({ runQuery: { server: 5 } }, { POHODA_SQL_SERVER: 'srv-env' }), /runQuery[.]server/);
  assertClosed(load({ runQuery: { allowedDatabases: [] } }, { POHODA_ALLOWED_DATABASES: 'DbEnv' }), /allowedDatabases/);
  const c = load({ runQuery: { server: 'tcp:srv; Password=x' } });
  assertClosed(c, /runQuery\.server – Neplatná adresa/);
  assert.equal(c.runQuery.server, DEFAULT_SQL_SERVER);
  const e = load(undefined, { POHODA_SQL_SERVER: 'admin:srv' });
  assertClosed(e, /POHODA_SQL_SERVER – Neplatná adresa/);
  assert.equal(e.runQuery.server, DEFAULT_SQL_SERVER);
});

test('proměnné prostředí mají přednost před souborem', () => {
  const file = { agentDir: 'C:/soubor/znalosti', runQuery: { enabled: false, server: 'srv-soubor', credentialFile: 'C:/soubor/login.xml', allowedDatabases: ['DbSoubor'] } };
  const c = load(file, { POHODA_RUN_QUERY: '1', POHODA_SQL_SERVER: 'srv-env,1433', POHODA_ALLOWED_DATABASES: 'DbEnv1;DbEnv2', POHODA_CREDENTIAL_FILE: 'C:/env/login.xml', POHODA_AGENT_DIR: 'C:/env/znalosti' });
  assert.deepEqual(c.configErrors, []);
  assert.equal(c.agentDir, 'C:/env/znalosti');
  assert.deepEqual(c.runQuery, { ...c.runQuery, enabled: true, server: 'srv-env,1433', credentialFile: 'C:/env/login.xml', allowedDatabases: ['DbEnv1', 'DbEnv2'] });
  // bez proměnných platí soubor
  const f = load(file);
  assert.equal(f.agentDir, 'C:/soubor/znalosti');
  assert.deepEqual(f.runQuery, { ...f.runQuery, enabled: false, server: 'srv-soubor', credentialFile: 'C:/soubor/login.xml', allowedDatabases: ['DbSoubor'] });
  // vypnutí proměnnou přebije zapnutí v souboru
  assert.equal(load({ runQuery: { enabled: true } }, { POHODA_RUN_QUERY: '0' }).runQuery.enabled, false);
});

test('hodnoty proměnných se ořezávají (trim)', () => {
  const c = load(undefined, { POHODA_SQL_SERVER: '  SRV01\\POHODA \t', POHODA_ALLOWED_DATABASES: ' DbA , DbB ', POHODA_CREDENTIAL_FILE: '  C:/x/login.xml  ', POHODA_AGENT_DIR: ' C:/x/znalosti ', POHODA_RUN_QUERY: ' on ' });
  assert.deepEqual(c.configErrors, []);
  assert.equal(c.runQuery.server, 'SRV01\\POHODA');
  assert.deepEqual(c.runQuery.allowedDatabases, ['DbA', 'DbB']);
  assert.equal(c.runQuery.credentialFile, 'C:/x/login.xml');
  assert.equal(c.agentDir, 'C:/x/znalosti');
  assert.equal(c.runQuery.enabled, true);
});

test('POHODA_RUN_QUERY: 1/true/yes/on a 0/false/no/off bez ohledu na velikost; jiná hodnota = chyba a vypnuto', () => {
  for (const v of ['1', 'true', 'TRUE', 'Yes', 'on', ' On ']) {
    const c = load({ runQuery: { enabled: false } }, { POHODA_RUN_QUERY: v });
    assert.equal(c.runQuery.enabled, true, v);
    assert.deepEqual(c.configErrors, [], v);
  }
  for (const v of ['0', 'false', ' False ', 'NO', 'off', 'Off']) {
    const c = load({ runQuery: { enabled: true } }, { POHODA_RUN_QUERY: v });
    assert.equal(c.runQuery.enabled, false, v);
    assert.deepEqual(c.configErrors, [], v);
  }
  for (const v of ['ne', 'ano', 'vypnuto', '2', 'tru', 'true false', 'enabled']) {
    assertClosed(load({ runQuery: { enabled: true } }, { POHODA_RUN_QUERY: v }), /POHODA_RUN_QUERY má neplatnou hodnotu/, v);
  }
  // prázdná = jako nenastaveno → platí soubor / výchozí
  for (const v of ['', '   ']) {
    assert.equal(load(undefined, { POHODA_RUN_QUERY: v }).runQuery.enabled, true, JSON.stringify(v));
    assert.equal(load({ runQuery: { enabled: false } }, { POHODA_RUN_QUERY: v }).runQuery.enabled, false, JSON.stringify(v));
  }
});

test('POHODA_ALLOWED_DATABASES: oddělovač , nebo ; – bez položek platí výchozí modelová DB', () => {
  assert.deepEqual(load(undefined, { POHODA_ALLOWED_DATABASES: 'DbA,DbB; DbC ,,;' }).runQuery.allowedDatabases, ['DbA', 'DbB', 'DbC']);
  for (const v of [',', ' ', '', ' ; , ']) {
    const c = load(undefined, { POHODA_ALLOWED_DATABASES: v });
    assert.deepEqual(c.runQuery.allowedDatabases, [MODEL_DB], JSON.stringify(v));
    assert.deepEqual(c.configErrors, [], JSON.stringify(v));
  }
  // bez položek = nenastaveno → použije se seznam ze souboru
  assert.deepEqual(load({ runQuery: { allowedDatabases: ['DbSoubor'] } }, { POHODA_ALLOWED_DATABASES: ',' }).runQuery.allowedDatabases, ['DbSoubor']);
});

test('nevyplněný zástupný text z manifestu (${user_config.x}) se ignoruje jako prázdná hodnota (POHODA_RUN_QUERY ale vypíná spouštění)', () => {
  const placeholders = {
    POHODA_RUN_QUERY: '${user_config.run_query_enabled}', POHODA_SQL_SERVER: '${user_config.sql_server}',
    POHODA_ALLOWED_DATABASES: ' ${user_config.allowed_databases} ', POHODA_CREDENTIAL_FILE: '${user_config.credential_file}', POHODA_AGENT_DIR: '${user_config.x}',
  };
  const c = load(undefined, placeholders);
  assert.deepEqual(c.configErrors, []);
  assert.equal(c.runQuery.server, DEFAULT_SQL_SERVER);
  assert.deepEqual(c.runQuery.allowedDatabases, [MODEL_DB]);
  assert.match(c.runQuery.credentialFile, /pohoda-sql\.xml$/);
  assert.match(c.agentDir, /knowledge$/);
  assert.equal(c.runQuery.enabled, false); // nedosazený zástupný text = výchozí stav balíčku (vypnuto)
  // … a platí pak hodnoty ze souboru
  const f = load({ runQuery: { enabled: false, server: 'srv-soubor', allowedDatabases: ['DbSoubor'] } }, placeholders);
  assert.deepEqual(f.configErrors, []);
  assert.equal(f.runQuery.enabled, false);
  assert.equal(f.runQuery.server, 'srv-soubor');
  assert.deepEqual(f.runQuery.allowedDatabases, ['DbSoubor']);
});

test('loadConfig nemění proměnné prostředí', () => {
  const before = JSON.stringify(Object.entries(process.env).filter(([k]) => k.startsWith('POHODA_')));
  load({ runQuery: { enabled: 'x' } }, { POHODA_RUN_QUERY: 'ne' });
  assert.equal(JSON.stringify(Object.entries(process.env).filter(([k]) => k.startsWith('POHODA_'))), before);
});

test('nevyplněný zástupný text POHODA_RUN_QUERY z manifestu = spouštění vypnuto (výchozí stav balíčku), bez chyby', () => {
  const c = load(undefined, { POHODA_RUN_QUERY: '${user_config.run_query_enabled}' });
  assert.equal(c.runQuery.enabled, false);
  assert.deepEqual(c.configErrors, []);
  // výslovně vyplněná hodnota ji přebije
  assert.equal(load(undefined, { POHODA_RUN_QUERY: 'true' }).runQuery.enabled, true);
});
