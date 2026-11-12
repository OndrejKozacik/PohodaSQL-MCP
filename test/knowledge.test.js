// node --test test/knowledge.test.js  – čtení znalostí (pravidla, schéma, nápověda) nad malou vymyšlenou fixture test/fixtures/knowledge-mini
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactSetWarnings, getHelp, getRules, getSchema, listRuleSections, listSchemas, resolveSchema, RULES_COMPACT_SECTIONS } from '../src/knowledge.js';
import { loadConfig } from '../src/config.js';
import { buildInstructions, SERVER_INSTRUCTIONS, WORKFLOW_PROMPT } from '../src/instructions.js';

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

// ===== pravidla po sekcích, hledání, režimy full / compact =====
const coreText = fs.readFileSync(path.join(fixture, 'pravidla.md'), 'utf8');
const chapterText = fs.readFileSync(path.join(fixture, 'pravidla', 'sklad.md'), 'utf8');
const FULL_TAIL = '\n\n---\nDostupné kapitoly (volej pohoda_rules s parametrem chapter): sklad';
const cfgCompact = { agentDir, rules: { mode: 'compact' } };
/** Výsledky hledání v pravidlech jako „id@kde“ (kde = jádro / název kapitoly). */
const found = (out) => [...out.matchAll(/^### (\S+) · (?:kapitola )?(\S+) · /gm)].map((m) => `${m[1]}@${m[2]}`);
const ids = (chapter) => listRuleSections(cfg, chapter).map((s) => s.id);

test('sekce jádra: id z čísla nadpisu, úvod, nadpis v bloku kódu se nepočítá', () => {
  const sub13 = Array.from({ length: 18 }, (_, i) => `13.${i + 1}`);
  assert.deepEqual(ids(), ['uvod', '0', '1', '2', '2.1', '3', '4', '5', '5.1', '5.2', '5.3', '6', '7', '7.5', '8', '8.1', '8.2', '8.3', '9', '10', '11', '11.2', '11.6', '11.15', '12', '12.1', '12.2', '13', ...sub13]);
  const byId = Object.fromEntries(listRuleSections(cfg).map((s) => [s.id, s]));
  assert.equal(byId['5'].title, 'Faktury');
  assert.equal(byId['5.1'].level, 3);
  assert.equal(byId['11.15'].title, 'Rozvaha po řádcích');
  assert.equal(byId['5'].size, getRules(cfg, { section: '5' }).length);
  assert.ok(byId['5'].size > byId['5.1'].size + byId['5.2'].size + byId['5.3'].size);
});

test('sekce kapitoly: číslované, nečíslované (slug), opakovaný titulek, číslo bez tečky', () => {
  const dlouhe = 'velmi-dlouhy-nadpis-sekce-pro-zkousku-de';
  assert.deepEqual(ids('sklad'), ['uvod', '7.5', '11.11', 'caste-chyby', 'zaporny-stav', 'caste-chyby-2', dlouhe, `${dlouhe}-2`, 'sekce-2026']);
  // slug má nejvýš 40 znaků, s příponou opakovaného titulku až 42 – i takové id jde načíst (limit parametru section v serveru je 50)
  assert.equal(dlouhe.length, 40);
  assert.equal(getRules(cfg, { chapter: 'sklad', section: `${dlouhe}-2` }), '## Velmi dlouhý nadpis sekce pro zkoušku délky identifikátoru\n\nDruhý dlouhý nadpis se stejným titulkem.');
  assert.match(getRules(cfg, { chapter: 'sklad', section: dlouhe }), /První dlouhý nadpis\.$/);
  assert.match(getRules(cfg, { chapter: 'sklad', section: 'uvod' }), /^# Sklad \(zkušební kapitola\)\n\nZásoby jsou v tabulce SKz\.$/);
  // nečíslovaná sekce `##` zahrnuje své `###` a končí u dalšího `##`
  const chyby = getRules(cfg, { chapter: 'sklad', section: 'caste-chyby' });
  assert.match(chyby, /^## Časté chyby\n[\s\S]*### Záporný stav[\s\S]*před příjmem\.$/);
  assert.doesNotMatch(chyby, /Druhý nadpis/);
  assert.match(getRules(cfg, { chapter: 'sklad', section: 'caste-chyby-2' }), /^## Časté chyby\n\nDruhý nadpis se stejným titulkem\.$/);
  assert.match(getRules(cfg, { chapter: 'sklad', section: 'zaporny-stav' }), /^### Záporný stav\n/);
  assert.match(getRules(cfg, { chapter: 'sklad', section: 'sekce-2026' }), /^## 2026\n/);
  // číslovaná `###` končí u nečíslovaného `##`
  assert.equal(getRules(cfg, { chapter: 'SKLAD.md', section: '11.11' }), '### 11.11. Stav skladu k datu\n\nStav skladu k datu se počítá z pohybů.');
});

test('section: sekce jádra včetně podsekcí, úvod, zápis id', () => {
  const s5 = getRules(cfg, { section: '5' });
  assert.match(s5, /^## 5\. Faktury\n[\s\S]*### 5\.1\. Typ dokladu[\s\S]*## 99\. Tohle není sekce[\s\S]*### 5\.2\. Storno[\s\S]*záporná\.\n\n### 5\.3\. Obrat\n\nObrat je součet faktur bez storna\.$/);
  assert.doesNotMatch(s5, /## 6\. DPH|## 4\./);
  const s51 = getRules(cfg, { section: '5.1' });
  assert.match(s51, /^### 5\.1\. Typ dokladu\n[\s\S]*```$/);
  assert.doesNotMatch(s51, /Storno/);
  for (const section of [' 5.1 ', '5.1.', '\t5.1.\n']) assert.equal(getRules(cfg, { section }), s51, JSON.stringify(section));
  assert.equal(getRules(cfg, { section: '11.15' }), '### 11.15. Rozvaha po řádcích\n\nVzor rozvahy, řádek po řádku.');
  const uvod = getRules(cfg, { section: 'uvod' });
  assert.match(uvod, /^# Pravidla \(zkušební jádro\)\n\n## Kapitoly k dočtení\n\nRejstřík kapitol: sklad\.$/);
  for (const section of ['UVOD', 'Úvod', ' úvod ']) assert.equal(getRules(cfg, { section }), uvod, section);
  // režim compact na `section` nemá vliv
  assert.equal(getRules(cfgCompact, { section: '5' }), s5);
});

test('section: odkazová sekce jádra dostane poučení, kde je celý text', () => {
  assert.match(getRules(cfg, { section: '7.5' }), /^### 7\.5\. Sklad – pohyby\n\n→ Obsah je v kapitole[\s\S]*\n\n---\nTato sekce jádra jen odkazuje na kapitolu sklad\. Načti ji: pohoda_rules chapter=sklad \(jen tuto sekci: chapter=sklad section=7\.5\)\.$/);
  assert.match(getRules(cfg, { section: '6' }), /Načti ji: pohoda_rules chapter=sklad\.$/); // kapitola sekci 6 nemá
  assert.doesNotMatch(getRules(cfg, { chapter: 'sklad', section: '7.5' }), /odkazuje na kapitolu/);
  assert.doesNotMatch(getRules(cfg, { section: '7' }), /\n---\n/); // sekce s vlastním textem není odkazová
});

test('section: neznámá nebo prázdná sekce → chyba s platnými id a s místem, kde sekce je', () => {
  assert.throws(() => getRules(cfg, { section: '99' }), (e) => /^Sekce „99“ v jádru pravidel neexistuje\. Platná id: uvod, 0, 1, 2, 2\.1, 3, .*13\.18\.$/.test(e.message));
  assert.throws(() => getRules(cfg, { section: '11.11' }), /Sekce „11\.11“ v jádru pravidel neexistuje\. Platná id: .*\. Sekce 11\.11 je v kapitole sklad \(pohoda_rules chapter=sklad section=11\.11\)\.$/);
  assert.throws(() => getRules(cfg, { chapter: 'sklad', section: '5.1' }), { message: 'Sekce „5.1“ v kapitole sklad neexistuje. Platná id: uvod, 7.5, 11.11, caste-chyby, zaporny-stav, caste-chyby-2, velmi-dlouhy-nadpis-sekce-pro-zkousku-de, velmi-dlouhy-nadpis-sekce-pro-zkousku-de-2, sekce-2026. Sekce 5.1 je v jádru (pohoda_rules section=5.1 bez chapter).' });
  assert.throws(() => getRules(cfg, { chapter: 'sklad', section: '6' }), (e) => /sekce-2026\.$/.test(e.message)); // odkazová sekce jádra se nenabízí
  for (const section of ['', ' ', ' . ']) assert.throws(() => getRules(cfg, { section }), /Parametr section je prázdný/, JSON.stringify(section));
  assert.throws(() => getRules(cfg, { section: 5 }), /Parametr section je prázdný/);
  const long = '9'.repeat(300);
  assert.throws(() => getRules(cfg, { section: long }), (e) => !e.message.includes(long) && e.message.includes(`${long.slice(0, 100)}…`));
});

test('section: vstup podobný cestě se jen hledá mezi id, mimo znalosti nevede', () => {
  for (const section of ['..\\..\\outside\\tajne', '../../outside/tajne.md', '..', '.\\5', 'sklad/7.5', path.join(tmp, 'outside', 'tajne.md'), 'pravidla.md', '__proto__', 'constructor']) {
    assert.throws(() => getRules(cfg, { section }), /Sekce „.*“ v jádru pravidel neexistuje\. Platná id: uvod, 0, /, section);
    assert.throws(() => getRules(cfg, { chapter: 'sklad', section }), /Sekce „.*“ v kapitole sklad neexistuje\./, section);
  }
  for (const chapter of ['..\\..\\outside\\tajne', '../pravidla', path.join(tmp, 'outside', 'tajne')]) {
    assert.throws(() => getRules(cfg, { chapter, section: '5' }), /Kapitola „.*“ neexistuje\. Dostupné: sklad/, chapter);
    assert.throws(() => getRules(cfg, { chapter, search: 'tajne' }), /Kapitola „.*“ neexistuje\. Dostupné: sklad/, chapter);
  }
  assert.match(getRules(cfg, { search: 'tajne mimo znalosti' }), /^Nic nenalezeno/);
});

test('search: jádro i kapitoly, titulek má přednost, odkazové sekce jádra se nehledají', () => {
  const out = getRules(cfg, { search: 'storno' });
  // 5.2 má slovo v titulku; 7.5 v jádru je jen odkaz → výsledek je z kapitoly; sekce 5 se neuvádí: shoduje se její podsekce a ve vlastním textu slovo nemá
  assert.deepEqual(found(out), ['5.2@jádro', '7.5@sklad']);
  assert.match(out, /^Nalezeno 2 sekcí pravidel \(zobrazeno 2\)\. Sekci načti: pohoda_rules section=<id> \(u sekce z kapitoly navíc chapter=<kapitola>\)\.\n\n### 5\.2 · jádro · Storno \(\d+ znaků\)\n> Stornovaný doklad má příznak storna\. Částka storna je záporná\.\n\n### 7\.5 · kapitola sklad · Sklad – pohyby \(\d+ znaků\)\n> Pohyby zásob/);
  const size = Number(/### 5\.2 · jádro · Storno \((\d+) znaků\)/.exec(out)[1]);
  assert.equal(size, getRules(cfg, { section: '5.2' }).length);
  assert.deepEqual(found(getRules(cfg, { search: 'sklad pohyby' })), ['7.5@sklad']);
  // s chapter jen v té kapitole
  assert.deepEqual(found(getRules(cfg, { chapter: 'sklad', search: 'storno' })), ['7.5@sklad']);
  assert.match(getRules(cfg, { chapter: 'sklad', search: 'reltpfak' }), /^Nic nenalezeno pro „reltpfak“ v pravidlech \(kapitola sklad\)\./);
  // režim compact hledání nemění
  assert.equal(getRules(cfgCompact, { search: 'storno' }), out);
});

test('search: víc slov = všechna v jedné sekci; shodná podsekce nahradí nadřazenou, jen když ta nemá shodu ve vlastním textu', () => {
  // sekce 12 má slovo ve VLASTNÍM textu (3×) i v podsekci 12.2 → uvádějí se obě; nadřazená se hodnotí a ukazuje jen vlastním textem
  const jehla = getRules(cfg, { search: 'jehla' });
  assert.deepEqual(found(jehla), ['12@jádro', '12.2@jádro']);
  assert.match(jehla, /### 12 · jádro · Hledání \(\d+ znaků\)\n> Slovo jehla: sekce 12 ho má třikrát – jehla, jehla\.\n\n### 12\.2 · jádro · Podsekce s jehlou \(\d+ znaků\)\n> Tady je jehla jednou\. Vedle leží kupka\.$/);
  // „kupka“ ve vlastním textu sekce 12 není → zůstává jen podsekce
  assert.deepEqual(found(getRules(cfg, { search: 'jehla kupka' })), ['12.2@jádro']);
  // slova jsou každé v jiné části sekce 12 (vlastní text + podsekce 12.1) → vrací se celá sekce 12
  assert.deepEqual(found(getRules(cfg, { search: 'třikrát sena' })), ['12@jádro']);
  assert.match(getRules(cfg, { search: 'jehla neexistujicislovo' }), /^Nic nenalezeno pro „jehla neexistujicislovo“ v pravidlech\. Zkus jiné nebo kratší slovo/);
  // řádky se shodou: nejvýše 3, nadpis sekce se neopakuje
  const out = getRules(cfg, { search: 'reltpfak' });
  assert.deepEqual(found(out), ['5.1@jádro', '5@jádro']); // sekce 5 má slovo i ve vlastním úvodním textu
  const bloky = out.split('\n\n### ');
  assert.equal(bloky[1].split('\n').filter((l) => l.startsWith('> ')).length, 3);
  assert.deepEqual(bloky[2].split('\n').filter((l) => l.startsWith('> ')), ['> Úvod k fakturám: typ dokladu určuje sloupec RelTpFak.']);
});

test('search: bez ohledu na diakritiku a velikost písmen, opakovaná slova, nejvýše 12 slov', () => {
  const want = getRules(cfg, { search: 'Zálohová faktura' });
  assert.deepEqual(found(want), ['5.1@jádro']);
  assert.match(want, /> Zálohová faktura má RelTpFak 4\./); // zobrazuje se původní text
  for (const search of ['zalohova faktura', 'ZÁLOHOVÁ   FAKTURA', ' faktura zalohova faktura ']) assert.deepEqual(found(getRules(cfg, { search })), ['5.1@jádro'], search);
  assert.deepEqual(found(getRules(cfg, { search: 'CASTE chyby' })), ['caste-chyby@sklad', 'caste-chyby-2@sklad']);
  // prvních 12 slov v sekci je, třinácté (neexistující) se už nehledá
  const twelve = 'stornovany doklad ma priznak storna castka je zaporna storno 5 2 data';
  assert.equal(new Set(twelve.split(' ')).size, 12);
  assert.match(getRules(cfg, { search: `${twelve} neexistujicislovo` }), /^Nic nenalezeno.* Dotaz má 13 různých slov – použito prvních 12 slov\.$/); // „data“ v sekci není
  const eleven = twelve.replace(' data', '');
  assert.deepEqual(found(getRules(cfg, { search: `${eleven} storna neexistujicislovo` })), []); // 12 různých slov, poslední chybí
  assert.deepEqual(found(getRules(cfg, { search: `${eleven} zaporna.` })), ['5.2@jádro']);
  const zkraceno = getRules(cfg, { search: `${eleven} zaporna. neexistujicislovo dalsislovo` });
  assert.deepEqual(found(zkraceno), ['5.2@jádro']);
  // víc než 12 slov: výsledek to řekne; do 12 slov věta chybí
  assert.match(zkraceno.split('\n')[0], /^Nalezeno 1 sekcí pravidel \(zobrazeno 1\)\. Sekci načti: .*\. Dotaz má 14 různých slov – použito prvních 12 slov\.$/);
  assert.doesNotMatch(getRules(cfg, { search: `${eleven} zaporna.` }), /použito prvních/);
  assert.doesNotMatch(getRules(cfg, { search: 'neexistujicislovo' }), /použito prvních/);
});

test('search: slova se dělí i na čárce, středníku, závorkách a uvozovkách; tečka a podtržítko ve slově zůstávají', () => {
  const storno = found(getRules(cfg, { search: 'storno' }));
  for (const search of ['storno,', '(storno)', '`storno`', '"storno"', "'storno'", '„storno“', 'storno;', ' ( „Storno“ ) ; ']) assert.deepEqual(found(getRules(cfg, { search })), storno, search);
  // dvě slova oddělená jen čárkou nebo středníkem jsou dvě slova (obě musí být v sekci)
  assert.deepEqual(found(getRules(cfg, { search: 'storna,záporná' })), ['5.2@jádro']);
  assert.deepEqual(found(getRules(cfg, { search: 'storna;záporná' })), ['5.2@jádro']);
  assert.deepEqual(found(getRules(cfg, { search: '(FA),`RelTpFak`' })), found(getRules(cfg, { search: 'FA RelTpFak' })));
  assert.ok(found(getRules(cfg, { search: '(FA),`RelTpFak`' })).includes('5.1@jádro'));
  // tečka dělí až za slovem: „dbo.AD“ a „FA.RefAD“ se hledají vcelku
  assert.deepEqual(found(getRules(cfg, { search: 'dbo.AD' })), ['8.2@jádro']);
  assert.deepEqual(found(getRules(cfg, { search: '`FA.RefAD`' })), ['8.2@jádro']);
  assert.match(getRules(cfg, { search: 'dbo,RefAD,neexistujicislovo' }), /^Nic nenalezeno/);
  // samé oddělovače = prázdný dotaz
  for (const search of [',', ' ( ) ', '`` ;', '„“']) assert.throws(() => getRules(cfg, { search }), /Parametr search je prázdný/, search);
  // stejné dělení platí pro hledání ve schématu a v nápovědě
  assert.deepEqual(tables(getSchema(cfg, { search: '(datum, splatnost)' })).sort(), ['FA', 'FApol']);
  assert.deepEqual(pages(getHelp(cfg, { query: '„párovací“, (symbol)' })).sort(), pages(getHelp(cfg, { query: 'párovací symbol' })).sort());
});

test('search: shoda celého slova se řadí před shodu uvnitř slova (krátké názvy AD, sk)', () => {
  // „ad“ je uvnitř slov sklad, řádek, nadpis…; jako celé slovo jen v sekci 4 (mapa tabulek) a 8.2 (dbo.AD)
  const ad = found(getRules(cfg, { search: 'AD' }));
  assert.deepEqual(ad.slice(0, 2).sort(), ['4@jádro', '8.2@jádro']);
  assert.ok(ad.length > 5 && ad.includes('7.5@sklad') && ad.includes('11.15@jádro'), ad.join());
  // „sk“ jako celé slovo je jen v sekci 1 (schéma sk); sekce skladu ho mají uvnitř slova, i v titulku
  const sk = found(getRules(cfg, { search: 'sk' }));
  assert.equal(sk[0], '1@jádro');
  assert.ok(sk.indexOf('7.5@sklad') > 0 && sk.indexOf('11.11@sklad') > 0, sk.join());
  // celé slovo v titulku má přednost před větším počtem výskytů v textu
  assert.equal(found(getRules(cfg, { search: 'storno' }))[0], '5.2@jádro');
  assert.equal(found(getRules(cfg, { search: 'sklad' }))[0], '7.5@sklad'); // titulek „Sklad – pohyby“
  // znaky s významem v regulárním výrazu se hledají doslova
  assert.match(getRules(cfg, { search: 'a.*b' }), /^Nic nenalezeno/);
  assert.deepEqual(found(getRules(cfg, { search: 'f.RelTpFak' })), ['5.1@jádro']);
  assert.match(getRules(cfg, { search: '[a-z]+ ^$ \\' }), /^Nic nenalezeno/);
});

test('odkazová sekce: jen přesný tvar „→ Obsah je v kapitole `pravidla/x.md`“; zmínka o souboru kapitoly ji nedělá', () => {
  // 8.3 je krátká skutečná sekce s textem „viz pravidla/sklad.md“ – vrací se bez poučení, hledá se v ní a v rejstříku má velikost
  const s83 = getRules(cfg, { section: '8.3' });
  assert.equal(s83, '### 8.3. Krátká skutečná sekce\n\nPodrobnosti viz pravidla/sklad.md.');
  assert.deepEqual(found(getRules(cfg, { search: 'podrobnosti' })), ['8.3@jádro']);
  assert.match(getRules(cfgCompact), new RegExp(`\\n  - 8\\.3 – Krátká skutečná sekce \\(${s83.length} znaků\\)\\n`));
  // skutečné odkazové sekce se poznají dál
  assert.match(getRules(cfg, { section: '6' }), /\n---\nTato sekce jádra jen odkazuje na kapitolu sklad\./);
  assert.match(getRules(cfg, { section: '7.5' }), /\n---\nTato sekce jádra jen odkazuje na kapitolu sklad\./);
  // obměny, které odkazovou sekci nedělají: text před odkazem, víc řádků, jiná cesta
  const dir = path.join(tmp, 'knowledge-stub');
  fs.mkdirSync(path.join(dir, 'pravidla'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pravidla', 'sklad.md'), '# Sklad\n', 'utf8');
  const odkaz = '→ Obsah je v kapitole `pravidla/sklad.md` – přečti ji celou, když se zadání týká tohoto tématu.';
  fs.writeFileSync(path.join(dir, 'pravidla.md'), [
    '# Jádro', '',
    '## 1. Odkaz', '', odkaz, '',
    '## 2. Odkaz bez dovětku', '', '→ Obsah je v kapitole `pravidla/sklad.md`', '',
    '## 3. Text před odkazem', '', `Poznámka. ${odkaz}`, '',
    '## 4. Dva řádky', '', odkaz, 'A k tomu jedno pravidlo navíc.', '',
    '## 5. Jiná cesta', '', '→ Obsah je v kapitole `jinde/sklad.md`', '',
    '## 6. Neexistující kapitola', '', '→ Obsah je v kapitole `pravidla/neni.md`', '',
  ].join('\n'), 'utf8');
  const c = { agentDir: dir };
  const jeOdkaz = (section) => /\n---\nTato sekce jádra jen odkazuje na kapitolu sklad\./.test(getRules(c, { section }));
  assert.deepEqual(['1', '2', '3', '4', '5', '6'].map(jeOdkaz), [true, true, false, false, false, false]);
});

test('search: nejvýše 15 výsledků, prázdný výraz je chyba, dlouhý výraz se v hlášce zkrátí', () => {
  const out = getRules(cfg, { search: 'opakovaneslovo' });
  assert.match(out, /^Nalezeno 18 sekcí pravidel \(zobrazeno 15\)\./);
  assert.deepEqual(found(out), Array.from({ length: 15 }, (_, i) => `13.${i + 1}@jádro`));
  for (const search of ['', ' ', ' \t\n ']) {
    assert.throws(() => getRules(cfg, { search }), /Parametr search je prázdný/, JSON.stringify(search));
    assert.throws(() => getRules(cfg, { chapter: 'sklad', search }), /Parametr search je prázdný/, JSON.stringify(search));
  }
  const long = 'neexistujicislovo'.repeat(20);
  const none = getRules(cfg, { search: long });
  assert.match(none, /^Nic nenalezeno pro „/);
  assert.ok(!none.includes(long) && none.includes(`${long.slice(0, 100)}…`));
});

test('section + search v jednom volání je chyba', () => {
  assert.throws(() => getRules(cfg, { section: '5', search: 'storno' }), /Parametry section a search nejde použít v jednom volání/);
  assert.throws(() => getRules(cfg, { chapter: 'sklad', section: '7.5', search: 'storno' }), /Nejdřív hledej \(search\), potom načti vybranou sekci \(section\)\./);
  assert.throws(() => getRules(cfg, { section: '', search: '' }), /v jednom volání/);
});

test('režim full (výchozí): jádro a kapitola beze změny', () => {
  const full = coreText + FULL_TAIL;
  assert.equal(getRules(cfg), full);
  assert.equal(getRules(cfg, {}), full);
  assert.equal(getRules(cfg, { chapter: '' }), full);
  assert.equal(getRules(cfg, { chapter: undefined, section: undefined, search: undefined }), full);
  for (const mode of ['full', 'nesmysl', 'COMPACT', undefined]) assert.equal(getRules({ agentDir, rules: { mode } }), full, String(mode));
  assert.equal(getRules(cfg, 'sklad'), chapterText);
  assert.equal(getRules(cfg, { chapter: 'sklad' }), chapterText);
});

test('režim compact: úvod + vybrané sekce v plném znění, ostatní jen v rejstříku', () => {
  assert.deepEqual(RULES_COMPACT_SECTIONS, ['0', '1', '2', '3', '4', '5.2', '5.3', '8.1', '8.2', '9', '10', '11.6']);
  const out = getRules(cfgCompact);
  const [body, tail] = out.split('\n\n---\n');
  const kept = ['uvod', ...RULES_COMPACT_SECTIONS].map((section) => getRules(cfg, { section }));
  assert.equal(body, kept.join('\n\n'));
  assert.match(body, /^# Pravidla \(zkušební jádro\)[\s\S]*Rejstřík kapitol: sklad\.\n\n## 0\. Role a výstup[\s\S]*### 2\.1\. Pokladna a prodejna[\s\S]*## 4\. Mapa hlavních tabulek[\s\S]*\n\n### 5\.2\. Storno[\s\S]*### 5\.3\. Obrat[\s\S]*### 8\.1\. Co databáze vynucuje[\s\S]*LEFT JOIN\.\n\n### 8\.2\. Ověřené vazby[\s\S]*## 10\. Instalačně specifické věci\n\nUživatelské sloupce se v každé instalaci liší\.\n\n### 11\.6\. Pomocný dotaz\n\nNeznámou hodnotu číselníku zjisti pomocným dotazem\.$/);
  for (const absent of ['Úvod k fakturám', 'Zálohová faktura', 'opakovaneslovo', 'Vzor rozvahy', 'Tabulka číselníků', 'Vazby mezi tabulkami', 'Krátká skutečná sekce\n\n']) assert.ok(!body.includes(absent), absent);
  assert.match(tail, /^Toto je KOMPAKTNÍ jádro pravidel: úvod s rejstříkem kapitol a sekce 0, 1, 2, 3, 4, 5\.2, 5\.3, 8\.1, 8\.2, 9, 10, 11\.6\. Ostatní sekce jádra jsou jen v rejstříku níže a jsou stejně závazné\.\nPŘED psaním SQL načti celou kapitolu k tématu zadání \(pohoda_rules chapter=…\) a příslušné sekce jádra \(pohoda_rules section=…\), např\. section=5\.1 typy faktur, section=5\.4 částky a data na faktuře, section=7 číselníky, section=8\.3 polymorfní vazby, section=11 vzorové dotazy, section=12 zápis \(sekce, jejichž část už máš výše, načítej po zbylých podsekcích z rejstříku\); DPH = chapter=dph, slovenská Pohoda = chapter=sk\. Když nevíš, kde pravidlo je, hledej: pohoda_rules search=… \(prohledá jádro i kapitoly\)\.\n\nRejstřík ostatních sekcí jádra \(id – titulek – velikost včetně podsekcí; u sekce, jejíž část už máš výše, velikost zbytku\):\n/);
  assert.match(tail, /\n\nDostupné kapitoly \(volej pohoda_rules s parametrem chapter\): sklad$/);
  // rejstřík: id – titulek – velikost; podsekce odsazené; odkazové sekce s kapitolou; sekce z kompaktního jádra v něm nejsou
  const index = tail.slice(tail.indexOf('Rejstřík ostatních sekcí jádra'), tail.indexOf('\n\nDostupné kapitoly')).split('\n').slice(1);
  const size = (id) => getRules(cfg, { section: id }).length;
  // nadřazená sekce, jejíž podsekce už kompaktní jádro vrátilo: velikost BEZ těchto podsekcí a jejich výčet
  assert.equal(index[0], `- 5 – Faktury (${size('5') - size('5.2') - size('5.3')} znaků bez podsekcí 5.2, 5.3 vrácených výše)`);
  assert.equal(index[1], `  - 5.1 – Typ dokladu (${size('5.1')} znaků)`);
  assert.equal(index[2], '- 6 – DPH → celý text je v kapitole sklad (chapter=sklad)');
  assert.equal(index[3], `- 7 – Číselníky (${size('7')} znaků)`);
  assert.equal(index[4], '  - 7.5 – Sklad – pohyby → celý text je v kapitole sklad (chapter=sklad)');
  assert.equal(index[5], `- 8 – Vazby a JOINy (${size('8') - size('8.1') - size('8.2')} znaků bez podsekcí 8.1, 8.2 vrácených výše)`);
  assert.equal(index[6], `  - 8.3 – Krátká skutečná sekce (${size('8.3')} znaků)`);
  assert.equal(index[7], `- 11 – Vzorové dotazy (${size('11') - size('11.6')} znaků bez podsekcí 11.6 vrácených výše)`);
  assert.equal(index[8], `  - 11.2 – Měsíční rozpad (${size('11.2')} znaků)`);
  assert.equal(index[9], `  - 11.15 – Rozvaha po řádcích (${size('11.15')} znaků)`);
  assert.equal(index[10], `- 12 – Hledání (${size('12')} znaků)`);
  const listed = index.map((l) => /^\s*- (\S+) – /.exec(l)?.[1]);
  assert.deepEqual(listed, ids().filter((id) => !['uvod', '2.1', ...RULES_COMPACT_SECTIONS].includes(id)));
  // plné znění vybraných sekcí je kratší než celé jádro (u zkušební fixture je s patičkou a rejstříkem delší – jádro má jen pár vět)
  assert.ok(body.length < coreText.length, `${body.length} < ${coreText.length}`);
  // kapitola se v režimu compact vrací celá
  assert.equal(getRules(cfgCompact, 'sklad'), chapterText);
  assert.equal(getRules(cfgCompact, { chapter: 'sklad' }), chapterText);
});

test('compactSetWarnings: id z kompaktní sady, které v jádru chybí nebo je jen odkazem, se hlásí; kompaktní jádro se i tak vrátí', () => {
  assert.deepEqual(compactSetWarnings(cfg), []);
  assert.deepEqual(compactSetWarnings(cfgCompact), []);
  // přečíslovaný zdroj: chybí 5.3, 8.x a 11.6; sekce 9 je jen odkaz na kapitolu
  const dir = path.join(tmp, 'knowledge-precislovano');
  fs.mkdirSync(path.join(dir, 'pravidla'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pravidla', 'sklad.md'), '# Sklad\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'pravidla.md'), [
    '# Jádro', '', '## 0. Role', '', 'a', '', '## 1. Databáze', '', 'b', '', '## 2. Tabulky', '', 'c', '', '## 3. Sloupce', '', 'd', '', '## 4. Mapa', '', 'e', '',
    '## 5. Faktury', '', '### 5.2. Storno', '', 'f', '', '## 9. Typy', '', '→ Obsah je v kapitole `pravidla/sklad.md` – přečti ji celou, když se zadání týká tohoto tématu.', '',
    '## 10. Instalace', '', 'g', '',
  ].join('\n'), 'utf8');
  const c = { agentDir: dir, rules: { mode: 'compact' } };
  const w = compactSetWarnings(c);
  assert.equal(w.length, 2);
  assert.equal(w[0], 'Kompaktní jádro pravidel: sekce 5.3, 8.1, 8.2, 11.6 v pravidla.md neexistuje (přečíslovaný zdroj?) – kompaktní jádro je neúplné; uprav RULES_COMPACT_SECTIONS v src/knowledge.js.');
  assert.match(w[1], /^Kompaktní jádro pravidel: sekce 9 je v pravidla\.md jen odkaz na kapitolu/);
  const out = getRules(c);
  assert.match(out, /^# Jádro\n\n## 0\. Role[\s\S]*### 5\.2\. Storno\n\nf\n\n## 9\. Typy[\s\S]*## 10\. Instalace\n\ng\n\n---\nToto je KOMPAKTNÍ jádro pravidel: úvod s rejstříkem kapitol a sekce 0, 1, 2, 3, 4, 5\.2, 9, 10\./);
  // chybějící jádro pravidel není důvod k pádu (hlásí ho až pohoda_rules)
  assert.deepEqual(compactSetWarnings({ agentDir: path.join(tmp, 'neexistuje') }), []);
  assert.throws(() => getRules({ agentDir: path.join(tmp, 'neexistuje') }), /Znalosti nenalezeny/);
});

// ===== nastavení režimu pravidel (config.json rules.mode, POHODA_RULES_MODE) =====
const ENV_KEYS = ['POHODA_MCP_CONFIG', 'POHODA_AGENT_DIR', 'POHODA_RUN_QUERY', 'POHODA_SQL_SERVER', 'POHODA_ALLOWED_DATABASES', 'POHODA_CREDENTIAL_FILE', 'POHODA_ALLOW_WRITABLE_LOGIN', 'POHODA_RULES_MODE'];
let configSeq = 0;
/** Načte konfiguraci s čistým prostředím (žádná POHODA_* z okolí) a vlastním config.json v dočasné složce; `file` undefined = soubor neexistuje. */
function loadCfg(file, env = {}) {
  let configFile = path.join(tmp, 'neexistuje', 'config.json');
  if (file !== undefined) {
    configFile = path.join(tmp, `config-${++configSeq}.json`);
    fs.writeFileSync(configFile, JSON.stringify(file), 'utf8');
  }
  const old = {};
  for (const k of Object.keys(process.env)) if (/^POHODA_/i.test(k)) { old[k] = process.env[k]; delete process.env[k]; }
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { POHODA_MCP_CONFIG: configFile }, env);
  try { return loadConfig(); } finally {
    for (const k of [...ENV_KEYS, ...Object.keys(env)]) delete process.env[k];
    Object.assign(process.env, old);
  }
}
const assertMode = (c, mode, label) => {
  assert.equal(c.rules.mode, mode, label);
  assert.deepEqual(c.configWarnings, [], label);
  assert.deepEqual(c.configErrors, [], label);
  assert.equal(c.runQuery.enabled, true, label);
};

test('rules.mode: výchozí full; config.json a POHODA_RULES_MODE (trim, velikost písmen), proměnná má přednost', () => {
  assertMode(loadCfg(undefined), 'full', 'bez souboru');
  assertMode(loadCfg({}), 'full', 'prázdný soubor');
  assertMode(loadCfg({ rules: {} }), 'full', 'rules bez mode');
  assertMode(loadCfg({ rules: { mode: null } }), 'full', 'mode null');
  assertMode(loadCfg({ rules: { mode: 'compact' } }), 'compact', 'soubor compact');
  assertMode(loadCfg({ rules: { mode: ' Compact ' } }), 'compact', 'soubor s mezerami');
  assertMode(loadCfg({ rules: { mode: 'full' } }), 'full', 'soubor full');
  for (const v of ['compact', 'COMPACT', '  Compact  ']) assertMode(loadCfg(undefined, { POHODA_RULES_MODE: v }), 'compact', v);
  assertMode(loadCfg(undefined, { POHODA_RULES_MODE: 'FULL' }), 'full', 'env FULL');
  assertMode(loadCfg({ rules: { mode: 'compact' } }, { POHODA_RULES_MODE: 'full' }), 'full', 'proměnná přebije soubor');
  assertMode(loadCfg({ rules: { mode: 'full' } }, { POHODA_RULES_MODE: 'compact' }), 'compact', 'proměnná přebije soubor');
});

test('rules.mode: prázdná proměnná nebo zástupný text ${…} = nenastaveno', () => {
  for (const v of ['', '   ', '${user_config.rules_mode}', ' ${x} ']) {
    assertMode(loadCfg(undefined, { POHODA_RULES_MODE: v }), 'full', JSON.stringify(v));
    assertMode(loadCfg({ rules: { mode: 'compact' } }, { POHODA_RULES_MODE: v }), 'compact', JSON.stringify(v));
  }
});

test('rules.mode: neplatná hodnota → configWarnings a full, spouštění dotazů zůstává zapnuté', () => {
  const warned = (c, pattern, label) => {
    assert.equal(c.rules.mode, 'full', label);
    assert.equal(c.configWarnings.length, 1, `${label}: ${JSON.stringify(c.configWarnings)}`);
    assert.match(c.configWarnings[0], pattern, label);
    assert.deepEqual(c.configErrors, [], label);
    assert.equal(c.runQuery.enabled, true, label);
  };
  for (const v of ['kompakt', 'compact,full', 'on', '1']) {
    warned(loadCfg(undefined, { POHODA_RULES_MODE: v }), /^Proměnná POHODA_RULES_MODE má neplatnou hodnotu „.*“ – povolené je full nebo compact \(použit režim full\)\.$/, `env ${v}`);
    // neplatná proměnná = full, i když soubor říká compact
    warned(loadCfg({ rules: { mode: 'compact' } }, { POHODA_RULES_MODE: v }), /POHODA_RULES_MODE/, `env ${v} + soubor compact`);
  }
  for (const v of ['kompakt', '', 1, true, ['compact'], {}]) {
    warned(loadCfg({ rules: { mode: v } }), /^config\.json: rules\.mode má neplatnou hodnotu „.*“ – povolené je full nebo compact \(použit režim full\)\.$/, `soubor ${JSON.stringify(v)}`);
  }
  for (const v of ['compact', 5, ['compact']]) warned(loadCfg({ rules: v }), /^config\.json: rules musí být objekt \(použit režim pravidel full\)\.$/, `rules ${JSON.stringify(v)}`);
  // platná proměnná + neplatný soubor: platí proměnná, upozornění na soubor zůstává
  const c = loadCfg({ rules: { mode: 'kompakt' } }, { POHODA_RULES_MODE: 'compact' });
  assert.equal(c.rules.mode, 'compact');
  assert.equal(c.configWarnings.length, 1);
  assert.equal(c.runQuery.enabled, true);
  // dlouhá hodnota se v hlášce zkrátí
  assert.ok(loadCfg(undefined, { POHODA_RULES_MODE: 'x'.repeat(500) }).configWarnings[0].length < 200);
  // chyby nastavení (configErrors) na režim pravidel nemají vliv a upozornění mezi ně nepatří
  const bad = loadCfg({ rules: { mode: 'compact' }, runQuery: { enabled: 'ano' } });
  assert.equal(bad.rules.mode, 'compact');
  assert.equal(bad.runQuery.enabled, false);
  assert.equal(bad.configErrors.length, 1);
  assert.deepEqual(bad.configWarnings, []);
});

// ===== instrukce serveru podle režimu pravidel =====
const INSTRUCTIONS_FULL_OFF = `Server pohoda-mcp pomáhá psát a ověřovat T-SQL skripty nad databází účetního programu POHODA (Stormware, MS SQL). Odpovídej česky.
Doménová pravidla jsou závazná a mají přednost před obecným odhadem o Pohodě.

Postup:
1. PRVNÍ krok vždy pohoda_rules (bez parametru = jádro pravidel s rejstříkem kapitol), pak přečti celou kapitolu k tématu zadání (pohoda_rules chapter=…). U slovenské Pohody (databáze StwPhSK_…) kapitolu "sk" a schéma "sk".
2. Najdi tabulky a sloupce: pohoda_schema (search=… / table=…). Použij jen sloupce, které v popisu tabulky skutečně jsou. K dispozici jsou dvě schémata: "obecny" (CZ, výchozí) a "sk" (slovenská Pohoda, databáze StwPhSK_…).
3. Pojmy z programu (název pole, typ dokladu, postup) dohledej v nápovědě: pohoda_help.
4. Napiš skript: hlavička s účelem, obdobím, předpoklady a vyloučeními; všechny sloupce s aliasem tabulky; parametry nahoře přes DECLARE.
5. VŽDY ho zkontroluj nástrojem pohoda_check_query (stejné schéma jako při psaní) a opravuj CHYBY, VAROVÁNÍ odstraň nebo vysvětli.
6. Spouštění dotazů je vypnuté – skript jen napiš a zkontroluj.
7. Odpověz: skript v bloku kódu, výsledek kontroly, předpoklady a co je vyloučeno, co je nejisté ([?] v pravidlech, odhadnuté hodnoty Rel*).`;
const step1 = (t) => /^1\. .*$/m.exec(t)[0];

test('instrukce: režim full (výchozí) je znak po znaku původní text', () => {
  assert.equal(buildInstructions({ runQueryEnabled: false }), INSTRUCTIONS_FULL_OFF);
  assert.equal(buildInstructions({ runQueryEnabled: false, rulesMode: 'full' }), INSTRUCTIONS_FULL_OFF);
  assert.equal(buildInstructions({ runQueryEnabled: false, rulesMode: 'nesmysl' }), INSTRUCTIONS_FULL_OFF);
  // se zapnutým spouštěním se liší jen krok 6 a závěrečná poznámka o výsledcích
  const on = buildInstructions();
  assert.equal(on, SERVER_INSTRUCTIONS);
  assert.equal(on, buildInstructions({ runQueryEnabled: true, rulesMode: 'full' }));
  assert.equal(step1(on), step1(INSTRUCTIONS_FULL_OFF));
  assert.equal(on.split('\n6. ')[0], INSTRUCTIONS_FULL_OFF.split('\n6. ')[0]);
  assert.equal(WORKFLOW_PROMPT('kolik faktur', { runQueryEnabled: false }), `${INSTRUCTIONS_FULL_OFF}\n\n---\nZadání: kolik faktur`);
});

test('instrukce: režim compact mění jen krok 1 (sekce, kapitola, hledání); prompt stejně', () => {
  for (const runQueryEnabled of [true, false]) {
    const full = buildInstructions({ runQueryEnabled });
    const compact = buildInstructions({ runQueryEnabled, rulesMode: 'compact' });
    assert.notEqual(step1(compact), step1(full));
    assert.equal(compact.replace(step1(compact), step1(full)), full);
    assert.match(step1(compact), /^1\. PRVNÍ krok vždy pohoda_rules \(bez parametru = kompaktní jádro pravidel/);
    for (const part of ['rejstřík ostatních sekcí jádra', 'pohoda_rules section=…', 'pohoda_rules chapter=…', 'pohoda_rules search=…', 'kapitolu "sk" a schéma "sk"']) assert.ok(step1(compact).includes(part), part);
    assert.equal(WORKFLOW_PROMPT('kolik faktur', { runQueryEnabled, rulesMode: 'compact' }), `${compact}\n\n---\nZadání: kolik faktur`);
    assert.equal(WORKFLOW_PROMPT('kolik faktur', { runQueryEnabled }), `${full}\n\n---\nZadání: kolik faktur`);
  }
});
