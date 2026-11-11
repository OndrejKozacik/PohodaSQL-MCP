// Pracovní postup pro MCP klienty (Claude Desktop, Codex …). Záměrně NE kopie CLAUDE.md agenta: ten říká, že agent nemá přístup k DB
// a končí hotovým skriptem, což by odporovalo nástroji pohoda_run_query.

const STEP_RUN_ON = 'Volitelně ho ověř nad daty pomocí pohoda_run_query – jen čtení, vždy ROLLBACK, jen na povolených databázích (pohoda_status). Zápisové skripty se nikdy nespouštějí: pro uživatele je jen napiš a zkontroluj.';
const STEP_RUN_OFF = 'Spouštění dotazů je vypnuté – skript jen napiš a zkontroluj.';
const RESULTS_NOTE = `

Výsledky dotazů vrať uživateli v plném rozsahu, přesně jak je databáze vrátila (včetně názvů partnerů, IČO a částek jednotlivých dokladů). Nic nevynechávej, nezkracuj ani neanonymizuj, pokud o to uživatel sám nepožádá; které databáze je povoleno dotazovat, určuje konfigurace serveru (pohoda_status), ne ty.`;

/** Instrukce serveru podle toho, zda je zapnuté pohoda_run_query (při vypnutém se nástroj vůbec neregistruje). */
export const buildInstructions = ({ runQueryEnabled = true } = {}) => `Server pohoda-mcp pomáhá psát a ověřovat T-SQL skripty nad databází účetního programu POHODA (Stormware, MS SQL). Odpovídej česky.
Doménová pravidla jsou závazná a mají přednost před obecným odhadem o Pohodě.

Postup:
1. PRVNÍ krok vždy pohoda_rules (bez parametru = jádro pravidel s rejstříkem kapitol), pak přečti celou kapitolu k tématu zadání (pohoda_rules chapter=…). U slovenské Pohody (databáze StwPhSK_…) kapitolu "sk" a schéma "sk".
2. Najdi tabulky a sloupce: pohoda_schema (search=… / table=…). Použij jen sloupce, které v popisu tabulky skutečně jsou. K dispozici jsou dvě schémata: "obecny" (CZ, výchozí) a "sk" (slovenská Pohoda, databáze StwPhSK_…).
3. Pojmy z programu (název pole, typ dokladu, postup) dohledej v nápovědě: pohoda_help.
4. Napiš skript: hlavička s účelem, obdobím, předpoklady a vyloučeními; všechny sloupce s aliasem tabulky; parametry nahoře přes DECLARE.
5. VŽDY ho zkontroluj nástrojem pohoda_check_query (stejné schéma jako při psaní) a opravuj CHYBY, VAROVÁNÍ odstraň nebo vysvětli.
6. ${runQueryEnabled ? STEP_RUN_ON : STEP_RUN_OFF}
7. Odpověz: skript v bloku kódu, výsledek kontroly, předpoklady a co je vyloučeno, co je nejisté ([?] v pravidlech, odhadnuté hodnoty Rel*).${runQueryEnabled ? RESULTS_NOTE : ''}`;

// Verze se zapnutým spouštěním (zpětná kompatibilita).
export const SERVER_INSTRUCTIONS = buildInstructions({ runQueryEnabled: true });

export const WORKFLOW_PROMPT = (zadani, { runQueryEnabled = true } = {}) => `${buildInstructions({ runQueryEnabled })}\n\n---\nZadání: ${zadani}`;
