#!/usr/bin/env node
// MCP server pohoda-mcp (stdio). Na stdout smí jen JSON-RPC – veškerý log jde na stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, projectRoot } from './config.js';
import { buildInstructions, WORKFLOW_PROMPT } from './instructions.js';
import { getHelp, getRules, getSchema, listRuleChapters, listSchemas, resolveSchema } from './knowledge.js';
import { checkQuery, runQuery } from './exec.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
const cfg = loadConfig();
const runQueryEnabled = cfg.runQuery.enabled;
for (const e of cfg.configErrors) console.error(`[pohoda-mcp] VAROVÁNÍ – chyba v nastavení: ${e}`);
if (cfg.configErrors.length) console.error('[pohoda-mcp] VAROVÁNÍ – kvůli chybám v nastavení je pohoda_run_query vypnuté; oprav je a server spusť znovu.');

const server = new McpServer({ name: 'pohoda-mcp', version: VERSION }, { instructions: buildInstructions({ runQueryEnabled }) });

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] });
const wrap = (fn) => async (args) => { try { return text(await fn(args)); } catch (e) { console.error('[pohoda-mcp]', e instanceof Error ? e.message : e); return fail(e); } };
// čtecí nástroje nad místními znalostmi; pohoda_run_query se navíc připojuje k SQL serveru (openWorldHint)
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const READ_ONLY_SQL = { ...READ_ONLY, openWorldHint: true };

server.registerTool('pohoda_rules', {
  title: 'Pravidla Pohoda SQL',
  description: 'Doménová pravidla pro psaní SQL nad Pohodou (tabulky, typy dokladů, DPH, stavy k datu, pasti, vzory dotazů). ZAVOLEJ JAKO PRVNÍ před psaním jakéhokoli SQL. Bez parametru vrátí jádro pravidel s rejstříkem kapitol; s `chapter` celou kapitolu (ucetnictvi, sklad, dph, historie, parametry, ulozene-dotazy, sk).',
  inputSchema: { chapter: z.string().max(50).optional().describe('Název kapitoly, např. "ucetnictvi"; vynech pro jádro') },
  annotations: READ_ONLY,
}, wrap(({ chapter }) => getRules(cfg, chapter)));

server.registerTool('pohoda_schema', {
  title: 'Schéma databáze Pohody',
  description: 'Popis tabulek a sloupců Pohody (typy, vazby, indexy, význam). Bez parametrů přehled schémat. `table` = celý popis tabulky (např. "FA"); `search` = hledání textu v popisech a sloupcích (např. "splatnost"). `schema`: "obecny" (obecná CZ Pohoda, výchozí) nebo "sk" (slovenská Pohoda – použij ho u databází StwPhSK_…). Použij jen sloupce, které v popisu skutečně jsou.',
  inputSchema: {
    schema: z.string().max(40).optional().describe('Složka schématu, výchozí "obecny"'),
    table: z.string().max(100).optional().describe('Název tabulky, např. "FA"'),
    search: z.string().max(100).optional().describe('Hledaný text (název sloupce nebo slovo z popisu; víc slov = všechna musí být v popisu tabulky; na diakritice a velikosti písmen nezáleží)'),
  },
  annotations: READ_ONLY,
}, wrap((a) => getSchema(cfg, a)));

server.registerTool('pohoda_help', {
  title: 'Nápověda programu POHODA',
  description: 'Fulltext v uživatelské nápovědě programu POHODA (jazyk "cz", u slovenské verze "sk"). Nápověda popisuje pole a postupy slovy z programu, ne názvy sloupců – hledej pojmy, které uživatel vidí. `query` = hledané výrazy (všechny musí být na stránce); `page` = celá stránka podle názvu souboru z výsledků.',
  inputSchema: {
    query: z.string().max(200).optional().describe('Hledané výrazy, např. "párovací symbol"'),
    lang: z.enum(['cz', 'sk']).optional().describe('cz (výchozí) nebo sk'),
    page: z.string().max(200).optional().describe('Název souboru stránky z výsledků hledání'),
    offset: z.number().int().min(0).optional().describe('Jen s page: od kterého znaku stránku vrátit (pokračování dlouhé stránky; hodnotu uvádí konec předchozího úseku)'),
    limit: z.number().int().min(1).max(25).optional().describe('Počet výsledků, výchozí 8'),
  },
  annotations: READ_ONLY,
}, wrap((a) => getHelp(cfg, a)));

