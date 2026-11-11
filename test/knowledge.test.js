// node --test test/knowledge.test.js  – čtení znalostí (pravidla, schéma, nápověda) nad malou vymyšlenou fixture test/fixtures/knowledge-mini
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHelp, getRules, getSchema, listSchemas, resolveSchema } from '../src/knowledge.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'knowledge-mini');

// Pracovní kopie v dočasné složce: vedle ní leží „cizí“ soubory, ke kterým se server nesmí dostat, a dlouhá stránka pro offset.
//   <tmp>/knowledge   = kopie fixture (agentDir)
//   <tmp>/outside     = soubory mimo znalosti (cíl pokusů o únik)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pohoda-mcp-knowledge-'));
const agentDir = path.join(tmp, 'knowledge');
fs.cpSync(fixture, agentDir, { recursive: true });
fs.mkdirSync(path.join(tmp, 'outside', 'tables'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'outside', 'tables', 'X.md'), '## `X`\n\n| 1 | `Tajne` | int | ne | tajne mimo znalosti |\n', 'utf8');
fs.writeFileSync(path.join(tmp, 'outside', 'tajne.txt'), 'Tajná stránka\n\ntajne mimo znalosti\n', 'utf8');
fs.writeFileSync(path.join(tmp, 'outside', 'tajne.md'), '# tajne mimo znalosti\n', 'utf8');
const longText = `Dlouhá stránka\n\n${Array.from({ length: 1500 }, (_, i) => `Řádek ${i + 1}: zkušební text dlouhé stránky nápovědy.`).join('\n')}\n`;
fs.writeFileSync(path.join(agentDir, 'reference', 'napoveda', 'Dlouha_stranka.txt'), longText, 'utf8');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cfg = { agentDir };
const tables = (out) => [...out.matchAll(/^### (\S+)/gm)].map((m) => m[1]);
const pages = (out) => [...out.matchAll(/^### .*`([^`]+)`$/gm)].map((m) => m[1]);

test('fixture: dvě schémata, přehled bez parametrů', () => {
  assert.deepEqual(listSchemas(cfg).sort(), ['obecny', 'sk']);
  assert.match(getSchema(cfg, {}), /Schémata \(zkušební\)/);
});

test('resolveSchema: kanonický název bez ohledu na velikost písmen, jinak chyba se seznamem', () => {
  assert.equal(resolveSchema(cfg, 'obecny'), 'obecny');
  assert.equal(resolveSchema(cfg, 'OBECNY'), 'obecny');
  assert.equal(resolveSchema(cfg, ' Sk '), 'sk');
  assert.throws(() => resolveSchema(cfg, 'neexistuje'), /Schéma „neexistuje“ neexistuje\. Dostupná: .*obecny/);
  assert.throws(() => resolveSchema(cfg, ''), /neexistuje/);
  assert.throws(() => resolveSchema(cfg, undefined), /neexistuje/);
});

test('getSchema: schema nesmí vést mimo znalosti (relativní cesta, lomítka, absolutní cesta)', () => {
  // kontrola testu samotného: cíl úniku opravdu existuje tam, kam by cesta složená ze vstupu mířila
  assert.ok(fs.existsSync(path.join(agentDir, 'schema', '..\\..\\outside', 'tables', 'X.md')));
  const bad = [
    '..\\..\\outside', '../../outside', '..', '.', 'obecny\\..\\..\\..\\outside', 'obecny/../sk', 'obecny/', '\\obecny', 'sk\\tables',
    path.join(tmp, 'outside'), path.join(tmp, 'outside').replace(/\\/g, '/'), `\\\\?\\${path.join(tmp, 'outside')}`,
  ];
  for (const schema of bad) {
    assert.throws(() => getSchema(cfg, { schema, table: 'X' }), /Schéma „.*“ neexistuje\. Dostupná: /, `table, schema=${schema}`);
    assert.throws(() => getSchema(cfg, { schema, search: 'tajne' }), /Schéma „.*“ neexistuje\. Dostupná: /, `search, schema=${schema}`);
  }
});

test('getSchema: tabulka podle názvu (velikost písmen, prefix dbo.), schéma sk', () => {
  assert.match(getSchema(cfg, { table: 'fa' }), /## `FA`[\s\S]*DatSplat/);
  assert.match(getSchema(cfg, { table: 'dbo.FApol' }), /## `FApol`/);
  assert.match(getSchema(cfg, { schema: 'SK', table: 'FA' }), /Faktúry/);
  assert.match(getSchema(cfg, { schema: '', table: 'AD' }), /Adresář/); // prázdné schema = výchozí obecny
});

test('getSchema: neznámá tabulka → chyba s nápovědou „Podobné“', () => {
  assert.throws(() => getSchema(cfg, { table: 'FApolozky' }), /Tabulka „FApolozky“ ve schématu obecny neexistuje\. Podobné: FA, FApol/);
  assert.throws(() => getSchema(cfg, { table: 'Xyz' }), (e) => /neexistuje\.$/.test(e.message));
  assert.throws(() => getSchema(cfg, { table: '..\\..\\..\\outside\\tables\\X' }), /neexistuje/);
});

test('getSchema(search): hlavička <!-- … --> se nepočítá ani nezobrazuje', () => {
  // „ico“ je v hlavičce každého souboru (db: StwPh_<ICO>), ve sloupcích jen u FA
  const out = getSchema(cfg, { search: 'ico' });
  assert.deepEqual(tables(out), ['FA']);
  assert.match(out, /Nalezeno v 1 tabulkách/);
  assert.doesNotMatch(out, /<!--/);
  for (const only of ['StwPh', 'export', 'varianta', '<!--']) assert.match(getSchema(cfg, { search: only }), /^Nic nenalezeno/, only);
});

test('getSchema(search): prázdný dotaz je chyba, ne přehled ani „všechno“', () => {
  for (const search of ['', ' ', ' \t\n ']) assert.throws(() => getSchema(cfg, { search }), /search je prázdný/, JSON.stringify(search));
});

test('getSchema(search): víc slov = všechna musí být v tabulce (i na různých řádcích)', () => {
  assert.deepEqual(tables(getSchema(cfg, { search: 'datum' })).sort(), ['AD', 'FA', 'FApol']);
  // FA: obě slova na jednom řádku; FApol: „Splatnost“ v poznámce a „datum“ u sloupce; AD: jen „datum“
  const out = getSchema(cfg, { search: 'datum  splatnost' });
  assert.deepEqual(tables(out).sort(), ['FA', 'FApol']);
  assert.match(out, /### FApol \(2 shod\)/);
  assert.match(getSchema(cfg, { search: 'datum neexistujicislovo' }), /^Nic nenalezeno pro „datum neexistujicislovo“ ve schématu obecny\. Zkus jedno slovo .* bez diakritiky/);
});

test('getSchema(search): bez ohledu na diakritiku a velikost písmen', () => {
  const a = getSchema(cfg, { search: 'částka' });
  assert.deepEqual(tables(a), ['FA']);
  assert.match(a, /Částka celkem je ve sloupci/); // zobrazuje se původní text s diakritikou
  assert.equal(getSchema(cfg, { search: 'castka' }), a);
  assert.equal(getSchema(cfg, { search: 'ČÁSTKA' }), a);
  assert.deepEqual(tables(getSchema(cfg, { search: 'adresar' })), ['AD']);
  assert.deepEqual(tables(getSchema(cfg, { schema: 'sk', search: 'ciastka' })), ['FA']);
});

test('getSchema(search): shoda v názvu tabulky má přednost', () => {
  assert.equal(tables(getSchema(cfg, { search: 'fapol' }))[0], 'FApol');
});

test('getHelp: prázdný dotaz je chyba', () => {
  for (const query of [undefined, '', ' ', ' \t\n ']) assert.throws(() => getHelp(cfg, { query }), /Zadej query/, JSON.stringify(query));
});

test('getHelp: přesný titulek první, pak titulek se všemi slovy, pak ostatní', () => {
  // Banka.txt má výskytů nejvíc, ale slova nemá v titulku
  const out = getHelp(cfg, { query: 'párovací symbol' });
  assert.deepEqual(pages(out), ['Parovaci_symbol.txt', 'Parovaci_symbol_v_bance.txt', 'Banka.txt']);
  assert.match(out, /^Nalezeno 3 stránek \(zobrazeno 3\)/);
  assert.match(out, /> Párovací symbol slouží ke spojení úhrady s dokladem\./);
});

test('getHelp: bez ohledu na diakritiku, velikost písmen a opakovaná slova', () => {
  const want = pages(getHelp(cfg, { query: 'párovací symbol' }));
  for (const query of ['parovaci symbol', 'PÁROVACÍ   SYMBOL', ' Parovaci Symbol ', 'symbol párovací symbol']) {
    assert.deepEqual(pages(getHelp(cfg, { query })).sort(), want.slice().sort(), query);
  }
  assert.equal(pages(getHelp(cfg, { query: 'PAROVACI symbol' }))[0], 'Parovaci_symbol.txt');
  assert.deepEqual(pages(getHelp(cfg, { query: 'kontrolny vykaz', lang: 'sk' })), ['Kontrolny_vykaz.txt']);
});

test('getHelp: počet výskytů je omezený, dlouhá stránka nevítězí jen délkou', () => {
  // 20× vs 60× „saldo“ → stejné skóre, rozhoduje název souboru
  assert.deepEqual(pages(getHelp(cfg, { query: 'saldo' })), ['Aaa_saldo.txt', 'Zzz_saldo_dlouhe.txt']);
});

test('getHelp: limit, nic nenalezeno, dlouhý dotaz se v hlášce zkrátí', () => {
  const out = getHelp(cfg, { query: 'symbol', limit: 1 });
  assert.equal(pages(out).length, 1);
  assert.match(out, /^Nalezeno 3 stránek \(zobrazeno 1\)/);
  assert.equal(pages(getHelp(cfg, { query: 'symbol', limit: 2 })).length, 2);
  const long = 'neexistujicislovo'.repeat(20);
  const none = getHelp(cfg, { query: long });
  assert.match(none, /^Nic nenalezeno pro „/);
  assert.ok(!none.includes(long) && none.includes(`${long.slice(0, 100)}…`));
});

test('getHelp: nejvýše 12 různých slov', () => {
  // prvních 12 slov na stránce je, třinácté (neexistující) se už nehledá
  const twelve = 'parovaci symbol slouzi ke spojeni uhrady s dokladem vyplnuje se v poli';
  assert.deepEqual(pages(getHelp(cfg, { query: `${twelve} neexistujicislovo` })), ['Parovaci_symbol.txt']);
  assert.match(getHelp(cfg, { query: 'parovaci neexistujicislovo' }), /^Nic nenalezeno/);
});

test('getHelp(page): krátká stránka celá, s příponou i bez', () => {
  const text = getHelp(cfg, { page: 'Parovaci_symbol' });
  assert.match(text, /^Párovací symbol\n/);
  assert.doesNotMatch(text, /pokračování/);
  assert.equal(getHelp(cfg, { page: 'Parovaci_symbol.txt' }), text);
  assert.equal(getHelp(cfg, { page: 'Parovaci_symbol.txt', offset: 0 }), text);
});

test('getHelp(page, offset): dlouhá stránka po úsecích s údajem o pokračování', () => {
  assert.ok(longText.length > 60000);
  const tail = /\n\n… pokračování: offset=(\d+) \(z (\d+) znaků\)$/;
  let offset;
  let joined = '';
  let calls = 0;
  for (;;) {
    const part = getHelp(cfg, { page: 'Dlouha_stranka.txt', offset });
    calls++;
    const m = tail.exec(part);
    const body = m ? part.slice(0, m.index) : part;
    assert.ok(body.length <= 30000, `úsek má ${body.length} znaků`);
    joined += body;
    if (!m) break;
    assert.equal(Number(m[2]), longText.length);
    assert.equal(Number(m[1]), joined.length);
    offset = Number(m[1]);
    assert.ok(calls < 10);
  }
  assert.equal(joined, longText);
  assert.ok(calls >= 3);
  assert.throws(() => getHelp(cfg, { page: 'Dlouha_stranka.txt', offset: longText.length }), /offset=\d+ je za koncem stránky/);
  assert.throws(() => getHelp(cfg, { page: 'Dlouha_stranka.txt', offset: 10_000_000 }), /za koncem/);
  assert.throws(() => getHelp(cfg, { page: 'Dlouha_stranka.txt', offset: -1 }), /offset musí být/);
  assert.throws(() => getHelp(cfg, { page: 'Dlouha_stranka.txt', offset: 1.5 }), /offset musí být/);
});

test('getHelp(page): cesta se ořízne na název souboru, mimo složku nápovědy se nedostane', () => {
  assert.ok(fs.existsSync(path.join(agentDir, 'reference', 'napoveda', '..\\..\\..\\outside\\tajne.txt')));
  for (const page of ['..\\..\\..\\outside\\tajne', '../../../outside/tajne.txt', path.join(tmp, 'outside', 'tajne.txt'), '..\\..\\pravidla', '..\\..\\schema\\README', '..', '.']) {
    assert.throws(() => getHelp(cfg, { page }), /Stránka „.*“ neexistuje\./, page);
  }
  // cesta před platným názvem se zahodí – čte se vždy jen ze složky nápovědy
  assert.match(getHelp(cfg, { page: '..\\..\\cokoli\\Parovaci_symbol.txt' }), /^Párovací symbol\n/);
});

test('getRules: jádro, kapitola, traversal přes chapter → chyba', () => {
  assert.match(getRules(cfg), /zkušební jádro[\s\S]*Dostupné kapitoly .*: sklad$/);
  assert.match(getRules(cfg, 'Sklad'), /zkušební kapitola/);
  assert.match(getRules(cfg, 'sklad.md'), /zkušební kapitola/);
  assert.ok(fs.existsSync(path.join(agentDir, 'pravidla', '..\\..\\outside\\tajne.md')));
  for (const chapter of ['..\\..\\outside\\tajne', '../../outside/tajne.md', '..\\pravidla', 'sklad\\..\\sklad', path.join(tmp, 'outside', 'tajne'), 'neexistuje']) {
    assert.throws(() => getRules(cfg, chapter), /Kapitola „.*“ neexistuje\. Dostupné: sklad/, chapter);
  }
});
