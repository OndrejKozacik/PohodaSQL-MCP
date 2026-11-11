// Čtení znalostí: pravidla, schéma tabulek, nápověda. Zdroj = snímek `knowledge\` vedle serveru (scripts\Sync-Knowledge.ps1).
import fs from 'node:fs';
import path from 'node:path';

const cache = new Map(); // soubor → { text, folded } (soubory se čtou líně a jen jednou za běh serveru)
const PAGE_CHARS = 30000; // nejdelší úsek stránky nápovědy na jedno volání
const MAX_WORDS = 12; // nejvíc hledaných slov v jednom dotazu
const MAX_QUERY_SHOWN = 100; // délka dotazu opsaného do hlášky

function entry(file) {
  if (!cache.has(file)) cache.set(file, { text: fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), folded: null });
  return cache.get(file);
}
const read = (file) => entry(file).text;
/** Text souboru pro hledání: malá písmena bez diakritiky; počítá se jednou a drží se vedle původního textu. */
function readFolded(file) {
  const e = entry(file);
  if (e.folded === null) e.folded = fold(e.text);
  return e.folded;
}
/** Sjednocení pro porovnání bez ohledu na velikost písmen a diakritiku („Částka“ = „castka“). Konce řádků zachovává. */
const fold = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const exists = (p) => fs.existsSync(p);
const cap = (text, max) => (text.length > max ? `${text.slice(0, max)}\n\n… [zkráceno na ${max} znaků z ${text.length}]` : text);
const shown = (s, max = MAX_QUERY_SHOWN) => (s.length > max ? `${s.slice(0, max)}…` : s);
/** Hledaná slova: bez diakritiky, malými písmeny, bez duplicit, nejvýše MAX_WORDS. */
const toWords = (s) => [...new Set(fold(s).split(/\s+/).filter(Boolean))].slice(0, MAX_WORDS);

