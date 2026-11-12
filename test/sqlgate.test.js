// node --test test/sqlgate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkSql, splitBatches } from '../src/sqlgate.js';

const ok = (s) => assert.equal(checkSql(s).ok, true, `${s}\n${checkSql(s).errors.join('; ')}`);
const bad = (s) => assert.equal(checkSql(s).ok, false, s);
const errs = (s) => checkSql(s).errors.join(' | ');

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

test('A1: vícedílné názvy objektů (jiná databáze / server)', () => {
  bad('SELECT * FROM StwPh_x.dbo.FA');
  bad('SELECT * FROM StwPh_x..FA');
  bad('SELECT * FROM srv.StwPh_x.dbo.FA');
  bad('SELECT * FROM [StwPh_x].[dbo].[FA] AS f');
  bad('SELECT * FROM [StwPh_x] . dbo . FA');
  bad('SELECT 1 FROM dbo.FA f JOIN StwPh_x.dbo.AD a ON a.ID = f.RefAD');
  bad('SELECT 1 FROM dbo.FA f CROSS APPLY other.dbo.fn(f.ID) x');
  bad('SELECT 1 FROM dbo.FA f, StwPh_x.dbo.AD a');
  bad('SELECT 1 FROM #t AS t WITH (NOLOCK), StwPh_x..AD a');
  bad('SELECT 1 FROM (SELECT 1 AS a) q, StwPh_x.sys.tables t');
  bad('SELECT 1 WHERE EXISTS (SELECT 1 FROM StwPh_x.sys.tables)');
  bad('SELECT 1 FROM (StwPh_x.dbo.FA f JOIN dbo.AD a ON a.ID = f.RefAD)');
  bad('SELECT 1 FROM ((StwPh_x..FA f JOIN dbo.AD a ON a.ID = f.RefAD) JOIN dbo.SKz s ON 1 = 1)');
  ok('SELECT 1 FROM (dbo.FA f JOIN dbo.AD a ON a.ID = f.RefAD), (SELECT 1 AS x) q, (VALUES (1)) v(a)');
  bad('SELECT * INTO #k FROM tempdb.dbo.FA');
  bad('INSERT INTO StwPh_x.dbo.FA (ID) SELECT 1');
  bad('DELETE FROM StwPh_x..FA');
  bad('UPDATE StwPh_x.dbo.FA SET a = 1');
  bad('TRUNCATE TABLE StwPh_x.dbo.FA');
  bad('MERGE StwPh_x.dbo.FA AS t USING #s s ON 1 = 1 WHEN MATCHED THEN DELETE;');
  assert.match(errs('SELECT * FROM StwPh_x.dbo.FA'), /mimo aktuální databázi: „StwPh_x\.dbo\.FA“/);
  ok('SELECT dbo.FA.ID, f.ID, [dbo].[FA].[Cislo] FROM dbo.FA JOIN dbo.FA AS f ON f.ID = dbo.FA.ID');
  ok('SELECT f.ID FROM FA f, dbo.AD a WHERE a.ID = f.RefAD');
  ok('SELECT * FROM sys.tables t JOIN [sys].[columns] c ON c.object_id = t.object_id');
  ok('CREATE TABLE #x (a int); SELECT * FROM tempdb..#x; SELECT * FROM tempdb.dbo.#x; SELECT * FROM [tempdb]..[#x]');
  ok('DECLARE @t TABLE (a int); SELECT * FROM @t t, #x x');
  ok("SELECT 'FROM a.b.c' AS s -- FROM a.b.c\n/* FROM a.b.c */");
  ok('SELECT a.b.c.d FROM dbo.FA'); // čtyřdílný výraz ve sloupcích není zdroj tabulky
});

