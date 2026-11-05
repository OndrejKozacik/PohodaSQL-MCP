import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Modelová (fiktivní) firma – jediná DB, do které se server dostane bez výslovného povolení v config.json.
export const MODEL_DB = 'StwPh_12345678_2026';
export const DEFAULT_SQL_SERVER = '127.0.0.1,1433';

/** Vrací text chyby, nebo null když je adresa v pořádku: host[,port] / host\instance / IPv4 / [IPv6]; bez mezer a středníků. */
export function validateSqlServer(value) {
  const v = String(value ?? '').trim();
  if (!v) return 'Adresa SQL serveru je prázdná.';
  if (v.length > 200 || !/^[\w.\-\\:,[\]]+$/.test(v)) return `Neplatná adresa SQL serveru „${v}“ – povolené je host, host,port nebo host\\instance (bez mezer a středníků).`;
  return null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

export function loadConfig() {
  const file = process.env.POHODA_MCP_CONFIG || path.join(projectRoot, 'config.json');
  const user = readJson(file) ?? {};
  // Znalosti (pravidla, schéma, nápověda) = snímek knowledge\ vedle serveru (vytváří ho scripts\Sync-Knowledge.ps1).
  // POHODA_AGENT_DIR / agentDir jen přesměruje na jinou složku stejné struktury (např. při vývoji přímo na složku agenta).
  const agentDir = process.env.POHODA_AGENT_DIR || user.agentDir || path.join(projectRoot, 'knowledge');
  const rq = user.runQuery ?? {};
  const allowed = process.env.POHODA_ALLOWED_DATABASES
    ? process.env.POHODA_ALLOWED_DATABASES.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
    : (rq.allowedDatabases ?? [MODEL_DB]);
  return {
    configFile: file,
    configFound: Object.keys(user).length > 0,
    agentDir,
    auditLog: user.auditLog || path.join(projectRoot, 'logs', 'dotazy.jsonl'),
    runQuery: {
      enabled: process.env.POHODA_RUN_QUERY ? !/^(0|false|no|off)$/i.test(process.env.POHODA_RUN_QUERY) : (rq.enabled ?? true),
      // adresa SQL serveru: host[,port] nebo host\instance (např. 192.168.1.10,1433 / SRV01\POHODA)
      server: process.env.POHODA_SQL_SERVER || rq.server || DEFAULT_SQL_SERVER,
      // soubor Export-Clixml s přihlášením (tools\Set-PohodaCredential.ps1); čte ho jen PowerShell pomocník, nikdy Node
      credentialFile: process.env.POHODA_CREDENTIAL_FILE || rq.credentialFile || path.join(projectRoot, 'secrets', 'pohoda-sql.xml'),
      allowedDatabases: allowed,
      maxRowsPerSet: rq.maxRowsPerSet ?? 200,
      maxRowsHard: rq.maxRowsHard ?? 2000,
      maxChars: rq.maxChars ?? 60000,
      timeoutSec: rq.timeoutSec ?? 60,
    },
  };
}
