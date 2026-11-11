// node test/smoke.js  (npm run smoke) – spustí server přes stdio (SDK klient), projde všechny nástroje a akceptační kontroly.
// Běží jen proti modelové DB (StwPh_12345678_2026); reálné databáze se nedotkne.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot, MODEL_DB } from '../src/config.js';

// Samostatný režim: znalosti ze snímku knowledge\ (scripts\Sync-Knowledge.ps1). Kontroly run_query potřebují soubor s přihlášením
// (POHODA_CREDENTIAL_FILE nebo secrets\pohoda-sql.xml v projektu); bez něj se přeskočí.
const credFile = process.env.POHODA_CREDENTIAL_FILE || path.join(projectRoot, 'secrets', 'pohoda-sql.xml');
const runOk = fs.existsSync(credFile);
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'OK   ' : 'CHYBA'} ${name}${detail ? ` – ${detail}` : ''}`); if (!cond) failed++; };
const short = (t) => t.replace(/\s+/g, ' ').slice(0, 120); // detail na jeden řádek
const skip = (name, why) => console.log(`SKIP  ${name} – ${why}`);

// Povolená sada schémat ve snímku (záměr projektu): obecné CZ a slovenské. Co je navíc, je chyba sestavení snímku.
const ALLOWED_SCHEMAS = ['obecny', 'sk'];
// Název databáze reálné firmy (StwPh_<8 číslic> kromě modelové 12345678) – stejný vzor jako scripts\Test-Snapshot.ps1.
const RE_REAL_DB = /StwPh(SK)?_(?!12345678|<ICO>)\d{8}/i;
const TRAVERSAL = '..\\..\\x';

/**
 * Spustí server s izolovaným prostředím: z okolí se odeberou všechny proměnné POHODA_* a nastaví se jen `extra`
 * (a POHODA_CREDENTIAL_FILE, pokud ji okolí má). Ostatní proměnné zůstávají – PowerShell pomocníci potřebují SystemRoot, TEMP, PATH.
 */
async function start(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^POHODA_/i.test(k)) env[k] = v;
  if (process.env.POHODA_CREDENTIAL_FILE) env.POHODA_CREDENTIAL_FILE = process.env.POHODA_CREDENTIAL_FILE;
  Object.assign(env, extra);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, 'src', 'server.js')], env, stderr: 'pipe' });
  transport.stderr?.on('data', () => { /* log serveru se zahazuje, jen aby se roura nezaplnila */ });
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(transport);
  // chyba nástroje (isError) i chyba protokolu (neznámý nástroj, neplatné parametry) = err
  const call = async (name, args = {}) => {
    try {
      const r = await client.callTool({ name, arguments: args });
      return { err: !!r.isError, text: (r.content ?? []).map((c) => c.text).join('\n') };
    } catch (e) {
      return { err: true, text: String(e?.message ?? e) };
    }
  };
  return { client, call };
}

const ALL_TOOLS = ['pohoda_check_query', 'pohoda_help', 'pohoda_rules', 'pohoda_run_query', 'pohoda_schema', 'pohoda_status'];

// ===== 1. běh: spouštění dotazů zapnuté (POHODA_RUN_QUERY=1) =====
let { client, call } = await start({ POHODA_RUN_QUERY: '1' });

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check('seznam nástrojů (spouštění zapnuté: 6)', tools.join() === ALL_TOOLS.join(), tools.join(', '));
check('instrukce serveru', /pohoda_rules/.test(client.getInstructions() ?? '') && /pohoda_run_query/.test(client.getInstructions() ?? ''));
const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
check('prompt', prompts.includes('pohoda_sql'), prompts.join());

let r = await call('pohoda_status');
check('status', !r.err && /allowedDatabases/.test(r.text) && r.text.includes(MODEL_DB));
const st = r.err ? { schemas: [], configErrors: [], runQuery: {} } : JSON.parse(r.text);
check('status: spouštění zapnuté, žádné chyby nastavení', st.runQuery.enabled === true && Array.isArray(st.configErrors) && st.configErrors.length === 0, (st.configErrors ?? []).join('; '));
const knowledgeDir = st.agentDir ?? path.join(projectRoot, 'knowledge');
const hasSk = st.schemas.includes('sk');

r = await call('pohoda_rules');
check('rules jádro', !r.err && r.text.length > 30000 && /Dostupné kapitoly/.test(r.text), `${r.text.length} znaků`);
r = await call('pohoda_rules', { chapter: 'sk' });
check('rules kapitola sk', !r.err && /Slovenská Pohoda/.test(r.text));
r = await call('pohoda_rules', { chapter: 'neexistuje' });
check('rules neznámá kapitola → chyba', r.err);

// schémata: `obecny` musí být, nic mimo povolenou sadu; nezávisí na tom, co má vývojář v scripts\sync.local.json
const extraSchemas = st.schemas.filter((s) => !ALLOWED_SCHEMAS.includes(s));
check('status: schéma obecny existuje a žádné mimo povolenou sadu (obecny, sk)', st.schemas.includes('obecny') && extraSchemas.length === 0, st.schemas.join());
r = await call('pohoda_schema');
check('schema přehled: řádek tabulky pro obecny', !r.err && /^\|\s*`obecny`\s*\|/m.test(r.text));
if (hasSk) check('schema přehled: řádek tabulky pro sk', !r.err && /^\|\s*`sk`\s*\|/m.test(r.text));
{
  const rows = r.err ? [] : [...r.text.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]);
  check('schema přehled: jen zkopírovaná schémata', rows.length > 0 && rows.every((s) => st.schemas.includes(s)), rows.join());
}
r = await call('pohoda_schema', { schema: 'neexistujici-firma', table: 'FA' });
check('neznámé schéma → chyba', r.err && /neexistuje/.test(r.text));
r = await call('pohoda_check_query', { sql: 'SELECT f.ID FROM dbo.FA AS f', schema: 'neexistujici-firma' });
// kontrola tu neskončí chybou nástroje: vrátí výsledek s exit 1 (chyba nástroje kontroly) a hláškou o neexistujícím schématu
check('check_query s neznámým schématem: chyba nástroje s hláškou o neexistujícím schématu', r.err && /neexistuje/.test(r.text), short(r.text));

// pokusy o únik mimo knowledge\ (schéma se jen porovnává se seznamem složek, stránka nápovědy se bere jen jménem souboru)
r = await call('pohoda_schema', { schema: TRAVERSAL, table: 'FA' });
check('schema: „..\\..\\x“ jako schéma (table) → chyba', r.err && /neexistuje/.test(r.text), short(r.text));
r = await call('pohoda_schema', { schema: TRAVERSAL, search: 'splatnost' });
check('schema: „..\\..\\x“ jako schéma (search) → chyba', r.err && /neexistuje/.test(r.text), short(r.text));
r = await call('pohoda_check_query', { sql: 'SELECT f.ID FROM dbo.FA AS f', schema: TRAVERSAL });
check('check_query: „..\\..\\x“ jako schéma → chyba', r.err && /neexistuje|Neplatný název schématu/.test(r.text), short(r.text));
r = await call('pohoda_help', { page: '..\\..\\package.json' });
check('help: stránka „..\\..\\package.json“ → chyba', r.err && !/"name"/.test(r.text), short(r.text));
r = await call('pohoda_help', { page: '../../README.md' });
check('help: stránka „../../README.md“ → chyba', r.err, short(r.text));
r = await call('pohoda_help', { query: 'saldo', lang: '..\\..\\x' });
check('help: „..\\..\\x“ jako jazyk → chyba', r.err);

{
  // ochrana proti úniku: ve snímku nesmí zbýt názvy databází reálných firem (stejný vzor a stejné složky jako scripts\Test-Snapshot.ps1)
  const leaks = [];
  const scan = (p) => { if (RE_REAL_DB.test(fs.readFileSync(p, 'utf8'))) leaks.push(path.relative(knowledgeDir, p)); };
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else scan(p);
  } };
  for (const sub of ['schema', 'pravidla', 'tools']) if (fs.existsSync(path.join(knowledgeDir, sub))) walk(path.join(knowledgeDir, sub));
  scan(path.join(knowledgeDir, 'pravidla.md'));
  check('snímek znalostí neobsahuje názvy databází reálných firem', leaks.length === 0, leaks.slice(0, 3).join(', '));
}
r = await call('pohoda_schema', { table: 'FA' });
check('schema tabulka FA', !r.err && /RelTpFak/.test(r.text));
r = await call('pohoda_schema', { search: 'splatnost' });
check('schema hledání', !r.err && /DatSplat/i.test(r.text));
r = await call('pohoda_schema', { search: 'SPLATNOSTI datum' });
check('schema hledání: víc slov (AND), bez ohledu na velikost písmen', !r.err && /^Nalezeno/.test(r.text), r.text.split('\n')[0]);
r = await call('pohoda_schema', { search: '   ' });
check('schema hledání: prázdný dotaz → chyba', r.err);
if (hasSk) {
  r = await call('pohoda_schema', { schema: 'sk', table: 'sKVDPH' });
  check('schema SK sKVDPH', !r.err && /IDS/.test(r.text));
} else skip('schema SK sKVDPH', 'snímek neobsahuje schéma sk');
r = await call('pohoda_schema', { table: 'NeniTo' });
check('schema neznámá tabulka → chyba', r.err);

r = await call('pohoda_help', { query: 'párovací symbol' });
check('help cz', !r.err && /Nalezeno/.test(r.text), r.text.split('\n')[0]);
r = await call('pohoda_help', { query: 'PAROVACI symbol' });
check('help cz bez diakritiky', !r.err && /Nalezeno/.test(r.text), r.text.split('\n')[0]);
r = await call('pohoda_help', { query: 'kontrolný výkaz', lang: 'sk' });
check('help sk', !r.err && /Nalezeno/.test(r.text), r.text.split('\n')[0]);
r = await call('pohoda_help', { query: '  ' });
check('help prázdný dotaz → chyba', r.err);

const good = 'SELECT f.ID, f.Cislo FROM dbo.FA AS f WHERE f.Datum >= \'2026-01-01\'';
r = await call('pohoda_check_query', { sql: good });
check('check_query OK', !r.err && /exit 0/.test(r.text), r.text.split('\n').find((l) => /Výsledek:/.test(l)) ?? short(r.text));
r = await call('pohoda_check_query', { sql: 'SELECT f.NeniTo FROM dbo.FA AS f' });
check('check_query chyba sloupce', !r.err && /exit 2/.test(r.text));
if (hasSk) {
  r = await call('pohoda_check_query', { sql: 'SELECT k.IDS FROM dbo.sKVDPH AS k', schema: 'sk' });
  check('check_query SK schéma', !r.err && /exit 0/.test(r.text));
} else skip('check_query SK schéma', 'snímek neobsahuje schéma sk');

if (!runOk) skip('kontroly pohoda_run_query', `chybí soubor s přihlášením (${credFile})`);
if (runOk) {
// databáze se uvádí výslovně: test se nesmí dotknout jiné než modelové DB, ani kdyby místní config.json povoloval další
r = await call('pohoda_run_query', { database: MODEL_DB, sql: 'SELECT 1 AS Ok, N\'ěščřžýáíé\' AS Diakritika' });
check('run_query SELECT 1 + diakritika', !r.err && /\| 1 \| ěščřžýáíé \|/.test(r.text), r.text.split('\n').slice(0, 6).join(' / '));
check('run_query hlavička potvrzuje ROLLBACK', !r.err && /transakce vrácena \(ROLLBACK\)/.test(r.text), r.text.split('\n')[0]);
r = await call('pohoda_run_query', { database: MODEL_DB, sql: 'SELECT COUNT(*) AS Pocet FROM dbo.FA AS f' });
check('run_query jednosloupcový set', !r.err && /\| Pocet \|/.test(r.text) && /\| \d+ \|/.test(r.text));

const vzor = path.join(projectRoot, 'test', 'fixtures', 'vzor-rozvaha2.sql');
if (fs.existsSync(vzor)) {
  r = await call('pohoda_run_query', { database: MODEL_DB, sql: fs.readFileSync(vzor, 'utf8'), maxRows: 500 });
  check('run_query vzor rozvahy (T19): 2 983 375,54', !r.err && r.text.includes('2983375.54'), r.err ? r.text.slice(0, 300) : '');
} else check('vzor-rozvaha2.sql nalezen', false, vzor);

r = await call('pohoda_run_query', { database: MODEL_DB, sql: 'UPDATE dbo.FA SET Poznamka = N\'x\'' });
check('UPDATE dbo.FA odmítnut', r.err && /odmítnut/.test(r.text));
r = await call('pohoda_run_query', { database: MODEL_DB, sql: 'SELECT * INTO dbo.kopie_fa FROM dbo.FA' });
check('SELECT INTO trvalé tabulky odmítnut', r.err && /odmítnut/.test(r.text));
r = await call('pohoda_run_query', { database: MODEL_DB, sql: 'SELECT TOP 1 f.ID FROM master.dbo.FA AS f' });
check('odkaz mimo aktuální databázi odmítnut', r.err && /mimo aktuální databázi/.test(r.text));
r = await call('pohoda_run_query', { sql: 'SELECT 1 AS a', database: 'StwPhSK_00000000' });
check('DB mimo allowlist odmítnuta', r.err && /není povolená/.test(r.text));
r = await call('pohoda_run_query', { database: MODEL_DB, sql: 'SELECT neexistuje FROM dbo.FA' });
check('chyba SQL se vrátí jako isError', r.err && /Chyba SQL/.test(r.text));
}

await client.close();

// ===== 2. běh: spouštění dotazů vypnuté (POHODA_RUN_QUERY=0) – nástroj se nesmí nabízet =====
({ client, call } = await start({ POHODA_RUN_QUERY: '0' }));
const toolsOff = (await client.listTools()).tools.map((t) => t.name).sort();
check('vypnuté spouštění: 5 nástrojů bez pohoda_run_query', toolsOff.join() === ALL_TOOLS.filter((t) => t !== 'pohoda_run_query').join(), toolsOff.join(', '));
check('vypnuté spouštění: instrukce o pohoda_run_query nemluví', /pohoda_rules/.test(client.getInstructions() ?? '') && !/pohoda_run_query/.test(client.getInstructions() ?? ''));
r = await call('pohoda_status');
{
  const off = r.err ? {} : JSON.parse(r.text);
  check('vypnuté spouštění: status runQuery.enabled = false', off.runQuery?.enabled === false && Array.isArray(off.configErrors) && off.configErrors.length === 0);
}
r = await call('pohoda_run_query', { database: MODEL_DB, sql: 'SELECT 1 AS a' });
check('vypnuté spouštění: volání pohoda_run_query → chyba', r.err, short(r.text));
await client.close();

console.log(failed ? `\n${failed} kontrol selhalo` : '\nVše prošlo');
process.exit(failed ? 1 : 0);
