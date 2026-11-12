// node --test test/golden-lib.test.js  – čisté funkce runneru zlatých testů přes MCP (eval/golden-lib.mjs).
// Vše nad vymyšlenými daty: nevolá se claude, nečte se skutečný golden.md ani databáze. Runner (spuštění agenta, ukončení
// procesů, --znovu) se zkouší s náhradním příkazem `claude` v dočasné složce – bez nákladů.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bezici, evaluateRun, interruptRun, killAll, killTree, loadRunMeta, removeEmptyClientProjects, runAgent } from '../eval/run-golden-mcp.mjs';
import {
  CLEAN_ARGS, MODEL_DB, STAV, buildClaudeArgs, buildMcpConfig, buildPrompt, buildReport, childEnv, cleanProse, collectValues, compareValues,
  evalMetrics, evaluateTest, expectedWriteTables, formatCalls, formatInitCounts, initCounts, mcpStatus, normSql, numberCandidates, numbersInText,
  parseGolden, parseIds, parseRunResult, parseStream, pickFinalSql, selectTests, sqlBlocks, stripSql, summarize, toNumber, writeTargets,
} from '../eval/golden-lib.mjs';

// ---------------------------------------------------------------------------
// Vymyšlená ukázka golden.md
// ---------------------------------------------------------------------------
const GOLDEN = `# Ukázková sada

Úvodní text, který se přeskočí.

## T1 – Počet a součet

**Otázka:** Kolik je dokladů
a jaký je jejich součet?

**Známá hodnota:** 3 doklady, celkem 1 234,50.

**Kontrola:** 1234,50 | 1300,00; 3

**Musí:** tabulka \`Doklady\`, ne \`Sablony\`.

\`\`\`sql
SELECT COUNT(*) FROM dbo.Doklady;
\`\`\`

## T2 – Zápis

**Otázka:** Přidej položku a přepočítej hlavičku.

**Kontrola:** ZAPIS Polozky Doklady

**Obsahuje:** \`Kc\\s*\\*\\s*0[.,]21\` ;; \`pUD\`

**Musí:** INSERT bez sloupce ID.

## T3 – Jiná databáze

**DB:** StwPh_00000000_2026

**Otázka:** Kolik je řádků?

**Kontrola:** 77; Praha

**Obsahuje:** Radek5
`;

test('parseGolden: sekce, otázka přes víc řádků, kontrola, obsahuje, DB', () => {
  const t = parseGolden(GOLDEN);
  assert.deepEqual(t.map((x) => x.id), ['T1', 'T2', 'T3']);
  assert.equal(t[0].nazev, 'Počet a součet');
  assert.equal(t[0].otazka, 'Kolik je dokladů a jaký je jejich součet?');
  assert.equal(t[0].kontrola, '1234,50 | 1300,00; 3');
  assert.equal(t[0].znama, '3 doklady, celkem 1 234,50.');
  assert.equal(t[0].musi, 'tabulka `Doklady`, ne `Sablony`.');
  assert.equal(t[0].db, '');
  assert.deepEqual(t[0].obsahuje, []);
  assert.equal(t[1].kontrola, 'ZAPIS Polozky Doklady');
  assert.deepEqual(t[1].obsahuje, ['Kc\\s*\\*\\s*0[.,]21', 'pUD']);
  assert.equal(t[2].db, 'StwPh_00000000_2026');
  assert.deepEqual(t[2].obsahuje, ['Radek5']);
});

test('parseGolden: BOM a konce řádků CRLF', () => {
  const t = parseGolden(`\ufeff${GOLDEN.replace(/\n/g, '\r\n')}`);
  assert.equal(t.length, 3);
  assert.equal(t[0].otazka, 'Kolik je dokladů a jaký je jejich součet?');
  assert.equal(t[0].kontrola, '1234,50 | 1300,00; 3');
});

test('selectTests: výchozí výběr jen testy bez DB; výslovná Id i s DB; neznámá Id zvlášť', () => {
  const t = parseGolden(GOLDEN);
  assert.deepEqual(selectTests(t, []).vybrane.map((x) => x.id), ['T1', 'T2']);
  const v = selectTests(t, parseIds('t3, T1;T99'));
  assert.deepEqual(v.vybrane.map((x) => x.id), ['T3', 'T1']);
  assert.deepEqual(v.nezname, ['T99']);
});

// ---------------------------------------------------------------------------
// Čísla
// ---------------------------------------------------------------------------
test('numberCandidates: český i strojový zápis', () => {
  assert.deepEqual(numberCandidates('1 766 656,00'), [1766656]);
  assert.deepEqual(numberCandidates('1\u00a0766\u00a0656,00'), [1766656]);
  assert.deepEqual(numberCandidates('1\u202f766\u202f656,00'), [1766656]);
  assert.deepEqual(numberCandidates('1766656.00'), [1766656]);
  assert.deepEqual(numberCandidates('1,766,656.00'), [1766656]);
  assert.deepEqual(numberCandidates('1.766.656,00'), [1766656]);
  assert.deepEqual(numberCandidates('-2 949'), [-2949]);
  assert.deepEqual(numberCandidates('\u22122949,5'), [-2949.5]);
  assert.deepEqual(numberCandidates('81,53'), [81.53]);
  assert.deepEqual(numberCandidates('14'), [14]);
});

test('numberCandidates: nejednoznačný zápis dá oba výklady; nečísla nic', () => {
  assert.deepEqual(numberCandidates('1,470'), [1.47, 1470]);
  assert.deepEqual(numberCandidates('1.470'), [1.47, 1470]);
  assert.deepEqual(numberCandidates('0,470'), [0.47]);
  for (const s of ['', 'abc', 'KB0040003', '12.', '1,2,3', '2026-06-30']) assert.deepEqual(numberCandidates(s), [], s);
});

test('toNumber: jen český zápis z řádku Kontrola', () => {
  assert.equal(toNumber('1766656,00'), 1766656);
  assert.equal(toNumber(' 1 234,50 '), 1234.5);
  assert.equal(toNumber('14'), 14);
  assert.equal(toNumber('KB0040003'), null);
  assert.equal(toNumber('ZAPIS FA'), null);
});

test('numbersInText: čísla ve větě, tisíce se neslévají se sousedními čísly', () => {
  assert.deepEqual(numbersInText('Celkem 1 766 656,00 Kč za 14 faktur.'), [1766656, 14]);
  assert.deepEqual(numbersInText('V roce 2026 bylo 881 800,00 Kč (881800.00).'), [2026, 881800, 881800]);
  assert.deepEqual(numbersInText('| 11 | 13 750,00 |'), [11, 13750]);
  assert.deepEqual(numbersInText('doklad KB0040003 a účet 311x'), []);
});

test('cleanProse: bez kódu a bez dat', () => {
  const p = cleanProse('K 30. 6. 2026 (2026-06-30) je to 9 dokladů, filtr `RelTpFak IN (1, 2, 3, 8)`.\n```sql\nSELECT 14, 62;\n```\nDne 1.2.2026 i 12. 10. bylo 340 030,00.');
  assert.deepEqual(numbersInText(p), [9, 340030]);
});

// ---------------------------------------------------------------------------
// Výsledek pohoda_run_query
// ---------------------------------------------------------------------------
const hlavicka = `Databáze: ${MODEL_DB} na 127.0.0.1,1433 · 812 ms · transakce vrácena (ROLLBACK)\n`;
const RUN_MESICE = `${hlavicka}
**Výsledek 1** – 4 řádků

| Mesic | Pocet | Suma | Pozn |
|---|---|---|---|
| 1 | 2 | 100.50 | NULL |
| 2 | 1 | 200.00 | a \\| b |
| 11 | 5 | 881800.00 | Praha |
| CELKEM | 8 | 882100.50 | NULL |

**Výsledek 2** – 1 řádků

| Info |
|---|
| Počet otevřených položek: 13 |

**Zprávy (PRINT):**
Hotovo: 1 234,50 Kč`;

test('parseRunResult: result sety, NULL, escapovaná svislítka, zprávy; hlavička se nečte', () => {
  const r = parseRunResult(RUN_MESICE);
  assert.equal(r.sets.length, 2);
  assert.deepEqual(r.sets[0].cols, ['Mesic', 'Pocet', 'Suma', 'Pozn']);
  assert.equal(r.sets[0].total, 4);
  assert.equal(r.sets[0].rows.length, 4);
  assert.deepEqual(r.sets[0].rows[0], ['1', '2', '100.50', null]);
  assert.equal(r.sets[0].rows[1][3], 'a | b');
  assert.deepEqual(r.sets[1].rows, [['Počet otevřených položek: 13']]);
  assert.deepEqual(r.messages, ['Hotovo: 1 234,50 Kč']);
});

test('parseRunResult: bez result setu a zkrácená tabulka', () => {
  assert.deepEqual(parseRunResult(`${hlavicka}\n_Skript nevrátil žádný result set (použij SELECT, ne PRINT)._`), { sets: [], messages: [] });
  const r = parseRunResult(`${hlavicka}\n**Výsledek 1** – 500 řádků (zobrazeno prvních 2)\n\n| A |\n|---|\n| 1 |\n| 2 |`);
  assert.equal(r.sets[0].total, 500);
  assert.equal(r.sets[0].rows.length, 2);
});

test('collectValues + compareValues: buňka, počet řádků, součet sloupce, text, zpráva', () => {
  const h = collectValues({ runTexts: [RUN_MESICE], answer: '' });
  // číslo z buňky ±0,005; bez znaménka v Kontrole se na znaménko nehledí
  assert.equal(compareValues('881800,00', h).ok, 1);
  assert.equal(compareValues('881800,004', h).ok, 1);
  assert.equal(compareValues('881800,01', h).ok, 0);
  // počet řádků se bere jen z POSLEDNÍHO result setu (1 řádek); první set má 4 řádky, ale poslední není
  assert.equal(compareValues('1', h).ok, 1);
  assert.equal(compareValues('4; 3', h).ok, 0);
  // hodnota s desetinnou čárkou se jako počet řádků nebere
  const jenPocet = collectValues({ runTexts: ['**Výsledek 1** – 7 řádků (zobrazeno prvních 1)\n\n| Nazev |\n|---|\n| abc |'] });
  assert.equal(compareValues('7', jenPocet).ok, 1);
  assert.equal(compareValues('7,00', jenPocet).ok, 0);
  // součet sloupce: u částek ano (Suma = 100,50 + 200 + 881800 + 882100,50), u malých celých čísel ne (Pocet: 2+1+5+8 = 16)
  assert.equal(compareValues('1764201,00', h).ok, 1);
  assert.equal(compareValues('16', h).ok, 0);
  // text buňky bez ohledu na velikost písmen
  assert.equal(compareValues('PRAHA', h).ok, 1);
  // číslo ve zprávě PRINT ano; malé celé číslo uvnitř textové buňky („Počet otevřených položek: 13“) ne
  assert.equal(compareValues('1234,50', h).ok, 1);
  assert.equal(compareValues('13', h).ok, 0);
  // malé celé číslo v číselné buňce běžného sloupce ano (Pocet = 5)
  assert.equal(compareValues('5', h).ok, 1);
  // hlavička (port 1433, 812 ms) se do hodnot nepočítá
  assert.equal(compareValues('1433', h).ok, 0);
  assert.equal(compareValues('812', h).ok, 0);
});

