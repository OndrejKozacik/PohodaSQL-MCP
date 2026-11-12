// Čisté funkce runneru zlatých testů přes MCP (eval/run-golden-mcp.mjs): parsování golden.md, čtení výstupu
// `claude -p --output-format stream-json`, porovnání hodnot, metriky dodržení postupu a report.
// Nic tu nesahá na disk ani nespouští procesy – vše jde testovat nad vymyšlenými daty (test/golden-lib.test.js).

export const MODEL_DB = 'StwPh_12345678_2026';
export const MCP_SERVER_NAME = 'pohoda-sql';
export const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
export const STAV = { OK: 'PROŠLO', CAST: 'ČÁSTEČNĚ', NE: 'NEPROŠLO', AGENT: 'CHYBA AGENTA', BEZ: 'BEZ KONTROLY' };
const NASTROJE = ['pohoda_rules', 'pohoda_schema', 'pohoda_help', 'pohoda_check_query', 'pohoda_run_query', 'pohoda_status'];
const TOLERANCE = 0.005;
const MEZERY = /[\s   ]/g;

// ---------------------------------------------------------------------------
// golden.md
// ---------------------------------------------------------------------------

/**
 * Odstavec za tučným návěštím (`**Otázka:** …` až po prázdný řádek nebo další návěští), bílé znaky sloučené do mezer.
 * Prázdné návěští (`**Otázka:**` a hned prázdný řádek) dá prázdný text – nepřebere následující odstavec.
 */
function odstavec(sekce, hlava) {
  const m = new RegExp(`^\\*\\*${hlava}[^\\n]*?:\\*\\*[ \\t]*([\\s\\S]*?)(?=\\r?\\n[ \\t]*\\r?\\n|\\r?\\n\\*\\*[^\\n*]+:\\*\\*|$(?![\\s\\S]))`, 'm').exec(sekce);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

/**
 * Načte testy z textu golden.md: sekce `## Tn – název`, řádky **Otázka:**, **Kontrola:**, **Obsahuje:** (regulární výrazy
 * oddělené ` ;; `), volitelně **DB:** (jiná databáze než výchozí), **Známá hodnota:** a **Musí:** (jen k ručnímu posouzení).
 * @returns {Array<{id: string, nazev: string, otazka: string, znama: string, musi: string, kontrola: string, db: string, obsahuje: string[]}>}
 */
export function parseGolden(text) {
  const testy = [];
  for (const sekce of String(text).replace(/^﻿/, '').split(/^(?=## T\d+ )/m)) {
    const h = /^## (T\d+)\s+\S+\s+(.+?)\s*$/m.exec(sekce);
    if (!h) continue;
    const radek = (hlava) => new RegExp(`^\\*\\*${hlava}:\\*\\*[ \\t]*(.*?)[ \\t]*$`, 'm').exec(sekce)?.[1] ?? '';
    const obsahuje = [];
    for (const m of sekce.matchAll(/^\*\*Obsahuje:\*\*[ \t]*(.+?)[ \t]*$/gm)) {
      for (const p of m[1].split(/\s;;\s/)) {
        const v = p.trim().replace(/^`+|`+$/g, '');
        if (v) obsahuje.push(v);
      }
    }
    testy.push({
      id: h[1],
      nazev: h[2],
      otazka: odstavec(sekce, 'Otázka'),
      znama: odstavec(sekce, 'Známá hodnota'),
      musi: odstavec(sekce, 'Musí'),
      kontrola: radek('Kontrola'),
      db: radek('DB').split(/\s+/)[0] ?? '',
      obsahuje,
    });
  }
  return testy;
}

/** `T1,t2; T10` → ['T1', 'T2', 'T10'] */
export function parseIds(value) {
  return String(value ?? '').split(/[,;\s]+/).filter(Boolean).map((x) => x.toUpperCase());
}

/**
 * Výběr testů k běhu. Bez `ids` jen testy bez řádku **DB:** (modelová databáze); testy nad jinou databází
 * se spouštějí jen výslovným výčtem. Neznámá Id se vrací zvlášť.
 */
export function selectTests(testy, ids) {
  if (!ids || !ids.length) return { vybrane: testy.filter((t) => !t.db), nezname: [] };
  const mapa = new Map(testy.map((t) => [t.id, t]));
  return { vybrane: ids.filter((i) => mapa.has(i)).map((i) => mapa.get(i)), nezname: ids.filter((i) => !mapa.has(i)) };
}

// ---------------------------------------------------------------------------
// Čísla
// ---------------------------------------------------------------------------

/**
 * Možné číselné významy zápisu čísla. „1 766 656,00“, „1766656.00“ i „1,766,656.00“ → [1766656]; nejednoznačné „1,470“
 * (desetinná čárka, nebo oddělovač tisíců) → [1.47, 1470]. Co není číslo → [].
 */
export function numberCandidates(s) {
  let x = String(s ?? '').replace(MEZERY, '').replace(/−/g, '-');
  if (!/^[+-]?\d[\d.,]*$/.test(x) || /[.,]$/.test(x)) return [];
  const znamenko = x.startsWith('-') ? -1 : 1;
  x = x.replace(/^[+-]/, '');
  const carky = (x.match(/,/g) ?? []).length;
  const tecky = (x.match(/\./g) ?? []).length;
  const cislo = (t) => { const n = Number(t); return Number.isFinite(n) ? [znamenko * n] : []; };
  if (!carky && !tecky) return cislo(x);
  if (carky && tecky) {
    // poslední oddělovač je desetinný, druhý dělí tisíce
    const des = x.lastIndexOf(',') > x.lastIndexOf('.') ? ',' : '.';
    const tis = des === ',' ? '.' : ',';
    if (x.split(des).length !== 2) return [];
    return cislo(x.split(tis).join('').replace(des, '.'));
  }
  const sep = carky ? ',' : '.';
  const casti = x.split(sep);
  if (casti.length > 2) return casti.slice(1).every((c) => c.length === 3) ? cislo(casti.join('')) : [];
  const desetinne = cislo(`${casti[0]}.${casti[1]}`);
  // „1,470“ / „1.470“: může jít i o oddělovač tisíců
  if (casti[1].length === 3 && /^[1-9]\d{0,2}$/.test(casti[0])) return [...desetinne, ...cislo(casti.join(''))];
  return desetinne;
}

/** Číslo v českém zápisu z řádku **Kontrola:** (čárka = desetinná, mezery = tisíce); jinak null. */
export function toNumber(s) {
  const x = String(s ?? '').replace(MEZERY, '').replace(/−/g, '-');
  return /^[+-]?\d+([.,]\d+)?$/.test(x) ? Number(x.replace(',', '.')) : null;
}

// Číslo ve volném textu. Před ním nesmí být písmeno, číslice, tečka, čárka ani spojovník či lomítko navazující na slovo
// (FV-2026-0014 ani 2026/14 nejsou čísla); hned za ním smí být jednotka („1 766 656,00Kč“), jinak ne písmeno ani číslice (311x)
// a ne spojovník či lomítko se slovem (14-denní, 14/2026).
const JEDNOTKA = String.raw`(?:Kč|CZK|EUR|USD|ks)(?![\p{L}\d_])`;
const TISICE = String.raw`[    ]`;
const RE_CISLO_V_TEXTU = new RegExp(
  String.raw`(?<![\p{L}\d_.,])(?<![\p{L}\d_][-−/])[-−]?`
  + String.raw`(?:\d{1,3}(?:${TISICE}\d{3})+(?:[.,]\d+)?|\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)`
  + String.raw`(?!(?!${JEDNOTKA})[\p{L}\d_]|[.,]\d|[-−/][\p{L}\d_])`,
  'gu',
);

/** Všechna čísla nalezená ve volném textu (český i „strojový“ zápis). */
export function numbersInText(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(RE_CISLO_V_TEXTU)) out.push(...numberCandidates(m[0]));
  return out;
}

const MESICE = 'ledna|února|března|dubna|května|června|července|srpna|září|října|listopadu|prosince|januára|februára|marca|apríla|mája|júna|júla|augusta|septembra|októbra|novembra|decembra';

/**
 * Text odpovědi připravený pro hledání čísel: bez bloků kódu, kódu v řádku, dat (30. 6. 2026, 2026-06-30, 13. května 2026),
 * procent („13 %“) a číslování seznamu na začátku řádku („14. …“, „3) …“).
 * Jinak by se malé očekávané hodnoty (počty 2, 9, 14…) „našly“ v `IN (1, 2, 3, 8)`, v datu, v sazbě nebo v pořadí odrážky.
 */
export function cleanProse(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?/g, ' ')
    .replace(/(?<![\d.,])\d{1,2}\.\s?\d{1,2}\.\s?\d{4}(?!\d)/g, ' ')
    .replace(/(?<![\d.,])\d{1,2}\.\s\d{1,2}\.(?!\d)/g, ' ')
    .replace(new RegExp(String.raw`(?<![\d.,])\d{1,2}\.[  ]?(?:${MESICE})(?![\p{L}])(?:[  ]\d{4}(?!\d))?`, 'giu'), ' ')
    .replace(/(?<![\p{L}\d_.,])[-−+]?\d+(?:[.,]\d+)?[   ]?%/gu, ' ')
    .replace(/^[ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+)?\d{1,3}[.)](?=[ \t]|$)/gm, ' ');
}

