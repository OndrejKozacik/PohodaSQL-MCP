import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Modelová (fiktivní) firma – jediná DB, do které se server dostane bez výslovného povolení v nastavení.
export const MODEL_DB = 'StwPh_12345678_2026';
export const DEFAULT_SQL_SERVER = '127.0.0.1,1433';

// Výchozí hodnoty a horní meze číselných limitů sekce runQuery.
const LIMITS = {
  maxRowsPerSet: { def: 200, max: 100_000 },
  maxRowsHard: { def: 2000, max: 100_000 },
  maxChars: { def: 60_000, max: 1_000_000 },
  timeoutSec: { def: 60, max: 600 },
};

/**
 * Vrací text chyby, nebo null když je adresa v pořádku. Povolené tvary: host, host,port, host\instance, host\instance,port,
 * [IPv6] a [IPv6],port. Host jen [A-Za-z0-9_.-], port 1–65535; žádné prefixy (tcp:, admin:, np:), mezery ani středníky.
 */
export function validateSqlServer(value) {
  const v = String(value ?? '').trim();
  if (!v) return 'Adresa SQL serveru je prázdná.';
  const bad = `Neplatná adresa SQL serveru „${v.slice(0, 80)}“ – povolené je host, host,port, host\\instance nebo [IPv6],port (bez prefixů tcp:/admin:/np:, mezer a středníků).`;
  if (v.length > 200) return bad;
  const m = /^(?:\[([0-9A-Fa-f:.]+)\]|[A-Za-z0-9_.-]+(?:\\[A-Za-z0-9_$]+)?)(?:,(\d{1,5}))?$/.exec(v);
  if (!m) return bad;
  if (m[1] !== undefined && !net.isIPv6(m[1])) return bad;
  if (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return `Neplatný port v adrese SQL serveru „${v}“ – povolený rozsah je 1–65535.`;
  return null;
}

/** Hodnota proměnné prostředí: oříznutá; prázdná nebo nevyplněný zástupný text z manifestu (${user_config.x}) = nenastaveno. */
function env(name) {
  const v = (process.env[name] ?? '').trim();
  return !v || /^\$\{[^}]*\}$/.test(v) ? undefined : v;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const splitList = (s) => s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);

/** Chybějící soubor = prázdná konfigurace bez chyby; nečitelný soubor nebo neplatný JSON = chyba (a spouštění dotazů se vypne). */
function readConfigFile(file, errors) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') errors.push(`Konfigurační soubor ${file} nejde přečíst: ${e.message}`);
    return { user: {}, found: false };
  }
  let user;
  try { user = JSON.parse(raw.replace(/^﻿/, '')); } catch (e) {
    errors.push(`Konfigurační soubor ${file} není platný JSON: ${e.message}`);
    return { user: {}, found: false };
  }
  if (!isObject(user)) {
    errors.push(`Konfigurační soubor ${file} musí obsahovat objekt JSON ({ … }).`);
    return { user: {}, found: false };
  }
  return { user, found: true };
}

/** Neprázdný řetězec z config.json (oříznutý); chybějící = undefined; jiný typ = chyba a undefined. */
function optString(value, name, errors) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) { errors.push(`config.json: ${name} musí být neprázdný řetězec.`); return undefined; }
  return value.trim();
}

/** Kladné celé číslo do horní meze; chybějící = výchozí; chybná hodnota = chyba a výchozí. */
function optInt(rq, key, errors) {
  const { def, max } = LIMITS[key];
  const value = rq[key];
  if (value === undefined || value === null) return def;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    errors.push(`config.json: runQuery.${key} musí být celé číslo 1–${max} (použita výchozí hodnota ${def}).`);
    return def;
  }
  return value;
}

function fileDatabases(value, errors) {
  if (value === undefined || value === null) return undefined;
  const list = typeof value === 'string' ? splitList(value) : value;
  if (!Array.isArray(list) || !list.length || !list.every((d) => typeof d === 'string' && d.trim())) {
    errors.push(`config.json: runQuery.allowedDatabases musí být neprázdné pole názvů databází (použita výchozí ${MODEL_DB}).`);
    return undefined;
  }
  return list.map((d) => d.trim());
}

/**
 * Načte nastavení (proměnné prostředí mají přednost před config.json). Striktně: každá chybná hodnota se zapíše do `configErrors`,
 * nahradí se výchozí a spouštění dotazů (`runQuery.enabled`) se při jakékoli chybě vypne (fail closed).
 */