export function listRuleChapters(cfg) {
  const dir = path.join(cfg.agentDir, 'pravidla');
  return exists(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort() : [];
}

/** Bez `chapter` jádro pravidel (pravidla.md, rejstřík kapitol na začátku); jinak celá kapitola z pravidla/<chapter>.md. */
export function getRules(cfg, chapter) {
  const chapters = listRuleChapters(cfg);
  if (!chapter) {
    const core = path.join(cfg.agentDir, 'pravidla.md');
    if (!exists(core)) throw new Error(`Znalosti nenalezeny (chybí ${core}). Vytvoř snímek: powershell -File scripts\\Sync-Knowledge.ps1, nebo použij sestavený balíček .mcpb.`);
    return `${read(core)}\n\n---\nDostupné kapitoly (volej pohoda_rules s parametrem chapter): ${chapters.join(', ')}`;
  }
  const name = chapter.toLowerCase().replace(/\.md$/, '');
  if (!chapters.includes(name)) throw new Error(`Kapitola „${shown(chapter)}“ neexistuje. Dostupné: ${chapters.join(', ')}`);
  return read(path.join(cfg.agentDir, 'pravidla', `${name}.md`));
}

export function listSchemas(cfg) {
  const root = path.join(cfg.agentDir, 'schema');
  if (!exists(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && exists(path.join(root, d.name, 'tables'))).map((d) => d.name);
}

/**
 * Kanonický název schématu ze seznamu listSchemas (bez ohledu na velikost písmen), jinak chyba. Vstup se jen porovnává se seznamem
 * složek, nikdy se z něj neskládá cesta – „..\..\x“, lomítka ani absolutní cesta se tak mimo knowledge\ nedostanou.
 */
export function resolveSchema(cfg, name) {
  const schemas = listSchemas(cfg);
  const want = String(name ?? '').trim().toLowerCase();
  const hit = schemas.find((s) => s.toLowerCase() === want);
  if (!hit) throw new Error(`Schéma „${shown(String(name ?? ''))}“ neexistuje. Dostupná: ${schemas.join(', ')}`);
  return hit;
}

function tableFiles(cfg, schema) {
  const name = resolveSchema(cfg, schema);
  const dir = path.join(cfg.agentDir, 'schema', name, 'tables');
  return { name, dir, files: fs.readdirSync(dir).filter((f) => f.endsWith('.md')) };
}

/** Bez parametrů přehled schémat; `table` = popis tabulky; `search` = hledání v popisech tabulek a sloupcích. */
export function getSchema(cfg, { schema, table, search } = {}) {
  if (!table && typeof search === 'string' && !search.trim()) throw new Error('Parametr search je prázdný – zadej hledaný text (název sloupce nebo slovo z popisu).');
  if (!table && !search) {
    const readme = path.join(cfg.agentDir, 'schema', 'README.md');
    return exists(readme) ? read(readme) : `Dostupná schémata: ${listSchemas(cfg).join(', ')}`;
  }
  const { name, dir, files } = tableFiles(cfg, schema === undefined || schema === null || schema === '' ? 'obecny' : schema);
  if (table) {
    const want = table.trim().replace(/^dbo\./i, '').toLowerCase();
    const hit = files.find((f) => f.replace(/\.md$/, '').toLowerCase() === want);
    if (!hit) {
      const near = want ? files.map((f) => f.replace(/\.md$/, '')).filter((n) => n.toLowerCase().includes(want) || want.includes(n.toLowerCase())).slice(0, 15) : [];
      throw new Error(`Tabulka „${shown(table)}“ ve schématu ${name} neexistuje.${near.length ? ` Podobné: ${near.join(', ')}` : ''}`);
    }
    return cap(read(path.join(dir, hit)), 60000); // pojistka; popisy tabulek mají dnes nejvýš ~20 000 znaků
  }
  const words = toWords(search);
  const results = [];
  for (const f of files) {
    const file = path.join(dir, f);
    const folded = readFolded(file);
    if (!words.every((w) => folded.includes(w))) continue; // rychlé vyřazení bez dělení na řádky
    // hlavička exportu (<!-- … db, datum -->) není popis tabulky – nehledá se v ní a nezobrazuje se
    const lines = read(file).split('\n');
    const hits = [];
    const found = new Set();
    folded.split('\n').forEach((l, i) => {
      if (l.trimStart().startsWith('<!--')) return;
      const inLine = words.filter((w) => l.includes(w));
      if (!inLine.length) return;
      inLine.forEach((w) => found.add(w));
      hits.push(lines[i]);
    });
    if (found.size < words.length) continue; // všechna slova musí být v popisu tabulky
    const tableName = f.replace(/\.md$/, '');
    const nameHit = words.some((w) => fold(tableName).includes(w)) ? 1000 : 0;
    results.push({ name: tableName, score: hits.length + nameHit, hits });
  }
  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  if (!results.length) return `Nic nenalezeno pro „${shown(search.trim())}“ ve schématu ${name}. Zkus jedno slovo (víc slov musí být v popisu tabulky všechna) nebo výraz bez diakritiky; hledá se v názvech sloupců a v poznámkách.`;
  const out = results.slice(0, 25).map((r) => `### ${r.name} (${r.hits.length} shod)\n${r.hits.slice(0, 4).map((l) => `- ${l.trim().slice(0, 220)}`).join('\n')}`);
  return `Nalezeno v ${results.length} tabulkách (ukázka ${Math.min(25, results.length)}). Celý popis: pohoda_schema s parametrem table.\n\n${out.join('\n\n')}`;
}

function helpDir(cfg, lang) {
  const dir = path.join(cfg.agentDir, 'reference', lang === 'sk' ? 'napoveda-sk' : 'napoveda');
  if (!exists(dir)) throw new Error(`Nápověda ${lang === 'sk' ? 'sk' : 'cz'} nenalezena v ${dir}`);
  return dir;
}

/** Počet výskytů slova v textu, nejvýše `max` (dlouhá stránka nemá vítězit jen délkou). */
function countUpTo(text, word, max) {
  let n = 0;
  for (let i = text.indexOf(word); i !== -1 && n < max; i = text.indexOf(word, i + word.length)) n++;
  return n;
}

/**
 * `page` = stránka nápovědy (název souboru z výsledků), po úsecích PAGE_CHARS znaků od `offset`;
 * jinak fulltext (všechna slova musí být na stránce, bez ohledu na velikost písmen a diakritiku).
 */
export function getHelp(cfg, { query, lang = 'cz', page, limit = 8, offset } = {}) {
  const dir = helpDir(cfg, lang);
  if (page) {
    const safe = path.basename(page);
    const file = path.join(dir, safe.endsWith('.txt') ? safe : `${safe}.txt`);
    if (!safe || !exists(file) || !fs.statSync(file).isFile()) throw new Error(`Stránka „${shown(page)}“ neexistuje.`);
    const text = read(file);
    const from = offset ?? 0;
    if (!Number.isInteger(from) || from < 0) throw new Error('Parametr offset musí být celé nezáporné číslo (pozice ve znacích).');
    if (from > 0 && from >= text.length) throw new Error(`Parametr offset=${from} je za koncem stránky (má ${text.length} znaků).`);
    let to = Math.min(from + PAGE_CHARS, text.length);
    if (to < text.length) {
      const nl = text.lastIndexOf('\n', to - 1); // řež na konci řádku, pokud je rozumně blízko
      if (nl >= from + PAGE_CHARS * 0.8) to = nl + 1;
    }
    const part = text.slice(from, to);
    return to < text.length ? `${part}\n\n… pokračování: offset=${to} (z ${text.length} znaků)` : part;
  }
  if (typeof query !== 'string' || !query.trim()) throw new Error('Zadej query (hledaný text) nebo page (soubor stránky).');
  const words = toWords(query);
  if (!words.length) throw new Error('Zadej query (hledaný text) nebo page (soubor stránky).');
  const wanted = fold(query.trim()).replace(/\s+/g, ' ');
  const results = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.txt')) continue;
    const file = path.join(dir, f);
    const low = readFolded(file);
    if (!words.every((w) => low.includes(w))) continue;
    const title = read(file).split(/\r?\n/, 1)[0].trim();
    const lowTitle = fold(title).replace(/\s+/g, ' ');
    // pořadí: přesný titulek → titulek se všemi slovy → počet výskytů (každé slovo nejvýš 20×)
    const rank = lowTitle === wanted ? 2 : (words.every((w) => lowTitle.includes(w)) ? 1 : 0);
    const score = words.reduce((s, w) => s + countUpTo(low, w, 20), 0);
    results.push({ file, name: f, title, rank, score });
  }
  results.sort((a, b) => b.rank - a.rank || b.score - a.score || a.name.localeCompare(b.name));
  const q = shown(query.trim());
  if (!results.length) return `Nic nenalezeno pro „${q}“ (${lang === 'sk' ? 'sk' : 'cz'}). Zkus kratší nebo jiný výraz (nápověda používá slova z programu).`;
  const n = Math.min(Math.max(Math.trunc(Number(limit)) || 8, 1), 25);
  const out = results.slice(0, n).map((r) => {
    const lines = read(r.file).split('\n');
    const snip = [];
    readFolded(r.file).split('\n').some((l, i) => {
      if (words.some((w) => l.includes(w))) snip.push(lines[i].trim().slice(0, 240));
      return snip.length >= 3;
    });
    return `### ${r.title}  \`${r.name}\`\n${snip.map((s) => `> ${s}`).join('\n')}`;
  });
  return `Nalezeno ${results.length} stránek (zobrazeno ${Math.min(n, results.length)}). Celou stránku načti parametrem page.\n\n${out.join('\n\n')}`;
}
