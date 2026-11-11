# PohodaSQL-MCP

Samostatný **MCP server** (Node.js, stdio) pro psaní a ověřování **T-SQL nad databází účetního programu POHODA** (Stormware).
Dává AI asistentovi v **Claude Desktop, Claude Code nebo Codexu** doménová pravidla Pohody, schéma databáze, uživatelskou
nápovědu programu, kontrolu skriptu proti schématu a volitelně **read-only spuštění dotazu** nad vaší databází.

- Asistent píše SQL podle ověřených pravidel Pohody (typy dokladů, DPH, stavy k datu, výkazy…), ne podle odhadu.
- Každý skript projde kontrolou proti schématu (neexistující tabulky a sloupce, aliasy, typ skriptu čtení/zápis, známé pasti).
- Dotaz lze rovnou spustit (jen čtení, transakce se vždy vrací) a výsledek dostanete v odpovědi.
- Pokrývá **českou i slovenskou Pohodu** (SK: kontrolný výkaz DPH, súvaha a výkaz ziskov a strát, slovenská nápověda).

> **Stažení:** hotový instalační balíček je v [Releases](https://github.com/OndrejKozacik/PohodaSQL-MCP/releases/latest) (`pohoda-mcp-<verze>.mcpb`).
> Zdrojové soubory v tomto repozitáři neobsahují znalosti (pravidla, schémata, nápovědu) – ty jsou součástí balíčku z Releases.

## Obsah

- [Rychlý start](#rychlý-start-claude-desktop)
- [Nástroje](#nástroje)
- [Požadavky](#požadavky)
- [Soubory serveru (přenos na jiný počítač)](#jaké-soubory-server-potřebuje-přenos-na-jiný-počítač)
- [Instalace](#instalace)
- [Přihlášení k SQL](#přihlášení-k-sql)
- [Adresa SQL serveru](#adresa-sql-serveru)
- [Bezpečnostní model `pohoda_run_query`](#bezpečnostní-model-pohoda_run_query)
- [Konfigurace](#konfigurace)
- [Příklady zadání](#příklady-zadání)
- [Spuštění ze zdrojů a sestavení balíčku](#spuštění-ze-zdrojů-a-sestavení-balíčku)
- [Testy](#testy)
- [Stav ověření](#stav-ověření)
- [Struktura repozitáře](#struktura-repozitáře)
- [Licence a upozornění](#licence-a-upozornění)

## Rychlý start (Claude Desktop)

1. Stáhni `pohoda-mcp-<verze>.mcpb` z [Releases](https://github.com/OndrejKozacik/PohodaSQL-MCP/releases/latest).
2. Claude Desktop → **Settings → Extensions → Install Extension** (název položky se může lišit podle verze aplikace; funguje i dvojklik na soubor) a vyber balíček.
3. Ve formuláři rozšíření **Pohoda SQL** nastav (vše je nepovinné; bez nastavení server jen radí a kontroluje):
   - *Povolit spouštění dotazů* – zapni, pokud má asistent dotazy pouštět nad databází,
   - *Adresa SQL serveru* – např. `127.0.0.1,1433` (výchozí),
   - *Povolené databáze* – názvy tvých databází, např. `StwPh_12345678_2026`,
   - *Soubor s přihlášením k SQL* – viz [Přihlášení k SQL](#přihlášení-k-sql).
4. Zeptej se např.: *„Kolik jsme v roce 2026 vyfakturovali a kolik to bylo faktur?“* – asistent má postupně zavolat `pohoda_rules`, `pohoda_check_query` a `pohoda_run_query`.

## Nástroje

| Nástroj | Co dělá |
|---|---|
| `pohoda_rules` | doménová pravidla: bez parametru jádro s rejstříkem kapitol, s `chapter` celá kapitola (`ucetnictvi`, `sklad`, `dph`, `historie`, `parametry`, `ulozene-dotazy`, `sk`) |
| `pohoda_schema` | přehled schémat, popis tabulky (`table`), hledání v popisech a sloupcích (`search`); `schema` = `obecny` (obecná CZ Pohoda, výchozí) nebo `sk` (slovenská Pohoda) |
| `pohoda_help` | fulltext v uživatelské nápovědě programu (`query`, `lang` `cz` / `sk`), celá stránka přes `page`, pokračování dlouhé stránky přes `offset` |
| `pohoda_check_query` | statická kontrola skriptu proti schématu, k databázi se nepřipojuje |
| `pohoda_run_query` | čtecí běh na povolené databázi: textová brána SQL, transakce se vždy vrací (ROLLBACK), limity řádků a znaků. **Nabízí se jen při zapnutém spouštění** – při vypnutém se nástroj vůbec neregistruje |
| `pohoda_status` | co server používá: verze, složka znalostí, schémata, kapitoly, zda je zapnuté spouštění, povolené databáze, adresa SQL serveru a **chyby nastavení** (`configErrors`) |

Server posílá klientovi `instructions` s pracovním postupem (pravidla → schéma → skript → kontrola → volitelně běh) a prompt `pohoda_sql`.
Instrukce i prompt se přizpůsobí nastavení: při vypnutém spouštění o `pohoda_run_query` nemluví a postup končí zkontrolovaným skriptem.

Hledání (`pohoda_schema` s `search`, `pohoda_help` s `query`):

- víc slov = musí se najít **všechna** (AND), nejvýš 12 slov; na velikosti písmen ani na **diakritice** nezáleží („castka“ najde „Částka“),
- prázdný dotaz je chyba (ne prázdný výsledek),
- `pohoda_help` s `page` vrací stránku po úsecích 30 000 znaků; konec úseku uvádí `offset` pro pokračování,
- parametr `schema` se jen porovnává se seznamem složek schémat ve `knowledge\schema` (bez ohledu na velikost písmen) – neznámý název, `..\..\x` nebo absolutní cesta skončí chybou a mimo `knowledge\` se server nedostane; stránka nápovědy se bere jen jménem souboru.

## Požadavky

- **Windows** (kontrola dotazu i spuštění SQL jsou PowerShell pomocníci) s Windows PowerShell 5.1, který je součástí systému.
- **Node.js ≥ 18 v PATH** pro Codex, Claude Code a ruční instalaci do Claude Desktopu. Balíček `.mcpb` v Claude Desktopu vlastní Node nepotřebuje. (Jednotkové testy při vývoji potřebují Node ≥ 18.13, viz [Testy](#testy).)
- Jen pro `pohoda_run_query`: dosažitelný SQL Server (adresa se nastavuje, viz [Adresa SQL serveru](#adresa-sql-serveru)), SQL login s právem jen číst a soubor s přihlášením (viz [Přihlášení k SQL](#přihlášení-k-sql)). Bez toho funguje všechno ostatní.

## Jaké soubory server potřebuje (přenos na jiný počítač)

```
<složka>\
├── src\                 vlastní server (6 souborů)
├── ps\                  PowerShell pomocníci (Run-Query.ps1, Check-Query.ps1)
├── knowledge\           pravidla.md, pravidla\, schema\, tools\Test-PohodaQuery.ps1, reference\napoveda, reference\napoveda-sk  (~26 MB)
├── node_modules\        produkční závislosti (npm ci --omit=dev)
└── package.json
```

Nejjednodušší přenos je hotový balíček `pohoda-mcp-<verze>.mcpb` z [Releases](https://github.com/OndrejKozacik/PohodaSQL-MCP/releases/latest) (~14 MB), který obsahuje přesně tohle (a `manifest.json`). Je to ZIP:
`Copy-Item pohoda-mcp-<verze>.mcpb pohoda-mcp.zip; Expand-Archive pohoda-mcp.zip C:\PohodaSQL` vytvoří použitelnou složku (`C:\PohodaSQL\src\server.js`).
V balíčku ani v `knowledge\` **není žádné heslo** ani složka `secrets\`.

## Instalace

V příkladech je `<SLOŽKA>` kořen serveru, tj. složka, kam rozbalíš balíček z Releases (viz níže), např. `C:/PohodaSQL`.
V cestách se používají lomítka `/` (v TOML a JSON by se zpětná musela zdvojovat).

Název serveru je všude **`pohoda-sql`** (kdybys už měl jiný server s názvem `pohoda`, názvy se tak nekříží).

### Nastavení serveru (stejné ve všech klientech)

Server se nastavuje čtyřmi proměnnými prostředí. Claude Desktop je nabízí jako formulář, ostatním klientům se zadávají ručně
(další dvě proměnné, `POHODA_AGENT_DIR` a `POHODA_MCP_CONFIG`, jsou jen pro vývoj – viz [Konfigurace](#konfigurace)):

| Formulář v Claude Desktopu | Proměnná | Hodnota |
|---|---|---|
| Povolit spouštění dotazů (`pohoda_run_query`) | `POHODA_RUN_QUERY` | zapnuto `1` / `true` / `yes` / `on`, vypnuto `0` / `false` / `no` / `off`; jiná hodnota je chyba nastavení. Bez proměnné je zapnuto (pokud to nevypíná `config.json`) |
| Adresa SQL serveru | `POHODA_SQL_SERVER` | `host`, `host,port` nebo `host\instance`; výchozí `127.0.0.1,1433` |
| Povolené databáze (oddělené čárkou) | `POHODA_ALLOWED_DATABASES` | např. `StwPh_12345678_2026` (výchozí) |
| Soubor s přihlášením k SQL (Export-Clixml) | `POHODA_CREDENTIAL_FILE` | cesta k souboru, výchozí `<SLOŽKA>\secrets\pohoda-sql.xml` |

Nastavení se čte **striktně** a při chybě se spouštění dotazů vypne (fail closed), viz [Konfigurace](#konfigurace).
Nastavení se čte jen při startu serveru – po změně klienta restartuj (nebo rozšíření vypni a zapni).

### Claude Desktop – balíček `.mcpb` (doporučeno)

1. Settings → Extensions → **Install Extension** → vyber `pohoda-mcp-<verze>.mcpb` (nebo dvojklik na soubor).
2. Ve formuláři rozšíření zapni „Povolit spouštění dotazů“, zadej adresu SQL serveru, nech nebo uprav povolené databáze, vyber soubor s přihlášením (Browse) a ulož (Save).
3. Zeptej se např.: „Kolik jsme v roce 2026 vyfakturovali a kolik to bylo faktur?“ – asistent má zavolat `pohoda_rules`, `pohoda_check_query`, `pohoda_run_query`.

Ve výchozím stavu balíčku je spouštění dotazů **vypnuté** – server pak jen radí a kontroluje a nástroj `pohoda_run_query` vůbec nenabízí.
Vypnuto je i tehdy, když klient hodnotu z formuláře nedosadí (do proměnné přijde nevyplněný zástupný text `${user_config.…}` z manifestu).

Ruční alternativa (`%APPDATA%\Claude\claude_desktop_config.json`, vyžaduje Node v PATH):
```json
{
  "mcpServers": {
    "pohoda-sql": {
      "command": "node",
      "args": ["<SLOŽKA>/src/server.js"],
      "env": {
        "POHODA_RUN_QUERY": "1",
        "POHODA_SQL_SERVER": "127.0.0.1,1433",
        "POHODA_ALLOWED_DATABASES": "StwPh_12345678_2026",
        "POHODA_CREDENTIAL_FILE": "<SLOŽKA>/secrets/pohoda-sql.xml"
      }
    }
  }
}
```

### Rozbalení balíčku do složky

Balíček `.mcpb` je obyčejný ZIP. Pro Codex a Claude Code (a ruční instalaci do Claude Desktopu) ho rozbal:

```powershell
Copy-Item pohoda-mcp-0.3.0.mcpb pohoda-mcp.zip
Expand-Archive pohoda-mcp.zip C:\PohodaSQL
```

Vznikne složka `C:\PohodaSQL` se `src\`, `ps\`, `knowledge\` (pravidla, schémata, nápověda), `node_modules\` a `package.json`; spouštěcí soubor serveru je `C:\PohodaSQL\src\server.js`. V balíčku **není žádné heslo**.

### Codex

Příkazem (zapíše se do `~/.codex/config.toml`, který sdílí Codex CLI i desktopová aplikace):
```powershell
codex mcp add pohoda-sql `
  --env POHODA_RUN_QUERY=1 `
  --env POHODA_SQL_SERVER=127.0.0.1,1433 `
  --env POHODA_ALLOWED_DATABASES=StwPh_12345678_2026 `
  --env POHODA_CREDENTIAL_FILE=<SLOŽKA>/secrets/pohoda-sql.xml `
  -- node <SLOŽKA>/src/server.js
```
nebo ručně do `~/.codex/config.toml`:
```toml
[mcp_servers.pohoda-sql]
command = "node"
args = ["<SLOŽKA>/src/server.js"]
env = { POHODA_RUN_QUERY = "1", POHODA_SQL_SERVER = "127.0.0.1,1433", POHODA_ALLOWED_DATABASES = "StwPh_12345678_2026", POHODA_CREDENTIAL_FILE = "<SLOŽKA>/secrets/pohoda-sql.xml" }
```
Ověření: `codex mcp get pohoda-sql` (hodnoty proměnných Codex maskuje); poté Codex (aplikaci i běžící relace) restartuj.
Záznam `pohoda-sql` už existuje? Nejdřív `codex mcp remove pohoda-sql` nebo ho uprav ručně; cizí záznamy (např. `pohoda`) neměň.
Bez `node` v PATH procesu, který Codex spouští, dej do `command` úplnou cestu k `node.exe`.
Spouštění dotazů vypneš `POHODA_RUN_QUERY=0` (nástroj `pohoda_run_query` se pak nenabízí). Když proměnnou vynecháš, je spouštění zapnuté; bez souboru s přihlášením pak běh skončí srozumitelnou chybou.

Jednorázově bez zápisu do konfigurace: `codex -c 'mcp_servers.pohoda-sql.command="node"' -c 'mcp_servers.pohoda-sql.args=["<SLOŽKA>/src/server.js"]' …`.

### Claude Code

```powershell
claude mcp add --scope user pohoda-sql -e POHODA_RUN_QUERY=1 -e POHODA_SQL_SERVER=127.0.0.1,1433 -e POHODA_CREDENTIAL_FILE=<SLOŽKA>/secrets/pohoda-sql.xml -- node <SLOŽKA>/src/server.js
```
Neinteraktivní zkouška (otázka na stdin): `claude -p --permission-mode dontAsk --allowedTools "mcp__pohoda-sql"`.

## Přihlášení k SQL

`pohoda_run_query` potřebuje soubor s přihlášením ve formátu PowerShell `Export-Clixml`:
```powershell
New-Item -ItemType Directory -Force <SLOŽKA>\secrets | Out-Null
Get-Credential | Export-Clixml <SLOŽKA>\secrets\pohoda-sql.xml
```
Soubor je šifrovaný (DPAPI) pro **vašeho uživatele Windows na tomto počítači** – na jiný počítač ho kopírovat nelze, vytvoří se tam znovu.

**Jaký login použít.** Skutečnou ochranou dat je SQL login, ne server:

- jen právo číst (`db_datareader`), žádná práva zápisu, `EXECUTE` ani role serveru,
- namapovaný **jen do povolených databází** – login, který vidí i jiné databáze na serveru, by je modelu zpřístupnil, kdyby textová brána selhala (viz [Omezení brány SQL](#omezení-brány-sql)).

## Adresa SQL serveru

Kam se `pohoda_run_query` připojuje, určuje (od nejvyšší priority) proměnná `POHODA_SQL_SERVER`, pole `runQuery.server` v `config.json`, výchozí hodnota `127.0.0.1,1433`.
V Claude Desktopu je to pole „Adresa SQL serveru“ ve formuláři rozšíření.

| Zápis | Příklad |
|---|---|
| host | `localhost`, `SRV01`, `srv01.firma.local` (výchozí port 1433) |
| host,port | `127.0.0.1,1433`, `192.168.1.10,14330` |
| host\instance | `SRV01\POHODA` (pojmenovaná instance; vyžaduje běžící službu SQL Server Browser a otevřený UDP 1434), případně `SRV01\POHODA,14330` |
| [IPv6],port | `[::1]`, `[fe80::1],1433` |

- Adresa se kontroluje: host jen z písmen, číslic a znaků `_ . -`, port 1–65535, žádné prefixy (`tcp:`, `admin:`, `np:`), mezery ani středníky. Neplatná adresa je **chyba nastavení** – zapíše se do `configErrors` a spouštění dotazů se vypne.
- Spojení je vždy šifrované (`Encrypt=true`; certifikát serveru se nekontroluje – `TrustServerCertificate=true`).
- Připojovací řetězec nese `ApplicationIntent=ReadOnly`. To **zápis neblokuje** – jen u skupin dostupnosti Always On směruje spojení na čtecí repliku. Zápisu brání práva loginu, vrácená transakce a textová brána, ne tento příznak.
- Adresa je jedna pro všechny povolené databáze. Server musí být z počítače, kde běží MCP server, dosažitelný (firewall, TCP/IP povolené v SQL Server Configuration Manageru).
- Adresu uvidíš v `pohoda_status` a v záhlaví každého výsledku (`Databáze: … na <adresa>`); při chybě spojení je v hlášce také.
- Příklady: `POHODA_SQL_SERVER=192.168.1.10,1433`, v `config.json`: `{ "runQuery": { "server": "SRV01\\POHODA" } }` (v JSON se zpětné lomítko zdvojuje).

## Bezpečnostní model `pohoda_run_query`

1. **Read-only SQL login** je hlavní ochrana (viz [Přihlášení k SQL](#přihlášení-k-sql)): co login nesmí, to se nestane, ať model napíše cokoli.
2. **Transakce se vždy vrací.** Celý skript běží v jedné transakci a končí `ROLLBACK`. Záhlaví výsledku uvádí **skutečný stav**: „transakce vrácena (ROLLBACK)“ jen tehdy, když vrácení proběhlo; jinak výrazné varování, že se vrácení nepodařilo potvrdit (spojení je v tu chvíli zavřené, čímž SQL Server otevřenou transakci ruší).
3. **Allowlist databází.** Výchozí je jen modelová firma `StwPh_12345678_2026`. Reálné firmy se přidávají výslovně (`POHODA_ALLOWED_DATABASES` nebo `config.json`).
4. **Výsledky putují k modelu v cloudu.** Server výsledky nijak nefiltruje ani neanonymizuje a model je má uživateli vrátit v plném rozsahu (včetně názvů partnerů, IČO a částek). Rozhodnutí, jaká data půjdou modelu, je proto jen ve výběru povolených databází – reálné firmy přidávej do `POHODA_ALLOWED_DATABASES` vědomě.
5. **Textová brána** (`src/sqlgate.js`) je **pojistka, ne ochrana** – zachytí zjevné omyly dřív, než dojdou na server. Propouští vzory výkazů (`SELECT`, `SELECT INTO #tmp`, `CREATE TABLE #tmp`, `INSERT`/`UPDATE`/`DELETE`/`DROP` nad `#dočasnými` tabulkami a `@tabulkovými` proměnnými, `DECLARE`, `WHILE`, `GO`, více result setů). Odmítá:
   - zápis do trvalých tabulek; `UPDATE`/`DELETE` přes alias projde jen tehdy, když ho klauzule `FROM` téhož příkazu váže na `#`/`@` objekt (`UPDATE t SET … FROM #tmp AS t`),
   - `EXEC`/`EXECUTE`, `sp_*`/`xp_*`, `{call …}` i **holé volání procedury bez `EXEC`** (dávka musí začínat příkazem – `SELECT`, `WITH`, `DECLARE`, `SET`, `IF`, `CREATE TABLE #…` …),
   - **vícedílné názvy objektů mimo aktuální databázi** – `db.schema.tab`, `db..tab`, `server.db.schema.tab` (výjimka: `tempdb..#x` a `tempdb.dbo.#x`); jinou databázi určuje parametr `database`,
   - `OPENROWSET`/`OPENQUERY`/`OPENDATASOURCE`, `BACKUP`/`RESTORE`, `ALTER`, `MERGE`, `BULK INSERT`, `TRUNCATE` trvalé tabulky, `GRANT`/`DENY`/`REVOKE`, `DBCC`, `WAITFOR`, `KILL`, `SHUTDOWN` …,
   - vlastní řízení transakce (`BEGIN TRAN`, `COMMIT`, `ROLLBACK`, `SAVE TRAN`),
   - řídicí znaky v kódu (SQL Server je čte jako mezery), neukončený řetězec nebo komentář, `GO <počet>` (opakování dávky) a řádek `GO` uvnitř víceřádkového řetězce nebo komentáře.

   `USE <databáze>` se odstraní jen jako samostatný příkaz (s poznámkou ve výsledku; databázi určuje parametr) – `OPTION (USE HINT(…))` projde beze změny. Jiné použití slova `USE` se odmítne (sloupec toho jména piš `[use]`).
6. **Heslo nikdy neopustí PowerShell.** `ps\Run-Query.ps1` načte `Import-Clixml`, Node vidí jen cestu k souboru.
7. **Audit** `logs\dotazy.jsonl` (JSON Lines): každé volání zanechá právě jeden záznam – úspěch i **selhání** (odmítnutí bránou, nepovolená databáze, chyba SQL, timeout, pád pomocníka). Obsahuje čas, databázi, hash celého textu, text SQL oříznutý na 20 000 znaků (s původní délkou), dobu běhu, počty řádků a stav rollbacku, u selhání důvod – **žádné hodnoty z výsledků**. Soubor větší než 5 MB se přejmenuje na `dotazy.jsonl.1` (starší `.1` se přepíše).
8. Zápisové skripty se nikdy nespouštějí (brána je odmítne); asistent je jen napíše a zkontroluje.

### Podoba a limity výsledků

- Result sety se vracejí jako markdown tabulky, `NULL` jako `NULL`.
- Desetinná čísla **bez zaokrouhlení**: `decimal`/`money` v plné přesnosti a s měřítkem sloupce (`25.10` zůstane `25.10`), `float`/`real` v přesném zápisu; desetinná tečka. Datum jako `yyyy-MM-dd HH:mm:ss` (zlomky sekundy, jen když nejsou nulové), binární data jako prvních 16 bajtů hexadecimálně.
- Limity: řádků na result set 200 (parametr `maxRows`, nejvýš `maxRowsHard` = 2000), celý výstup 60 000 znaků, buňka 200 znaků, nejvýš **50 result setů** a **20 zpráv `PRINT`** (zpráva nejvýš 500 znaků), časový limit 60 s na dávku. Zkrácení je ve výstupu vždy uvedeno i se skutečným počtem řádků. Limity řádků, znaků výstupu a časový limit lze změnit v `config.json`, ostatní jsou pevné.

### Omezení brány SQL

Brána není parser T-SQL: pracuje nad tokeny a hlídá jen známé vzory. Známá omezení:

- **Vícedílné názvy se hledají jen za `FROM` / `JOIN` / `APPLY`** a v čárkovém seznamu hned za `FROM`. Seznam za `JOIN … ON` a názvy na jiných místech (např. volání funkce `db.dbo.fn()` ve výběru sloupců) se nekontrolují – tady chrání jen práva loginu.
- **Některé správné dotazy odmítne:** `TRIM(x FROM dbo.FA.Sloupec)` a `CROSS APPLY t.XmlSloupec.nodes('…')` vyhodnotí jako odkaz mimo databázi (pomůže dvoudílný zápis přes alias). Sloupec nebo alias pojmenovaný zakázaným slovem (`Commit`, `Execute`, `Use` …) je potřeba psát v hranatých závorkách – `[Commit]`. Název začínající `sp_` nebo `xp_` se odmítne vždy, i v závorkách.
- Alias v `UPDATE`/`DELETE` se přijme jen při jednoznačné vazbě na `#`/`@` objekt ve vlastním `FROM`; při pochybnosti brána odmítá.
- Dávky se dělí na řádcích `GO` bez ohledu na řetězce a komentáře (stejně jako v `ps\Run-Query.ps1`), proto se takový řádek uvnitř řetězce nebo komentáře odmítá.
- Brána nezná práva ani obsah databáze: neposoudí pohledy, funkce a synonyma, které samy sahají jinam.

**Doporučení:** nespoléhej na bránu. Použij SQL login, který smí **jen číst a jen do povolených databází** – jinak by model mohl číst i jiné databáze na serveru, kdyby brána selhala nebo ji některý z uvedených zápisů obešel.

## Konfigurace

Volitelný `config.json` v kořeni serveru (vzor `config.example.json`) nebo soubor z `POHODA_MCP_CONFIG`; proměnné prostředí mají přednost.

| Proměnná | Význam |
|---|---|
| `POHODA_RUN_QUERY` | `1` / `true` / `yes` / `on` zapne, `0` / `false` / `no` / `off` vypne `pohoda_run_query`; jiná hodnota je chyba nastavení |
| `POHODA_SQL_SERVER` | adresa SQL serveru (výchozí `127.0.0.1,1433`) |
| `POHODA_ALLOWED_DATABASES` | povolené DB, oddělené čárkou |
| `POHODA_CREDENTIAL_FILE` | soubor Clixml s přihlášením (výchozí `<SLOŽKA>\secrets\pohoda-sql.xml`) |
| `POHODA_AGENT_DIR` | jen vývoj: číst znalosti z jiné složky stejné struktury než `knowledge\` |
| `POHODA_MCP_CONFIG` | cesta k jinému `config.json` |

Pole `config.json`: `agentDir`, `auditLog` a sekce `runQuery` – `enabled` (`true`/`false`, bez uvozovek), `server`, `credentialFile`, `allowedDatabases` (pole názvů), `maxRowsPerSet` (výchozí 200), `maxRowsHard` (2000; oba nejvýš 100 000), `maxChars` (60 000, nejvýš 1 000 000), `timeoutSec` (60, nejvýš 600).

**Nastavení je striktní a při chybě se zavírá (fail closed).** Každá chybná hodnota – neplatný JSON nebo nečitelný `config.json`, špatný typ, číslo mimo rozsah, `maxRowsPerSet` větší než `maxRowsHard`, neplatná adresa serveru, neznámá hodnota `POHODA_RUN_QUERY` – se zapíše do `configErrors`, nahradí se výchozí hodnotou a **spouštění dotazů se vypne**, dokud chybu neopravíš a server nespustíš znovu. Chyby jsou vidět v `pohoda_status` a v logu serveru (stderr). Chybějící `config.json` chyba není. Prázdná proměnná nebo nevyplněný zástupný text z manifestu (`${user_config.…}`) se bere jako nenastavená; u `POHODA_RUN_QUERY` znamená zástupný text **vypnuto**.

## Příklady zadání

- „Kolik jsme v roce 2026 vyfakturovali a kolik to bylo faktur?“
- „Potřebuji seznam největších dodavatelů a odběratelů za rok 2026. Dotaz rovnou pusť na databázi a vrať mi výsledky.“
- „Sestav rozvahu ve zkráceném rozsahu k 30. 9. 2026 včetně součtových řádků.“ (CZ)
- „Kolik dokladov patrí do jednotlivých oddielov kontrolného výkazu DPH?“ (SK)
- „Kde je v Pohodě uložená splatnost faktury?“ (struktura databáze, bez spuštění dotazu)

## Spuštění ze zdrojů a sestavení balíčku

Zdrojové soubory v repozitáři **neobsahují složku `knowledge\`** (pravidla, schémata a nápovědu), protože se generují z jiného zdroje a jejich část
(uživatelská nápověda programu) není součástí zdrojů. Server za běhu čte jen složku `knowledge\` vedle sebe a **žádného agenta ani jinou složku nepotřebuje**.
Pro spuštění ze zdrojů:

1. Stáhni a rozbal balíček z Releases (viz [Rozbalení balíčku](#rozbalení-balíčku-do-složky)) – obsahuje hotovou `knowledge\`.
2. Zkopíruj ji vedle `src\` ve svém klonu a spusť `npm ci --omit=dev` (nebo `npm install`).
3. Spusť `node src/server.js` (klient MCP komunikuje přes stdio), případně nastav `POHODA_AGENT_DIR` na jinou složku stejné struktury:

```
knowledge/
├── pravidla.md, pravidla/*.md                         doménová pravidla (jádro + kapitoly)
├── schema/<název>/{schema.json, tables/*.md}          schémata (obecny, sk)  + schema/README.md
├── tools/Test-PohodaQuery.ps1                         kontrola skriptu proti schématu
└── reference/napoveda/, reference/napoveda-sk/        stránky nápovědy (*.txt)
```

**Server drží načtené soubory znalostí v paměti a za běhu je neobnovuje** – po výměně `knowledge\` (nebo instalaci nového balíčku) restartuj klienta, případně rozšíření vypni a zapni.

### Sestavení balíčku `.mcpb`

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Sync-Knowledge.ps1 -Zdroj <složka se znalostmi>   # snímek -> knowledge\ (volitelně -Cil <jiná složka>, -Konfigurace <sync*.json>)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Pack-Mcpb.ps1                                      # balíček dist\pohoda-mcp-<verze>.mcpb
```

`-Zdroj` je složka se strukturou znalostí (viz strom výše, ve zdroji navíc všechna schémata, ze kterých se vybírá). `Sync-Knowledge.ps1` zkopíruje jen pravidla, schémata, nápovědu a `Test-PohodaQuery.ps1`; nikdy `secrets\`, `config.json`, `dotazy\`, `logs\`, `tests\`.
Co se do snímku kopíruje a anonymizuje, určuje konfigurace `scripts\sync.local.json` (parametr `-Konfigurace`; vzor [`scripts/sync.example.json`](scripts/sync.example.json)). **Soubor `sync.local.json` obsahuje skutečné identifikátory a do gitu se nedává.** Pole:

| Pole | Význam |
|---|---|
| `schemata` | zdrojové složky schémat, která přejdou do snímku (záměr projektu: jen obecné CZ a SK) |
| `prejmenovani` | přejmenování složek schémat ve snímku, např. SK schéma se ve snímku jmenuje jen `sk` |
| `nahrady` | seznam `[vzor, náhrada]` pro texty schémat a pravidel: IČO a názvy databází reálných firem → `<ICO>`, jména firem → „firma A“, „firma B“; vzor je doslovný text (rozlišuje velikost písmen) nebo regulární výraz s předponou `(?i)` |
| `priklady` | náhrady příkladů: `schemaReadme` pro `schema\README.md` (vzor je **vždy regulární výraz**), `kontrola` pro nápovědu skriptu kontroly (doslovný text) |

**Co ve snímku je z reálných dat.** Obě schémata vznikla exportem struktury z databáze a u tabulek uvádějí odhad počtu řádků. Schéma `obecny` je česká Pohoda bez uživatelských sloupců (`VPr*`). **Schéma `sk` pochází z reálné databáze** slovenské Pohody: obsahuje názvy uživatelských sloupců (`VPr*`) té firmy a odhady počtu řádků jejích tabulek. Ostatní údaje jsou anonymizovány – IČO, názvy databází, název SQL serveru a jména firem se ve snímku nahrazují (`<ICO>`, „firma A“ …).

Zdroj se nemění, anonymizuje se až kopie ve snímku. Kontrola dotazu z těchto údajů nic nepoužívá – vypisuje jen název databáze do záhlaví výstupu. Přehled `schema\README.md` ve snímku se zkrátí na zkopírovaná schémata. Vypnutí anonymizace: `-BezAnonymizace` (takový snímek se nesmí balit ani zveřejnit; kontrola úniku se při něm přeskočí).

Pojistky sestavení:

- **Výměna až po úspěchu.** Snímek se staví v dočasné složce `<cíl>.new` a cíl se nahradí až po dokončení kopie, anonymizace a kontroly úniku. Při chybě zůstane původní `knowledge\` beze změny a `<cíl>.new` se smaže.
- **Ochrana cíle.** `-Cil` nesmí být zdroj, jeho nadřazená složka ani složka uvnitř zdroje; existující neprázdný cíl se přepíše jen tehdy, když vypadá jako snímek (obsahuje `pravidla.md`). Relativní cesty parametrů se berou vůči aktuální složce PowerShellu.
- **Kontrola úniku** `scripts\Test-Snapshot.ps1 -Cesta <snímek> [-Konfigurace <sync*.json>]` projde `pravidla.md`, `pravidla\`, `schema\` a `tools\` (obsah i názvy souborů) a hledá zdrojové vzory z `nahrady` (bez ohledu na velikost písmen; vzor obsažený ve své vlastní náhradě se přeskakuje) a obecný vzor názvu databáze reálné firmy `StwPh(SK)?_<8 číslic>` (kromě ukázkové `12345678`). Vypisuje jen soubor a pořadí vzoru, nikdy nalezený text. Návratový kód 0 = čisto, 1 = nález, 2 = kontrolu nejde provést. `Sync-Knowledge.ps1` ji volá před nahrazením cíle, `Pack-Mcpb.ps1` **vždy** před balením (i s `-BezSync`).

`Pack-Mcpb.ps1` navíc ověří, že se shoduje verze v `package.json` a `manifest.json`, balí připnutou verzí nástroje `@anthropic-ai/mcpb` (konstanta `$mcpbVerze` na začátku skriptu), nemění pracovní složku volajícího a starší balíčky v `dist\` maže jen s přepínačem `-SmazatStarsi`.

## Testy

```powershell
npm test                 # jen jednotkové testy: brána SQL, konfigurace, čtení znalostí (hledání, schémata, nápověda), formát výsledků a audit
npm run smoke            # = node test/smoke.js: server přes stdio, všechny nástroje, zapnuté i vypnuté spouštění
```

`npm test` spouští výslovně čtyři soubory (`test/sqlgate.test.js`, `config.test.js`, `knowledge.test.js`, `exec.test.js`); nepotřebuje `knowledge\`, SQL Server ani přihlášení – čtení znalostí zkouší nad malou vymyšlenou sadou `test/fixtures/knowledge-mini`. Volitelné akceptační testy brány procházejí sbírku vlastních SQL skriptů z lokální složky autora; když složka neexistuje, přeskočí se. Vyžaduje Node ≥ 18.13 (hooky `after` v `node:test`: globální od 18.8, `t.after` od 18.13).

`npm run smoke` potřebuje snímek `knowledge\` (viz [Spuštění ze zdrojů](#spuštění-ze-zdrojů-a-sestavení-balíčku)). Server spouští s izolovaným prostředím (proměnné `POHODA_*` z okolí se nepřebírají, kromě `POHODA_CREDENTIAL_FILE`) dvakrát: se zapnutým spouštěním (6 nástrojů) a s vypnutým (5 nástrojů bez `pohoda_run_query`). Ověřuje také, že snímek obsahuje jen schémata `obecny` a `sk`, že v něm nezbyl název databáze reálné firmy (stejný vzor jako `Test-Snapshot.ps1`) a že pokusy o únik mimo `knowledge\` (`..\..\x`) končí chybou.
Kontroly `pohoda_run_query` ve `smoke.js` běží jen proti ukázkové databázi `StwPh_12345678_2026` a jen když existuje soubor s přihlášením (`POHODA_CREDENTIAL_FILE` nebo `secrets\pohoda-sql.xml`) a SQL Server odpovídá; jinak se přeskočí. Vzor rozvahy (kontrola výsledku 2 983 375,54) je v `test/fixtures/`.

## Stav ověření

| Co | Stav |
|---|---|
| Claude Desktop (`.mcpb`) | nainstalováno a funguje |
| Claude Code (`claude -p`) | ověřeno: otázka „Kolik jsme v roce 2026 vyfakturovali?“ → 1 766 656,00 Kč, 14 faktur (ukázková databáze) |
| Codex | konfigurace přijata (`codex mcp get`), spuštění přes Codex zatím neověřeno |
| SQL Server | `npm run smoke` včetně kontrol `pohoda_run_query` proti ukázkové databázi (skutečné typy hodnot, číslo dávky a řádku v chybě, ROLLBACK v hlavičce, odmítnutí zápisu, cizí databáze i vícedílného názvu) |

## Struktura repozitáře

```
src/server.js        registrace nástrojů, prompt
src/instructions.js  instrukce serveru a text promptu (podle toho, zda je zapnuté spouštění)
src/knowledge.js     čtení pravidel, schématu a nápovědy ze složky knowledge\
src/sqlgate.js       textová brána pro pohoda_run_query
src/exec.js          volání PowerShell pomocníků, formát výsledku, audit
src/config.js        konfigurace (striktní, fail closed)
ps/                  Run-Query.ps1 (SQL běh, Import-Clixml, ROLLBACK), Check-Query.ps1 (obálka nad kontrolou skriptu)
scripts/             Sync-Knowledge.ps1 (snímek znalostí), Test-Snapshot.ps1 (kontrola úniku), Pack-Mcpb.ps1 (balíček), sync.example.json
manifest.json        popis balíčku .mcpb (formulář nastavení v Claude Desktopu)
test/                sqlgate.test.js, config.test.js, knowledge.test.js, exec.test.js (npm test), smoke.js (npm run smoke), fixtures/
```

## Licence a upozornění

- Projekt **není oficiálním produktem společnosti STORMWARE s.r.o.**; POHODA je jejím produktem a ochrannou známkou.
- Uživatelská nápověda programu POHODA, která je součástí balíčku z Releases, je dílem společnosti STORMWARE s.r.o.; práva k ní zůstávají jejímu autorovi.
  Není součástí zdrojových souborů v tomto repozitáři.
- Zdrojový kód je vydán pod licencí [MIT](LICENSE). Licence se vztahuje na soubory tohoto repozitáře; **nevztahuje se na uživatelskou nápovědu programu POHODA** obsaženou v balíčku z Releases.
- Server posílá výsledky dotazů AI asistentovi; za volbu povolených databází a za nakládání s daty odpovídá uživatel.
