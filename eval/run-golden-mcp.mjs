#!/usr/bin/env node
// Zlaté testy přes MCP: měří, jestli asistent (claude -p) jen s nástroji serveru pohoda-sql napíše SPRÁVNÉ SQL a dodrží postup
// (pohoda_rules první, pohoda_check_query před pohoda_run_query). Otázky a očekávané hodnoty jsou v souboru golden.md mimo repozitář.
//
//   node eval/run-golden-mcp.mjs --golden <golden.md> --credential <soubor Export-Clixml> [--id T1,T2] [--label "popis"]
//   node eval/run-golden-mcp.mjs --golden <golden.md> --znovu eval/results/<běh>     (jen znovu vyhodnotí uložené výstupy)
//
// Výstup: eval/results/<čas>/ – meta.json (hned na začátku), report.md, souhrn.json a složka na test (stream.jsonl, odpoved.md,
// sql.sql, vyhodnoceni.json). Běh stojí peníze (claude -p, řádově desetiny USD za test). Čisté funkce a pravidla vyhodnocení:
// eval/golden-lib.mjs.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLEAN_ARGS, MCP_SERVER_NAME, MODEL_DB, buildClaudeArgs, buildMcpConfig, buildPrompt, buildReport, childEnv, evaluateTest, formatCalls,
  formatInitCounts, formatSummary, parseGolden, parseIds, selectTests, summarize,
} from './golden-lib.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const TMP_PREFIX = 'pohoda-golden-'; // dočasná složka runneru; podle názvu se po běhu uklízí i prázdné složky klienta

const POUZITI = `Použití:
  node eval/run-golden-mcp.mjs --golden <cesta ke golden.md> [volby]

Volby:
  --golden <soubor>        soubor s testy (povinné; leží mimo repozitář)
  --id T1,T2               jen vybrané testy (výchozí: všechny testy bez řádku **DB:**, tj. nad modelovou databází)
  --credential <soubor>    soubor Export-Clixml s přihlášením k SQL (nebo proměnná POHODA_CREDENTIAL_FILE); předává se jen cesta
  --database <název>       databáze (výchozí ${MODEL_DB})
  --rules-mode full|compact  předá se serveru jako POHODA_RULES_MODE
  --model <model>          model pro claude -p (výchozí podle klienta; uživatelské nastavení se v čistém prostředí nenačítá)
  --effort <úroveň>        low | medium | high | xhigh | max
  --parallel <n>           počet souběžných testů 1–6 (výchozí 3)
  --max-budget-usd <n>     strop ceny na jeden test (výchozí 3)
  --timeout-min <n>        časový limit jednoho testu v minutách (výchozí 15)
  --label <text>           popis běhu do reportu
  --clean on|off           čisté prostředí agenta: bez vestavěných nástrojů, skills, pluginů a hooků z profilu (výchozí on)
  --out <složka>           kam uložit výsledky (výchozí eval/results; běh si v ní založí podsložku s časem)
  --znovu <složka>         znovu vyhodnotit uložené výstupy běhu (agent se nespouští; databáze se bere z meta běhu)
  --help                   tato nápověda`;

function parseArgs(argv) {
  const volby = { golden: '', id: '', credential: '', database: '', 'rules-mode': '', model: '', effort: '', parallel: '3', 'max-budget-usd': '3', 'timeout-min': '15', label: '', clean: 'on', out: '', znovu: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(POUZITI); process.exit(0); }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m || !(m[1] in volby)) throw new Error(`Neznámý parametr „${a}“.`);
    const hodnota = m[2] ?? argv[++i];
    if (hodnota === undefined) throw new Error(`Parametr --${m[1]} potřebuje hodnotu.`);
    volby[m[1]] = hodnota;
  }
  return volby;
}

function cislo(volby, nazev, min, max, cele) {
  const n = Number(volby[nazev]);
  if (!Number.isFinite(n) || n < min || n > max || (cele && !Number.isInteger(n))) throw new Error(`--${nazev} musí být ${cele ? 'celé ' : ''}číslo ${min}–${max}.`);
  return n;
}