test('A2: procedury a dynamické SQL', () => {
  bad("EXEC [sp_executesql] N'SELECT 1'");
  bad('SELECT 1; EXECUTE("SELECT 1")');
  bad('SELECT [sp_who]');
  bad('SELECT "xp_cmdshell"');
  bad('SELECT sys.sp_helptext');
  bad('{call dbo.MojeProc(1)}');
  bad('{ ? = CALL dbo.MojeProc(1) }');
  bad('SELECT 1; {call dbo.MojeProc(1)}');
  bad('dbo.MojeProc 1');
  bad("[sp_executesql] N'SELECT 1'");
  bad('MojeProc');
  bad('SELECT 1\nGO\ndbo.MojeProc 1');
  bad('SELECT 1\ngo -- dalsi\n  MojeProc 1\nGO');
  bad(';;dbo.MojeProc');
  bad('navesti: dbo.MojeProc');
  bad('-- komentář\n/* a */ dbo.MojeProc 1');
  assert.match(errs('SELECT 1\nGO\ndbo.MojeProc 1'), /Dávka 2 začíná „dbo“.*bez EXEC/);
  assert.match(errs("[sp_executesql] N'x'"), /Zakázaná systémová procedura: sp_executesql/);
  ok('SELECT 1\nGO\nSELECT 2\nGO\n');
  ok('SELECT 1\nGO;\n;WITH c AS (SELECT 1 AS a) SELECT * FROM c\nGO -- konec\n(SELECT 1) UNION ALL (SELECT 2)');
  ok("SELECT 'a\nb' AS s\nGO\n-- MojeProc 1\nGO\n/* jen komentář */\nGO\nSELECT 2");
  ok('DECLARE c CURSOR LOCAL FAST_FORWARD FOR SELECT 1; DECLARE @a int; OPEN c; FETCH NEXT FROM c INTO @a; CLOSE c; DEALLOCATE c;');
  ok("IF OBJECT_ID('tempdb..#a') IS NOT NULL DROP TABLE #a;\nGO\nPRINT 1\nGO\nSET NOCOUNT ON");
  ok("SELECT {fn NOW()} AS d, {d '2026-01-01'} AS x");
});

test('A2/A7: GO jako oddělovač dávek', () => {
  assert.deepEqual(splitBatches('SELECT 1\r\nGO\r\nSELECT 2\r\n  go ;  \r\nSELECT 3\nGO -- x\nSELECT 4\nGO'), ['SELECT 1\r', 'SELECT 2\r', 'SELECT 3', 'SELECT 4']);
  assert.deepEqual(splitBatches('SELECT 1 AS GO\nGOTO x\nGO 5\nGO'), ['SELECT 1 AS GO\nGOTO x\nGO 5']);
  bad('SELECT 1\nGO 5');
  bad('SELECT 1\n  go   12  \nSELECT 2');
  assert.match(errs('SELECT 1\nGO 5'), /Řádek 2: `GO <počet>`/);
  bad("SELECT '\nGO\ndbo.MojeProc 1 --' AS s"); // runner by dělil uvnitř řetězce
  bad('SELECT 1 /*\nGO\n*/');
  ok('SELECT 1 AS go\nFROM dbo.FA go');
  ok('SELECT 1 -- GO 5\n/* GO 5 */');
});

