// node --test test/sqlgate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSql } from '../src/sqlgate.js';

const ok = (s) => assert.equal(checkSql(s).ok, true, `${s}\n${checkSql(s).errors.join('; ')}`);
const bad = (s) => assert.equal(checkSql(s).ok, false, s);

test('povolené vzory výkazů', () => {
  ok('SELECT 1 AS a; -- UPDATE x');
  ok("SELECT 'DELETE FROM FA' AS s, [Update] FROM dbo.FA AS f");
  ok('SELECT z.Ucet INTO #u FROM dbo.pUD AS z; UPDATE #u SET Kc = 0; DROP TABLE #u;');
  ok('CREATE TABLE #r (a int); INSERT #r (a) SELECT 1; DECLARE @t TABLE (a int); INSERT INTO @t SELECT 1;');
  ok('DECLARE @i int = 1; WHILE @i < 3 BEGIN SET @i += 1; END; SELECT @i;');
  ok('/* UPDATE dbo.FA SET x = 1 */ SELECT 1');
  ok('USE StwPh_x\nSELECT 1');
});

test('zakázané příkazy', () => {
  bad('UPDATE dbo.FA SET Poznamka = 1');
  bad('UPDATE f SET x = 1 FROM dbo.FA f');
  bad('DELETE FROM dbo.FA');
  bad('EXEC sp_who');
  bad('SELECT * INTO dbo.kopie FROM dbo.FA');
  bad('DROP TABLE dbo.FA');
  bad('BEGIN TRAN; COMMIT');
  bad('INSERT INTO dbo.FA (ID) SELECT 1');
  bad('SELECT * FROM OPENROWSET(1)');
  bad('CREATE TABLE dbo.x (a int)');
  bad('TRUNCATE TABLE dbo.FA');
  bad('ALTER TABLE #x ADD b int');
  bad('SELECT 1; SELECT * INTO ##glob FROM dbo.FA');
});

test('USE se odstraní, ne zakáže', () => {
  const r = checkSql('USE StwPh_x\nSELECT 1');
  assert.equal(r.ok, true);
  assert.ok(!/USE/i.test(r.sql));
  assert.equal(r.notes.length, 1);
});