/** Najde spustitelný soubor claude (PATH, pak ~/.local/bin). */
function najdiClaude() {
  const jmena = WIN ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const slozky = [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), path.join(os.homedir(), '.local', 'bin')];
  for (const s of slozky) for (const j of jmena) { const p = path.join(s, j); if (fs.existsSync(p)) return p; }
  throw new Error('Nenalezen příkaz claude (Claude Code CLI) – přidej ho do PATH.');
}

/** .cmd jde ve Windows spustit jen přes shell; parametry se pak uzavírají do uvozovek (prázdný parametr = ""). */
function spawnClaude(claude, args, options) {
  if (WIN && /\.cmd$/i.test(claude)) {
    const q = (x) => `"${String(x).replace(/"/g, '')}"`;
    return spawn([q(claude), ...args.map(q)].join(' '), { ...options, shell: true });
  }
  return spawn(claude, args, options);
}

/** Ukončí proces i s potomky (ve Windows taskkill /T /F – klient spouští MCP server a ten PowerShell). */
export function killTree(child) {
  if (!child || child.pid === undefined) return;
  if (!WIN) { try { child.kill('SIGKILL'); } catch { /* už neběží */ } return; }
  const r = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  if (r.error || r.status !== 0) { try { child.kill(); } catch { /* už neběží */ } }
}

const cas = () => new Date().toTimeString().slice(0, 8);
const dvoj = (n) => String(n).padStart(2, '0');
function razitko(d = new Date()) {
  return `${d.getFullYear()}${dvoj(d.getMonth() + 1)}${dvoj(d.getDate())}-${dvoj(d.getHours())}${dvoj(d.getMinutes())}${dvoj(d.getSeconds())}`;
}
const zapis = (soubor, text) => fs.writeFileSync(soubor, text, 'utf8');
const ctiJson = (soubor) => { try { return JSON.parse(fs.readFileSync(soubor, 'utf8').replace(/^\ufeff/, '')); } catch { return null; } };

/** Právě běžící procesy agenta (kvůli ukončení při Ctrl+C a v `finally` hlavního cyklu). */
export const bezici = new Set();

/** Ukončí všechny běžící procesy agenta. */
export function killAll() {
  for (const ch of [...bezici]) { killTree(ch); bezici.delete(ch); }
}

/** Spustí agenta pro jeden test; výstup stream-json se zapisuje průběžně (po pádu nebo timeoutu jde vyhodnotit přes --znovu). */
export function runAgent({ claude, args, prompt, dir, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = fs.createWriteStream(path.join(dir, 'stream.jsonl'));
    const err = fs.createWriteStream(path.join(dir, 'agent-stderr.txt'));
    let timeout = false;
    let hotovo = false;
    let child;
    const konec = (exit, chyba) => {
      if (hotovo) return;
      hotovo = true;
      clearTimeout(timer);
      if (child) bezici.delete(child);
      const beh = { exit, sec: Math.round((Date.now() - t0) / 1000), timeout, ...(chyba ? { chyba } : {}) };
      let ceka = 2;
      const dopsano = () => { if (--ceka === 0) { zapis(path.join(dir, 'beh.json'), JSON.stringify(beh)); resolve(beh); } };
      out.end(dopsano);
      err.end(dopsano);
    };
    const timer = setTimeout(() => { timeout = true; if (child) killTree(child); }, timeoutMs);
    try {
      child = spawnClaude(claude, args, { cwd, env: childEnv(process.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { konec(null, e.message); return; }
    bezici.add(child);
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(err, { end: false });
    child.on('error', (e) => konec(null, e.message));
    child.on('close', (code) => konec(code));
    child.stdin.on('error', () => { /* proces skončil dřív, než přečetl zadání */ });
    child.stdin.end(prompt, 'utf8');
  });
}

/** Je ve stromu složky aspoň jeden soubor (cokoli, co není složka – i odkaz)? */
function maSoubor(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || maSoubor(path.join(dir, e.name))) return true;
  }
  return false;
}
/** Smaže strom složek bez souborů odspodu (jen rmdir – na neprázdné složce selže, nic dalšího nemaže). */
function smazPrazdnyStrom(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) smazPrazdnyStrom(path.join(dir, e.name));
  fs.rmdirSync(dir);
}