test('A3: USE se odstraní jen jako příkaz', () => {
  const sqlOf = (s) => checkSql(s).sql;
  assert.equal(sqlOf('USE x; SELECT 1'), ' SELECT 1');
  assert.equal(sqlOf('USE [StwPh x];\nSELECT 1'), '\nSELECT 1');
  assert.equal(sqlOf('USE[x] SELECT 1'), ' SELECT 1');
  assert.equal(sqlOf('use x\r\nGO\r\nSELECT 1'), '\r\nGO\r\nSELECT 1');
  assert.equal(sqlOf('SELECT 1;\n  USE "x" ;\nSELECT 2'), 'SELECT 1;\n  \nSELECT 2');
  for (const s of ['USE x; SELECT 1', 'USE[x] SELECT 1', 'USE [x]\nSELECT 1', 'SELECT 1\nUSE x\nSELECT 2']) {
    const r = checkSql(s);
    assert.equal(r.ok, true, `${s}: ${r.errors.join('; ')}`);
    assert.equal(r.notes.length, 1);
    assert.ok(!/USE/i.test(r.sql));
  }
  // řetězce, komentáře a aliasy se nepoškodí
  for (const s of ["SELECT 'a\nuse b' AS s", 'SELECT 1 -- x\n/*\nUSE db\n*/', "SELECT 1 OPTION (USE HINT('FORCE_LEGACY_CARDINALITY_ESTIMATION'))", 'SELECT a AS Výuse, [use] FROM dbo.FA']) {
    const r = checkSql(s);
    assert.equal(r.ok, true, `${s}: ${r.errors.join('; ')}`);
    assert.equal(r.sql, s);
    assert.equal(r.notes.length, 0);
  }
  // `use AS b` není příkaz USE: text zůstane beze změny (USE je vyhrazené slovo, takže se odmítne)
  const r = checkSql('SELECT a,\n use AS b FROM dbo.FA');
  assert.equal(r.sql, 'SELECT a,\n use AS b FROM dbo.FA');
  assert.equal(r.ok, false);
  for (const s of ['USE x', 'USE [x];', '-- a\nUSE x;\n/* b */', 'USE x\nUSE y;']) {
    const e = checkSql(s);
    assert.equal(e.ok, false, s);
    assert.deepEqual(e.errors, ['Po odstranění USE nezbyl žádný příkaz.']);
  }
  bad('SELECT 1 USE x'); // uprostřed řádku za výrazem – nejednoznačné, neodstraňuje se
});

test('A7: DROP TABLE se seznamem', () => {
  ok('CREATE TABLE #a (a int); CREATE TABLE #b (a int); DROP TABLE #a, #b; DROP TABLE IF EXISTS #a, [#b], tempdb..#c');
  bad('DROP TABLE #a, dbo.FA');
  bad('DROP TABLE IF EXISTS #a, dbo.FA');
  bad('DROP TABLE #a, #b, FA');
  bad('DROP TABLE #a, ##g');
  bad('DROP TABLE #a,');
  bad('DROP TABLE @t');
  bad('DROP VIEW #a');
  bad('DROP INDEX ix ON dbo.FA');
  assert.match(errs('DROP TABLE IF EXISTS #a, dbo.FA'), /DROP TABLE dbo\.FA/);
});

test('A7: řídicí znaky, CR, komentáře', () => {
  for (const ch of ['\u0000', '\u0001', '\u0008', '\u000B', '\u000C', '\u000E', '\u001F', '\u007F', '\u0085']) {
    bad(`SELECT${ch}1`);
    bad(`DROP${ch}TABLE${ch}dbo.FA`);
    ok(`SELECT 'a${ch}b' AS s -- ${ch}\n/* ${ch} */`); // v řetězci a komentáři nevadí
  }
  assert.match(errs('SELECT\u00011'), /Řídicí znaky v kódu \(U\+0001\)/);
  ok('SELECT\t1\r\nFROM\tdbo.FA\r\n');
  bad('SELECT 1 -- komentář\rDELETE FROM dbo.FA'); // samotné CR ukončuje řádkový komentář
  bad('SELECT 1 --x\rEXEC sp_who');
  ok('SELECT 1 -- komentář\rSELECT 2');
  bad("SELECT 'neukončený");
  bad('SELECT 1 /* neukončený');
  ok('SELECT 1 /* a /* vnořený */ DELETE FROM dbo.FA */');
});