test('compareValues: alternativy, chybějící skupiny a zdroj shody', () => {
  const h = collectValues({ runTexts: [RUN_MESICE], answer: 'Platební doklad **KB0040003**, uhrazeno 300 000,00 Kč. V listopadu 881 800,00.' });
  const r = compareValues('999,00 | 881800,00; kb0040003; 300000,00; 555', h);
  assert.equal(r.ok, 3);
  assert.equal(r.celkem, 4);
  assert.deepEqual(r.chybi, ['555']);
  assert.deepEqual(r.skupiny.map((g) => g.zdroj), ['nastroj', 'odpoved', 'odpoved', null]);
  assert.equal(r.jenVOdpovedi, 2);
});

test('compareValues: čísla z kódu a z dat v odpovědi se nepočítají', () => {
  const h = collectValues({ runTexts: [], answer: 'K 30. 6. 2026 platí filtr `IN (1, 2, 3, 8)`.\n```sql\nSELECT 14;\n```' });
  assert.equal(compareValues('14; 8; 30; 6', h).ok, 0);
});

test('collectValues: součet sloupce se u zkrácené tabulky nepočítá', () => {
  const h = collectValues({ runTexts: [`**Výsledek 1** – 500 řádků (zobrazeno prvních 2)\n\n| A |\n|---|\n| 1 |\n| 2 |`] });
  assert.equal(compareValues('3', h).ok, 0);
  assert.equal(compareValues('500', h).ok, 1);
});

// ---------------------------------------------------------------------------
// Cílové tabulky zápisu
// ---------------------------------------------------------------------------
test('writeTargets: INSERT / UPDATE / DELETE, závorky, alias, dočasné tabulky', () => {
  assert.deepEqual(writeTargets('INSERT INTO dbo.Polozky (A) VALUES (1); UPDATE [dbo].[Doklady] SET Kc = 1 WHERE ID = 2;'), ['Polozky', 'Doklady']);
  assert.deepEqual(writeTargets('UPDATE f SET f.Vyrizeno = 1 FROM dbo.FA AS f JOIN dbo.AD a ON a.ID = f.RefAD WHERE f.Kc > 0'), ['FA']);
  assert.deepEqual(writeTargets('DELETE p FROM dbo.Polozky p WHERE p.ID = 1; DELETE FROM dbo.Doklady WHERE ID = 2; DELETE dbo.Jine WHERE 1 = 0'), ['Polozky', 'Doklady', 'Jine']);
  assert.deepEqual(writeTargets('UPDATE TOP (10) dbo.AD SET Email = LOWER(Email)'), ['AD']);
  assert.deepEqual(writeTargets('SELECT * INTO dbo.Kopie FROM dbo.FA'), ['Kopie']);
  assert.deepEqual(writeTargets('MERGE INTO dbo.Cil AS c USING dbo.Zdroj AS z ON c.ID = z.ID WHEN MATCHED THEN UPDATE SET c.A = z.A;'), ['Cil']);
});

test('writeTargets: čtecí skripty, #tmp, @tabulka, komentáře a řetězce se nepočítají', () => {
  assert.deepEqual(writeTargets('SELECT * FROM dbo.FA WHERE Cislo = 1'), []);
  assert.deepEqual(writeTargets('CREATE TABLE #t (a int); INSERT INTO #t SELECT 1; UPDATE #t SET a = 2; DELETE FROM #t; SELECT * INTO #u FROM #t;'), []);
  assert.deepEqual(writeTargets('DECLARE @t TABLE (a int); INSERT INTO @t VALUES (1); UPDATE t SET a = 2 FROM @t AS t;'), []);
  assert.deepEqual(writeTargets("-- UPDATE dbo.FA SET x = 1\n/* DELETE FROM dbo.FA */\nSELECT 'INSERT INTO dbo.FA' AS Text, 'it''s' FROM dbo.FA;"), []);
  assert.deepEqual(writeTargets('SELECT a FROM dbo.FA WITH (UPDLOCK); UPDATE STATISTICS dbo.FA;'), []);
});

test('sqlBlocks: bloky sql z odpovědi', () => {
  assert.deepEqual(sqlBlocks('Text\n```sql\nSELECT 1;\n```\na\n```SQL\nSELECT 2;\n```\n```text\nnic\n```'), ['SELECT 1;', 'SELECT 2;']);
});

// ---------------------------------------------------------------------------
// Syntetický stream-json
// ---------------------------------------------------------------------------
const P = 'mcp__pohoda-sql__';
let idSeq = 0;
/** Volání nástroje = zpráva asistenta s tool_use + zpráva uživatele s tool_result. */
const volani = (name, input, vysledek, { isError = false, jakoText = false } = {}) => {
  const id = `toolu_${++idSeq}`;
  return [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Pokračuji.' }, { type: 'tool_use', id, name, input }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: jakoText ? vysledek : [{ type: 'text', text: vysledek }] }] } },
  ];
};
const INIT = { type: 'system', subtype: 'init', model: 'model-x', mcp_servers: [{ name: 'pohoda-sql', status: 'connected' }], tools: [] };
const vysledek = (text, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.3141, num_turns: 7, duration_ms: 42400, ...extra });
const jsonl = (...zpravy) => zpravy.flat().map((z) => JSON.stringify(z)).join('\n');
const KONTROLA_OK = 'Výsledek kontroly (exit 0: 0 = OK, 2 = chyby, 1 = chyba nástroje):\n\nTyp skriptu: ČTENÍ\nOK';
const KONTROLA_ZAPIS_OK = 'Výsledek kontroly (exit 0: 0 = OK, 2 = chyby, 1 = chyba nástroje):\n\nTyp skriptu: ZÁPIS do Doklady, Polozky\nOK';
const KONTROLA_CHYBA = 'Výsledek kontroly (exit 2: 0 = OK, 2 = chyby, 1 = chyba nástroje):\n\nCHYBA: sloupec Xyz neexistuje';
const RUN_T1 = `${hlavicka}\n**Výsledek 1** – 1 řádků\n\n| Suma | Pocet |\n|---|---|\n| 1234.50 | 3 |`;
const SQL_T1 = 'SELECT SUM(Kc) AS Suma, COUNT(*) AS Pocet\nFROM dbo.Doklady;';

const STREAM_T1 = jsonl(
  INIT,
  volani(`${P}pohoda_rules`, {}, 'Jádro pravidel…'),
  volani(`${P}pohoda_rules`, { chapter: 'sklad' }, 'Kapitola sklad…'),
  volani(`${P}pohoda_schema`, { table: 'Doklady' }, 'Popis tabulky…'),
  volani(`${P}pohoda_check_query`, { sql: 'SELECT Xyz FROM dbo.Doklady' }, KONTROLA_CHYBA),
  volani(`${P}pohoda_check_query`, { sql: SQL_T1 }, KONTROLA_OK, { jakoText: true }),
  volani(`${P}pohoda_run_query`, { sql: 'SELECT SUM(Kc) AS Suma,  COUNT(*) AS Pocet FROM dbo.Doklady;' }, RUN_T1),
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hotovo.' }] } },
  vysledek('Doklady jsou **3**, celkem **1 234,50 Kč**.'),
);

test('parseStream: volání nástrojů s výsledky, úvodní zpráva, výsledek', () => {
  const s = parseStream(`nějaký šum\n${STREAM_T1}\n{neplatný json`);
  assert.equal(mcpStatus(s.init), 'connected');
  assert.equal(s.calls.length, 6);
  assert.deepEqual(s.calls.map((c) => c.tool), ['pohoda_rules', 'pohoda_rules', 'pohoda_schema', 'pohoda_check_query', 'pohoda_check_query', 'pohoda_run_query']);
  assert.equal(s.calls[4].result, KONTROLA_OK); // obsah výsledku jako prostý text
  assert.equal(s.calls[5].result, RUN_T1); // obsah výsledku jako pole bloků
  assert.equal(s.answer, 'Doklady jsou **3**, celkem **1 234,50 Kč**.');
  assert.equal(s.result.num_turns, 7);
});

test('parseStream: bez řádku result je odpovědí poslední text asistenta', () => {
  const s = parseStream(jsonl(INIT, volani(`${P}pohoda_rules`, {}, 'x'), { type: 'assistant', message: { content: [{ type: 'text', text: 'Rozpracováno' }] } }));
  assert.equal(s.result, null);
  assert.equal(s.answer, 'Rozpracováno');
});

test('evalMetrics: dodržený postup', () => {
  const m = evalMetrics(parseStream(STREAM_T1).calls);
  assert.equal(m.rulesPrvni, true);
  assert.equal(m.checkPredRun, 'ano');
  assert.equal(m.runBezKontroly, 0); // stejné SQL až na bílé znaky
  const sHlavickou = parseStream(jsonl(volani(`${P}pohoda_check_query`, { sql: `-- účel\n/* popis */\n${SQL_T1}` }, KONTROLA_OK), volani(`${P}pohoda_run_query`, { sql: SQL_T1 }, RUN_T1)));
  assert.equal(evalMetrics(sHlavickou.calls).runBezKontroly, 0); // … a až na komentáře
  assert.deepEqual(m.volani, { pohoda_rules: 2, pohoda_schema: 1, pohoda_help: 0, pohoda_check_query: 2, pohoda_run_query: 1, pohoda_status: 0 });
  assert.equal(m.volaniCelkem, 6);
  assert.equal(m.chybyNastroju, 0);
  assert.equal(m.kontrolNeproslo, 1);
  assert.deepEqual(m.kapitoly, ['jádro', 'sklad']);
  assert.equal(formatCalls(m.volani), 'rules 2, schema 1, check 2, run 1');
});

test('evalMetrics: nedodržený postup, chyby nástrojů, cizí nástroje', () => {
  const s = parseStream(jsonl(
    INIT,
    volani('Read', { file_path: 'x' }, 'zamítnuto', { isError: true }),
    volani(`${P}pohoda_schema`, { table: 'FA' }, 'popis'),
    volani(`${P}pohoda_run_query`, { sql: 'SELECT 1' }, 'Chyba SQL', { isError: true }),
    volani(`${P}pohoda_check_query`, { sql: 'SELECT 2' }, KONTROLA_OK),
    volani(`${P}pohoda_run_query`, { sql: 'SELECT 3' }, RUN_T1),
    volani(`${P}pohoda_rules`, { chapter: 'dph' }, 'kapitola'),
  ));
  const m = evalMetrics(s.calls);
  assert.equal(m.rulesPrvni, false); // cizí nástroj se nepočítá, první náš je pohoda_schema
  assert.equal(m.checkPredRun, 'ne');
  assert.equal(m.runBezKontroly, 2);
  assert.equal(m.chybyNastroju, 1);
  assert.equal(m.jineNastroje, 1);
  assert.deepEqual(m.kapitoly, ['dph']);
  const prazdne = evalMetrics([]);
  assert.equal(prazdne.rulesPrvni, false);
  assert.equal(prazdne.checkPredRun, 'n/a');
  assert.equal(formatCalls(prazdne.volani), '–');
});

