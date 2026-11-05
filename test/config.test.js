// node --test test/config.test.js  – nastavení adresy SQL serveru (POHODA_SQL_SERVER) a jeho kontrola
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateSqlServer, DEFAULT_SQL_SERVER } from '../src/config.js';

const withEnv = (vars, fn) => {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
};

test('výchozí adresa SQL serveru je 127.0.0.1,1433', () => {
  withEnv({ POHODA_SQL_SERVER: undefined, POHODA_MCP_CONFIG: 'C:/neexistuje/config.json' }, () => {
    assert.equal(loadConfig().runQuery.server, DEFAULT_SQL_SERVER);
    assert.equal(DEFAULT_SQL_SERVER, '127.0.0.1,1433');
  });
});

test('POHODA_SQL_SERVER přepíše výchozí hodnotu; prázdná proměnná se ignoruje', () => {
  withEnv({ POHODA_SQL_SERVER: 'SRV01\\POHODA', POHODA_MCP_CONFIG: 'C:/neexistuje/config.json' }, () => {
    assert.equal(loadConfig().runQuery.server, 'SRV01\\POHODA');
  });
  withEnv({ POHODA_SQL_SERVER: '', POHODA_MCP_CONFIG: 'C:/neexistuje/config.json' }, () => {
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