test('A7: další zakázané příkazy a hinty', () => {
  bad('UPDATE STATISTICS dbo.FA');
  bad('UPDATE  statistics #t');
  bad('UPDATE STATISTICS_x SET a = 1'); // trvalá tabulka
  ok('CREATE TABLE #STATISTICS_x (a int); UPDATE #STATISTICS_x SET a = 1');
  assert.match(errs('UPDATE STATISTICS dbo.FA'), /UPDATE STATISTICS/);
  assert.match(errs('UPDATE STATISTICS_x SET a = 1'), /UPDATE do trvalé tabulky\/aliasu „STATISTICS_x“/);
  bad('DISABLE TRIGGER ALL ON dbo.FA');
  bad('SELECT 1; ENABLE TRIGGER tr ON dbo.FA');
  bad("UPDATETEXT dbo.FA.Pozn @p 0 NULL 'x'");
  bad("WRITETEXT dbo.FA.Pozn @p 'x'");
  bad('READTEXT dbo.FA.Pozn @p 0 10');
  bad("SETUSER 'x'");
  bad('SELECT 1; REVERT');
  bad('SET IDENTITY_INSERT #t ON');
  bad('SELECT * FROM dbo.FA WITH (TABLOCKX)');
  bad('SELECT * FROM dbo.FA WITH (XLOCK, ROWLOCK)');
  bad("BULK INSERT #t FROM 'c:\\x.csv'");
  bad('SAVE TRANSACTION s');
  bad('BEGIN DISTRIBUTED TRANSACTION');
  bad('BEGIN\nTRAN');
  bad('IF @@TRANCOUNT > 0 ROLLBACK');
  bad('COMMIT');
  bad('MERGE #t AS t USING #s s ON 1 = 1 WHEN MATCHED THEN DELETE;');
  bad("SELECT 1; WAITFOR DELAY '0:0:5'");
  ok('SELECT [TABLOCKX], [Commit], "Exec" FROM dbo.FA WITH (NOLOCK)');
  ok('SELECT 1 AS Enable, 2 AS Trigger_x');
});

test('B: alias v UPDATE/DELETE nad dočasnou tabulkou', () => {
  ok('UPDATE x SET x.a = q.a FROM #r AS x JOIN #q q ON q.id = x.id');
  ok('UPDATE x SET a = 1 FROM #r x');
  ok('DELETE t FROM #u t WHERE t.a = 1');
  ok('DELETE FROM t FROM #u AS t JOIN dbo.FA f ON f.ID = t.id');
  ok('UPDATE x SET x.a = f.Kc FROM #r AS x JOIN dbo.FA AS f ON f.ID = x.id WHERE f.Kc > 0');
  ok('UPDATE x SET x.a = v.B FROM dbo.FA f, #r AS x CROSS JOIN (SELECT SUM(y.a) AS B FROM #r AS y) AS v WHERE x.id = f.ID;');
  ok('UPDATE x SET x.a = CASE WHEN x.a > 0 THEN 1 ELSE 0 END FROM @t AS x');
  ok('UPDATE x SET a = 1 FROM tempdb..#r AS x WITH (TABLOCK) WHERE x.a IN (SELECT ID FROM dbo.FA)');
  ok('WITH agg AS (SELECT ID, SUM(Kc) AS Kc FROM dbo.FA GROUP BY ID) UPDATE x SET x.a = a.Kc FROM #r AS x JOIN agg AS a ON a.ID = x.id;');
  ok('WHILE 1 = 0 BEGIN UPDATE x SET a = 1 FROM #r AS x WHERE x.a = 2 FETCH NEXT FROM c INTO @a END');
  bad('UPDATE f SET x = 1 FROM dbo.FA f');
  bad('UPDATE f SET x = 1 FROM FA AS f');
  bad('DELETE f FROM dbo.FA f');
  bad('UPDATE x SET a = 1'); // žádná vazba aliasu
  bad('SELECT 1 FROM #r AS x; UPDATE x SET a = 1'); // vazba v jiném příkazu neplatí
  bad('SELECT 1 FROM #r AS x UPDATE x SET a = 1');
  bad('UPDATE x SET a = (SELECT MAX(a) FROM #r AS x)'); // vazba jen v poddotazu
  bad('UPDATE x SET a = 1 FROM (SELECT * FROM dbo.FA) AS x');
  bad('UPDATE x SET a = 1 FROM dbo.FA AS x JOIN #r AS r ON r.id = x.ID');
  bad('UPDATE x SET a = 1 FROM #r AS r JOIN dbo.FA x ON r.id = x.ID');
  bad('UPDATE x SET a = 1 FROM #r AS r, dbo.FA x');
  bad('UPDATE X SET a = 1 FROM #r AS x'); // jiná velikost písmen
  bad('UPDATE x SET a = 1 FROM x JOIN #r AS r ON r.id = x.ID');
  bad('WITH c AS (SELECT * FROM dbo.FA) UPDATE c SET a = 1');
  bad('WITH x AS (SELECT * FROM dbo.FA) UPDATE x SET a = 1 FROM x JOIN #r r ON 1 = 1');
  bad('UPDATE x SET a = 1 SELECT 1 FROM #r AS x');
  bad('UPDATE x SET a = 1\nGO\nSELECT 1 FROM #r AS x');
  bad('DELETE x WHERE EXISTS (SELECT 1 FROM #r AS x)');
  bad('UPDATE x SET a = 1 FROM ##g AS x');
  bad('UPDATE x SET a = 1 FROM [@t] AS x');
});