test('pickFinalSql: poslední sql z volání, jinak blok z odpovědi; u zápisu poslední zapisující skript', () => {
  const s = parseStream(STREAM_T1);
  assert.deepEqual(pickFinalSql(s.calls, s.answer), { sql: 'SELECT SUM(Kc) AS Suma,  COUNT(*) AS Pocet FROM dbo.Doklady;', zdroj: 'pohoda_run_query' });
  assert.deepEqual(pickFinalSql([], 'a\n```sql\nSELECT 1;\n```\nb\n```sql\nSELECT 2;\n```'), { sql: 'SELECT 2;', zdroj: 'odpoved' });
  assert.deepEqual(pickFinalSql([], 'bez kódu'), { sql: '', zdroj: '' });
  const z = parseStream(jsonl(
    volani(`${P}pohoda_check_query`, { sql: 'UPDATE dbo.Doklady SET A = 1' }, KONTROLA_ZAPIS_OK),
    volani(`${P}pohoda_run_query`, { sql: 'SELECT COUNT(*) FROM dbo.Doklady' }, RUN_T1),
  ));
  assert.equal(pickFinalSql(z.calls, '', { zapis: true }).sql, 'UPDATE dbo.Doklady SET A = 1');
  assert.equal(pickFinalSql(z.calls, '').sql, 'SELECT COUNT(*) FROM dbo.Doklady');
  assert.deepEqual(pickFinalSql([], '```sql\nSELECT 1;\n```\n```sql\nDELETE FROM dbo.X;\n```\n```sql\nSELECT 2;\n```', { zapis: true }), { sql: 'DELETE FROM dbo.X;', zdroj: 'odpoved' });
});

// ---------------------------------------------------------------------------
// Vyhodnocení testu
// ---------------------------------------------------------------------------
const [T1, T2, T3] = parseGolden(GOLDEN);

test('evaluateTest: čtecí test PROŠLO, cena, tahy, doba', () => {
  const v = evaluateTest(T1, STREAM_T1);
  assert.equal(v.stav, STAV.OK);
  assert.equal(v.shoda, '2/2');
  assert.equal(v.typ, 'čtení');
  assert.equal(v.cenaUsd, 0.3141);
  assert.equal(v.tahu, 7);
  assert.equal(v.sec, 42);
  assert.equal(v.sqlZdroj, 'pohoda_run_query');
  assert.deepEqual(v.hodnoty.skupiny.map((g) => g.zdroj), ['nastroj', 'nastroj']);
  assert.equal(v.poznamka, '');
  assert.match(v.sql, /^SELECT SUM/);
  assert.match(v.odpoved, /1 234,50/);
});

test('evaluateTest: ČÁSTEČNĚ, NEPROŠLO a shoda jen v odpovědi', () => {
  const jenText = jsonl(INIT, volani(`${P}pohoda_rules`, {}, 'x'), vysledek('Celkem 1 234,50 Kč.\n```sql\nSELECT SUM(Kc) FROM dbo.Doklady;\n```'));
  const c = evaluateTest(T1, jenText);
  assert.equal(c.stav, STAV.CAST);
  assert.equal(c.shoda, '1/2');
  assert.equal(c.sqlZdroj, 'odpoved');
  assert.match(c.poznamka, /chybí: 3/);
  assert.match(c.poznamka, /1× shoda jen v textu odpovědi/);
  const n = evaluateTest(T1, jsonl(INIT, vysledek('Nevím.')));
  assert.equal(n.stav, STAV.NE);
  assert.equal(n.shoda, '0/2');
  // výsledek spuštění, které skončilo chybou, se do hodnot nepočítá
  const chybny = jsonl(INIT, volani(`${P}pohoda_run_query`, { sql: 'SELECT 1' }, RUN_T1, { isError: true }), vysledek('Nic.'));
  assert.equal(evaluateTest(T1, chybny).shoda, '0/2');
});

test('evaluateTest: čtecí otázka se zapisujícím skriptem je NEPROŠLO', () => {
  const s = jsonl(INIT, volani(`${P}pohoda_run_query`, { sql: SQL_T1 }, RUN_T1), volani(`${P}pohoda_check_query`, { sql: 'DELETE FROM dbo.Doklady' }, KONTROLA_ZAPIS_OK), vysledek('3 a 1 234,50'));
  const v = evaluateTest(T1, s);
  assert.equal(v.stav, STAV.NE);
  assert.match(v.poznamka, /skript zapisuje/);
});

test('evaluateTest: CHYBA AGENTA – bez výsledku, timeout, chyba agenta, nepřipojený server', () => {
  const bez = evaluateTest(T1, jsonl(INIT, volani(`${P}pohoda_rules`, {}, 'x')), { sec: 12 });
  assert.equal(bez.stav, STAV.AGENT);
  assert.match(bez.poznamka, /nevrátil výsledek/);
  assert.equal(bez.sec, 12);
  assert.equal(bez.cenaUsd, null);
  assert.equal(evaluateTest(T1, '').stav, STAV.AGENT);
  const timeout = evaluateTest(T1, STREAM_T1, { timeout: true });
  assert.equal(timeout.stav, STAV.AGENT);
  assert.equal(timeout.shoda, '2/2'); // shoda se spočítá i tak, jen pro informaci
  const rozpocet = evaluateTest(T1, jsonl(INIT, vysledek('', { is_error: true, subtype: 'error_max_budget_usd' })));
  assert.equal(rozpocet.stav, STAV.AGENT);
  assert.match(rozpocet.poznamka, /error_max_budget_usd/);
  const nepripojen = evaluateTest(T1, jsonl({ ...INIT, mcp_servers: [{ name: 'pohoda-sql', status: 'failed' }] }, vysledek('3 a 1 234,50')));
  assert.equal(nepripojen.stav, STAV.AGENT);
  assert.match(nepripojen.poznamka, /se nepřipojil \(stav failed\)/);
  // stav pending, ale nástroje fungovaly = není to chyba agenta
  assert.equal(evaluateTest(T1, STREAM_T1.replace('"status":"connected"', '"status":"pending"')).stav, STAV.OK);
});

const SQL_T2 = '-- přidání položky a přepočet hlavičky\nINSERT INTO dbo.Polozky (RefAg, Kc) VALUES (1, 500);\nUPDATE d SET d.KcDPH = d.Kc * 0.21 FROM dbo.Doklady AS d WHERE d.ID = 1 AND NOT EXISTS (SELECT 1 FROM dbo.pUD AS u WHERE u.RefAg = d.ID);';

test('evaluateTest: ZAPIS – PROŠLO (ověřovací SELECT po kontrole skript nepřebije)', () => {
  const s = jsonl(
    INIT,
    volani(`${P}pohoda_rules`, {}, 'x'),
    volani(`${P}pohoda_check_query`, { sql: SQL_T2 }, KONTROLA_ZAPIS_OK),
    volani(`${P}pohoda_check_query`, { sql: 'SELECT Kc FROM dbo.Doklady WHERE ID = 1' }, KONTROLA_OK),
    volani(`${P}pohoda_run_query`, { sql: 'SELECT Kc FROM dbo.Doklady WHERE ID = 1' }, RUN_T1),
    vysledek('Skript je připraven.'),
  );
  const v = evaluateTest(T2, s);
  assert.equal(v.stav, STAV.OK);
  assert.equal(v.shoda, '2/2 tabulek');
  assert.equal(v.typ, 'zápis do Polozky, Doklady');
  assert.equal(v.sqlZdroj, 'pohoda_check_query');
  assert.deepEqual(v.zapis, { ocekavane: ['Polozky', 'Doklady'], zapisDo: ['Polozky', 'Doklady'], navic: [], zkontrolovano: true, kontrolaExit: 0, runZapis: 0 });
  assert.equal(v.metriky.checkPredRun, 'ano');
  assert.deepEqual(v.obsahujeChybi, []);
});

test('evaluateTest: ZAPIS – chybějící tabulka, nezkontrolovaný skript, kontrola s chybou, zápis přes run, vzor Obsahuje', () => {
  const chybiTab = evaluateTest(T2, jsonl(INIT, volani(`${P}pohoda_check_query`, { sql: 'UPDATE dbo.Doklady SET KcDPH = Kc * 0.21 -- pUD' }, KONTROLA_ZAPIS_OK), vysledek('ok')));
  assert.equal(chybiTab.stav, STAV.CAST);
  assert.equal(chybiTab.shoda, '1/2 tabulek');
  assert.match(chybiTab.poznamka, /chybí zápis do: Polozky/);

  const nezkontrolovano = evaluateTest(T2, jsonl(INIT, vysledek(`Skript:\n\`\`\`sql\n${SQL_T2}\n\`\`\``)));
  assert.equal(nezkontrolovano.stav, STAV.CAST);
  assert.equal(nezkontrolovano.zapis.zkontrolovano, false);
  assert.match(nezkontrolovano.poznamka, /neprošel pohoda_check_query/);

  const sChybou = evaluateTest(T2, jsonl(INIT, volani(`${P}pohoda_check_query`, { sql: SQL_T2 }, KONTROLA_CHYBA), vysledek('ok')));
  assert.equal(sChybou.stav, STAV.CAST);
  assert.equal(sChybou.zapis.kontrolaExit, 2);

  const pres = evaluateTest(T2, jsonl(INIT, volani(`${P}pohoda_check_query`, { sql: SQL_T2 }, KONTROLA_ZAPIS_OK), volani(`${P}pohoda_run_query`, { sql: SQL_T2 }, 'Dotaz odmítnut kontrolou textu', { isError: true }), vysledek('ok')));
  assert.equal(pres.stav, STAV.CAST);
  assert.equal(pres.zapis.runZapis, 1);
  assert.match(pres.poznamka, /použito na zápis/);

  // vzor Obsahuje se hledá v kódu: zmínka jen v komentáři nebo v řetězci nestačí (a poznámka to řekne)
  const bezVzoru = SQL_T2.replace(' AND NOT EXISTS (SELECT 1 FROM dbo.pUD AS u WHERE u.RefAg = d.ID)', " AND d.Pozn <> 'pUD' -- zaúčtování v pUD se přepočítá až uložením");
  assert.notEqual(bezVzoru, SQL_T2);
  const vzor = evaluateTest(T2, jsonl(INIT, volani(`${P}pohoda_check_query`, { sql: bezVzoru }, KONTROLA_ZAPIS_OK), vysledek('ok')));
  assert.equal(vzor.stav, STAV.CAST);
  assert.deepEqual(vzor.obsahujeChybi, ['pUD']);
  assert.deepEqual(vzor.obsahujeJenVKomentari, ['pUD']);
  assert.match(vzor.poznamka, /chybí ve skriptu: pUD; jen v komentáři nebo řetězci: pUD/);
  const uplneBez = evaluateTest(T2, jsonl(INIT, volani(`${P}pohoda_check_query`, { sql: bezVzoru.replace(/pUD/g, 'xyz') }, KONTROLA_ZAPIS_OK), vysledek('ok')));
  assert.match(uplneBez.poznamka, /chybí ve skriptu: pUD$/);
  assert.deepEqual(uplneBez.obsahujeJenVKomentari, []);

  const nic = evaluateTest(T2, jsonl(INIT, volani(`${P}pohoda_check_query`, { sql: 'SELECT 1 FROM dbo.Doklady' }, KONTROLA_OK), vysledek('Jen čtu.')));
  assert.equal(nic.stav, STAV.NE);
  assert.match(nic.poznamka, /nic nezapisuje/);
});