export function loadConfig() {
  const errors = [];
  const file = env('POHODA_MCP_CONFIG') || path.join(projectRoot, 'config.json');
  const { user, found } = readConfigFile(file, errors);

  let rq = user.runQuery ?? {};
  if (!isObject(rq)) { errors.push('config.json: runQuery musí být objekt.'); rq = {}; }

  // Znalosti (pravidla, schéma, nápověda) = snímek knowledge\ vedle serveru (vytváří ho scripts\Sync-Knowledge.ps1).
  // POHODA_AGENT_DIR / agentDir jen přesměruje na jinou složku stejné struktury (např. při vývoji přímo na složku agenta).
  const fileAgentDir = optString(user.agentDir, 'agentDir', errors); // soubor se kontroluje vždy, i když ho proměnná přebije
  const agentDir = env('POHODA_AGENT_DIR') || fileAgentDir || path.join(projectRoot, 'knowledge');
  const auditLog = optString(user.auditLog, 'auditLog', errors) || path.join(projectRoot, 'logs', 'dotazy.jsonl');

  // zapnutí: POHODA_RUN_QUERY (1/true/yes/on · 0/false/no/off) → runQuery.enabled (boolean) → zapnuto
  let enabled = true;
  if (rq.enabled !== undefined && rq.enabled !== null) {
    if (typeof rq.enabled === 'boolean') enabled = rq.enabled;
    else errors.push('config.json: runQuery.enabled musí být true nebo false (bez uvozovek).');
  }
  const envEnabled = env('POHODA_RUN_QUERY');
  // nevyplněný zástupný text z manifestu (${user_config.run_query_enabled}) = host hodnotu nedosadil; výchozí stav balíčku je vypnuto
  if (/^\$\{[^}]*\}$/.test((process.env.POHODA_RUN_QUERY ?? '').trim())) enabled = false;
  if (envEnabled !== undefined) {
    if (/^(1|true|yes|on)$/i.test(envEnabled)) enabled = true;
    else if (/^(0|false|no|off)$/i.test(envEnabled)) enabled = false;
    else errors.push(`Proměnná POHODA_RUN_QUERY má neplatnou hodnotu „${envEnabled.slice(0, 40)}“ – povolené je 1/true/yes/on nebo 0/false/no/off.`);
  }

  // adresa SQL serveru: host[,port] nebo host\instance (např. 192.168.1.10,1433 / SRV01\POHODA)
  let server = DEFAULT_SQL_SERVER;
  const fileServer = optString(rq.server, 'runQuery.server', errors);
  if (fileServer !== undefined) {
    const bad = validateSqlServer(fileServer);
    if (bad) errors.push(`config.json: runQuery.server – ${bad}`); else server = fileServer;
  }
  const envServer = env('POHODA_SQL_SERVER');
  if (envServer !== undefined) {
    const bad = validateSqlServer(envServer);
    if (bad) { errors.push(`Proměnná POHODA_SQL_SERVER – ${bad}`); server = DEFAULT_SQL_SERVER; } else server = envServer;
  }

  // soubor Export-Clixml s přihlášením (tools\Set-PohodaCredential.ps1); čte ho jen PowerShell pomocník, nikdy Node
  const fileCredential = optString(rq.credentialFile, 'runQuery.credentialFile', errors);
  const credentialFile = env('POHODA_CREDENTIAL_FILE') || fileCredential || path.join(projectRoot, 'secrets', 'pohoda-sql.xml');

  const fromFile = fileDatabases(rq.allowedDatabases, errors);
  const fromEnv = splitList(env('POHODA_ALLOWED_DATABASES') ?? '');
  const allowedDatabases = fromEnv.length ? fromEnv : (fromFile ?? [MODEL_DB]);

  const maxRowsHard = optInt(rq, 'maxRowsHard', errors);
  let maxRowsPerSet = optInt(rq, 'maxRowsPerSet', errors);
  if (maxRowsPerSet > maxRowsHard) {
    // výslovně zadaná dvojice, která si odporuje, je chyba; výchozí maxRowsPerSet se jen tiše sníží na zadaný strop
    if (rq.maxRowsPerSet !== undefined && rq.maxRowsPerSet !== null && maxRowsPerSet === rq.maxRowsPerSet) {
      errors.push(`config.json: runQuery.maxRowsPerSet (${maxRowsPerSet}) nesmí být větší než runQuery.maxRowsHard (${maxRowsHard}).`);
    }
    maxRowsPerSet = maxRowsHard;
  }
  const maxChars = optInt(rq, 'maxChars', errors);
  const timeoutSec = optInt(rq, 'timeoutSec', errors);

  return {
    configFile: file,
    configFound: found,
    configErrors: errors,
    agentDir,
    auditLog,
    runQuery: {
      // jakákoli chyba v nastavení spouštění vypíná (fail closed) – raději žádný dotaz než dotaz s jiným nastavením, než uživatel zamýšlel
      enabled: enabled && errors.length === 0,
      server,
      credentialFile,
      allowedDatabases,
      maxRowsPerSet,
      maxRowsHard,
      maxChars,
      timeoutSec,
    },
  };
}