test('B: klíčová slova jako části identifikátorů a aliasy', () => {
  ok('SELECT 1 AS Tran');
  ok('SELECT 1 AS Bulk, 2 AS Transaction, 3 AS Save');
  ok('DECLARE @save money, @tran int; SELECT @save, @tran');
  ok('SELECT 2 AS a INTO #save; SELECT * FROM #save');
  ok('SELECT 1 AS Výuse, 2 AS Tranše, 3 AS předexec, 4 AS use_x, 5 AS Užuse');
  ok('SELECT Tranše, übercommit FROM #t');
  bad('SELECT 1 AS Exec');
  bad('SELECT 1; BEGIN TRAN');
});

test('B: výjimky – izolace, MERGE JOIN, USE HINT, index na #tmp, tempdb', () => {
  ok('SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SELECT 1');
  ok('SELECT 1 FROM dbo.FA f INNER MERGE JOIN dbo.AD a ON a.ID = f.RefAD');
  ok('SELECT 1 FROM dbo.FA f LEFT MERGE JOIN dbo.AD a ON a.ID = f.RefAD');
  ok('SELECT 1 FROM dbo.FA f RIGHT OUTER MERGE JOIN dbo.AD a ON a.ID = f.RefAD');
  ok('SELECT 1 FROM dbo.FA f FULL MERGE JOIN dbo.AD a ON a.ID = f.RefAD');
  ok('SELECT 1 FROM dbo.FA f JOIN dbo.AD a ON a.ID = f.RefAD OPTION (MERGE JOIN)');
  ok('SELECT 1 FROM dbo.FA f JOIN dbo.AD a ON a.ID = f.RefAD OPTION (RECOMPILE, MERGE JOIN, MAXDOP 1)');
  ok("SELECT 1 OPTION (USE HINT('DISABLE_OPTIMIZER_ROWGOAL'), RECOMPILE)");
  ok('CREATE TABLE #t (a int); CREATE INDEX ix ON #t(a); CREATE UNIQUE CLUSTERED INDEX ix2 ON #t (a); CREATE NONCLUSTERED INDEX ix3 ON tempdb..#t (a)');
  ok('INSERT INTO tempdb..#t (a) SELECT 1; INSERT tempdb.dbo.#t SELECT 2; SELECT 1 AS a INTO tempdb..#u');
  bad('CREATE INDEX ix ON dbo.FA(ID)');
  bad('CREATE UNIQUE INDEX ix ON FA(ID)');
  bad('CREATE INDEX ix ON @t(a)');
  bad('CREATE UNIQUE TABLE #t (a int)');
  bad('CREATE VIEW #v AS SELECT 1');
  bad('CREATE TABLE tempdb..FA (a int)');
  bad('INSERT INTO tempdb..FA SELECT 1');
  bad('INSERT INTO otherdb..#t SELECT 1');
  bad('MERGE JOIN AS t USING #s s ON 1 = 1 WHEN MATCHED THEN DELETE;');
  bad('MERGE dbo.FA AS t USING #s s ON 1 = 1 WHEN MATCHED THEN DELETE;');
  bad("SELECT 1 OPTION (USE PLAN N'x')");
});