server.registerTool('pohoda_check_query', {
  title: 'Kontrola SQL proti schématu',
  description: 'Statická kontrola T-SQL skriptu proti schématu Pohody (neexistující tabulky a sloupce, aliasy, typ skriptu čtení/zápis, známé pasti). Nic nespouští a nepřipojuje se k databázi. VŽDY ji spusť, než skript ukážeš uživateli; CHYBY oprav, VAROVÁNÍ odstraň nebo vysvětli. `schema` musí odpovídat schématu, podle kterého jsi skript psal.',
  inputSchema: {
    sql: z.string().max(200000).describe('Celý skript'),
    schema: z.string().max(40).optional().describe('"obecny" (CZ, výchozí) nebo "sk" (slovenská Pohoda)'),
  },
  annotations: READ_ONLY,
}, wrap(async ({ sql, schema }) => {
  // neznámé schéma = chyba nástroje (ne běžný výsledek „exit 1“); zároveň se parametr nedostane k PowerShellu neověřený
  const r = await checkQuery(cfg, sql, schema ? resolveSchema(cfg, schema) : undefined);
  return `Výsledek kontroly (exit ${r.exit}: 0 = OK, 2 = chyby, 1 = chyba nástroje):\n\n${r.output}`;
}));

// Při vypnutém spouštění se nástroj vůbec nenabízí (klient ho nevidí a instrukce o něm nemluví).
if (runQueryEnabled) server.registerTool('pohoda_run_query', {
  title: 'Spustit SQL (jen čtení)',
  description: `Spustí T-SQL skript nad databází Pohody v transakci, která se VŽDY vrátí (ROLLBACK), read-only loginem, a vrátí všechny result sety jako tabulky (limit řádků a znaků). Povolené je SELECT (i SELECT INTO #tmp), CREATE TABLE #tmp, INSERT/UPDATE/DELETE/DROP jen nad #dočasnými tabulkami, DECLARE, WHILE, GO. Zápis do trvalých tabulek, EXEC, USE a podobné se odmítne. Povolené databáze: ${cfg.runQuery.allowedDatabases.join(', ')} (výchozí: ${cfg.runQuery.allowedDatabases[0]}); jiné jen v nastavení (proměnná POHODA_ALLOWED_DATABASES nebo config.json). Výsledky vrať uživateli v plném rozsahu, přesně jak je databáze vrátila (včetně názvů partnerů, IČO a částek) – nic nevynechávej ani neanonymizuj, pokud o to uživatel sám nepožádá. Nejdřív skript zkontroluj pohoda_check_query.`,
  inputSchema: {
    sql: z.string().max(200000).describe('Čtecí skript; výsledky vracej přes SELECT, ne PRINT'),
    database: z.string().max(100).optional().describe('Název databáze z povolených; výchozí první povolená'),
    maxRows: z.number().int().min(1).optional().describe('Max. řádků na result set (výchozí 200)'),
  },
  annotations: READ_ONLY_SQL,
}, wrap(async (a) => (await runQuery(cfg, a)).text));

server.registerTool('pohoda_status', {
  title: 'Stav serveru',
  description: 'Co server právě používá: verze, složka znalostí, dostupná schémata a kapitoly pravidel, zda je zapnuté pohoda_run_query a které databáze jsou povolené. Nepřipojuje se k databázi.',
  inputSchema: {},
  annotations: READ_ONLY,
}, wrap(() => JSON.stringify({
  version: VERSION,
  agentDir: cfg.agentDir,
  configFile: cfg.configFile,
  configFound: cfg.configFound,
  configErrors: cfg.configErrors,
  schemas: listSchemas(cfg),
  ruleChapters: listRuleChapters(cfg),
  runQuery: { enabled: cfg.runQuery.enabled, allowedDatabases: cfg.runQuery.allowedDatabases, server: cfg.runQuery.server, maxRowsPerSet: cfg.runQuery.maxRowsPerSet, maxRowsHard: cfg.runQuery.maxRowsHard },
}, null, 2)));

server.registerPrompt('pohoda_sql', {
  title: 'Napsat SQL pro Pohodu',
  description: `Spustí pracovní postup: pravidla → schéma → skript → kontrola${runQueryEnabled ? ' → (volitelně) ověření nad daty' : ''}.`,
  argsSchema: { zadani: z.string().describe('Co má dotaz vrátit / změnit') },
}, ({ zadani }) => ({ messages: [{ role: 'user', content: { type: 'text', text: WORKFLOW_PROMPT(zadani, { runQueryEnabled }) } }] }));

await server.connect(new StdioServerTransport());
console.error(`[pohoda-mcp ${VERSION}] běží; znalosti: ${cfg.agentDir}; run_query: ${cfg.runQuery.enabled ? cfg.runQuery.allowedDatabases.join(',') : 'vypnuto'}`);