/**
 * Klient si pro pracovní složku agenta zakládá složku v `~/.claude/projects/` (název = cesta s pomlčkami); s --no-session-persistence
 * v ní zůstanou jen prázdné podsložky. Po běhu se mažou JEN složky, jejichž název obsahuje `token` (název dočasné složky tohoto
 * běhu, vždy s „pohoda-golden“) a které v celém stromu nemají žádný soubor. Nic jiného v ~/.claude se nemaže.
 * @returns {string[]} názvy smazaných složek
 */
export function removeEmptyClientProjects(token, root = path.join(os.homedir(), '.claude', 'projects')) {
  const smazane = [];
  if (typeof token !== 'string' || !token.includes('pohoda-golden') || !fs.existsSync(root)) return smazane;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.includes(token)) continue;
    const dir = path.join(root, e.name);
    try {
      if (maSoubor(dir)) continue;
      smazPrazdnyStrom(dir);
      smazane.push(e.name);
    } catch { /* složku právě používá jiný proces – nechá se být */ }
  }
  return smazane;
}

/**
 * Meta uloženého běhu: `meta.json` (zapisuje se hned na začátku běhu), jinak `meta` ze `souhrn.json` (starší běhy).
 * Null, když běh žádné meta nemá.
 */
export function loadRunMeta(outDir) {
  const m = ctiJson(path.join(outDir, 'meta.json')) ?? ctiJson(path.join(outDir, 'souhrn.json'))?.meta ?? null;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
}

/**
 * Vyhodnotí testy z uložených výstupů a zapíše vyhodnoceni.json, odpoved.md, sql.sql, report.md, souhrn.json a meta.json.
 * `jenSVystupem` = přeskočit testy bez stream.jsonl (přerušený běh). Do `meta.prostredi` doplní počty z úvodní zprávy klienta.
 */
export function evaluateRun({ outDir, meta, testy, jenSVystupem = false }) {
  const vysledky = [];
  const vyhodnocene = [];
  for (const t of testy) {
    const dir = path.join(outDir, t.id);
    const proud = path.join(dir, 'stream.jsonl');
    if (jenSVystupem && !fs.existsSync(proud)) continue;
    fs.mkdirSync(dir, { recursive: true });
    const jsonl = fs.existsSync(proud) ? fs.readFileSync(proud, 'utf8') : '';
    const beh = ctiJson(path.join(dir, 'beh.json')) ?? {};
    const { sql, odpoved, ...v } = evaluateTest(t, jsonl, { timeout: beh.timeout === true, sec: beh.sec ?? null, database: meta.database });
    if (beh.chyba) v.poznamka = [v.poznamka, `spuštění agenta: ${beh.chyba}`].filter(Boolean).join('; ');
    zapis(path.join(dir, 'odpoved.md'), odpoved);
    zapis(path.join(dir, 'sql.sql'), sql);
    zapis(path.join(dir, 'vyhodnoceni.json'), JSON.stringify(v, null, 2));
    vysledky.push(v);
    vyhodnocene.push(t);
  }
  meta.prostredi = vysledky.find((x) => x.prostredi)?.prostredi ?? meta.prostredi ?? null;
  const sm = summarize(vysledky);
  zapis(path.join(outDir, 'report.md'), buildReport(meta, vysledky, vyhodnocene));
  zapis(path.join(outDir, 'souhrn.json'), JSON.stringify({ meta, souhrn: sm, testy: vysledky }, null, 2));
  if (!meta.znovuVyhodnoceno || !fs.existsSync(path.join(outDir, 'meta.json'))) zapis(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  return { vysledky, sm };
}

/**
 * Přerušení běhu (Ctrl+C): ukončí běžící agenty, zapíše report z toho, co je hotové (testy, které aspoň začaly; nedokončené
 * vyjdou jako CHYBA AGENTA), a uklidí dočasné soubory. Proces neukončuje – to dělá volající.
 */
export function interruptRun({ outDir, meta, testy, uklid }) {
  killAll();
  try {
    meta.preruseno = true;
    evaluateRun({ outDir, meta, testy, jenSVystupem: true });
  } catch (e) { console.error(`CHYBA při zápisu rozpracovaného běhu: ${e instanceof Error ? e.message : e}`); }
  try { uklid?.(); } catch { /* úklid je jen pokus */ }
}

/**
 * Zeptá se serveru (stejné prostředí jako dostane od klienta) na `pohoda_status` – bez připojení k databázi. Vrací skutečný
 * režim pravidel a ověří, že server vůbec naběhne a má zapnuté spouštění dotazů (jinak by běh stál peníze a nic nezměřil).
 */
async function serverStatus(mcpConfig) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const def = mcpConfig.mcpServers[MCP_SERVER_NAME];
  const env = { ...childEnv(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined))), ...def.env };
  const transport = new StdioClientTransport({ command: process.execPath, args: def.args, env, stderr: 'pipe' });
  transport.stderr?.on('data', () => { /* log serveru se zahazuje */ });
  const client = new Client({ name: 'golden-runner', version: '0' });
  try {
    await client.connect(transport);
    const r = await client.callTool({ name: 'pohoda_status', arguments: {} });
    const text = (r.content ?? []).map((c) => c.text).join('\n');
    if (r.isError) throw new Error(text);
    return JSON.parse(text);
  } finally { try { await client.close(); } catch { /* server už neběží */ } }
}