// Akceptační test nad skutečnými skripty agenta (jen názvy souborů a počty; přeskočí se, když agent na počítači není).
const AGENT = 'C:\\data\\PohodaAI';
const ANALYZA = path.join(AGENT, 'dotazy', '_analyza');
const VYSLEDKY = path.join(AGENT, 'tests', 'vysledky');
const readSql = (f) => fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
const VYKAZY = ['rozvaha-obecna', 'rozvaha-plna', 'vzz-DP', 'vzz-DZ', 'vzz-obecna', 'vzz-UP', 'vzz-UZ'];
// správně odmítnuté: soubor → čím musí začínat každá chyba
const ODMITNUTE = {
  'druh-ost': /^Zakázané klíčové slovo: EXEC/,
  'pokusy-kontrola': /^Zakázan(é klíčové slovo: EXEC|á systémová procedura)/,
  'test-vpr-kontrola': /^UPDATE do trvalé tabulky/,
  'vzor-dotazy-insert': /^(INSERT|INTO .*) do trvalé tabulky/,
  'model-inventura': /^Odkaz mimo aktuální databázi/, // A1: čte sys.tables jiných databází – dříve prošlo, nově se odmítá záměrně
};

test('akceptace: skripty dotazy\\_analyza', (t) => {
  if (!fs.existsSync(ANALYZA)) return t.skip('složka agenta neexistuje');
  const files = fs.readdirSync(ANALYZA).filter((f) => /\.sql$/i.test(f));
  if (!files.length) return t.skip('žádné skripty');
  const accepted = [];
  const refused = [];
  for (const f of files) {
    const r = checkSql(readSql(path.join(ANALYZA, f)));
    const name = f.replace(/\.sql$/i, '');
    (r.ok ? accepted : refused).push(name);
    if (ODMITNUTE[name]) {
      assert.equal(r.ok, false, `${f} má zůstat odmítnutý`);
      for (const e of r.errors) assert.match(e, ODMITNUTE[name], f);
    } else assert.equal(r.ok, true, `${f} má projít: ${r.errors.map((e) => e.slice(0, 80)).join(' | ')}`);
  }
  for (const v of VYKAZY) if (files.includes(`${v}.sql`)) assert.ok(accepted.includes(v), `výkaz ${v} má projít`);
  t.diagnostic(`_analyza: ${files.length} skriptů, přijato ${accepted.length}, odmítnuto ${refused.length} (${refused.join(', ')})`);
});