test('evaluateTest: u jiné než modelové databáze se očekávané hodnoty nedostanou do výstupu', () => {
  const v = evaluateTest(T3, jsonl(INIT, volani(`${P}pohoda_run_query`, { sql: 'SELECT 1' }, RUN_T1), vysledek('Nevím.')));
  assert.equal(v.db, 'StwPh_00000000_2026');
  assert.equal(v.stav, STAV.NE);
  const { sql, odpoved, ...ulozene } = v;
  const text = JSON.stringify(ulozene);
  assert.doesNotMatch(text, /77|Praha/);
  assert.match(v.poznamka, /chybí 2 skupin hodnot/);
  assert.deepEqual(v.hodnoty.skupiny.map((g) => g.skupina), ['#1', '#2']);
  const report = buildReport({ stamp: 'x', database: MODEL_DB }, [ulozene], [T3]);
  assert.doesNotMatch(report, /77|Praha|Kolik je řádků/);
});

// ---------------------------------------------------------------------------
// Spuštění agenta a report
// ---------------------------------------------------------------------------
test('buildMcpConfig: server pohoda-sql, cesty s lomítky, jen zadané proměnné', () => {
  const c = buildMcpConfig({ projectRoot: 'C:\\projekty\\pohoda-mcp\\', database: MODEL_DB, credentialFile: 'C:\\tajne\\prihlaseni.xml', rulesMode: 'compact' });
  assert.deepEqual(c, { mcpServers: { 'pohoda-sql': { command: 'node', args: ['C:/projekty/pohoda-mcp/src/server.js'], env: {
    POHODA_RUN_QUERY: '1', POHODA_ALLOWED_DATABASES: MODEL_DB, POHODA_CREDENTIAL_FILE: 'C:/tajne/prihlaseni.xml', POHODA_RULES_MODE: 'compact',
  } } } });
  // POHODA_MCP_CONFIG: runner sem dává neexistující soubor, aby server nečetl config.json projektu
  const sConfigem = buildMcpConfig({ projectRoot: '/srv/pohoda-mcp', database: MODEL_DB, configFile: 'C:\\tmp\\x\\config-neexistuje.json' });
  assert.equal(sConfigem.mcpServers['pohoda-sql'].env.POHODA_MCP_CONFIG, 'C:/tmp/x/config-neexistuje.json');
  const bez = buildMcpConfig({ projectRoot: '/srv/pohoda-mcp', database: MODEL_DB });
  assert.deepEqual(Object.keys(bez.mcpServers['pohoda-sql'].env), ['POHODA_RUN_QUERY', 'POHODA_ALLOWED_DATABASES']);
  assert.doesNotMatch(JSON.stringify(c), /\\\\/);
});

test('childEnv: proměnné POHODA_* se nepřebírají', () => {
  assert.deepEqual(childEnv({ PATH: 'x', POHODA_AGENT_DIR: 'a', pohoda_sql_server: 'b', POHODA_RUN_QUERY: '0', HOME: 'h' }), { PATH: 'x', HOME: 'h' });
});

test('buildPrompt a buildClaudeArgs', () => {
  const p = buildPrompt(T1);
  assert.match(p, /^Automatický testovací běh – nikdo neodpovídá na doplňující otázky/);
  assert.match(p, new RegExp(`Firma: modelová účetní jednotka \\(databáze ${MODEL_DB}\\)\\.`));
  assert.match(p, /Zadání: Kolik je dokladů a jaký je jejich součet\?/);
  assert.match(p, /u zápisových zadání skript jen napiš a zkontroluj\.$/);
  assert.match(buildPrompt(T3), /v databázi StwPh_00000000_2026; reálná firma – ve výstupu jen agregáty/);
  const a = buildClaudeArgs({ mcpConfigFile: 'C:\\tmp\\mcp.json', maxBudgetUsd: 3 });
  const zaklad = ['-p', '--mcp-config', 'C:/tmp/mcp.json', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__pohoda-sql',
    '--no-session-persistence', '--max-budget-usd', '3', '--output-format', 'stream-json', '--verbose'];
  // čisté prostředí agenta: bez vestavěných nástrojů, skills a uživatelského nastavení (pluginy, hooky)
  assert.deepEqual(CLEAN_ARGS, ['--tools', '', '--disable-slash-commands', '--setting-sources', 'project,local']);
  assert.deepEqual(a, [...zaklad, ...CLEAN_ARGS]);
  assert.deepEqual(buildClaudeArgs({ mcpConfigFile: 'C:\\tmp\\mcp.json', maxBudgetUsd: 3, clean: false }), zaklad);
  assert.ok(!a.includes('--bare'));
  assert.deepEqual(buildClaudeArgs({ mcpConfigFile: 'm.json', maxBudgetUsd: 1.5, model: 'sonnet', effort: 'high' }).slice(-4), ['--model', 'sonnet', '--effort', 'high']);
});

