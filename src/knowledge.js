// Čtení znalostí: pravidla, schéma tabulek, nápověda. Zdroj = snímek `knowledge\` vedle serveru (scripts\Sync-Knowledge.ps1).
import fs from 'node:fs';
import path from 'node:path';

const cache = new Map(); // soubor → { text, folded } (soubory se čtou líně a jen jednou za běh serveru)
const sectionCache = new Map(); // soubor pravidel → { list, byId } (na sekce se dělí líně a jen jednou za běh serveru)
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
// Oddělovače hledaných slov: bílé znaky, čárka, středník, závorky a uvozovky („storno, dobropis“, „(FA)“, „`RelTpFak`“).
// Tečka a podtržítko zůstávají součástí slova (dbo.FA, FA.RefAD, Radek_5).
const RE_WORD_SEP = /[\s,;()`"'„“”]+/;
/** Všechna hledaná slova: bez diakritiky, malými písmeny, bez duplicit. */
const allWords = (s) => [...new Set(fold(s).split(RE_WORD_SEP).filter(Boolean))];
/** Hledaná slova, nejvýše MAX_WORDS (další se nehledají). */
const toWords = (s) => allWords(s).slice(0, MAX_WORDS);
/** Výraz pro shodu CELÉHO slova v textu po `fold`: kolem nesmí být písmeno ani číslice („ad“ v „dbo.ad“, ne v „sklad“ nebo „refad“). */
const wholeWord = (w) => new RegExp(`(?<![a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'g');
/** Počet shod výrazu v textu, nejvýše `max`. */
function countMatchesUpTo(text, re, max) {
  let n = 0;
  re.lastIndex = 0;
  while (n < max && re.exec(text)) n++;
  return n;
}

export function listRuleChapters(cfg) {
  const dir = path.join(cfg.agentDir, 'pravidla');
  return exists(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort() : [];
}

// ===== Pravidla po sekcích =====
// Jádro i kapitoly se dělí podle nadpisů `##` a `###` (nadpisy uvnitř bloků kódu ``` se neberou). Id sekce:
//   • číslovaný nadpis („## 5. Faktury“, „### 11.15. Rozvaha“; za číslem musí být tečka) → jeho číslo: `5`, `11.15`;
//     sekce `5` zahrnuje podsekce `5.x` a končí u dalšího číslovaného nadpisu, který pod ni nepatří;
//   • `uvod` = vše před prvním číslovaným nadpisem (v jádru hlavička a rejstřík „Kapitoly k dočtení“); nemá-li soubor žádný
//     číslovaný nadpis, vše před prvním nadpisem;
//   • nadpis bez čísla (za úvodem) → slug z titulku: malá písmena bez diakritiky, vše ostatní „-“, nejvýše 40 znaků
//     („## Časté chyby“ → `caste-chyby`); končí u dalšího nadpisu stejné nebo vyšší úrovně. Opakované id dostane příponu `-2`, `-3` …;
//     slug jen z číslic dostane předponu `sekce-` („## 2026“ → `sekce-2026`), aby se nepletl s číslem sekce.
// Id se jen hledá v mapě sekcí, nikdy se z něj neskládá cesta.
const RE_FENCE = /^\s*(```|~~~)/;
const RE_HEADING = /^(#{2,3})\s+(\S.*)$/;
const RE_NUMBERED = /^(\d+(?:\.\d+)*)\.\s+(\S.*)$/;
// Odkazová sekce: pod nadpisem je JEDINÝ řádek přesně tohoto tvaru (tak ho generuje Update-PohodaAI.ps1). Pouhá zmínka
// „viz pravidla/sklad.md“ v krátké skutečné sekci odkazovou sekci nedělá.
const RE_STUB = /^→ Obsah je v kapitole `pravidla\/([a-z0-9-]+)\.md`[^\n]*$/;
const STUB_MAX_CHARS = 300; // delší text pod nadpisem už není pouhý odkaz na kapitolu
const MAX_RULE_RESULTS = 15; // nejvíc sekcí ve výsledku hledání
const TITLE_SHOWN = 110; // délka titulku v rejstříku a ve výsledcích hledání

/**
 * Sekce, které kompaktní jádro (režim `compact`) vrací vždy; ostatní jsou jen v rejstříku a načítají se podle tématu.
 * Výběr = pravidla potřebná prakticky u každého dotazu bez ohledu na agendu: 0 role a výstup, 1 databáze a varianta CZ/SK,
 * 2 které tabulky nezapočítávat (prefixy), 3 pojmenování sloupců (Rel*, Ref*, Kc*), 4 mapa hlavních tabulek, 5.2 storno a
 * 5.3 výchozí výklad „obratu“ (týká se každého součtu dokladů), 8.1 co databáze nevynucuje (LEFT JOIN na číselníky) a
 * 8.2 cíle vazeb Ref*, 9 datové typy a technické pasti, 10 instalačně specifické věci, 11.6 pomocný dotaz pro neznámou hodnotu
 * Rel* (míří na něj sekce 0). Ostatní tematické sekce (5.1 a 5.4 faktury, 7 číselníky, zbytek 8, 11 vzory, 12 zápis) tvoří
 * většinu velikosti jádra a načítají se podle tématu. Podsekce se vracejí bez nadpisu nadřazené sekce; ta zůstává v rejstříku
 * s velikostí bez již vrácených podsekcí.
 * Id, které v jádru přestane existovat (přečíslování zdroje), se tiše vynechá – hlásí ho compactSetWarnings.
 */
export const RULES_COMPACT_SECTIONS = ['0', '1', '2', '3', '4', '5.2', '5.3', '8.1', '8.2', '9', '10', '11.6'];

function slugify(title) {
  const s = fold(title).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return !s || /^[\d-]+$/.test(s) ? `sekce-${s || 'x'}` : s; // čistě číselný slug by se pletl s číslem sekce
}

/** Rozdělí soubor pravidel na sekce (viz komentář výše). `text` sekce = celý rozsah včetně podsekcí, `own` = jen po další nadpis. */
function parseSections(file) {
  if (sectionCache.has(file)) return sectionCache.get(file);
  const lines = read(file).split('\n');
  const heads = [];
  let fence = false;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (RE_FENCE.test(line)) { fence = !fence; return; }
    if (fence) return;
    const m = RE_HEADING.exec(line);
    if (!m) return;
    const num = RE_NUMBERED.exec(m[2].trim());
    heads.push({ line: i, level: m[1].length, numbered: !!num, num: num ? num[1] : null, title: (num ? num[2] : m[2]).trim() });
  });
  // nadpisy bez čísla před prvním číslovaným patří do úvodu (rejstřík kapitol v jádru)
  const firstNumbered = heads.findIndex((h) => h.numbered);
  const used = firstNumbered > 0 ? heads.slice(firstNumbered) : heads;
  const slice = (from, to) => lines.slice(from, to).join('\n').replace(/\r/g, '').trim();
  const list = [];
  const byId = new Map();
  const add = (s) => {
    let id = s.id;
    for (let n = 2; byId.has(id); n++) id = `${s.id}-${n}`;
    byId.set(id, s);
    list.push(Object.assign(s, { id, folded: null })); // text pro hledání se počítá až při prvním hledání
  };
  const introEnd = used.length ? used[0].line : lines.length;
  const intro = slice(0, introEnd);
  if (intro) add({ id: 'uvod', title: 'Úvod', level: 1, numbered: false, start: 0, end: introEnd, text: intro, own: intro });
  used.forEach((h, i) => {
    let j = i + 1;
    for (; j < used.length; j++) {
      const n = used[j];
      // číslovaná sekce končí u čísla, které pod ni nepatří; jinak rozhoduje úroveň nadpisu
      if (h.numbered && n.numbered ? !n.num.startsWith(`${h.num}.`) : n.level <= h.level) break;
    }
    const end = j < used.length ? used[j].line : lines.length;
    const ownEnd = i + 1 < used.length ? used[i + 1].line : lines.length;
    add({ id: h.numbered ? h.num : slugify(h.title), title: h.title, level: h.level, numbered: h.numbered, start: h.line, end, text: slice(h.line, end), own: slice(h.line, ownEnd) });
  });
  for (const s of list) {
    // „odkazová“ sekce: v souboru je jen nadpis a odkaz na kapitolu, kde je skutečný text
    const nl = s.own.indexOf('\n');
    const body = s.id === 'uvod' || nl < 0 ? '' : s.own.slice(nl + 1).trim(); // text pod nadpisem
    const m = body.length <= STUB_MAX_CHARS ? RE_STUB.exec(body) : null;
    s.ref = m ? m[1] : null;
    s.children = list.filter((c) => c !== s && c.start > s.start && c.end <= s.end);
  }
  const parsed = { list, byId };
  sectionCache.set(file, parsed);
  return parsed;
}

function coreFile(cfg) {
  const core = path.join(cfg.agentDir, 'pravidla.md');
  if (!exists(core)) throw new Error(`Znalosti nenalezeny (chybí ${core}). Vytvoř snímek: powershell -File scripts\\Sync-Knowledge.ps1, nebo použij sestavený balíček .mcpb.`);
  return core;
}
const chapterFile = (cfg, name) => path.join(cfg.agentDir, 'pravidla', `${name}.md`);
/** Kanonický název kapitoly ze seznamu listRuleChapters, jinak chyba; ze vstupu se cesta neskládá. */
function resolveChapter(chapters, chapter) {
  const name = chapter.toLowerCase().replace(/\.md$/, '');
  if (!chapters.includes(name)) throw new Error(`Kapitola „${shown(chapter)}“ neexistuje. Dostupné: ${chapters.join(', ')}`);
  return name;
}
const shownTitle = (s) => shown(s.title, TITLE_SHOWN);
/** Kapitola, na kterou odkazová sekce jádra vede (jen pokud taková kapitola ve snímku je). */
const refChapter = (s, chapters) => (s.ref && chapters.includes(s.ref) ? s.ref : null);
/** Sekce jádra, která sama ani v podsekcích nemá nic než odkazy na kapitolu. */
const isPointer = (s, chapters) => !!refChapter(s, chapters) && s.children.every((c) => refChapter(c, chapters));

/** Přehled sekcí jádra (bez `chapter`) nebo kapitoly: id, titulek, úroveň nadpisu a velikost ve znacích (včetně podsekcí). */
export function listRuleSections(cfg, chapter) {
  const file = chapter ? chapterFile(cfg, resolveChapter(listRuleChapters(cfg), chapter)) : coreFile(cfg);
  return parseSections(file).list.map((s) => ({ id: s.id, title: s.title, level: s.level, size: s.text.length }));
}

function ruleSection(cfg, chapters, chapterName, section) {
  const wanted = fold(section.trim()).replace(/\.$/, ''); // „5.1.“ opsané z nadpisu = „5.1“
  if (!wanted) throw new Error('Parametr section je prázdný – zadej id sekce (např. "5", "5.1", "11.15" nebo "uvod").');
  const { list, byId } = parseSections(chapterName ? chapterFile(cfg, chapterName) : coreFile(cfg));
  const hit = byId.get(wanted);
  if (!hit) {
    // sekce se stejným id bývá jinde (v kapitole, nebo v jádru) – napověz, kde je; odkazová sekce jádra se nenabízí
    const core = parseSections(coreFile(cfg)).byId.get(wanted);
    const places = [
      ...(chapterName && core && !refChapter(core, chapters) ? [`v jádru (pohoda_rules section=${wanted} bez chapter)`] : []),
      ...chapters.filter((c) => c !== chapterName && parseSections(chapterFile(cfg, c)).byId.has(wanted)).map((c) => `v kapitole ${c} (pohoda_rules chapter=${c} section=${wanted})`),
    ];
    const elsewhere = places.length ? ` Sekce ${wanted} je ${places.join(', ')}.` : '';
    throw new Error(`Sekce „${shown(section.trim())}“ ${chapterName ? `v kapitole ${chapterName}` : 'v jádru pravidel'} neexistuje. Platná id: ${list.map((s) => s.id).join(', ')}.${elsewhere}`);
  }
  const ref = chapterName ? null : refChapter(hit, chapters);
  if (!ref) return hit.text;
  const inChapter = parseSections(chapterFile(cfg, ref)).byId.has(hit.id);
  return `${hit.text}\n\n---\nTato sekce jádra jen odkazuje na kapitolu ${ref}. Načti ji: pohoda_rules chapter=${ref}${inChapter ? ` (jen tuto sekci: chapter=${ref} section=${hit.id})` : ''}.`;
}

function searchRules(cfg, chapters, chapterName, search) {
  const all = allWords(search);
  const words = all.slice(0, MAX_WORDS);
  const cut = all.length > MAX_WORDS ? ` Dotaz má ${all.length} různých slov – použito prvních ${MAX_WORDS} slov.` : '';
  const whole = words.map(wholeWord);
  const sources = chapterName ? [chapterName] : [null, ...chapters]; // null = jádro
  const results = [];
  sources.forEach((src, order) => {
    const { list } = parseSections(src ? chapterFile(cfg, src) : coreFile(cfg));
    const hits = [];
    for (const s of list) {
      // odkazové sekce jádra se nehledají – skutečný text (se stejným id) je v kapitole
      if (!src && refChapter(s, chapters)) continue;
      if (s.folded === null) {
        s.searchText = src ? s.text : [s.own, ...s.children.filter((c) => !refChapter(c, chapters)).map((c) => c.own)].join('\n');
        s.folded = fold(s.searchText);
        s.ownFolded = fold(s.own);
      }
      if (words.every((w) => s.folded.includes(w))) hits.push(s); // všechna slova musí být v jedné sekci
    }
    for (const s of hits) {
      // shoduje se i podsekce → stačí ta (je přesnější a menší); nadřazená zůstává jen tehdy, když má všechna slova i ve VLASTNÍM textu
      const childHit = hits.some((c) => s.children.includes(c));
      if (childHit && !words.every((w) => s.ownFolded.includes(w))) continue;
      // nadřazená sekce vedle své podsekce se hodnotí a ukazuje jen vlastním textem (podsekce má svůj řádek)
      const shownText = childHit ? s.own : s.searchText;
      const text = childHit ? s.ownFolded : s.folded;
      const title = fold(s.title);
      results.push({
        s, src, order, shownText, text,
        titleWhole: whole.filter((re) => { re.lastIndex = 0; return re.test(title); }).length,
        inTitle: words.filter((w) => title.includes(w)).length,
        wholeScore: whole.reduce((n, re) => n + countMatchesUpTo(text, re, 20), 0),
        score: words.reduce((n, w) => n + countUpTo(text, w, 20), 0),
      });
    }
  });
  if (!results.length) return `Nic nenalezeno pro „${shown(search.trim())}“ v pravidlech${chapterName ? ` (kapitola ${chapterName})` : ''}. Zkus jiné nebo kratší slovo (víc slov musí být všechna v jedné sekci), výraz bez diakritiky nebo název tabulky či sloupce.${cut}`;
  // pořadí: shoda CELÉHO slova má přednost před shodou uvnitř slova („ad“ v „dbo.AD“ před „sklad“) –
  //   víc hledaných slov jako celé slovo v titulku → víc výskytů celého slova v textu (každé slovo nejvýš 20×)
  //   → víc slov kdekoli v titulku → víc výskytů kdekoli → jádro před kapitolami → pořadí v souboru
  results.sort((a, b) => b.titleWhole - a.titleWhole || b.wholeScore - a.wholeScore || b.inTitle - a.inTitle || b.score - a.score || a.order - b.order || a.s.start - b.s.start);
  const out = results.slice(0, MAX_RULE_RESULTS).map(({ s, src, shownText, text }) => {
    const lines = shownText.split('\n');
    const snip = [];
    text.split('\n').some((l, i) => {
      if (i > 0 && lines[i].trim() && words.some((w) => l.includes(w))) snip.push(lines[i].trim().slice(0, 200)); // řádek 0 = nadpis
      return snip.length >= 3;
    });
    return `### ${s.id} · ${src ? `kapitola ${src}` : 'jádro'} · ${shownTitle(s)} (${s.text.length} znaků)${snip.map((x) => `\n> ${x}`).join('')}`;
  });
  return `Nalezeno ${results.length} sekcí pravidel (zobrazeno ${out.length}). Sekci načti: pohoda_rules section=<id> (u sekce z kapitoly navíc chapter=<kapitola>).${cut}\n\n${out.join('\n\n')}`;
}

/**
 * Pojistka kompaktní sady: id z RULES_COMPACT_SECTIONS, která v jádru pravidel nejsou (zdroj se přečísloval) nebo jsou jen
 * odkazem na kapitolu. Kompaktní jádro je pak neúplné – server to vypíše při startu a ukáže v pohoda_status.configWarnings.
 * Když jádro pravidel chybí úplně, vrací prázdný seznam (to hlásí až pohoda_rules).
 * @returns {string[]} texty upozornění
 */
export function compactSetWarnings(cfg) {
  let parsed;
  try { parsed = parseSections(coreFile(cfg)); } catch { return []; }
  const chapters = listRuleChapters(cfg);
  const missing = RULES_COMPACT_SECTIONS.filter((id) => !parsed.byId.has(id));
  const pointers = RULES_COMPACT_SECTIONS.filter((id) => parsed.byId.has(id) && isPointer(parsed.byId.get(id), chapters));
  const out = [];
  if (missing.length) out.push(`Kompaktní jádro pravidel: sekce ${missing.join(', ')} v pravidla.md neexistuje (přečíslovaný zdroj?) – kompaktní jádro je neúplné; uprav RULES_COMPACT_SECTIONS v src/knowledge.js.`);
  if (pointers.length) out.push(`Kompaktní jádro pravidel: sekce ${pointers.join(', ')} je v pravidla.md jen odkaz na kapitolu – kompaktní jádro její text neobsahuje; uprav RULES_COMPACT_SECTIONS v src/knowledge.js.`);
  return out;
}

/** Kompaktní jádro: úvod + sekce RULES_COMPACT_SECTIONS v plném znění, ostatní sekce jádra jen jako rejstřík (id, titulek, velikost). */
function compactCore(cfg, chapters) {
  const { list } = parseSections(coreFile(cfg));
  const keep = list.filter((s) => s.id === 'uvod' || RULES_COMPACT_SECTIONS.includes(s.id));
  const index = [];
  for (const s of list) {
    if (keep.some((k) => k === s || k.children.includes(s))) continue;
    // podsekce sekce, která celá jen odkazuje na kapitolu, se nevypisují (stačí řádek nadřazené sekce)
    if (list.some((p) => p.children.includes(s) && isPointer(p, chapters))) continue;
    const depth = s.numbered ? s.id.split('.').length - 1 : Math.max(s.level - 2, 0);
    const ref = refChapter(s, chapters);
    // podsekce, které už jsou v kompaktním jádru výše, se do velikosti nadřazené sekce nepočítají
    const given = keep.filter((k) => s.children.includes(k));
    const size = given.length
      ? `(${s.text.length - given.reduce((n, k) => n + k.text.length, 0)} znaků bez podsekcí ${given.map((k) => k.id).join(', ')} vrácených výše)`
      : `(${s.text.length} znaků)`;
    index.push(`${'  '.repeat(depth)}- ${s.id} – ${shownTitle(s)} ${ref ? `→ celý text je v kapitole ${ref} (chapter=${ref})` : size}`);
  }
  const kept = keep.filter((s) => s.id !== 'uvod').map((s) => s.id);
  return `${keep.map((s) => s.text).join('\n\n')}

---
Toto je KOMPAKTNÍ jádro pravidel: úvod s rejstříkem kapitol${kept.length ? ` a sekce ${kept.join(', ')}` : ''}. Ostatní sekce jádra jsou jen v rejstříku níže a jsou stejně závazné.
PŘED psaním SQL načti celou kapitolu k tématu zadání (pohoda_rules chapter=…) a příslušné sekce jádra (pohoda_rules section=…), např. section=5.1 typy faktur, section=5.4 částky a data na faktuře, section=7 číselníky, section=8.3 polymorfní vazby, section=11 vzorové dotazy, section=12 zápis (sekce, jejichž část už máš výše, načítej po zbylých podsekcích z rejstříku); DPH = chapter=dph, slovenská Pohoda = chapter=sk. Když nevíš, kde pravidlo je, hledej: pohoda_rules search=… (prohledá jádro i kapitoly).

Rejstřík ostatních sekcí jádra (id – titulek – velikost včetně podsekcí; u sekce, jejíž část už máš výše, velikost zbytku):
${index.length ? index.join('\n') : '(žádné další sekce)'}

Dostupné kapitoly (volej pohoda_rules s parametrem chapter): ${chapters.join(', ')}`;
}

/**
 * Pravidla. Druhý parametr je název kapitoly (řetězec), nebo objekt `{ chapter, section, search }`:
 *   • nic → jádro pravidel (pravidla.md, rejstřík kapitol na začátku) a seznam kapitol; při `cfg.rules.mode = "compact"`
 *     kompaktní jádro s rejstříkem ostatních sekcí;
 *   • `chapter` → celá kapitola z pravidla/<chapter>.md;
 *   • `section` → jedna sekce (včetně podsekcí) z jádra, s `chapter` z kapitoly;
 *   • `search` → seznam sekcí z jádra i kapitol (s `chapter` jen z ní), které obsahují všechna hledaná slova.
 */
export function getRules(cfg, arg) {
  const { chapter, section, search } = typeof arg === 'string' ? { chapter: arg } : (arg ?? {});
  const chapters = listRuleChapters(cfg);
  const hasSection = section !== undefined && section !== null;
  const hasSearch = search !== undefined && search !== null;
  if (hasSection && hasSearch) throw new Error('Parametry section a search nejde použít v jednom volání: search hledá sekce podle slov, section vrací jednu sekci podle id. Nejdřív hledej (search), potom načti vybranou sekci (section).');
  if (hasSearch && (typeof search !== 'string' || !toWords(search).length)) throw new Error('Parametr search je prázdný – zadej hledaný text (slovo z pravidel, název tabulky nebo sloupce).');
  if (hasSection && typeof section !== 'string') throw new Error('Parametr section je prázdný – zadej id sekce (např. "5", "5.1", "11.15" nebo "uvod").');
  const name = chapter ? resolveChapter(chapters, String(chapter)) : null;
  if (hasSection) return ruleSection(cfg, chapters, name, section);
  if (hasSearch) return searchRules(cfg, chapters, name, search);
  if (name) return read(chapterFile(cfg, name));
  const core = coreFile(cfg);
  if (cfg.rules?.mode === 'compact') return compactCore(cfg, chapters);
  return `${read(core)}\n\n---\nDostupné kapitoly (volej pohoda_rules s parametrem chapter): ${chapters.join(', ')}`;
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