test('akceptace: skripty golden testů tests\\vysledky', (t) => {
  if (!fs.existsSync(VYSLEDKY)) return t.skip('složka agenta neexistuje');
  const files = [];
  for (const run of fs.readdirSync(VYSLEDKY, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    for (const d of fs.readdirSync(path.join(VYSLEDKY, run.name), { withFileTypes: true })) {
      if (!d.isDirectory() || !/^T/.test(d.name)) continue;
      for (const f of fs.readdirSync(path.join(VYSLEDKY, run.name, d.name))) if (/^T.*\.sql$/i.test(f)) files.push(path.join(VYSLEDKY, run.name, d.name, f));
    }
  }
  if (!files.length) return t.skip('žádné skripty');
  let accepted = 0;
  const kinds = {};
  for (const f of files) {
    const r = checkSql(readSql(f));
    if (r.ok) { accepted++; continue; }
    // odmítnutí smí být jen kvůli zápisu do trvalé tabulky/aliasu nebo EXEC (skripty odpovídají na otázky typu „napiš UPDATE“)
    for (const e of r.errors) {
      assert.match(e, /^(UPDATE|INSERT|DELETE|INTO .*) do trvalé tabulky|^Zakázané klíčové slovo: EXEC/, `${path.basename(path.dirname(path.dirname(f)))}\\${path.basename(f)}`);
      const kind = e.split(' ')[0];
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
  }
  t.diagnostic(`vysledky: ${files.length} skriptů, přijato ${accepted}, odmítnuto ${files.length - accepted} (chyby: ${JSON.stringify(kinds)})`);
});

test('seznam databází serveru se odmítá (názvy dalších databází se nemají dostat k modelu)', () => {
  const refused = (s, re) => { const r = checkSql(s); assert.equal(r.ok, false, s); assert.match(r.errors.join(' | '), re, s); };
  const LIST = /Odkaz na seznam databází serveru \(„[\w.]+“\) není povolený – databázi určuje parametr `database`; seznam dalších databází na serveru model nedostane\./;
  // zdroj ve FROM / JOIN / APPLY, různé zápisy
  refused('SELECT name FROM sys.databases', LIST);
  refused('SELECT d.name FROM sys . databases AS d', LIST);
  refused('SELECT d.name FROM [sys].[databases] AS d', LIST);
  refused('SELECT d.name FROM "sys"."databases" AS d', LIST);
  refused('SELECT d.name FROM sys.[databases] d', LIST);
  refused('SELECT d.name FROM SYS.DATABASES d', LIST);
  refused('SELECT d.name FROM Sys.DataBases d', LIST);
  refused('SELECT d.name FROM sys./* komentář */databases d', LIST);
  refused('SELECT d.name FROM sys -- komentář\n . -- další\n databases d', LIST);
  refused('SELECT d.name FROM sys\n.\n\tdatabases d', LIST);
  refused('SELECT f.ID FROM dbo.FA AS f JOIN sys.databases AS d ON 1 = 1', LIST);
  refused('SELECT f.ID FROM dbo.FA AS f CROSS APPLY (SELECT TOP 1 d.name FROM sys.databases AS d) AS x', LIST);
  refused('SELECT name FROM master.sys.databases', LIST);
  // kdekoli v kódu, nejen jako zdroj hned za FROM
  refused('SELECT (SELECT TOP 1 name FROM sys.databases) AS n', LIST);
  refused('SELECT 1 WHERE EXISTS (SELECT 1 FROM dbo.FA AS f, sys.databases AS d)', LIST);
  refused('SELECT f.ID FROM dbo.FA AS f JOIN dbo.AD AS a ON a.ID = f.RefAD, sys.databases AS d', LIST);
  refused('DECLARE @n sysname; SELECT @n = name FROM sys.databases WHERE database_id = 5; SELECT @n', LIST);
  refused("SELECT OBJECT_ID(N'x'), sys.databases.name FROM dbo.FA", LIST);
  // starší názvy a soubory databází
  assert.match(errs('SELECT name FROM sys.databases'), /„sys\.databases“/);
  assert.match(errs('SELECT name FROM sys.sysdatabases'), /„sys\.sysdatabases“/);
  assert.match(errs('SELECT name FROM sysdatabases'), /„sysdatabases“/);
  assert.match(errs('SELECT name FROM dbo.sysdatabases'), /„sysdatabases“/);
  assert.match(errs('SELECT name FROM [sysdatabases]'), /„sysdatabases“/);
  assert.match(errs('SELECT name FROM master..sysdatabases'), /„sysdatabases“/);
  assert.match(errs('SELECT name, physical_name FROM sys.master_files'), /„sys\.master_files“/);
  assert.match(errs('SELECT name FROM [sys].[master_files]'), /„sys\.master_files“/);
  assert.match(errs('SELECT name, filename FROM sys.sysaltfiles'), /„sys\.sysaltfiles“/);
  assert.match(errs('SELECT name FROM sysaltfiles'), /„sysaltfiles“/);
  for (const s of ['SELECT name FROM sys.sysdatabases', 'SELECT name FROM SYSDATABASES', 'SELECT name FROM sys.Master_Files', 'SELECT name FROM SysAltFiles']) refused(s, LIST);
  // jedna chyba na jeden odkaz (sys.sysdatabases se nehlásí dvakrát)
  assert.equal(checkSql('SELECT name FROM sys.sysdatabases').errors.length, 1);

  // funkce
  const FN = /Funkce HAS_DBACCESS není povolená – databázi určuje parametr `database`; seznam dalších databází na serveru model nedostane\./;
  refused("SELECT HAS_DBACCESS('StwPh_x')", FN);
  refused('SELECT has_dbaccess (@n)', FN);
  refused('SELECT [HAS_DBACCESS](@n)', FN);
  const DBN = /DB_NAME s argumentem není povolené \(jen DB_NAME\(\) bez argumentu = aktuální databáze\) – databázi určuje parametr `database`/;
  refused('SELECT DB_NAME(5)', DBN);
  refused('SELECT db_name ( 5 )', DBN);
  refused('SELECT DB_NAME(/* x */ 5)', DBN);
  refused('SELECT DB_NAME(\n@i\n)', DBN);
  refused('SELECT DB_NAME(DB_ID())', DBN);
  refused('SELECT DB_NAME((5))', DBN);
  refused('DECLARE @i int = 5; WHILE @i < 40 BEGIN SELECT DB_NAME(@i); SET @i += 1; END', DBN);
  refused('SELECT [DB_NAME](5)', DBN);

  // povolené: DB_NAME() bez argumentu a slova, která nejsou odkazem na seznam databází
  ok('SELECT DB_NAME() AS Db');
  ok('SELECT db_name ( ) AS Db');
  ok('SELECT DB_NAME(/* aktuální */) AS Db, f.ID FROM dbo.FA AS f');
  ok('DECLARE @db sysname = DB_NAME(); SELECT @db');
  ok('SELECT COUNT(*) AS databases FROM dbo.FA AS f');
  ok('SELECT f.ID AS [databases], f.Cislo AS sys FROM dbo.FA AS f');
  ok('SELECT databases.ID FROM dbo.FA AS databases');
  ok('SELECT x.databases, x.master_files FROM (SELECT 1 AS databases, 2 AS master_files) AS x');
  ok('SELECT d.ID FROM dbo.databases AS d');
  ok('SELECT sys.ID FROM dbo.FA AS sys');
  ok("SELECT 'SELECT name FROM sys.databases; DB_NAME(5); HAS_DBACCESS(1)' AS Text");
  ok('SELECT 1 AS a -- sys.databases, DB_NAME(5)');
  ok('/* SELECT name FROM sys.databases */ SELECT 1 AS a');
  ok('SELECT 1 AS HAS_DBACCESS, 2 AS DB_NAME');
  ok('SELECT t.name FROM sys.tables AS t JOIN sys.columns AS c ON c.object_id = t.object_id');
  ok('SELECT f.name, f.physical_name FROM sys.database_files AS f');
  ok('SELECT p.name FROM sys.database_principals AS p');
  ok("SELECT OBJECT_ID(N'dbo.FA') AS Id, SCHEMA_NAME(1) AS S, OBJECT_NAME(5) AS O");
  ok("SELECT f.ID, f.Cislo FROM dbo.FA AS f WHERE f.Datum >= '2026-01-01'");
});
