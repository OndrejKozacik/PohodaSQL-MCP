// node test/smoke.js  – spustí server přes stdio (SDK klient), projde všechny nástroje a akceptační kontroly.
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

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, 'src', 'server.js')],
  env: { ...process.env },
  stderr: 'pipe',
});
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content.map((c) => c.text).join('\n') };
};

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check('seznam nástrojů', tools.join() === ['pohoda_check_query', 'pohoda_help', 'pohoda_rules', 'pohoda_run_query', 'pohoda_schema', 'pohoda_status'].join(), tools.join(', '));
check('instrukce serveru', /pohoda_rules/.test(client.getInstructions() ?? ''));
const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
check('prompt', prompts.includes('pohoda_sql'), prompts.join());

let r = await call('pohoda_status');
check('status', !r.err && /allowedDatabases/.test(r.text) && r.text.includes(MODEL_DB));

r = await call('pohoda_rules');
check('rules jádro', !r.err && r.text.length > 30000 && /Dostupné kapitoly/.test(r.text), `${r.text.length} znaků`);
r = await call('pohoda_rules', { chapter: 'sk' });
check('rules kapitola sk', !r.err && /Slovenská Pohoda/.test(r.text));
r = await call('pohoda_rules', { chapter: 'neexistuje' });
check('rules neznámá kapitola → chyba', r.err);

r = await call('pohoda_schema');
check('schema přehled', !r.err && /sk/.test(r.text));
const st = JSON.parse((await call('pohoda_status')).text);
check('status: schémata = obecny + sk', st.schemas.slice().sort().join() === 'obecny,sk', st.schemas.join());
r = await call('pohoda_schema', { schema: 'neexistujici-firma', table: 'FA' });
check('neznámé schéma → chyba', r.err);
r = await call('pohoda_check_query', { sql: 'SELECT f.ID FROM dbo.FA AS f', schema: 'neexistujici-firma' });
check('check_query s neznámým schématem hlásí neexistující schéma', /neexistuje/.test(r.text));
{
  // ochrana proti úniku: ve snímku nesmí zbýt názvy databází reálných firem (StwPh_<8 číslic>, kromě modelové 12345678)
  const root = path.join(projectRoot, 'knowledge');
  const leaks = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(md|json|txt)$/.test(e.name) && /StwPh(SK)?_(?!12345678)\d{8}/.test(fs.readFileSync(p, 'utf8'))) leaks.push(path.relative(root, p));
  } };
  for (const sub of ['schema', 'pravidla']) walk(path.join(root, sub));
  if (/StwPh(SK)?_(?!12345678)\d{8}/.test(fs.readFileSync(path.join(root, 'pravidla.md'), 'utf8'))) leaks.push('pravidla.md');
  check('snímek znalostí neobsahuje názvy databází reálných firem', leaks.length === 0, leaks.slice(0, 3).join(', '));
}
r = await call('pohoda_schema', { table: 'FA' });
check('schema tabulka FA', !r.err && /RelTpFak/.test(r.text));
r = await call('pohoda_schema', { search: 'splatnost' });
check('schema hledání', !r.err && /DatSplat/i.test(r.text));
r = await call('pohoda_schema', { schema: 'sk', table: 'sKVDPH' });
check('schema SK sKVDPH', !r.err && /IDS/.test(r.text));
r = await call('pohoda_schema', { table: 'NeniTo' });
check('schema neznámá tabulka → chyba', r.err);

r = await call('pohoda_help', { query: 'párovací symbol' });
check('help cz', !r.err && /Nalezeno/.test(r.text), r.text.split('\n')[0]);
r = await call('pohoda_help', { query: 'kontrolný výkaz', lang: 'sk' });
check('help sk', !r.err && /Nalezeno/.test(r.text), r.text.split('\n')[0]);

const good = 'SELECT f.ID, f.Cislo FROM dbo.FA AS f WHERE f.Datum >= \'2026-01-01\'';
r = await call('pohoda_check_query', { sql: good });
check('check_query OK', !r.err && /exit 0/.test(r.text), r.text.split('\n').find((l) => /Výsledek:/.test(l)) ?? r.text.slice(0, 120));
r = await call('pohoda_check_query', { sql: 'SELECT f.NeniTo FROM dbo.FA AS f' });
check('check_query chyba sloupce', !r.err && /exit 2/.test(r.text));
r = await call('pohoda_check_query', { sql: 'SELECT k.IDS FROM dbo.sKVDPH AS k', schema: 'sk' });
check('check_query SK schéma', !r.err && /exit 0/.test(r.text));

if (!runOk) console.log(`SKIP  kontroly pohoda_run_query – chybí soubor s přihlášením (${credFile})`);
if (runOk) {
r = await call('pohoda_run_query', { sql: 'SELECT 1 AS Ok, N\'ěščřžýáíé\' AS Diakritika' });
check('run_query SELECT 1 + diakritika', !r.err && /\| 1 \| ěščřžýáíé \|/.test(r.text), r.text.split('\n').slice(0, 6).join(' / '));
r = await call('pohoda_run_query', { sql: 'SELECT COUNT(*) AS Pocet FROM dbo.FA AS f' });
check('run_query jednosloupcový set', !r.err && /\| Pocet \|/.test(r.text) && /\| \d+ \|/.test(r.text));

const vzor = path.join(projectRoot, 'test', 'fixtures', 'vzor-rozvaha2.sql');
if (fs.existsSync(vzor)) {
  r = await call('pohoda_run_query', { sql: fs.readFileSync(vzor, 'utf8'), maxRows: 500 });
  check('run_query vzor rozvahy (T19): 2 983 375,54', !r.err && r.text.includes('2983375.54'), r.err ? r.text.slice(0, 300) : '');
} else check('vzor-rozvaha2.sql nalezen', false, vzor);

r = await call('pohoda_run_query', { sql: 'UPDATE dbo.FA SET Poznamka = N\'x\'' });
check('UPDATE dbo.FA odmítnut', r.err && /odmítnut/.test(r.text));
r = await call('pohoda_run_query', { sql: 'SELECT * INTO dbo.kopie_fa FROM dbo.FA' });
check('SELECT INTO trvalé tabulky odmítnut', r.err && /odmítnut/.test(r.text));
r = await call('pohoda_run_query', { sql: 'SELECT 1 AS a', database: 'StwPhSK_00000000' });
check('DB mimo allowlist odmítnuta', r.err && /není povolená/.test(r.text));
r = await call('pohoda_run_query', { sql: 'SELECT neexistuje FROM dbo.FA' });
check('chyba SQL se vrátí jako isError', r.err && /Chyba SQL/.test(r.text));
}

await client.close();
console.log(failed ? `\n${failed} kontrol selhalo` : '\nVše prošlo');
process.exit(failed ? 1 : 0);
