// Čtení znalostí: pravidla, schéma tabulek, nápověda. Zdroj = snímek `knowledge\` vedle serveru (scripts\Sync-Knowledge.ps1).
import fs from 'node:fs';
import path from 'node:path';

const cache = new Map(); // klíč → obsah (soubory se čtou líně a jen jednou za běh serveru)

function read(file) {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  return cache.get(file);
}
const exists = (p) => fs.existsSync(p);
const cap = (text, max) => (text.length > max ? `${text.slice(0, max)}\n\n… [zkráceno na ${max} znaků z ${text.length}]` : text);

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
  if (!chapters.includes(name)) throw new Error(`Kapitola „${chapter}“ neexistuje. Dostupné: ${chapters.join(', ')}`);
  return read(path.join(cfg.agentDir, 'pravidla', `${name}.md`));
}

export function listSchemas(cfg) {
  const root = path.join(cfg.agentDir, 'schema');
  if (!exists(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && exists(path.join(root, d.name, 'tables'))).map((d) => d.name);
}

function tableFiles(cfg, schema) {
  const dir = path.join(cfg.agentDir, 'schema', schema, 'tables');
  if (!exists(dir)) throw new Error(`Schéma „${schema}“ neexistuje. Dostupná: ${listSchemas(cfg).join(', ')}`);
  return { dir, files: fs.readdirSync(dir).filter((f) => f.endsWith('.md')) };
}

/** Bez parametrů přehled schémat; `table` = popis tabulky; `search` = hledání v popisech tabulek a sloupcích. */
export function getSchema(cfg, { schema = 'obecny', table, search }) {
  if (!table && !search) {
    const readme = path.join(cfg.agentDir, 'schema', 'README.md');
    return exists(readme) ? read(readme) : `Dostupná schémata: ${listSchemas(cfg).join(', ')}`;
  }
  const { dir, files } = tableFiles(cfg, schema);
  if (table) {
    const want = table.replace(/^dbo\./i, '').toLowerCase();
    const hit = files.find((f) => f.replace(/\.md$/, '').toLowerCase() === want);
    if (!hit) {
      const near = files.map((f) => f.replace(/\.md$/, '')).filter((n) => n.toLowerCase().includes(want) || want.includes(n.toLowerCase())).slice(0, 15);
      throw new Error(`Tabulka „${table}“ ve schématu ${schema} neexistuje.${near.length ? ` Podobné: ${near.join(', ')}` : ''}`);
    }
    return cap(read(path.join(dir, hit)), 60000);
  }
  const needle = search.toLowerCase();
  const results = [];
  for (const f of files) {
    const lines = read(path.join(dir, f)).split(/\r?\n/);
    const hits = lines.filter((l) => l.toLowerCase().includes(needle));
    if (!hits.length) continue;
    const nameHit = f.toLowerCase().includes(needle) ? 1000 : 0;
    results.push({ name: f.replace(/\.md$/, ''), score: hits.length + nameHit, hits });
  }
  results.sort((a, b) => b.score - a.score);
  if (!results.length) return `Nic nenalezeno pro „${search}“ ve schématu ${schema}.`;
  const out = results.slice(0, 25).map((r) => `### ${r.name} (${r.hits.length} shod)\n${r.hits.slice(0, 4).map((l) => `- ${l.trim().slice(0, 220)}`).join('\n')}`);
  return `Nalezeno v ${results.length} tabulkách (ukázka 25). Celý popis: pohoda_schema s parametrem table.\n\n${out.join('\n\n')}`;
}

function helpDir(cfg, lang) {
  const dir = path.join(cfg.agentDir, 'reference', lang === 'sk' ? 'napoveda-sk' : 'napoveda');
  if (!exists(dir)) throw new Error(`Nápověda ${lang} nenalezena v ${dir}`);
  return dir;
}

/** `page` = celá stránka nápovědy (název souboru z výsledků); jinak fulltext (všechna slova musí být na stránce). */
export function getHelp(cfg, { query, lang = 'cz', page, limit = 8 }) {
  const dir = helpDir(cfg, lang);
  if (page) {
    const safe = path.basename(page);
    const file = path.join(dir, safe.endsWith('.txt') ? safe : `${safe}.txt`);
    if (!exists(file)) throw new Error(`Stránka „${page}“ neexistuje.`);
    return cap(read(file), 30000);
  }
  if (!query) throw new Error('Zadej query (hledaný text) nebo page (soubor stránky).');
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.txt')) continue;
    const text = read(path.join(dir, f));
    const low = text.toLowerCase();
    if (!words.every((w) => low.includes(w))) continue;
    const title = text.split(/\r?\n/, 1)[0].trim();
    const score = words.reduce((s, w) => s + low.split(w).length - 1, 0) + (words.every((w) => title.toLowerCase().includes(w)) ? 50 : 0);
    const lines = text.split(/\r?\n/);
    const snip = lines.filter((l) => words.some((w) => l.toLowerCase().includes(w))).slice(0, 3).map((l) => l.trim().slice(0, 240));
    results.push({ file: f, title, score, snip });
  }
  results.sort((a, b) => b.score - a.score);
  if (!results.length) return `Nic nenalezeno pro „${query}“ (${lang}). Zkus kratší nebo jiný výraz (nápověda používá slova z programu).`;
  const n = Math.min(Math.max(limit, 1), 25);
  const out = results.slice(0, n).map((r) => `### ${r.title}  \`${r.file}\`\n${r.snip.map((s) => `> ${s}`).join('\n')}`);
  return `Nalezeno ${results.length} stránek (zobrazeno ${Math.min(n, results.length)}). Celou stránku načti parametrem page.\n\n${out.join('\n\n')}`;
}