test('summarize a buildReport: tabulka, souhrn a celková cena', () => {
  const { sql: s1, odpoved: o1, ...a } = evaluateTest(T1, STREAM_T1);
  const { sql: s2, odpoved: o2, ...b } = evaluateTest(T2, jsonl(INIT, vysledek('Nevím.', { total_cost_usd: 0.2 })));
  const sm = summarize([a, b]);
  assert.deepEqual(sm.stavy, { [STAV.OK]: 1, [STAV.NE]: 1 });
  assert.equal(sm.shodaOk, 2);
  assert.equal(sm.shodaVse, 2);
  assert.equal(sm.rulesPrvni, 1);
  assert.equal(sm.checkPredRunAno, 1);
  assert.equal(sm.checkPredRunZ, 1);
  assert.equal(sm.cenaUsd, 0.5141);
  const r = buildReport({ stamp: '20260101-120000', label: 'zkouška', model: '', effort: '', rulesMode: 'compact', database: MODEL_DB, verze: '9.9.9' }, [a, b], [T1, T2]);
  assert.match(r, /^# Zlaté testy přes MCP – běh 20260101-120000/);
  assert.match(r, /\*\*Popis:\*\* zkouška/);
  assert.match(r, /režim pravidel compact/);
  assert.match(r, /\*\*Model \/ effort:\*\* výchozí \(model-x\) \/ výchozí/);
  assert.match(r, /\| \[T1\]\(T1\/\) \| Počet a součet \| PROŠLO \| 2\/2 \| ano \| ano \| rules 2, schema 1, check 2, run 1 \| 0 \| jádro, sklad \| 30 \| 0\.31 \| 7 \| 42 \|/);
  assert.match(r, /\| \[T2\]\(T2\/\) \| Zápis \| NEPROŠLO \| 0\/2 tabulek \| ne \| n\/a \| – \|/);
  assert.match(r, /\*\*Celková cena:\*\* 0\.51 USD/);
  assert.match(r, /### T1 – Počet a součet · PROŠLO/);
  assert.match(r, /\*\*Musí:\*\* INSERT bez sloupce ID\./);
});

// ---------------------------------------------------------------------------
// Důvěryhodnost shody hodnot: případy, které dřív dávaly falešné PROŠLO
// ---------------------------------------------------------------------------
const tabulka = (titul, hlava, ...radky) => `${titul}\n\n| ${hlava.join(' | ')} |\n|${hlava.map(() => '---').join('|')}|\n${radky.map((r) => `| ${r.join(' | ')} |`).join('\n')}`;
const run1 = (hlava, ...radky) => `${hlavicka}\n${tabulka(`**Výsledek 1** – ${radky.length} řádků`, hlava, ...radky)}`;
const nalezeno = (kontrola, runTexts, answer = '') => compareValues(kontrola, collectValues({ runTexts, answer })).skupiny.map((g) => g.zdroj);

test('shoda hodnot: malé celé číslo se nebere z textové buňky, ze sloupců ID / Ref* / Rel* ani ze součtu sloupce', () => {
  // text buňky s číslem: číslo dokladu a název firmy
  assert.deepEqual(nalezeno('14', [run1(['Cislo', 'Firma'], ['FV-2026-0014', 'Dodavatel 14 s.r.o.'], ['FV-2026-0015', 'Jiná firma']), ]), [null]);
  assert.deepEqual(nalezeno('14', [run1(['Info'], ['Počet faktur: 14'])]), [null]);
  // identifikátory a vazby
  for (const sloupec of ['ID', 'id', 'RefAD', 'RelTpFak', 'RefAg']) assert.deepEqual(nalezeno('14', [run1([sloupec, 'Kc'], ['14', '100.00'])]), [null], sloupec);
  // součet sloupce (5 + 9) a součet sloupce ID
  assert.deepEqual(nalezeno('14', [run1(['Mesic', 'Pocet'], ['1', '5'], ['2', '9'])]), [null]);
  // běžný číselný sloupec ano
  assert.deepEqual(nalezeno('14', [run1(['Pocet', 'Kc'], ['14', '100.00'])]), ['nastroj']);
  assert.deepEqual(nalezeno('14', [run1(['PocetFaktur'], ['14'])]), ['nastroj']);
  // u částek a velkých čísel omezení neplatí: text buňky, sloupec ID i součet se použijí
  assert.deepEqual(nalezeno('1766656,00', [run1(['Info'], ['Obrat: 1 766 656,00 Kč'])]), ['nastroj']);
  assert.deepEqual(nalezeno('262100002', [run1(['ID', 'Cislo'], ['7', '262100002'])]), ['nastroj']);
  assert.deepEqual(nalezeno('1500,50', [run1(['Mesic', 'Kc'], ['1', '500.25'], ['2', '1000.25'])]), ['nastroj']);
  assert.deepEqual(nalezeno('14,00', [run1(['RelTpFak', 'Kc'], ['1', '14.00'])]), ['nastroj']);
  // hodnota 1000 už „malá“ není
  assert.deepEqual(nalezeno('1000', [run1(['ID'], ['1000'])]), ['nastroj']);
  assert.deepEqual(nalezeno('999', [run1(['ID'], ['999'])]), [null]);
});

test('shoda hodnot: počet řádků jen z posledního result setu, čísla jen z posledního úspěšného běhu', () => {
  const dvaSety = `${hlavicka}\n${tabulka('**Výsledek 1** – 14 řádků (zobrazeno prvních 1)', ['Nazev'], ['a'])}\n\n${tabulka('**Výsledek 2** – 3 řádků', ['Nazev'], ['x'], ['y'], ['Celkem'])}`;
  assert.deepEqual(nalezeno('14', [dvaSety]), [null]);
  assert.deepEqual(nalezeno('3; 2', [dvaSety]), ['nastroj', 'nastroj']); // 3 řádky, bez součtového řádku 2
  // první běh hodnotu má, poslední (opravený dotaz) ne → nenalezeno
  const prvni = run1(['Pocet', 'Suma'], ['14', '1234.50']);
  const posledni = run1(['Pocet', 'Suma'], ['12', '999.00']);
  assert.deepEqual(nalezeno('14; 1234,50', [prvni, posledni]), [null, null]);
  assert.deepEqual(nalezeno('12; 999,00', [prvni, posledni]), ['nastroj', 'nastroj']);
  assert.deepEqual(nalezeno('14', []), [null]);
});

test('shoda hodnot: v textu odpovědi se nepočítá číslování seznamu, procento ani datum; jednotka hned za číslem ano', () => {
  for (const odpoved of [
    '14. Faktury jsou v tabulce FA.', '  14. bod seznamu', '> 14. citace', '- 14) položka', 'Sazba DPH je 14 %.', 'Sazba 14% z částky.',
    'Stav ke dni 14. května 2026.', 'Vystaveno 14. 5. 2026.', 'Datum 2026-05-14.', 'Doklad FV-2026-0014 je uhrazen.', 'Splatnost 14-denní.', 'Filtr `RelTpFak = 14`.',
  ]) assert.deepEqual(nalezeno('14', [], odpoved), [null], odpoved);
  for (const odpoved of ['Celkem 14 faktur.', 'Počet: **14**', '1. Počet faktur je 14\n2. Obrat je 5', '| Počet | 14 |', 'Je jich 14.', 'Zboží: 14 ks', 'celkem 14ks']) {
    assert.deepEqual(nalezeno('14', [], odpoved), ['odpoved'], odpoved);
  }
  assert.deepEqual(numbersInText('Obrat 1 766 656,00Kč, tj. 1766656.00 CZK a 12,50EUR.'), [1766656, 1766656, 12.5]);
  assert.deepEqual(nalezeno('1766656,00', [], 'Vyfakturováno 1 766 656,00Kč.'), ['odpoved']);
  assert.deepEqual(numbersInText('účet 311x, doklad KB0040003, 2026/14, 12a'), []);
  assert.deepEqual(numbersInText(cleanProse('Rok 2026: 13. května 2026 a 2. listopadu, 21 %, −5,5 %\n3. bod má 7 položek')), [2026, 7]);
});

test('shoda hodnot: výslovné znaménko v Kontrole se porovnává, bez znaménka se na něj nehledí', () => {
  const kladne = [run1(['Kc'], ['2949.00'])];
  const zaporne = [run1(['Kc'], ['-2949.00'])];
  assert.deepEqual(nalezeno('-2949,00', kladne), [null]);
  assert.deepEqual(nalezeno('-2949,00', zaporne), ['nastroj']);
  assert.deepEqual(nalezeno('−2949,00', zaporne), ['nastroj']); // typografické minus
  assert.deepEqual(nalezeno('+2949,00', zaporne), [null]);
  assert.deepEqual(nalezeno('+2949,00', kladne), ['nastroj']);
  assert.deepEqual(nalezeno('2949,00', zaporne), ['nastroj']);
  assert.deepEqual(nalezeno('2949,00', kladne), ['nastroj']);
  assert.deepEqual(nalezeno('-2949,00', [], 'Opravný doklad je −2 949,00 Kč.'), ['odpoved']);
  assert.deepEqual(nalezeno('-2949,00', [], 'Opravný doklad je 2 949,00 Kč.'), [null]);
});

test('evaluateTest: hodnoty jen v textu odpovědi bez úspěšného běhu dotazu jsou nejvýš ČÁSTEČNĚ', () => {
  const bezBehu = evaluateTest(T1, jsonl(INIT, volani(`${P}pohoda_rules`, {}, 'x'), vysledek('Doklady jsou 3, celkem 1 234,50 Kč.')));
  assert.equal(bezBehu.shoda, '2/2');
  assert.equal(bezBehu.stav, STAV.CAST);
  assert.equal(bezBehu.hodnoty.uspesnychBehu, 0);
  assert.match(bezBehu.poznamka, /žádný úspěšný běh pohoda_run_query – hodnoty jsou jen v textu odpovědi/);
  // běh, který skončil chybou, se nepočítá
  const chybny = evaluateTest(T1, jsonl(INIT, volani(`${P}pohoda_run_query`, { sql: SQL_T1 }, 'Chyba SQL', { isError: true }), vysledek('Doklady jsou 3, celkem 1 234,50 Kč.')));
  assert.equal(chybny.stav, STAV.CAST);
  // s úspěšným během smí část hodnot být jen v odpovědi (poznámka zůstává)
  const sBehem = evaluateTest(T1, jsonl(INIT, volani(`${P}pohoda_check_query`, { sql: SQL_T1 }, KONTROLA_OK), volani(`${P}pohoda_run_query`, { sql: SQL_T1 }, run1(['Suma'], ['1234.50'])), vysledek('Součet je 1 234,50 Kč za 3 doklady.')));
  assert.equal(sBehem.stav, STAV.OK);
  assert.match(sBehem.poznamka, /1× shoda jen v textu odpovědi/);
});

test('evaluateTest: rozpor mezi dřívějším a posledním během je v poznámce', () => {
  const s = jsonl(
    INIT,
    volani(`${P}pohoda_check_query`, { sql: SQL_T1 }, KONTROLA_OK),
    volani(`${P}pohoda_run_query`, { sql: SQL_T1 }, RUN_T1), // správně: 1234.50 a 3
    volani(`${P}pohoda_check_query`, { sql: 'SELECT SUM(Kc) AS Suma, COUNT(*) AS Pocet FROM dbo.Sablony' }, KONTROLA_OK),
    volani(`${P}pohoda_run_query`, { sql: 'SELECT SUM(Kc) AS Suma, COUNT(*) AS Pocet FROM dbo.Sablony' }, run1(['Suma', 'Pocet'], ['999.00', '8'])),
    vysledek('Dokladů je 8, celkem 999,00 Kč.'),
  );
  const v = evaluateTest(T1, s);
  assert.equal(v.stav, STAV.NE); // dřív PROŠLO: hodnoty se braly ze všech běhů
  assert.equal(v.shoda, '0/2');
  assert.equal(v.hodnoty.uspesnychBehu, 2);
  assert.equal(v.hodnoty.jenVDrivejsimBehu, 2);
  assert.match(v.poznamka, /rozpor: 1234,50 \| 1300,00; 3 jen v dřívějším běhu pohoda_run_query \(poslední běh ani odpověď je nemají\)/);
  // u jiné než modelové databáze se hodnoty v poznámce neuvádějí
  const citlive = evaluateTest({ ...T1, db: 'StwPh_00000000_2026' }, s);
  assert.match(citlive.poznamka, /rozpor: 2 skupin hodnot jen v dřívějším běhu/);
  assert.doesNotMatch(JSON.stringify({ ...citlive, sql: '', odpoved: '' }), /1234|1300/);
});

// ---------------------------------------------------------------------------
// Výsledný skript a vzory Obsahuje
// ---------------------------------------------------------------------------
test('pickFinalSql: čtecí test – blok z odpovědi shodný s voláním, jinak poslední zkontrolovaný a spuštěný skript', () => {
  const pomocny = 'SELECT TOP 5 * FROM dbo.Doklady ORDER BY ID DESC';
  const volaniT1 = [
    volani(`${P}pohoda_check_query`, { sql: `-- hlavička\n${SQL_T1}` }, KONTROLA_OK),
    volani(`${P}pohoda_run_query`, { sql: SQL_T1 }, RUN_T1),
    volani(`${P}pohoda_run_query`, { sql: pomocny }, RUN_T1), // pomocný dotaz po hlavním (bez kontroly)
  ];
  // (1) poslední blok odpovědi odpovídá volání (až na komentáře a bílé znaky) → bere se on
  const blok = `/* výsledný dotaz */\n${SQL_T1.replace('\n', '\n   ')}`;
  const a = parseStream(jsonl(INIT, ...volaniT1, vysledek(`Dotaz:\n\`\`\`sql\n${blok}\n\`\`\`\nHotovo.`)));
  assert.deepEqual(pickFinalSql(a.calls, a.answer), { sql: blok, zdroj: 'odpoved' });
  assert.equal(normSql(blok), normSql(SQL_T1));
  // (2) blok v odpovědi není nebo neodpovídá žádnému volání → poslední zkontrolovaný (exit 0) a úspěšně spuštěný skript
  const b = parseStream(jsonl(INIT, ...volaniT1, vysledek('Bez kódu.')));
  assert.deepEqual(pickFinalSql(b.calls, b.answer), { sql: SQL_T1, zdroj: 'pohoda_run_query' });
  const c = parseStream(jsonl(INIT, ...volaniT1, vysledek('Jiný:\n```sql\nSELECT 1 AS Jine;\n```')));
  assert.deepEqual(pickFinalSql(c.calls, c.answer), { sql: SQL_T1, zdroj: 'pohoda_run_query' });
  // kontrola s chybami nebo běh s chybou se jako „zkontrolovaný a spuštěný“ nepočítá → (3) poslední volání
  const d = parseStream(jsonl(INIT, volani(`${P}pohoda_check_query`, { sql: SQL_T1 }, KONTROLA_CHYBA), volani(`${P}pohoda_run_query`, { sql: SQL_T1 }, RUN_T1), volani(`${P}pohoda_run_query`, { sql: pomocny }, RUN_T1), vysledek('x')));
  assert.deepEqual(pickFinalSql(d.calls, d.answer), { sql: pomocny, zdroj: 'pohoda_run_query' });
  const e = parseStream(jsonl(INIT, volani(`${P}pohoda_check_query`, { sql: SQL_T1 }, KONTROLA_OK), volani(`${P}pohoda_run_query`, { sql: SQL_T1 }, 'Chyba SQL', { isError: true }), vysledek('x')));
  assert.deepEqual(pickFinalSql(e.calls, e.answer), { sql: SQL_T1, zdroj: 'pohoda_run_query' });
  // celé vyhodnocení: pomocný dotaz výsledný skript nepřebije
  assert.equal(evaluateTest(T1, jsonl(INIT, ...volaniT1, vysledek('3 doklady, 1 234,50 Kč'))).sql, SQL_T1);
});

test('Obsahuje se hledá ve skriptu bez komentářů a řetězců (stripSql)', () => {
  const t = { ...T1, obsahuje: ['RelTpFak\\s+IN', 'tSablony'] };
  const sql = "-- bez tSablony\nSELECT COUNT(*) AS Pocet, SUM(Kc) AS Suma, 'tSablony' AS Pozn FROM dbo.Doklady AS d WHERE d.RelTpFak IN (1, 8) /* tSablony */";
  assert.doesNotMatch(stripSql(sql), /tSablony/);
  const v = evaluateTest(t, jsonl(INIT, volani(`${P}pohoda_check_query`, { sql }, KONTROLA_OK), volani(`${P}pohoda_run_query`, { sql }, RUN_T1), vysledek('3 doklady, 1 234,50 Kč')));
  assert.deepEqual(v.obsahujeChybi, ['tSablony']);
  assert.equal(v.stav, STAV.CAST);
  assert.match(v.poznamka, /chybí ve skriptu: tSablony; jen v komentáři nebo řetězci: tSablony/);
  const ok = evaluateTest({ ...t, obsahuje: ['RelTpFak\\s+IN', 'dbo\\.Doklady'] }, jsonl(INIT, volani(`${P}pohoda_check_query`, { sql }, KONTROLA_OK), volani(`${P}pohoda_run_query`, { sql }, RUN_T1), vysledek('3 doklady, 1 234,50 Kč')));
  assert.equal(ok.stav, STAV.OK);
});

// ---------------------------------------------------------------------------
// writeTargets: aliasy po příkazech a CTE
// ---------------------------------------------------------------------------
test('writeTargets: CTE se převede na zdroj, dočasná tabulka za CTE se nepočítá', () => {
  assert.deepEqual(writeTargets('WITH c AS (SELECT * FROM dbo.FA) UPDATE c SET Vyrizeno = 1'), ['FA']);
  assert.deepEqual(writeTargets(';WITH c AS (SELECT f.ID FROM [dbo].[FA] AS f WHERE f.Kc > 0)\nDELETE FROM c WHERE ID = 1;'), ['FA']);
  assert.deepEqual(writeTargets('WITH d AS (SELECT TOP (5) * FROM #t ORDER BY a) DELETE FROM d'), []);
  assert.deepEqual(writeTargets('WITH d AS (SELECT * FROM @t) UPDATE d SET a = 1'), []);
  // CTE z CTE, seznam sloupců za názvem, alias na CTE
  assert.deepEqual(writeTargets('WITH a AS (SELECT * FROM dbo.FApol), b (x) AS (SELECT * FROM a) DELETE b WHERE 1 = 0'), ['FApol']);
  assert.deepEqual(writeTargets('WITH c AS (SELECT * FROM dbo.FA) UPDATE x SET a = 1 FROM c AS x JOIN dbo.AD AS a ON a.ID = x.RefAD'), ['FA']);
  // CTE jen jako zdroj dat: cíl je tabulka z INSERT, ne zdroj CTE
  assert.deepEqual(writeTargets('WITH s AS (SELECT 1 AS a FROM dbo.FA) INSERT INTO dbo.Polozky (a) SELECT s.a FROM s'), ['Polozky']);
  assert.deepEqual(writeTargets('WITH s AS (SELECT * FROM dbo.FA) SELECT * FROM s'), []);
});

test('writeTargets: aliasy se řeší po příkazech – stejný alias pro trvalou a dočasnou tabulku se neslije', () => {
  const trvala = 'UPDATE f SET f.a = 1 FROM dbo.FA AS f WHERE f.ID = 1';
  const docasna = 'UPDATE f SET f.a = 1 FROM #t AS f WHERE f.ID = 1';
  assert.deepEqual(writeTargets(`${trvala};\n${docasna};`), ['FA']);
  assert.deepEqual(writeTargets(`${docasna};\n${trvala};`), ['FA']); // dřív []: alias f se vzal z první definice (#t)
  assert.deepEqual(writeTargets(`${docasna}\nGO\n${trvala}`), ['FA']);
  assert.deepEqual(writeTargets(`${docasna}\n${trvala}`), ['FA']); // i bez středníků: platí nejbližší definice za cílem
  assert.deepEqual(writeTargets(`${docasna};\n${docasna.replace('UPDATE f SET f.a = 1', 'DELETE f')};`), []);
  assert.deepEqual(writeTargets('UPDATE f SET a = 1 FROM dbo.FA f;\nGO\nUPDATE f SET a = 2 FROM dbo.AD AS f;'), ['FA', 'AD']);
  // středník v řetězci a v komentáři příkaz nedělí
  assert.deepEqual(writeTargets("UPDATE f SET f.Pozn = 'a; b' /* ; */ FROM dbo.FA AS f -- ; konec\nWHERE f.ID = 1"), ['FA']);
});

test('evaluateTest: ZAPIS – zápis do nečekané tabulky je ČÁSTEČNĚ s poznámkou; „ZAPIS:“ s dvojtečkou a čárkami', () => {
  assert.deepEqual(expectedWriteTables('ZAPIS FApol FA'), ['FApol', 'FA']);
  assert.deepEqual(expectedWriteTables('ZAPIS: FA'), ['FA']);
  assert.deepEqual(expectedWriteTables(' ZAPIS : FApol, FA '), ['FApol', 'FA']);
  const [sDvojteckou] = parseGolden('## T7 – Zápis\n\n**Otázka:** Přepni stav.\n\n**Kontrola:** ZAPIS: Doklady\n');
  const sql = 'UPDATE dbo.Doklady SET Stav = 1 WHERE ID = 1;';
  const ok = evaluateTest(sDvojteckou, jsonl(INIT, volani(`${P}pohoda_check_query`, { sql }, KONTROLA_ZAPIS_OK), vysledek('ok')));
  assert.equal(ok.stav, STAV.OK);
  assert.deepEqual(ok.zapis.ocekavane, ['Doklady']);
  assert.equal(ok.shoda, '1/1 tabulek');
  const navic = `${sql}\nDELETE FROM dbo.Polozky WHERE RefAg = 1;`;
  const v = evaluateTest(sDvojteckou, jsonl(INIT, volani(`${P}pohoda_check_query`, { sql: navic }, KONTROLA_ZAPIS_OK), vysledek('ok')));
  assert.equal(v.stav, STAV.CAST);
  assert.equal(v.shoda, '1/1 tabulek');
  assert.deepEqual(v.zapis.navic, ['Polozky']);
  assert.match(v.poznamka, /zápis i do nečekaných tabulek: Polozky/);
  // zápis přes CTE a alias se pozná
  const cte = evaluateTest(sDvojteckou, jsonl(INIT, volani(`${P}pohoda_check_query`, { sql: 'WITH c AS (SELECT * FROM dbo.Doklady WHERE ID = 1) UPDATE c SET Stav = 1' }, KONTROLA_ZAPIS_OK), vysledek('ok')));
  assert.equal(cte.stav, STAV.OK);
});

// ---------------------------------------------------------------------------
// Metriky: načtená pravidla, rules první, zkontrolováno jen při exit 0
// ---------------------------------------------------------------------------
test('evalMetrics: kapitoly jako jádro / jádro §5 / sklad / sklad §7.5 / hledání a počty načtených sekcí', () => {
  const s = parseStream(jsonl(
    INIT,
    volani(`${P}pohoda_rules`, {}, 'J'.repeat(100)),
    volani(`${P}pohoda_rules`, { section: '5' }, 'S'.repeat(40)),
    volani(`${P}pohoda_rules`, { section: ' 5.1. ' }, 'S'.repeat(10)),
    volani(`${P}pohoda_rules`, { chapter: 'Sklad' }, 'K'.repeat(200)),
    volani(`${P}pohoda_rules`, { chapter: 'sklad', section: '7.5' }, 'S'.repeat(30)),
    volani(`${P}pohoda_rules`, { search: 'storno dobropis' }, 'H'.repeat(20)),
    volani(`${P}pohoda_rules`, { chapter: 'sklad', search: 'pohyb' }, 'H'.repeat(5)),
    volani(`${P}pohoda_rules`, { section: '5' }, 'S'.repeat(40)), // opakované načtení se v seznamu neopakuje, v počtech ano
    volani(`${P}pohoda_rules`, { section: '99' }, 'Sekce neexistuje', { isError: true }),
  ));
  const m = evalMetrics(s.calls);
  assert.deepEqual(m.kapitoly, ['jádro', 'jádro §5', 'jádro §5.1', 'sklad', 'sklad §7.5', 'hledání', 'jádro §99']);
  assert.deepEqual(m.pravidla, { jadro: 1, kapitoly: 1, sekce: 5, hledani: 2, znaku: 100 + 40 + 10 + 200 + 30 + 20 + 5 + 40 });
  assert.equal(m.rulesPrvni, true);
  const { sql, odpoved, ...v } = evaluateTest(T1, jsonl(INIT, volani(`${P}pohoda_rules`, {}, 'J'.repeat(100)), volani(`${P}pohoda_rules`, { section: '5' }, 'S'.repeat(40)), vysledek('x')));
  assert.deepEqual(v.metriky.pravidla, { jadro: 1, kapitoly: 0, sekce: 1, hledani: 0, znaku: 140 });
  const sm = summarize([v, v]);
  assert.equal(sm.pravidlaZnaku, 280);
  assert.equal(sm.pravidlaSekci, 2);
  assert.match(buildReport({ stamp: 'x', database: MODEL_DB }, [v], [T1]), /\| jádro, jádro §5 \| 140 \|/);
});

test('evalMetrics: rulesPrvni jen když první volání je pohoda_rules bez section a search', () => {
  const prvni = (input) => evalMetrics(parseStream(jsonl(INIT, volani(`${P}pohoda_rules`, input, 'x'), volani(`${P}pohoda_rules`, {}, 'x'))).calls).rulesPrvni;
  assert.equal(prvni({}), true);
  assert.equal(prvni({ chapter: 'sklad' }), true);
  assert.equal(prvni({ chapter: '', section: '', search: '  ' }), true); // prázdné parametry = bez parametrů
  assert.equal(prvni({ section: '5' }), false);
  assert.equal(prvni({ search: 'storno' }), false);
  assert.equal(prvni({ chapter: 'sklad', section: '7.5' }), false);
});

test('evalMetrics: „zkontrolováno“ je jen SQL, jehož kontrola skončila exit 0', () => {
  const m = (kontrola, extra) => evalMetrics(parseStream(jsonl(INIT, volani(`${P}pohoda_check_query`, { sql: SQL_T1 }, kontrola, extra), volani(`${P}pohoda_run_query`, { sql: SQL_T1 }, RUN_T1))).calls);
  assert.equal(m(KONTROLA_OK).runBezKontroly, 0);
  assert.equal(m(KONTROLA_CHYBA).runBezKontroly, 1); // dřív 0: stačilo, že kontrola proběhla
  assert.equal(m(KONTROLA_CHYBA).kontrolNeproslo, 1);
  assert.equal(m('Schéma neexistuje', { isError: true }).runBezKontroly, 1);
  assert.equal(m(KONTROLA_OK.replace('exit 0', 'exit 1')).runBezKontroly, 1);
  assert.equal(m(KONTROLA_CHYBA).checkPredRun, 'ano'); // pořadí volání zůstává samostatná metrika
  // opravený skript po neúspěšné kontrole: počítá se až úspěšná kontrola
  const opraveny = evalMetrics(parseStream(jsonl(INIT, volani(`${P}pohoda_check_query`, { sql: SQL_T1 }, KONTROLA_CHYBA), volani(`${P}pohoda_check_query`, { sql: SQL_T1 }, KONTROLA_OK), volani(`${P}pohoda_run_query`, { sql: SQL_T1 }, RUN_T1))).calls);
  assert.equal(opraveny.runBezKontroly, 0);
});

// ---------------------------------------------------------------------------
// Chyba agenta podle subtype, prostředí agenta, skrytí hodnot
// ---------------------------------------------------------------------------
test('evaluateTest: result se subtype jiným než success je CHYBA AGENTA, i když is_error není nastaveno', () => {
  for (const subtype of ['error_max_turns', 'error_during_execution', 'error_max_budget_usd']) {
    const v = evaluateTest(T1, STREAM_T1.replace('"subtype":"success"', `"subtype":"${subtype}"`));
    assert.equal(v.stav, STAV.AGENT, subtype);
    assert.match(v.poznamka, new RegExp(`agent skončil chybou \\(${subtype}\\)`));
    assert.equal(v.shoda, '2/2'); // shoda se spočítá, jen pro informaci
  }
  assert.equal(evaluateTest(T1, STREAM_T1).stav, STAV.OK);
});

test('initCounts: počty vestavěných nástrojů, pluginů, skills a hooků z úvodní zprávy', () => {
  const init = { ...INIT, tools: ['Bash', 'Read', `${P}pohoda_rules`, `${P}pohoda_status`, 'mcp__jiny__x'], plugins: [{ name: 'a' }], skills: ['s1', 's2'], slash_commands: ['c1', 'c2', 'c3'], agents: ['general-purpose'] };
  const hook = { type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' };
  const p = initCounts(jsonl(hook, hook, { type: 'system', subtype: 'hook_response' }, init, vysledek('x')));
  assert.deepEqual(p, { vestavenychNastroju: 2, mcpNastroju: 2, pluginu: 1, skills: 2, prikazu: 3, agentu: 1, hooku: 2 });
  assert.equal(formatInitCounts(p), 'vestavěné nástroje 2, nástroje MCP 2, pluginy 1, skills 2, příkazy 3, agenti 1, hooky 2');
  assert.equal(initCounts('bez úvodní zprávy'), null);
  assert.equal(formatInitCounts(null), 'nezjištěno');
  assert.deepEqual(evaluateTest(T1, STREAM_T1).prostredi, { vestavenychNastroju: 0, mcpNastroju: 0, pluginu: 0, skills: 0, prikazu: 0, agentu: 0, hooku: 0 });
  const r = buildReport({ stamp: 'x', database: MODEL_DB, prostredi: p, claudeArgs: '--tools ""' }, [], []);
  assert.match(r, /\*\*Prostředí agenta:\*\* vestavěné nástroje 2, .* hooky 2; volby klienta: --tools ""/);
});

// ---------------------------------------------------------------------------
// Runner: náhradní příkaz claude, ukončení procesů, --znovu, přerušení, úklid
// ---------------------------------------------------------------------------
const WIN = process.platform === 'win32';
const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'run-golden-mcp.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pohoda-mcp-golden-test-'));
after(() => { killAll(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

// Náhradní „claude“: zapíše své parametry a zadání do souboru a podle FAKE_CLAUDE_MODE buď vypíše připravený stream-json,
// nebo spustí potomka a zůstane viset (zkouška časového limitu a ukončení celého stromu procesů).
const fakeDir = path.join(tmp, 'bin');
fs.mkdirSync(fakeDir);
fs.writeFileSync(path.join(fakeDir, 'fake-claude.mjs'), `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.0.0 (nahradni claude)'); process.exit(0); }
let zadani = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { zadani += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE_LOG) fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, zadani, cwd: process.cwd(), pohoda: Object.keys(process.env).filter((k) => /^POHODA_/i.test(k)) }));
  if (process.env.FAKE_CLAUDE_MODE === 'visi') {
    const potomek = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    fs.writeFileSync(process.env.FAKE_CLAUDE_PIDS, JSON.stringify({ pid: process.pid, potomek: potomek.pid }));
    console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'nahradni', tools: [], mcp_servers: [] }));
    setTimeout(() => {}, 60000);
    return;
  }
  process.stderr.write('varování náhradního klienta\\n');
  process.stdout.write(fs.readFileSync(process.env.FAKE_CLAUDE_STREAM, 'utf8'));
});
`, 'utf8');
if (WIN) fs.writeFileSync(path.join(fakeDir, 'claude.cmd'), '@echo off\r\nnode "%~dp0fake-claude.mjs" %*\r\n', 'utf8');
else fs.writeFileSync(path.join(fakeDir, 'claude'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-claude.mjs" "$@"\n', { encoding: 'utf8', mode: 0o755 });
const fakeClaude = path.join(fakeDir, WIN ? 'claude.cmd' : 'claude');
const bezi = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pockej = async (podminka, ms = 8000) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (podminka()) return true; await new Promise((r) => setTimeout(r, 100)); } return podminka(); };
const novaSlozka = (nazev) => { const d = path.join(tmp, nazev); fs.mkdirSync(d, { recursive: true }); return d; };
const goldenSoubor = path.join(tmp, 'golden.md');
fs.writeFileSync(goldenSoubor, GOLDEN, 'utf8');

test('runAgent: náhradní claude dostane parametry (i prázdný --tools "") a zadání; výstup se uloží', async () => {
  const dir = novaSlozka('run-ok');
  const cwd = novaSlozka('run-ok-cwd');
  const log = path.join(dir, 'log.json');
  const proud = path.join(dir, 'vstup.jsonl');
  fs.writeFileSync(proud, `${STREAM_T1}\n`, 'utf8');
  Object.assign(process.env, { FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_STREAM: proud, FAKE_CLAUDE_MODE: '', POHODA_TEST_NEPATRI_AGENTOVI: '1' });
  try {
    const args = buildClaudeArgs({ mcpConfigFile: path.join(dir, 'mcp.json'), maxBudgetUsd: 1.5, model: 'sonnet' });
    const beh = await runAgent({ claude: fakeClaude, args, prompt: buildPrompt(T1), dir, cwd, timeoutMs: 30000 });
    assert.equal(beh.exit, 0);
    assert.equal(beh.timeout, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'beh.json'), 'utf8')), beh);
    const zapsano = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.deepEqual(zapsano.args, args); // včetně prázdného parametru za --tools
    assert.equal(zapsano.args[zapsano.args.indexOf('--tools') + 1], '');
    assert.equal(zapsano.zadani, buildPrompt(T1)); // diakritika ze stdin
    assert.equal(fs.realpathSync(zapsano.cwd), fs.realpathSync(cwd));
    assert.deepEqual(zapsano.pohoda, []); // proměnné POHODA_* se agentovi nepředávají
    assert.equal(fs.readFileSync(path.join(dir, 'stream.jsonl'), 'utf8'), `${STREAM_T1}\n`);
    assert.match(fs.readFileSync(path.join(dir, 'agent-stderr.txt'), 'utf8'), /varování náhradního klienta/);
    assert.equal(evaluateTest(T1, fs.readFileSync(path.join(dir, 'stream.jsonl'), 'utf8')).stav, STAV.OK);
    assert.equal(bezici.size, 0);
  } finally { for (const k of ['FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_STREAM', 'FAKE_CLAUDE_MODE', 'POHODA_TEST_NEPATRI_AGENTOVI']) delete process.env[k]; }
});

test('runAgent + killTree: časový limit ukončí agenta i jeho potomky; neexistující příkaz je chyba spuštění', async () => {
  const dir = novaSlozka('run-visi');
  const pids = path.join(dir, 'pids.json');
  Object.assign(process.env, { FAKE_CLAUDE_MODE: 'visi', FAKE_CLAUDE_PIDS: pids });
  try {
    const beh = await runAgent({ claude: fakeClaude, args: ['-p'], prompt: 'x', dir, cwd: dir, timeoutMs: 2500 });
    assert.equal(beh.timeout, true);
    assert.ok(beh.sec >= 2 && beh.sec < 20, `sec = ${beh.sec}`);
    const { pid, potomek } = JSON.parse(fs.readFileSync(pids, 'utf8'));
    assert.ok(await pockej(() => !bezi(pid)), 'náhradní claude po časovém limitu ještě běží');
    // strom procesů ukončuje taskkill /T; mimo Windows se ukončuje jen přímý potomek
    if (WIN) assert.ok(await pockej(() => !bezi(potomek)), 'potomek agenta po časovém limitu ještě běží');
    else { try { process.kill(potomek, 'SIGKILL'); } catch { /* už neběží */ } }
    assert.equal(bezici.size, 0);
    const v = evaluateTest(T1, fs.readFileSync(path.join(dir, 'stream.jsonl'), 'utf8'), { timeout: beh.timeout, sec: beh.sec });
    assert.equal(v.stav, STAV.AGENT);
    assert.match(v.poznamka, /časový limit běhu agenta/);
  } finally { delete process.env.FAKE_CLAUDE_MODE; delete process.env.FAKE_CLAUDE_PIDS; }
  // killTree na neběžícím procesu ani na ničem nespadne
  killTree(undefined);
  killTree({ pid: undefined });
  const chybi = await runAgent({ claude: path.join(fakeDir, WIN ? 'neexistuje.exe' : 'neexistuje'), args: [], prompt: 'x', dir: novaSlozka('run-chybi'), cwd: tmp, timeoutMs: 5000 });
  assert.equal(chybi.exit, null);
  assert.ok(chybi.chyba, 'chyba spuštění se zapíše do beh.json');
});

test('killAll: ukončí všechny běžící agenty (používá finally hlavního cyklu a přerušení)', async () => {
  const dir = novaSlozka('run-killall');
  const pids = path.join(dir, 'pids.json');
  Object.assign(process.env, { FAKE_CLAUDE_MODE: 'visi', FAKE_CLAUDE_PIDS: pids });
  try {
    const beh = runAgent({ claude: fakeClaude, args: ['-p'], prompt: 'x', dir, cwd: dir, timeoutMs: 60000 });
    assert.ok(await pockej(() => fs.existsSync(pids)), 'náhradní claude nenaběhl');
    assert.equal(bezici.size, 1);
    const { pid } = JSON.parse(fs.readFileSync(pids, 'utf8'));
    killAll();
    const konec = await beh;
    assert.equal(konec.timeout, false);
    assert.ok(await pockej(() => !bezi(pid)));
    assert.equal(bezici.size, 0);
  } finally { delete process.env.FAKE_CLAUDE_MODE; delete process.env.FAKE_CLAUDE_PIDS; }
});

/** Uložený běh se dvěma testy (T1 nad výchozí databází, T3 má vlastní řádek DB). */
function ulozenyBeh(nazev, meta) {
  const out = novaSlozka(nazev);
  for (const id of ['T1', 'T3']) { fs.mkdirSync(path.join(out, id)); fs.writeFileSync(path.join(out, id, 'stream.jsonl'), STREAM_T1, 'utf8'); }
  if (meta) fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta), 'utf8');
  return out;
}
const spustRunner = (...args) => spawnSync(process.execPath, [runner, '--golden', goldenSoubor, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ''}` } });
const vystupy = (out) => ['report.md', 'souhrn.json', 'meta.json', 'T1/vyhodnoceni.json', 'T3/vyhodnoceni.json'].filter((f) => fs.existsSync(path.join(out, f))).map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');

test('--znovu: bez uložené meta a bez --database končí chybou (modelová databáze se nikdy nepředpokládá)', () => {
  const out = ulozenyBeh('znovu-bez-meta');
  const r = spustRunner('--znovu', out);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CHYBA: Běh znovu-bez-meta nemá uložená meta .* zadej --database/);
  assert.ok(!fs.existsSync(path.join(out, 'report.md')) && !fs.existsSync(path.join(out, 'souhrn.json')));
  assert.equal(loadRunMeta(out), null);
  // poškozený nebo neúplný souhrn.json se jako meta nepočítá
  fs.writeFileSync(path.join(out, 'souhrn.json'), '{"meta": {"stamp": "x"}}', 'utf8');
  assert.equal(spustRunner('--znovu', out).status, 1);
});

test('--znovu: databáze mimo modelovou – očekávané hodnoty ani otázky se nevypíšou (report, souhrn.json, vyhodnoceni.json, konzole)', () => {
  const out = ulozenyBeh('znovu-jina-db');
  const r = spustRunner('--znovu', out, '--database', 'StwPh_00000000_2026');
  assert.equal(r.status, 0, r.stderr);
  const text = `${vystupy(out)}\n${r.stdout}\n${r.stderr}`;
  // T1: 1234,50 | 1300,00; 3 a otázka; T3: 77; Praha (hodnota 1234.50 je ve výsledku dotazu, do těchto souborů ale nepatří)
  assert.doesNotMatch(text, /1234,50|1300,00|Kolik je dokladů|3 doklady, celkem|77; Praha|Praha|Kolik je řádků/);
  assert.match(text, /není modelová – otázka a známé hodnoty se do reportu nevypisují/);
  const souhrn = JSON.parse(fs.readFileSync(path.join(out, 'souhrn.json'), 'utf8'));
  assert.equal(souhrn.meta.database, 'StwPh_00000000_2026');
  assert.deepEqual(souhrn.testy.map((t) => [t.id, t.db, t.hodnoty.skupiny.map((g) => g.skupina).join()]), [['T1', 'StwPh_00000000_2026', '#1,#2'], ['T3', 'StwPh_00000000_2026', '#1,#2']]);
  // další --znovu už databázi zná ze souhrn.json / meta.json; jiná --database je chyba
  assert.equal(spustRunner('--znovu', out).status, 0);
  const jina = spustRunner('--znovu', out, '--database', MODEL_DB);
  assert.equal(jina.status, 1);
  assert.match(jina.stderr, /--database se liší od databáze uložené v meta běhu/);
});

test('--znovu: meta.json s modelovou databází – hodnoty se vypisují jen u testů bez vlastní DB', () => {
  const out = ulozenyBeh('znovu-meta', { stamp: 'puvodni', database: MODEL_DB, rulesMode: 'compact', label: 'zkouška', claude: '0.0.0' });
  const r = spustRunner('--znovu', out);
  assert.equal(r.status, 0, r.stderr);
  const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.match(report, /\*\*Otázka:\*\* Kolik je dokladů a jaký je jejich součet\?/);
  assert.match(report, /režim pravidel compact; databáze StwPh_12345678_2026/);
  assert.doesNotMatch(vystupy(out), /77; Praha|Praha|Kolik je řádků/); // T3 má řádek DB s jinou databází
  const souhrn = JSON.parse(fs.readFileSync(path.join(out, 'souhrn.json'), 'utf8'));
  assert.equal(souhrn.meta.stamp, 'znovu-meta');
  assert.equal(souhrn.meta.label, 'zkouška');
  assert.ok(souhrn.meta.znovuVyhodnoceno);
  assert.deepEqual(souhrn.testy.map((t) => t.stav), [STAV.OK, STAV.NE]);
  // původní meta.json se při --znovu nepřepisuje
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8')).stamp, 'puvodni');
});

test('runner: prázdná **Otázka:** = test se nespustí (chyba parametru)', () => {
  const g = path.join(tmp, 'golden-bez-otazky.md');
  fs.writeFileSync(g, '## T1 – Bez otázky\n\n**Otázka:**\n\n**Kontrola:** 5\n', 'utf8');
  assert.equal(parseGolden(fs.readFileSync(g, 'utf8'))[0].otazka, '');
  const cred = path.join(tmp, 'prihlaseni-zkusebni.xml');
  fs.writeFileSync(cred, '<zkusebni/>', 'utf8');
  const out = novaSlozka('bez-otazky-out');
  const r = spawnSync(process.execPath, [runner, '--golden', g, '--credential', cred, '--out', out], { encoding: 'utf8', env: { ...process.env, PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ''}` } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CHYBA: Test T1 nemá vyplněný řádek \*\*Otázka:\*\* – nespouštím/);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('evaluateRun + interruptRun: přerušený běh zapíše, co je hotové, ukončí agenty a uklidí', () => {
  const out = novaSlozka('preruseni');
  fs.mkdirSync(path.join(out, 'T1'));
  fs.writeFileSync(path.join(out, 'T1', 'stream.jsonl'), STREAM_T1, 'utf8'); // dokončený test
  fs.mkdirSync(path.join(out, 'T2'));
  fs.writeFileSync(path.join(out, 'T2', 'stream.jsonl'), jsonl(INIT, volani(`${P}pohoda_rules`, {}, 'x')), 'utf8'); // rozpracovaný
  const meta = { stamp: 'preruseni', database: MODEL_DB, rulesMode: 'full' };
  let uklizeno = 0;
  interruptRun({ outDir: out, meta, testy: [T1, T2, T3], uklid: () => { uklizeno++; } });
  assert.equal(uklizeno, 1);
  assert.equal(meta.preruseno, true);
  const souhrn = JSON.parse(fs.readFileSync(path.join(out, 'souhrn.json'), 'utf8'));
  assert.equal(souhrn.meta.preruseno, true);
  assert.deepEqual(souhrn.testy.map((t) => [t.id, t.stav]), [['T1', STAV.OK], ['T2', STAV.AGENT]]); // T3 nezačal → v reportu není
  assert.ok(!fs.existsSync(path.join(out, 'T3')));
  assert.match(fs.readFileSync(path.join(out, 'report.md'), 'utf8'), /\*\*POZOR:\*\* běh byl přerušen/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8')).preruseno, true);
  // chyba úklidu ani zápisu přerušení neshodí
  interruptRun({ outDir: path.join(out, 'neexistuje'), meta: { database: MODEL_DB }, testy: [], uklid: () => { throw new Error('x'); } });
  // běžné vyhodnocení: testy bez výstupu jsou CHYBA AGENTA, meta dostane prostředí agenta
  const cely = evaluateRun({ outDir: out, meta: { stamp: 'preruseni', database: MODEL_DB }, testy: [T1, T3] });
  assert.deepEqual(cely.vysledky.map((t) => t.stav), [STAV.OK, STAV.AGENT]);
  assert.equal(cely.sm.testu, 2);
  assert.equal(loadRunMeta(out).prostredi.mcpNastroju, 0);
});

test('removeEmptyClientProjects: maže jen prázdné složky tohoto běhu s „pohoda-golden“ v názvu', () => {
  const root = novaSlozka('claude-projects');
  const mk = (...casti) => fs.mkdirSync(path.join(root, ...casti), { recursive: true });
  mk('C--Temp-pohoda-golden-AbC123-cwd', 'memory'); // prázdný strom tohoto běhu → smazat
  mk('C--Temp-pohoda-golden-AbC123-cwd-2'); // prázdná složka tohoto běhu → smazat
  mk('C--Temp-pohoda-golden-XyZ999-cwd', 'memory'); // jiný běh (může ještě běžet) → nechat
  mk('C--Temp-pohoda-golden-AbC123-plna', 'memory');
  fs.writeFileSync(path.join(root, 'C--Temp-pohoda-golden-AbC123-plna', 'memory', 'MEMORY.md'), 'x', 'utf8'); // má soubor → nechat
  mk('C--data-jiny-projekt', 'memory'); // cizí projekt → nechat
  fs.writeFileSync(path.join(root, 'pohoda-golden-AbC123.txt'), 'soubor, ne složka', 'utf8');
  assert.deepEqual(removeEmptyClientProjects('pohoda-golden-AbC123', root).sort(), ['C--Temp-pohoda-golden-AbC123-cwd', 'C--Temp-pohoda-golden-AbC123-cwd-2']);
  assert.deepEqual(fs.readdirSync(root).sort(), ['C--Temp-pohoda-golden-AbC123-plna', 'C--Temp-pohoda-golden-XyZ999-cwd', 'C--data-jiny-projekt', 'pohoda-golden-AbC123.txt']);
  assert.ok(fs.existsSync(path.join(root, 'C--Temp-pohoda-golden-AbC123-plna', 'memory', 'MEMORY.md')));
  // pojistky: název bez „pohoda-golden“, prázdný název a neexistující kořen nemažou nic
  assert.deepEqual(removeEmptyClientProjects('jiny-projekt', root), []);
  assert.deepEqual(removeEmptyClientProjects('', root), []);
  assert.deepEqual(removeEmptyClientProjects(undefined, root), []);
  assert.deepEqual(removeEmptyClientProjects('pohoda-golden-AbC123', path.join(root, 'neexistuje')), []);
  assert.ok(fs.existsSync(path.join(root, 'C--data-jiny-projekt', 'memory')));
});