// ---------------------------------------------------------------------------
// Výsledek nástroje pohoda_run_query (markdown tabulky)
// ---------------------------------------------------------------------------

function bunky(radek) {
  const t = radek.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/**
 * Rozebere text výsledku pohoda_run_query: `**Výsledek N** – X řádků` + tabulka, případně `**Zprávy (PRINT):**`.
 * Hlavička (databáze, server, doba) se přeskakuje. Buňka `NULL` = null.
 * @returns {{sets: Array<{cols: string[], rows: Array<Array<string|null>>, total: number}>, messages: string[]}}
 */
export function parseRunResult(text) {
  const sets = [];
  const messages = [];
  let set = null;
  let rezim = '';
  for (const radek of String(text ?? '').split(/\r?\n/)) {
    const titul = /^\*\*Výsledek \d+\*\* – (\d+) řádků/.exec(radek);
    if (titul) { set = { cols: null, rows: [], total: Number(titul[1]) }; sets.push(set); rezim = 'set'; continue; }
    if (/^\*\*Zprávy \(PRINT\):\*\*/.test(radek)) { rezim = 'zpravy'; set = null; continue; }
    if (rezim === 'set' && set && radek.startsWith('|')) {
      if (set.cols === null) set.cols = bunky(radek);
      else if (!/^\|(?:\s*:?-+:?\s*\|)+\s*$/.test(radek) || set.rows.length) set.rows.push(bunky(radek).map((c) => (c === 'NULL' ? null : c)));
      continue;
    }
    if (rezim === 'zpravy' && radek.trim() && !/^_\+\d+ dalších zpráv_$/.test(radek)) messages.push(radek);
  }
  for (const s of sets) s.cols ??= [];
  return { sets, messages };
}

const RE_CISLO_BUNKY = /^[+-]?\d+(?:\.\d+)?$/;
const cisloBunky = (c) => (c !== null && RE_CISLO_BUNKY.test(c.trim()) ? Number(c) : null);
// sloupce s identifikátory a vazbami: jejich hodnoty nejsou počty (ID = 14 není „14 faktur“)
const RE_SLOUPEC_ID = /^(?:ID|Ref.*|Rel.*)$/i;
const MALE_CISLO = 1000; // celá čísla pod touto hranicí se berou jen z důvěryhodných míst (viz compareValues)

/**
 * Nasbírá hodnoty pro porovnání.
 * Z výsledku pohoda_run_query se bere jen POSLEDNÍ text z `runTexts` (volající předává jen úspěšné běhy v pořadí volání):
 * dřívější běhy jsou pokusy, které agent sám opravil. U každého čísla se zapisuje původ (`druh`):
 *   `bunka` číselná buňka (+ `idSloupec`, je-li ze sloupce ID / Ref* / Rel*), `text` číslo vyčtené z textové buňky,
 *   `soucet` součet číselného sloupce (jen u nezkrácené tabulky s aspoň 2 řádky), `zprava` číslo ze zprávy PRINT.
 * `counts` = počet řádků POSLEDNÍHO result setu (a týž počet bez součtových řádků Celkem / Součet / Total).
 * Z odpovědi agenta: čísla z vyčištěného textu (cleanProse) a celý text pro hledání textových hodnot.
 */
export function collectValues({ runTexts = [], answer = '' }) {
  const nastroj = { nums: [], strs: new Set(), counts: [], behu: runTexts.length };
  const pridej = (n, druh, idSloupec = false) => nastroj.nums.push({ n, druh, idSloupec });
  const posledni = runTexts.length ? runTexts[runTexts.length - 1] : null;
  if (posledni !== null) {
    const r = parseRunResult(posledni);
    r.sets.forEach((s, poradi) => {
      if (poradi === r.sets.length - 1) {
        nastroj.counts.push(s.total);
        const soucty = s.rows.filter((row) => row.some((c) => c !== null && /^\s*(celkem|sou[čc]et|total)(?![\p{L}\d])/iu.test(c))).length;
        if (soucty) nastroj.counts.push(s.total - soucty);
      }
      const idSloupce = s.cols.map((c) => RE_SLOUPEC_ID.test(String(c ?? '').trim()));
      for (const row of s.rows) {
        row.forEach((c, i) => {
          if (c === null) return;
          const txt = c.trim();
          nastroj.strs.add(txt.replace(MEZERY, '').toLowerCase());
          const n = cisloBunky(txt);
          if (n !== null) { pridej(n, 'bunka', idSloupce[i] === true); return; }
          const kandidati = numberCandidates(txt);
          if (kandidati.length) for (const k of kandidati) pridej(k, 'bunka', idSloupce[i] === true); // „1 234,50“ – číslo v českém zápisu
          else if (txt.length <= 200) for (const k of numbersInText(cleanProse(txt))) pridej(k, 'text'); // „Počet otevřených položek: 13“
        });
      }
      // součty číselných sloupců – otázka může chtít celkem, skript dá rozpad (jen u nezkrácených tabulek)
      if (s.rows.length >= 2 && s.rows.length === s.total) {
        for (let i = 0; i < s.cols.length; i++) {
          let sum = 0;
          let ciselny = true;
          for (const row of s.rows) {
            const c = row[i];
            if (c === null || c === undefined) continue;
            const n = cisloBunky(c);
            if (n === null) { ciselny = false; break; }
            sum += n;
          }
          if (ciselny) pridej(Math.round(sum * 1e6) / 1e6, 'soucet', idSloupce[i] === true);
        }
      }
    });
    for (const m of r.messages) for (const k of numbersInText(m)) pridej(k, 'zprava');
  }
  return {
    nastroj,
    odpoved: { nums: numbersInText(cleanProse(answer)), text: String(answer ?? '').replace(MEZERY, '').toLowerCase() },
  };
}

/**
 * Porovnání s řádkem **Kontrola:** – skupiny oddělené `;` musí být nalezeny všechny, z alternativ `|` stačí jedna.
 * Číslo = hodnota ±0,005; bez znaménka v Kontrole se porovnává absolutní hodnota, s výslovným znaménkem (`-2949,00`, `+5`)
 * i znaménko. Celé číslo (bez desetinné čárky v Kontrole) může být i počet řádků posledního result setu. U celých čísel
 * pod 1000 (počty) se z výsledku nástroje NEPOUŽIJÍ čísla z textových buněk („FV-2026-0014“, „Dodavatel 14 s.r.o.“),
 * ze sloupců ID / Ref* / Rel* ani součty sloupců – jinak by se počet „našel“ skoro v každém výsledku.
 * Text = celá hodnota buňky nebo výskyt v odpovědi (bez ohledu na velikost písmen a mezery).
 * U každé skupiny se zapisuje zdroj shody: `nastroj` (výsledek pohoda_run_query) má přednost před `odpoved` (jen text odpovědi).
 */
export function compareValues(kontrola, hodnoty) {
  const skupiny = String(kontrola ?? '').split(';').map((x) => x.trim()).filter(Boolean);
  const hledej = (alt) => {
    const key = alt.replace(MEZERY, '').toLowerCase();
    const c = toNumber(alt);
    if (c === null) {
      if (hodnoty.nastroj.strs.has(key)) return 'nastroj';
      return key && hodnoty.odpoved.text.includes(key) ? 'odpoved' : null;
    }
    const seZnamenkem = /^[+\-−]/.test(alt.trim());
    const cele = !alt.includes(',') && Number.isInteger(c);
    const male = cele && Math.abs(c) < MALE_CISLO;
    const shoda = (n) => (seZnamenkem ? Math.abs(n - c) < TOLERANCE : Math.abs(Math.abs(n) - Math.abs(c)) < TOLERANCE);
    if (hodnoty.nastroj.nums.some((x) => shoda(x.n) && !(male && (x.druh === 'text' || x.druh === 'soucet' || x.idSloupec)))) return 'nastroj';
    if (cele && hodnoty.nastroj.counts.includes(c)) return 'nastroj';
    if (hodnoty.odpoved.nums.some(shoda)) return 'odpoved';
    return null;
  };
  const detail = skupiny.map((skupina) => {
    let zdroj = null;
    for (const alt of skupina.split('|').map((x) => x.trim()).filter(Boolean)) {
      const z = hledej(alt);
      if (z === 'nastroj') { zdroj = z; break; }
      zdroj ??= z;
    }
    return { skupina, nalezeno: zdroj !== null, zdroj };
  });
  return {
    ok: detail.filter((d) => d.nalezeno).length,
    celkem: detail.length,
    chybi: detail.filter((d) => !d.nalezeno).map((d) => d.skupina),
    jenVOdpovedi: detail.filter((d) => d.zdroj === 'odpoved').length,
    skupiny: detail,
  };
}

// ---------------------------------------------------------------------------
// SQL: cílové tabulky zápisu
// ---------------------------------------------------------------------------

/** SQL bez komentářů a s vyprázdněnými řetězci (klíčová slova v komentáři nebo v textu se nepočítají). */
export function stripSql(sql) {
  return String(sql ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

const RE_OBJEKT = String.raw`((?:(?:\[[^\]]+\]|[\w$]+)\s*\.\s*){0,3}(?:\[[^\]]+\]|[#@]{0,2}[\w$]+))`;
const posledniCast = (objekt) => objekt.split('.').pop().trim().replace(/^\[|\]$/g, '');
const bezZavorek = (nazev) => nazev.replace(/^\[|\]$/g, '').toLowerCase();

/** Rozdělí skript (už bez komentářů a řetězců) na příkazy: středník a řádek `GO`. Bez středníků zůstane dávka vcelku. */
function prikazy(s) {
  return s.split(/^[ \t]*GO[ \t]*(?:\d+[ \t]*)?\r?$/gim).flatMap((davka) => davka.split(';')).filter((p) => p.trim());
}

/** Pozice závorky uzavírající tu na pozici `od`; -1, když chybí. */
function konecZavorky(s, od) {
  let hloubka = 0;
  for (let i = od; i < s.length; i++) {
    if (s[i] === '(') hloubka++;
    else if (s[i] === ')' && --hloubka === 0) return i;
  }
  return -1;
}

/** CTE jednoho příkazu: název (malými písmeny) → objekt z první klauzule FROM v těle (null, když tělo FROM nemá). */
function cteZdroje(prikaz) {
  const zdroje = new Map();
  if (!/^\s*WITH\b/i.test(prikaz)) return zdroje;
  const re = /(?:\bWITH|,)\s*(\[[^\]]+\]|[\w$]+)\s*(?:\([^()]*\)\s*)?AS\s*\(/gi;
  for (let m = re.exec(prikaz); m; m = re.exec(prikaz)) {
    const od = m.index + m[0].length - 1;
    const konec = konecZavorky(prikaz, od);
    if (konec < 0) break;
    const from = new RegExp(String.raw`\bFROM\s+${RE_OBJEKT}`, 'i').exec(prikaz.slice(od + 1, konec));
    const nazev = bezZavorek(m[1]);
    if (!zdroje.has(nazev)) zdroje.set(nazev, from ? from[1].replace(/\s+/g, '') : null);
    re.lastIndex = konec + 1;
    if (!/^\s*,/.test(prikaz.slice(konec + 1))) break; // za posledním CTE začíná vlastní příkaz
  }
  return zdroje;
}

/**
 * Trvalé tabulky, do kterých skript zapisuje (INSERT / UPDATE / DELETE / MERGE / SELECT … INTO). Dočasné tabulky (#tmp)
 * a tabulkové proměnné (@t) se nepočítají. Skript se dělí na příkazy (`;`, `GO`) a v každém zvlášť se cíl bez schématu převádí:
 *   • alias na tabulku (`UPDATE f … FROM dbo.FA AS f`); má-li příkaz týž alias vícekrát, platí nejbližší definice ZA cílem,
 *     jinak poslední před ním – stejný alias v jiném příkazu (`dbo.FA f` a `#t f`) se tak neslije;
 *   • název CTE na jeho zdroj = první FROM v těle (`WITH c AS (SELECT * FROM dbo.FA) UPDATE c …` je zápis do FA,
 *     `WITH d AS (… FROM #t) DELETE FROM d` je dočasná tabulka); CTE z CTE se rozbalí.
 * @returns {string[]} názvy bez schématu a závorek, bez duplicit, v pořadí výskytu
 */
export function writeTargets(sql) {
  const nalezene = [];
  const top = String.raw`(?:TOP\s*\([^)]*\)\s*(?:PERCENT\s+)?)?`;
  const vzory = [
    [new RegExp(String.raw`\bINSERT\s+${top}(?:INTO\s+)?${RE_OBJEKT}`, 'gi'), false],
    [new RegExp(String.raw`\bMERGE\s+${top}(?:INTO\s+)?${RE_OBJEKT}`, 'gi'), false],
    [new RegExp(String.raw`\bUPDATE\s+${top}(?!STATISTICS\b)${RE_OBJEKT}(?=\s+(?:SET|WITH)\b)`, 'gi'), true],
    [new RegExp(String.raw`\bDELETE\s+${top}(?:FROM\s+)?${RE_OBJEKT}`, 'gi'), true],
    [new RegExp(String.raw`\bSELECT\b[^;]*?\bINTO\s+${RE_OBJEKT}(?=\s+FROM\b|\s*;|\s*$)`, 'gi'), false],
  ];
  for (const p of prikazy(stripSql(sql))) {
    const cte = cteZdroje(p);
    const aliasy = [...p.matchAll(new RegExp(String.raw`\b(?:FROM|JOIN)\s+${RE_OBJEKT}\s+(?:AS\s+)?([\w$]+)`, 'gi'))]
      .map((m) => ({ alias: m[2].toLowerCase(), objekt: m[1].replace(/\s+/g, ''), pozice: m.index }));
    const rozbalCte = (o) => {
      for (let i = 0; i < 10 && !o.includes('.') && cte.has(bezZavorek(o)); i++) {
        o = cte.get(bezZavorek(o));
        if (o === null) return null; // CTE bez FROM (jen konstanty) – není kam zapisovat
      }
      return o;
    };
    const pridej = (objekt, muzeBytAlias, pozice) => {
      let o = objekt.replace(/\s+/g, '');
      if (muzeBytAlias && !o.includes('.') && !cte.has(bezZavorek(o))) {
        const stejne = aliasy.filter((a) => a.alias === o.toLowerCase());
        const def = stejne.find((a) => a.pozice > pozice) ?? stejne[stejne.length - 1];
        if (def) o = def.objekt;
      }
      o = rozbalCte(o);
      if (o === null) return;
      const nazev = posledniCast(o);
      if (/^[#@]/.test(nazev)) return;
      if (!nalezene.some((x) => x.toLowerCase() === nazev.toLowerCase())) nalezene.push(nazev);
    };
    for (const [re, muzeBytAlias] of vzory) for (const m of p.matchAll(re)) pridej(m[1], muzeBytAlias, m.index);
  }
  return nalezene;
}

/** Bloky ```sql z textu odpovědi (v pořadí výskytu). */
export function sqlBlocks(text) {
  return [...String(text ?? '').matchAll(/```sql[^\n]*\r?\n([\s\S]*?)```/gi)].map((m) => m[1].trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// stream-json
// ---------------------------------------------------------------------------

function textObsahu(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? String(c.text ?? '') : '')).join('\n');
}

/**
 * Rozebere výstup `claude -p --output-format stream-json --verbose` (řádek = JSON zpráva).
 * @returns {{init: object|null, result: object|null, answer: string, calls: Array<{id: string, name: string, tool: string|null,
 *   input: object, result: string|null, isError: boolean}>}} `tool` = název nástroje serveru bez předpony (null u cizích nástrojů)
 */
export function parseStream(jsonl) {
  const calls = [];
  const podleId = new Map();
  let init = null;
  let result = null;
  let posledniText = '';
  for (const radek of String(jsonl ?? '').split(/\r?\n/)) {
    const t = radek.trim();
    if (!t.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (o.type === 'system' && o.subtype === 'init') init ??= o;
    else if (o.type === 'result') result = o;
    else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      const texty = [];
      for (const c of o.message.content) {
        if (c?.type === 'text' && c.text) texty.push(c.text);
        if (c?.type === 'tool_use') {
          const name = String(c.name ?? '');
          const call = { id: String(c.id ?? ''), name, tool: name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : null, input: c.input ?? {}, result: null, isError: false };
          calls.push(call);
          podleId.set(call.id, call);
        }
      }
      if (texty.length) posledniText = texty.join('\n');
    } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c?.type !== 'tool_result') continue;
        const call = podleId.get(String(c.tool_use_id ?? ''));
        if (!call) continue;
        call.result = textObsahu(c.content);
        call.isError = c.is_error === true;
      }
    }
  }
  const answer = typeof result?.result === 'string' && result.result ? result.result : posledniText;
  return { init, result, answer, calls };
}

/** Stav MCP serveru z úvodní zprávy (`connected`, `failed`, …); null, když ve výstupu není. */
export function mcpStatus(init) {
  const s = (init?.mcp_servers ?? []).find((x) => x?.name === MCP_SERVER_NAME);
  return s ? String(s.status ?? '') : null;
}

/**
 * Počty z úvodní zprávy klienta a z událostí hooků – měří, jak „čisté“ je prostředí agenta (čím méně vestavěných nástrojů,
 * pluginů, skills a hooků z profilu uživatele, tím méně cizího textu v promptu a tím srovnatelnější běhy).
 * @returns {{vestavenychNastroju: number, mcpNastroju: number, pluginu: number, skills: number, prikazu: number, agentu: number, hooku: number}|null}
 *   null, když výstup úvodní zprávu nemá
 */
export function initCounts(jsonl) {
  let init = null;
  let hooku = 0;
  for (const radek of String(jsonl ?? '').split(/\r?\n/)) {
    const t = radek.trim();
    if (!t.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (o.type !== 'system') continue;
    if (o.subtype === 'init') init ??= o;
    else if (o.subtype === 'hook_started') hooku++;
  }
  if (!init) return null;
  const pocet = (x) => (Array.isArray(x) ? x.length : 0);
  const nastroje = Array.isArray(init.tools) ? init.tools.map(String) : [];
  return {
    vestavenychNastroju: nastroje.filter((n) => !n.startsWith('mcp__')).length,
    mcpNastroju: nastroje.filter((n) => n.startsWith(TOOL_PREFIX)).length,
    pluginu: pocet(init.plugins), skills: pocet(init.skills), prikazu: pocet(init.slash_commands), agentu: pocet(init.agents), hooku,
  };
}

/** „vestavěné nástroje 0, nástroje MCP 6, pluginy 0, skills 0, příkazy 0, agenti 3, hooky 0“ */
export function formatInitCounts(p) {
  if (!p) return 'nezjištěno';
  return `vestavěné nástroje ${p.vestavenychNastroju}, nástroje MCP ${p.mcpNastroju}, pluginy ${p.pluginu}, skills ${p.skills}, příkazy ${p.prikazu}, agenti ${p.agentu}, hooky ${p.hooku}`;
}

// shoda textu SQL bez ohledu na komentáře a bílé znaky (agent často zkontroluje skript s hlavičkou a spustí ho bez ní)
export const normSql = (sql) => String(sql ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
const kodKontroly = (call) => { const m = /exit (\d+):/.exec(call.result ?? ''); return m ? Number(m[1]) : null; };
const kontrolaOk = (call) => !call.isError && kodKontroly(call) === 0;
const maText = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Metriky dodržení postupu – jen z volání nástrojů serveru pohoda-sql (cizí nástroje se počítají zvlášť).
 * - rulesPrvni: první volání je pohoda_rules BEZ `section` a `search` (tj. jádro nebo celá kapitola; bez volání = ne)
 * - checkPredRun: 'ano' = každé pohoda_run_query mělo dřív nějaké pohoda_check_query, 'ne', nebo 'n/a' (run se nevolal)
 * - runBezKontroly: počet pohoda_run_query, jejichž SQL (bez komentářů a bílých znaků) předtím neprošlo pohoda_check_query
 *   s výsledkem exit 0 (kontrola s chybami nebo chyba nástroje se jako „zkontrolováno“ nepočítá)
 * - kapitoly: co si agent z pravidel načetl, v pořadí prvního výskytu: `jádro`, `jádro §5`, `sklad`, `sklad §7.5`, `hledání`
 * - pravidla: počty volání pohoda_rules podle druhu (jadro, kapitoly, sekce, hledani) a `znaku` = součet délek vrácených textů
 */
export function evalMetrics(calls) {
  const nase = calls.filter((c) => c.tool);
  const volani = Object.fromEntries(NASTROJE.map((n) => [n, 0]));
  const kapitoly = [];
  const pravidla = { jadro: 0, kapitoly: 0, sekce: 0, hledani: 0, znaku: 0 };
  const zkontrolovane = new Set();
  let bylCheck = false;
  let runy = 0;
  let runPoChecku = 0;
  let runBezKontroly = 0;
  let kontrolNeproslo = 0;
  for (const c of nase) {
    volani[c.tool] = (volani[c.tool] ?? 0) + 1;
    if (c.tool === 'pohoda_rules') {
      const kapitola = String(c.input?.chapter ?? '').trim().toLowerCase().replace(/\.md$/, '');
      const sekce = maText(c.input?.section) ? c.input.section.trim().replace(/\.$/, '') : '';
      let k;
      if (maText(c.input?.search)) { k = 'hledání'; pravidla.hledani++; }
      else if (sekce) { k = `${kapitola || 'jádro'} §${sekce}`; pravidla.sekce++; }
      else if (kapitola) { k = kapitola; pravidla.kapitoly++; }
      else { k = 'jádro'; pravidla.jadro++; }
      if (!kapitoly.includes(k)) kapitoly.push(k);
      if (!c.isError && typeof c.result === 'string') pravidla.znaku += c.result.length;
    } else if (c.tool === 'pohoda_check_query') {
      bylCheck = true;
      if (kontrolaOk(c)) zkontrolovane.add(normSql(c.input?.sql));
      else if (!c.isError) kontrolNeproslo++;
    } else if (c.tool === 'pohoda_run_query') {
      runy++;
      if (bylCheck) runPoChecku++;
      if (!zkontrolovane.has(normSql(c.input?.sql))) runBezKontroly++;
    }
  }
  const prvni = nase[0];
  return {
    rulesPrvni: !!prvni && prvni.tool === 'pohoda_rules' && !maText(prvni.input?.section) && !maText(prvni.input?.search),
    checkPredRun: runy === 0 ? 'n/a' : runPoChecku === runy ? 'ano' : 'ne',
    runBezKontroly,
    volani,
    volaniCelkem: nase.length,
    chybyNastroju: nase.filter((c) => c.isError).length,
    kontrolNeproslo,
    kapitoly,
    pravidla,
    jineNastroje: calls.length - nase.length,
  };
}

/**
 * Výsledný skript.
 * Čtecí test: (1) poslední blok ```sql odpovědi, pokud se (po normalizaci `normSql`) shoduje se skriptem některého volání
 * pohoda_check_query / pohoda_run_query – to je skript, který agent uživateli předkládá; (2) jinak poslední skript, který prošel
 * kontrolou (exit 0) a byl úspěšně spuštěn; (3) jinak poslední `sql` z volání; (4) jinak poslední blok ```sql odpovědi.
 * Pomocný dotaz puštěný až po hlavním (ověření, průzkum dat) tak výsledný skript „nepřebije“.
 * Zápisový test: poslední ZAPISUJÍCÍ skript z pohoda_check_query, jinak z odpovědi; když žádný nezapisuje, platí pravidlo čtecího testu.
 * @returns {{sql: string, zdroj: 'pohoda_check_query'|'pohoda_run_query'|'odpoved'|''}} `zdroj` = odkud je text skriptu
 */
export function pickFinalSql(calls, answer, { zapis = false } = {}) {
  const sqlVolani = calls.filter((c) => (c.tool === 'pohoda_check_query' || c.tool === 'pohoda_run_query') && typeof c.input?.sql === 'string' && c.input.sql.trim());
  const bloky = sqlBlocks(answer);
  if (zapis) {
    const kontroly = sqlVolani.filter((c) => c.tool === 'pohoda_check_query' && writeTargets(c.input.sql).length);
    if (kontroly.length) return { sql: kontroly[kontroly.length - 1].input.sql, zdroj: 'pohoda_check_query' };
    const zapisove = bloky.filter((b) => writeTargets(b).length);
    if (zapisove.length) return { sql: zapisove[zapisove.length - 1], zdroj: 'odpoved' };
  }
  if (bloky.length && sqlVolani.length) {
    const blok = bloky[bloky.length - 1];
    const n = normSql(blok);
    if (n && sqlVolani.some((c) => normSql(c.input.sql) === n)) return { sql: blok, zdroj: 'odpoved' };
  }
  const zkontrolovane = new Set(sqlVolani.filter((c) => c.tool === 'pohoda_check_query' && kontrolaOk(c)).map((c) => normSql(c.input.sql)));
  const spustene = sqlVolani.filter((c) => c.tool === 'pohoda_run_query' && !c.isError && c.result !== null && zkontrolovane.has(normSql(c.input.sql)));
  if (spustene.length) return { sql: spustene[spustene.length - 1].input.sql, zdroj: 'pohoda_run_query' };
  if (sqlVolani.length) { const c = sqlVolani[sqlVolani.length - 1]; return { sql: c.input.sql, zdroj: c.tool }; }
  if (bloky.length) return { sql: bloky[bloky.length - 1], zdroj: 'odpoved' };
  return { sql: '', zdroj: '' };
}

// ---------------------------------------------------------------------------
// Vyhodnocení jednoho testu
// ---------------------------------------------------------------------------

/** Tabulky z řádku Kontrola zápisového testu: `ZAPIS FApol FA`, `ZAPIS: FA, AD`. */
export function expectedWriteTables(kontrola) {
  return String(kontrola ?? '').replace(/^\s*ZAPIS\b\s*:?/, '').split(/[\s,;]+/).filter(Boolean);
}

/**
 * Vyhodnotí jeden test z uloženého výstupu agenta.
 * @param {object} test položka z parseGolden
 * @param {string} jsonl obsah stream.jsonl
 * @param {{timeout?: boolean, sec?: number|null, database?: string}} [beh] údaje o běhu procesu (timeout, doba, výchozí databáze)
 * @returns {object} záznam pro vyhodnoceni.json / souhrn.json (pole `sql` a `odpoved` se ukládají do zvláštních souborů)
 */
export function evaluateTest(test, jsonl, beh = {}) {
  const s = parseStream(jsonl);
  const metriky = evalMetrics(s.calls);
  const zapisovy = /^\s*ZAPIS\b/.test(test.kontrola);
  const final = pickFinalSql(s.calls, s.answer, { zapis: zapisovy });
  const db = test.db || beh.database || MODEL_DB;
  // hodnoty z jiné než modelové databáze nesmí do reportu ani do JSON – místo nich jen počty
  const citlive = db !== MODEL_DB;
  const pozn = [];
  const v = {
    id: test.id, nazev: test.nazev, db, stav: '', shoda: '', typ: '', sqlZdroj: final.zdroj, model: String(s.init?.model ?? ''),
    cenaUsd: typeof s.result?.total_cost_usd === 'number' ? s.result.total_cost_usd : null,
    tahu: typeof s.result?.num_turns === 'number' ? s.result.num_turns : null,
    sec: typeof s.result?.duration_ms === 'number' ? Math.round(s.result.duration_ms / 1000) : (beh.sec ?? null),
    metriky, prostredi: initCounts(jsonl), hodnoty: null, obsahujeChybi: [], obsahujeJenVKomentari: [], poznamka: '',
  };
  const hotovo = (stav) => { v.stav = stav; v.poznamka = pozn.join('; '); return { ...v, sql: final.sql, odpoved: s.answer }; };

  let chybaAgenta = '';
  const mcp = mcpStatus(s.init);
  if (beh.timeout) chybaAgenta = 'časový limit běhu agenta';
  else if (!s.result) chybaAgenta = 'agent nevrátil výsledek';
  // stav jiný než connected je chyba jen tehdy, když se nepovedlo žádné volání nástroje (pomalý start může být hlášen jako pending)
  else if (mcp !== null && mcp !== 'connected' && !s.calls.some((c) => c.tool && !c.isError && c.result !== null)) chybaAgenta = `MCP server ${MCP_SERVER_NAME} se nepřipojil (stav ${mcp})`;
  // i „úspěšný“ konec s jiným podtypem (error_max_turns, error_during_execution, …) znamená nedokončenou práci
  else if (s.result.is_error || (s.result.subtype ?? 'success') !== 'success') chybaAgenta = `agent skončil chybou (${s.result.subtype ?? 'bez podtypu'})`;
  if (chybaAgenta) pozn.push(chybaAgenta);

  const zapisDo = writeTargets(final.sql);
  v.typ = !final.sql ? '' : zapisDo.length ? `zápis do ${zapisDo.join(', ')}` : 'čtení';

  // vzory Obsahuje se hledají ve skriptu BEZ komentářů a s vyprázdněnými řetězci – název tabulky v komentáři není její použití
  const kod = stripSql(final.sql);
  const chybiVzory = [];
  const jenVKomentari = [];
  for (const vzor of test.obsahuje ?? []) {
    let re;
    try { re = new RegExp(vzor, 'is'); } catch { pozn.push(`neplatný vzor Obsahuje: ${vzor}`); continue; }
    if (re.test(kod)) continue;
    chybiVzory.push(vzor);
    if (re.test(final.sql)) jenVKomentari.push(vzor);
  }
  v.obsahujeChybi = chybiVzory;
  v.obsahujeJenVKomentari = jenVKomentari; // podmnožina obsahujeChybi: vzor ve skriptu je, ale jen v komentáři nebo řetězci
  const snizit = (stav) => {
    if (!chybiVzory.length) return stav;
    pozn.push(`chybí ve skriptu: ${chybiVzory.join(' ; ')}`);
    if (jenVKomentari.length) pozn.push(`jen v komentáři nebo řetězci: ${jenVKomentari.join(' ; ')}`);
    return stav === STAV.OK ? STAV.CAST : stav;
  };

  if (zapisovy) {
    const ocek = expectedWriteTables(test.kontrola);
    const stejna = (a, b) => a.toLowerCase() === b.toLowerCase();
    const chybi = ocek.filter((t) => !zapisDo.some((x) => stejna(x, t)));
    const navic = zapisDo.filter((x) => !ocek.some((t) => stejna(x, t)));
    const kontroly = s.calls.filter((c) => c.tool === 'pohoda_check_query' && normSql(c.input?.sql) === normSql(final.sql));
    const posledni = kontroly[kontroly.length - 1];
    const exit = posledni && !posledni.isError ? kodKontroly(posledni) : null;
    const runZapis = s.calls.filter((c) => c.tool === 'pohoda_run_query' && writeTargets(c.input?.sql).length).length;
    v.shoda = `${ocek.length - chybi.length}/${ocek.length} tabulek`;
    v.zapis = { ocekavane: ocek, zapisDo, navic, zkontrolovano: Boolean(posledni), kontrolaExit: exit, runZapis };
    if (chybaAgenta) return hotovo(STAV.AGENT);
    if (!zapisDo.length) { pozn.push(final.sql ? 'skript nic nezapisuje' : 'žádný skript'); return hotovo(STAV.NE); }
    if (chybi.length) pozn.push(`chybí zápis do: ${chybi.join(', ')}`);
    if (navic.length) pozn.push(`zápis i do nečekaných tabulek: ${navic.join(', ')}`);
    if (!posledni) pozn.push('výsledný skript neprošel pohoda_check_query');
    else if (exit !== 0) pozn.push(`pohoda_check_query výsledného skriptu: ${exit === null ? 'chyba nástroje' : `exit ${exit}`}`);
    if (runZapis) pozn.push(`pohoda_run_query použito na zápis (${runZapis}×)`);
    return hotovo(snizit(!chybi.length && !navic.length && exit === 0 && !runZapis ? STAV.OK : STAV.CAST));
  }

  if (test.kontrola) {
    const runTexts = s.calls.filter((c) => c.tool === 'pohoda_run_query' && !c.isError && c.result).map((c) => c.result);
    const h = compareValues(test.kontrola, collectValues({ runTexts, answer: s.answer }));
    // rozpor: hodnota je jen v dřívějším běhu – agent dotaz potom změnil a poslední běh ani odpověď ji už nemají
    const jenDrive = [];
    if (h.chybi.length && runTexts.length > 1) {
      for (let i = 0; i < runTexts.length - 1; i++) {
        const drive = compareValues(test.kontrola, collectValues({ runTexts: [runTexts[i]], answer: '' }));
        for (const g of drive.skupiny) if (g.nalezeno && h.chybi.includes(g.skupina) && !jenDrive.includes(g.skupina)) jenDrive.push(g.skupina);
      }
    }
    v.shoda = `${h.ok}/${h.celkem}`;
    v.hodnoty = {
      ok: h.ok, celkem: h.celkem, jenVOdpovedi: h.jenVOdpovedi, uspesnychBehu: runTexts.length, jenVDrivejsimBehu: jenDrive.length,
      skupiny: h.skupiny.map((g, i) => ({ skupina: citlive ? `#${i + 1}` : g.skupina, nalezeno: g.nalezeno, zdroj: g.zdroj })),
    };
    if (chybaAgenta) return hotovo(STAV.AGENT);
    if (zapisDo.length) { pozn.push('čtecí otázka, ale skript zapisuje'); return hotovo(STAV.NE); }
    if (h.chybi.length) pozn.push(citlive ? `chybí ${h.chybi.length} skupin hodnot` : `chybí: ${h.chybi.join('; ')}`);
    if (jenDrive.length) pozn.push(`rozpor: ${citlive ? `${jenDrive.length} skupin hodnot` : jenDrive.join('; ')} jen v dřívějším běhu pohoda_run_query (poslední běh ani odpověď je nemají)`);
    if (h.jenVOdpovedi) pozn.push(`${h.jenVOdpovedi}× shoda jen v textu odpovědi`);
    let stav = h.ok === h.celkem ? STAV.OK : h.ok > 0 ? STAV.CAST : STAV.NE;
    // hodnoty bez jediného úspěšného běhu dotazu nejsou doložené výsledkem z databáze
    if (stav === STAV.OK && !runTexts.length) { stav = STAV.CAST; pozn.push('žádný úspěšný běh pohoda_run_query – hodnoty jsou jen v textu odpovědi'); }
    return hotovo(snizit(stav));
  }
  if (chybaAgenta) return hotovo(STAV.AGENT);
  return hotovo(snizit(STAV.BEZ));
}

// ---------------------------------------------------------------------------
// Spuštění agenta (jen sestavení vstupů – proces spouští runner)
// ---------------------------------------------------------------------------

const lomitka = (p) => String(p).replace(/\\/g, '/');

/**
 * Obsah dočasného --mcp-config: server `pohoda-sql` = `node <kořen>/src/server.js` s vlastním prostředím (cesty s lomítky `/`).
 * `configFile` = cesta pro POHODA_MCP_CONFIG; runner sem dává NEEXISTUJÍCÍ soubor v dočasné složce, aby server nečetl
 * `config.json` projektu (místní nastavení vývojáře by jinak měnilo režim pravidel nebo povolené databáze).
 */
export function buildMcpConfig({ projectRoot, database, credentialFile, rulesMode, configFile }) {
  const env = { POHODA_RUN_QUERY: '1', POHODA_ALLOWED_DATABASES: database };
  if (configFile) env.POHODA_MCP_CONFIG = lomitka(configFile);
  if (credentialFile) env.POHODA_CREDENTIAL_FILE = lomitka(credentialFile);
  if (rulesMode) env.POHODA_RULES_MODE = rulesMode;
  return { mcpServers: { [MCP_SERVER_NAME]: { command: 'node', args: [`${lomitka(projectRoot).replace(/\/+$/, '')}/src/server.js`], env } } };
}

/** Prostředí pro proces agenta: okolní proměnné bez všech POHODA_* (server dostane jen to, co je v --mcp-config). */
export function childEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^POHODA_/i.test(k)));
}

/** Zadání pro agenta (jde na stdin). U jiné než modelové databáze jen agregáty. */
export function buildPrompt(test, database = MODEL_DB) {
  const db = test.db || database;
  const firma = db === MODEL_DB
    ? `modelová účetní jednotka (databáze ${db})`
    : /^StwPhSK_/.test(db)
      ? `slovenská účetní jednotka (SK Pohoda, EUR, databáze ${db}, schéma sk); reálná firma – ve výstupu jen agregáty, žádné názvy partnerů`
      : `účetní jednotka v databázi ${db}; reálná firma – ve výstupu jen agregáty, žádné názvy partnerů`;
  return [
    'Automatický testovací běh – nikdo neodpovídá na doplňující otázky; při nejasnosti zvol nejrozumnější výklad a napiš ho.',
    `Firma: ${firma}.`,
    `Zadání: ${test.otazka}`,
    'Pokud jde o čtecí zadání, dotaz rovnou pusť nad databází a výsledek uveď v odpovědi; u zápisových zadání skript jen napiš a zkontroluj.',
  ].join('\n');
}

/**
 * Volby klienta pro „čisté“ prostředí agenta (ověřeno s Claude Code 2.1.322):
 *   `--tools ""`                         žádné vestavěné nástroje (Bash, Read, …) – zůstanou jen nástroje MCP serveru;
 *   `--disable-slash-commands`           žádné skills ani příkazy z profilu uživatele a z pluginů;
 *   `--setting-sources project,local`    nenačte se uživatelské nastavení (~/.claude/settings.json: pluginy, hooky, výchozí model);
 *                                        pracovní složka agenta je prázdná, takže se nenačte nic. Přihlášení (OAuth) zůstává.
 * `--bare` se nepoužívá: nečte přihlášení přes OAuth.
 */
export const CLEAN_ARGS = ['--tools', '', '--disable-slash-commands', '--setting-sources', 'project,local'];

/** Parametry `claude -p` pro jeden test; `clean: false` vynechá volby čistého prostředí (CLEAN_ARGS). */
export function buildClaudeArgs({ mcpConfigFile, maxBudgetUsd, model, effort, clean = true }) {
  const args = [
    '-p', '--mcp-config', lomitka(mcpConfigFile), '--strict-mcp-config', '--permission-mode', 'dontAsk',
    '--allowedTools', `mcp__${MCP_SERVER_NAME}`, '--no-session-persistence', '--max-budget-usd', String(maxBudgetUsd),
    '--output-format', 'stream-json', '--verbose',
  ];
  if (clean) args.push(...CLEAN_ARGS);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const anoNe = (b) => (b ? 'ano' : 'ne');
const ZKRATKY = { pohoda_rules: 'rules', pohoda_schema: 'schema', pohoda_help: 'help', pohoda_check_query: 'check', pohoda_run_query: 'run', pohoda_status: 'status' };

/** „rules 2, schema 3, check 1, run 1“ – jen nástroje, které se volaly. */
export function formatCalls(volani) {
  const casti = Object.entries(volani ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${ZKRATKY[k] ?? k} ${n}`);
  return casti.length ? casti.join(', ') : '–';
}

/** Souhrnná čísla běhu (počty stavů, shoda hodnot, dodržení postupu, cena, čas). */
export function summarize(vysledky) {
  const stavy = {};
  let shodaOk = 0;
  let shodaVse = 0;
  let cena = 0;
  let sec = 0;
  let checkAno = 0;
  let checkVse = 0;
  let pravidlaZnaku = 0;
  let pravidlaSekci = 0;
  for (const x of vysledky) {
    pravidlaZnaku += x.metriky.pravidla?.znaku ?? 0;
    pravidlaSekci += x.metriky.pravidla?.sekce ?? 0;
    stavy[x.stav] = (stavy[x.stav] ?? 0) + 1;
    if (x.hodnoty) { shodaOk += x.hodnoty.ok; shodaVse += x.hodnoty.celkem; }
    cena += x.cenaUsd ?? 0;
    sec += x.sec ?? 0;
    if (x.metriky.checkPredRun !== 'n/a') { checkVse++; if (x.metriky.checkPredRun === 'ano') checkAno++; }
  }
  return {
    testu: vysledky.length, stavy, shodaOk, shodaVse,
    rulesPrvni: vysledky.filter((x) => x.metriky.rulesPrvni).length,
    checkPredRunAno: checkAno, checkPredRunZ: checkVse,
    chybyNastroju: vysledky.reduce((a, x) => a + x.metriky.chybyNastroju, 0),
    pravidlaZnaku, pravidlaSekci,
    cenaUsd: Math.round(cena * 10000) / 10000, sec,
  };
}

/** Jednořádkový souhrn pro konzoli i report. */
export function formatSummary(sm) {
  const stavy = Object.entries(sm.stavy).sort(([a], [b]) => a.localeCompare(b, 'cs')).map(([k, n]) => `${k} ${n}`).join(', ');
  return `${stavy || 'žádný test'}; shoda hodnot ${sm.shodaOk}/${sm.shodaVse}; pohoda_rules první ${sm.rulesPrvni}/${sm.testu}; `
    + `check před run ${sm.checkPredRunAno}/${sm.checkPredRunZ}; chyb nástrojů ${sm.chybyNastroju}; načtená pravidla ${sm.pravidlaZnaku ?? 0} znaků (sekcí ${sm.pravidlaSekci ?? 0}); cena ${sm.cenaUsd.toFixed(2)} USD; čas agenta ${Math.round(sm.sec / 60)} min (součet)`;
}

/**
 * report.md: hlavička běhu, tabulka testů a kritéria „Musí“ k ručnímu posouzení. U testů nad jinou než modelovou
 * databází se otázka a známé hodnoty nevypisují.
 */
export function buildReport(meta, vysledky, testy = []) {
  const sm = summarize(vysledky);
  const r = [];
  r.push(`# Zlaté testy přes MCP – běh ${meta.stamp}`, '');
  if (meta.label) r.push(`- **Popis:** ${meta.label}`);
  const modely = [...new Set(vysledky.map((x) => x.model).filter(Boolean))].join(', ');
  r.push(`- **Model / effort:** ${meta.model || (modely ? `výchozí (${modely})` : 'výchozí')} / ${meta.effort || 'výchozí'}`);
  r.push(`- **Server:** pohoda-mcp ${meta.verze || '?'}${meta.commit ? ` (commit ${meta.commit})` : ''}; režim pravidel ${meta.rulesMode || 'výchozí'}; databáze ${meta.database}`);
  const prostredi = meta.prostredi ?? vysledky.find((x) => x.prostredi)?.prostredi ?? null;
  r.push(`- **Prostředí agenta:** ${formatInitCounts(prostredi)}${meta.claudeArgs ? `; volby klienta: ${meta.claudeArgs}` : ''}`);
  if (meta.preruseno) r.push('- **POZOR:** běh byl přerušen (Ctrl+C) – report obsahuje jen testy, které stihly začít; nedokončené jsou CHYBA AGENTA.');
  r.push(`- **Souhrn:** ${formatSummary(sm)}`);
  r.push('', '| Id | Název | Stav | Shoda | Rules první | Check před run | Volání | Chyby nástrojů | Načtená pravidla | Znaků pravidel | USD | Tahy | s | Poznámka |');
  r.push('|---|---|---|--:|---|---|---|--:|---|--:|--:|--:|--:|---|');
  for (const x of vysledky) {
    const m = x.metriky;
    r.push(`| [${x.id}](${x.id}/) | ${esc(x.nazev)} | ${x.stav} | ${x.shoda} | ${anoNe(m.rulesPrvni)} | ${m.checkPredRun} | ${formatCalls(m.volani)} | ${m.chybyNastroju} | ${esc(m.kapitoly.join(', '))} | ${m.pravidla?.znaku ?? ''} | `
      + `${x.cenaUsd === null ? '' : x.cenaUsd.toFixed(2)} | ${x.tahu ?? ''} | ${x.sec ?? ''} | ${esc(x.poznamka)} |`);
  }
  r.push('', `**Celková cena:** ${sm.cenaUsd.toFixed(2)} USD`, '');
  r.push('Sloupce: **Shoda** = nalezené skupiny hodnot z řádku Kontrola (u zápisových testů cílové tabulky); **Rules první** = první volání nástroje bylo `pohoda_rules` bez `section` a `search`; '
    + '**Check před run** = před každým `pohoda_run_query` proběhlo `pohoda_check_query` (n/a = dotaz se nespouštěl); **Volání** = počty volání nástrojů serveru; '
    + '**Načtená pravidla** = `jádro`, `jádro §5` (sekce jádra), `sklad` (kapitola), `sklad §7.5` (sekce kapitoly), `hledání`; **Znaků pravidel** = součet délek textů vrácených nástrojem `pohoda_rules`.');
  if (testy.length) {
    r.push('', '## K ručnímu posouzení (kritéria „Musí“)');
    for (const t of testy) {
      const x = vysledky.find((y) => y.id === t.id);
      if (!x) continue;
      r.push('', `### ${t.id} – ${t.nazev} · ${x.stav}`);
      if (x.db !== MODEL_DB) r.push(`**DB:** ${x.db} (není modelová – otázka a známé hodnoty se do reportu nevypisují)  `);
      else {
        r.push(`**Otázka:** ${t.otazka}  `);
        if (t.znama) r.push(`**Známá hodnota:** ${t.znama}  `);
      }
      if (t.musi) r.push(`**Musí:** ${t.musi}  `);
      r.push(`[SQL](${t.id}/sql.sql) · [odpověď](${t.id}/odpoved.md) · [vyhodnocení](${t.id}/vyhodnoceni.json) · [průběh](${t.id}/stream.jsonl)`);
    }
  }
  return `${r.join('\n')}\n`;
}