async function main() {
  const volby = parseArgs(process.argv.slice(2));
  if (!volby.golden) throw new Error(`Chybí --golden <cesta ke golden.md>.\n\n${POUZITI}`);
  if (!fs.existsSync(volby.golden)) throw new Error(`Soubor s testy nenalezen: ${volby.golden}`);
  const paralelne = cislo(volby, 'parallel', 1, 6, true);
  const rozpocet = cislo(volby, 'max-budget-usd', 0.01, 1000, false);
  const timeoutMin = cislo(volby, 'timeout-min', 1, 240, false);
  if (volby['rules-mode'] && !/^(full|compact)$/.test(volby['rules-mode'])) throw new Error('--rules-mode musí být full nebo compact.');
  if (volby.effort && !/^(low|medium|high|xhigh|max)$/.test(volby.effort)) throw new Error('--effort musí být low, medium, high, xhigh nebo max.');
  if (volby.model && !/^[\w.:\-[\]]{1,100}$/.test(volby.model)) throw new Error('--model obsahuje nepovolené znaky.');
  if (volby.database && !/^[\w$-]{1,128}$/.test(volby.database)) throw new Error('--database obsahuje nepovolené znaky.');
  if (!/^(on|off)$/.test(volby.clean)) throw new Error('--clean musí být on nebo off.');

  const testy = parseGolden(fs.readFileSync(volby.golden, 'utf8'));
  if (!testy.length) throw new Error(`V souboru ${volby.golden} není žádný test (sekce „## Tn – název“).`);
  const ids = parseIds(volby.id);

  let outDir;
  let meta;
  let vybrane;
  if (volby.znovu) {
    outDir = path.resolve(volby.znovu);
    if (!fs.existsSync(outDir)) throw new Error(`Složka běhu nenalezena: ${outDir}`);
    const stare = loadRunMeta(outDir) ?? {};
    const ulozenaDb = typeof stare.database === 'string' ? stare.database : '';
    // databáze rozhoduje, jestli se smí vypsat očekávané hodnoty – nikdy se tiše nepředpokládá modelová
    if (!ulozenaDb && !volby.database) throw new Error(`Běh ${path.basename(outDir)} nemá uložená meta (meta.json ani souhrn.json s databází) – zadej --database <název databáze, nad kterou běžel>.`);
    if (ulozenaDb && volby.database && ulozenaDb !== volby.database) throw new Error('--database se liší od databáze uložené v meta běhu; při --znovu ji nezadávej.');
    // údaje o původním běhu se přebírají; mění se jen popis (je-li zadán) a čas nového vyhodnocení
    meta = {
      model: '', effort: '', rulesMode: '', verze: '', commit: '', ...stare,
      stamp: path.basename(outDir), label: volby.label || stare.label || '', database: ulozenaDb || volby.database,
      znovuVyhodnoceno: new Date().toISOString(),
    };
    const sVystupem = (t) => fs.existsSync(path.join(outDir, t.id, 'stream.jsonl'));
    const vyber = ids.length ? selectTests(testy, ids) : { vybrane: testy.filter(sVystupem), nezname: [] };
    if (vyber.nezname.length) throw new Error(`Neznámé testy: ${vyber.nezname.join(', ')}`);
    vybrane = vyber.vybrane;
    if (!vybrane.length) throw new Error(`Ve složce ${outDir} není žádný uložený výstup testu (<Tn>/stream.jsonl).`);
    console.log(`Znovu vyhodnocuji běh ${meta.stamp}: ${vybrane.length} testů`);
  } else {
    const vyber = selectTests(testy, ids);
    if (vyber.nezname.length) throw new Error(`Neznámé testy: ${vyber.nezname.join(', ')}`);
    vybrane = vyber.vybrane;
    if (!vybrane.length) throw new Error('Žádný test k běhu (zkontroluj --id).');
    const bezOtazky = vybrane.filter((t) => !t.otazka);
    if (bezOtazky.length) throw new Error(`Test ${bezOtazky.map((t) => t.id).join(', ')} nemá vyplněný řádek **Otázka:** – nespouštím (oprav soubor s testy nebo test vynech přes --id).`);
    const database = volby.database || MODEL_DB;
    const credential = path.resolve(volby.credential || process.env.POHODA_CREDENTIAL_FILE || '');
    // soubor s přihlášením se tu nečte – jen se ověří, že existuje, a cesta se předá serveru
    if (!(volby.credential || process.env.POHODA_CREDENTIAL_FILE)) throw new Error('Chybí --credential <soubor Export-Clixml> (nebo proměnná POHODA_CREDENTIAL_FILE).');
    if (!fs.existsSync(credential)) throw new Error(`Soubor s přihlášením nenalezen: ${credential}`);
    if (!fs.existsSync(path.join(projectRoot, 'src', 'server.js'))) throw new Error(`Nenalezen server: ${path.join(projectRoot, 'src', 'server.js')}`);

    const claude = najdiClaude();
    const verzeClaude = spawnSync(WIN && /\.cmd$/i.test(claude) ? `"${claude}" --version` : claude, WIN && /\.cmd$/i.test(claude) ? [] : ['--version'], { encoding: 'utf8', windowsHide: true, shell: WIN && /\.cmd$/i.test(claude) });
    if (verzeClaude.error || verzeClaude.status !== 0) throw new Error(`Příkaz claude nejde spustit (${claude}): ${verzeClaude.error?.message ?? verzeClaude.stderr}`);

    let commit = '';
    try { const g = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true }); if (g.status === 0) commit = g.stdout.trim(); } catch { /* bez gitu */ }

    // dočasná složka: MCP config pro každou databázi + prázdný pracovní adresář agenta (žádný CLAUDE.md projektu);
    // POHODA_MCP_CONFIG míří na soubor, který v ní NEEXISTUJE – server tak nečte config.json projektu
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
    const uklid = () => {
      try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* zůstane v dočasné složce */ }
      removeEmptyClientProjects(path.basename(tmp));
    };
    let ctx = null; // vyplní se po založení výstupní složky; do té doby není při přerušení co zapisovat
    const priSigint = () => {
      console.error('\nPřerušeno – ukončuji agenty a zapisuji, co je hotové.');
      if (ctx) interruptRun(ctx); else { killAll(); uklid(); }
      process.exit(130);
    };
    process.on('SIGINT', priSigint);
    try {
      const cwd = path.join(tmp, 'cwd');
      fs.mkdirSync(cwd);
      const prazdnyConfig = path.join(tmp, 'config-neexistuje.json');
      const configy = new Map();
      const mcpConfig = (db) => buildMcpConfig({ projectRoot, database: db, credentialFile: credential, rulesMode: volby['rules-mode'], configFile: prazdnyConfig });
      const configPro = (db) => {
        if (!configy.has(db)) {
          const soubor = path.join(tmp, `mcp-${configy.size + 1}.json`);
          zapis(soubor, JSON.stringify(mcpConfig(db), null, 2));
          JSON.parse(fs.readFileSync(soubor, 'utf8'));
          configy.set(db, soubor);
        }
        return configy.get(db);
      };

      // skutečný stav serveru ještě před prvním (placeným) testem
      let stav;
      try { stav = await serverStatus(mcpConfig(database)); } catch (e) { throw new Error(`MCP server se nepodařilo spustit nebo neodpověděl na pohoda_status: ${e instanceof Error ? e.message : e}`); }
      if (stav.configFound) throw new Error('Server načetl soubor s nastavením, i když neměl (POHODA_MCP_CONFIG míří na neexistující soubor).');
      if ((stav.configErrors ?? []).length) throw new Error(`Server hlásí chyby nastavení: ${stav.configErrors.join('; ')}`);
      if (stav.runQuery?.enabled !== true) throw new Error('Server má vypnuté pohoda_run_query – čtecí testy by nešly vyhodnotit.');
      if (volby['rules-mode'] && stav.rulesMode !== volby['rules-mode']) throw new Error(`Server běží v režimu pravidel ${stav.rulesMode}, zadán byl ${volby['rules-mode']}.`);

      const stamp = razitko();
      outDir = path.join(volby.out ? path.resolve(volby.out) : path.join(projectRoot, 'eval', 'results'), stamp);
      fs.mkdirSync(outDir, { recursive: true });
      const clean = volby.clean === 'on';
      meta = {
        stamp, label: volby.label, model: volby.model, effort: volby.effort, database,
        rulesMode: String(stav.rulesMode ?? ''), rulesModeZadany: volby['rules-mode'], rulesModeZdroj: 'pohoda_status',
        serverConfigWarnings: (stav.configWarnings ?? []).length,
        verze: String(stav.version ?? ctiJson(path.join(projectRoot, 'package.json'))?.version ?? ''), commit, claude: verzeClaude.stdout.trim(),
        claudeArgs: clean ? CLEAN_ARGS.map((a) => (a === '' ? '""' : a)).join(' ') : '',
        maxBudgetUsd: rozpocet, timeoutMin, paralelne, testy: vybrane.map((t) => t.id), zahajeno: new Date().toISOString(), prostredi: null,
      };
      // meta hned po založení složky: i přerušený nebo spadlý běh jde znovu vyhodnotit se správnou databází
      zapis(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
      ctx = { outDir, meta, testy: vybrane, uklid };

      console.log(`Běh ${stamp}: ${vybrane.length} testů (${vybrane.map((t) => t.id).join(', ')}), souběžně ${paralelne}, strop ${rozpocet} USD na test, režim pravidel ${meta.rulesMode}`);
      console.log(`Výstup: ${outDir}`);
      const fronta = [...vybrane];
      const pracovnik = async () => {
        for (let t = fronta.shift(); t; t = fronta.shift()) {
          const dir = path.join(outDir, t.id);
          fs.mkdirSync(dir, { recursive: true });
          const db = t.db || database;
          const args = buildClaudeArgs({ mcpConfigFile: configPro(db), maxBudgetUsd: rozpocet, model: volby.model, effort: volby.effort, clean });
          console.log(`  ${cas()} start  ${t.id}`);
          const beh = await runAgent({ claude, args, prompt: buildPrompt(t, database), dir, cwd, timeoutMs: timeoutMin * 60_000 });
          console.log(`  ${cas()} ${beh.timeout ? 'TIMEOUT' : 'hotovo '} ${t.id} (${beh.sec} s${beh.exit ? `, exit ${beh.exit}` : ''}${beh.chyba ? `, ${beh.chyba}` : ''})`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(paralelne, fronta.length) }, pracovnik));
      meta.dokonceno = new Date().toISOString();
    } finally {
      // při chybě v cyklu mohou agenti ještě běžet – nejdřív je ukončit, teprve pak mazat jejich pracovní složku
      killAll();
      uklid();
      process.off('SIGINT', priSigint);
    }
  }

  // vyhodnocení (stejné pro nový běh i --znovu)
  const { vysledky, sm } = evaluateRun({ outDir, meta, testy: vybrane });

  console.log('');
  console.table(vysledky.map((x) => ({
    Id: x.id, Stav: x.stav, Shoda: x.shoda, 'Rules první': x.metriky.rulesPrvni ? 'ano' : 'ne', 'Check před run': x.metriky.checkPredRun,
    Volání: formatCalls(x.metriky.volani), USD: x.cenaUsd === null ? '' : x.cenaUsd.toFixed(2), Tahy: x.tahu ?? '', s: x.sec ?? '', Poznámka: x.poznamka.slice(0, 80),
  })));
  console.log(`Souhrn: ${formatSummary(sm)}`);
  console.log(`Prostředí agenta: ${formatInitCounts(meta.prostredi)}`);
  console.log(`Report: ${path.join(outDir, 'report.md')}`);
}

// při importu (testy) se nic nespouští
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`CHYBA: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
