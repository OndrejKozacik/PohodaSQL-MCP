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
- [Instalace](#instalace)
- [Nastavení](#nastavení-serveru)
- [Přihlášení k SQL](#přihlášení-k-sql)
- [Adresa SQL serveru](#adresa-sql-serveru)
- [Bezpečnost](#bezpečnostní-model-pohoda_run_query)
- [Konfigurační soubor](#konfigurační-soubor)
- [Příklady](#příklady-zadání)
- [Ze zdrojů](#spuštění-ze-zdrojů-a-sestavení-balíčku)
- [Testy](#testy)
- [Stav ověření](#stav-ověření)
- [Licence](#licence-a-upozornění)

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
| `pohoda_schema` | přehled schémat, popis tabulky (`table`: typy, vazby, indexy, význam), hledání v popisech a sloupcích (`search`); `schema` = `obecny` (obecná CZ Pohoda, výchozí) nebo `sk` (slovenská Pohoda) |
| `pohoda_help` | fulltext v uživatelské nápovědě programu (`lang` = `cz` / `sk`), celá stránka přes `page` |
| `pohoda_check_query` | statická kontrola skriptu proti schématu; k databázi se nepřipojuje |
| `pohoda_run_query` | čtecí běh na povolené databázi: transakce se vždy vrací (`ROLLBACK`), `ApplicationIntent=ReadOnly`, limity řádků a znaků |
| `pohoda_status` | co server používá: verze, schémata, kapitoly pravidel, adresa SQL serveru, povolené databáze |

Server dále posílá klientovi **instrukce** s pracovním postupem (pravidla → schéma → skript → kontrola → volitelně běh nad daty)
a prompt `pohoda_sql`. Zápisové skripty (`UPDATE`, `INSERT`…) asistent jen napíše a zkontroluje – nikdy je nespouští.

## Požadavky

- **Windows** s Windows PowerShell 5.1 (je součástí systému) – kontrola dotazu a spuštění SQL jsou PowerShell pomocníci.
- **Node.js ≥ 18 v PATH** pro Codex, Claude Code a ruční instalaci do Claude Desktopu. Balíček `.mcpb` v Claude Desktopu vlastní Node nepotřebuje.
- Jen pro `pohoda_run_query`: dosažitelný **Microsoft SQL Server** s databází Pohody, **read-only SQL login** (`db_datareader`) a soubor s přihlášením.
  Bez toho funguje všechno ostatní (pravidla, schéma, nápověda, kontrola skriptu).

## Instalace

V příkladech je `<SLOŽKA>` kořen serveru, tj. složka, kam rozbalíš balíček (viz níže), např. `C:/PohodaSQL`.
V cestách používej lomítka `/` (ve formátech TOML a JSON by se zpětná musela zdvojovat).
Server se všude jmenuje **`pohoda-sql`** (kdybys už měl jiný server s názvem `pohoda`, názvy se tak nekříží).

### Claude Desktop – balíček `.mcpb` (doporučeno)

Postup je v [Rychlém startu](#rychlý-start-claude-desktop). Balíček obsahuje i znalosti, nic dalšího se nestahuje.
V jeho výchozím stavu je spouštění dotazů **vypnuté**.

Ruční alternativa bez balíčku (`%APPDATA%\Claude\claude_desktop_config.json`; vyžaduje Node.js v PATH a rozbalený balíček viz [Rozbalení balíčku](#rozbalení-balíčku-do-složky)):

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
Copy-Item pohoda-mcp-0.2.4.mcpb pohoda-mcp.zip
Expand-Archive pohoda-mcp.zip C:\PohodaSQL
```

Vznikne složka `C:\PohodaSQL` se `src\`, `ps\`, `knowledge\` (pravidla, schémata, nápověda), `node_modules\` a `package.json`;
spouštěcí soubor serveru je `C:\PohodaSQL\src\server.js`. V balíčku **není žádné heslo**.

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

- Ověření: `codex mcp get pohoda-sql` (hodnoty proměnných Codex maskuje); poté Codex (aplikaci i běžící relace) restartuj.
- Záznam `pohoda-sql` už existuje? Nejdřív `codex mcp remove pohoda-sql`, nebo ho uprav ručně; cizí záznamy neměň.
- Bez `node` v PATH procesu, který Codex spouští, dej do `command` úplnou cestu k `node.exe`.
- Spouštění dotazů vypneš `POHODA_RUN_QUERY=0`.
- Jednorázově bez zápisu do konfigurace: `codex -c 'mcp_servers.pohoda-sql.command="node"' -c 'mcp_servers.pohoda-sql.args=["<SLOŽKA>/src/server.js"]' …`

### Claude Code

```powershell
claude mcp add --scope user pohoda-sql -e POHODA_RUN_QUERY=1 -e POHODA_SQL_SERVER=127.0.0.1,1433 -e POHODA_ALLOWED_DATABASES=StwPh_12345678_2026 -e POHODA_CREDENTIAL_FILE=<SLOŽKA>/secrets/pohoda-sql.xml -- node <SLOŽKA>/src/server.js
```

Neinteraktivní zkouška (otázka na stdin): `claude -p --permission-mode dontAsk --allowedTools "mcp__pohoda-sql"`.

## Nastavení serveru

Server se nastavuje proměnnými prostředí. Claude Desktop je nabízí jako formulář rozšíření, ostatní klienty je dostanou v `env` / `--env`.

| Formulář v Claude Desktopu | Proměnná | Hodnota |
|---|---|---|
| Povolit spouštění dotazů (`pohoda_run_query`) | `POHODA_RUN_QUERY` | `1` zapnuto, `0` / `false` vypnuto (bez proměnné je zapnuto; v `.mcpb` je výchozí vypnuto) |
| Adresa SQL serveru | `POHODA_SQL_SERVER` | `host`, `host,port` nebo `host\instance`; výchozí `127.0.0.1,1433` |
| Povolené databáze (oddělené čárkou) | `POHODA_ALLOWED_DATABASES` | názvy databází, které smí `pohoda_run_query` dotazovat, např. `StwPh_12345678_2026,StwPh_87654321_2026` |
| Soubor s přihlášením k SQL (Export-Clixml) | `POHODA_CREDENTIAL_FILE` | cesta k souboru, výchozí `<SLOŽKA>\secrets\pohoda-sql.xml` |

Další proměnné: `POHODA_MCP_CONFIG` (cesta k jinému konfiguračnímu souboru), `POHODA_AGENT_DIR` (jen vývoj: číst znalosti z jiné složky stejné struktury než `knowledge\`).
Hodnota `StwPh_12345678_2026` je jen ukázková – nastav názvy svých databází (typicky `StwPh_<IČO>_<rok>`, slovenské `StwPhSK_<IČO>_<rok>`).

## Přihlášení k SQL

`pohoda_run_query` potřebuje soubor s přihlášením (login s právem jen číst, `db_datareader`) ve formátu PowerShell `Export-Clixml`:

```powershell
New-Item -ItemType Directory -Force <SLOŽKA>\secrets | Out-Null
Get-Credential | Export-Clixml <SLOŽKA>\secrets\pohoda-sql.xml
```

Soubor je šifrovaný (DPAPI) pro **uživatele Windows na tomto počítači** – na jiný počítač ho kopírovat nelze, vytvoří se tam znovu.
Server heslo nikdy nevidí: čte ho jen PowerShell pomocník (`ps\Run-Query.ps1`), Node zná jen cestu k souboru.

## Adresa SQL serveru

Kam se `pohoda_run_query` připojuje, určuje (od nejvyšší priority) proměnná `POHODA_SQL_SERVER`, pole `runQuery.server` v konfiguračním souboru
a výchozí hodnota `127.0.0.1,1433`. V Claude Desktopu je to pole „Adresa SQL serveru“.

| Zápis | Příklad |
|---|---|
| host | `localhost`, `SRV01`, `srv01.firma.local` (výchozí port 1433) |
| host,port | `127.0.0.1,1433`, `192.168.1.10,14330` |
| host\instance | `SRV01\POHODA` (pojmenovaná instance; vyžaduje běžící službu SQL Server Browser a otevřený UDP 1434) |

- Adresa se kontroluje: jen písmena, číslice a znaky `_ . - : , [ ]` a zpětné lomítko, bez mezer a středníků; jinak `pohoda_run_query` skončí chybou s návodem.
- Spojení je vždy šifrované (`Encrypt=true`; certifikát serveru se nekontroluje – `TrustServerCertificate=true`) a jen pro čtení (`ApplicationIntent=ReadOnly`).
- Adresa je jedna pro všechny povolené databáze. Server musí být z počítače, kde MCP server běží, dosažitelný (firewall, povolené TCP/IP v SQL Server Configuration Manageru).
- Adresu uvidíš v `pohoda_status`, v záhlaví každého výsledku (`Databáze: … na <adresa>`) i v chybové hlášce.
- V JSON konfiguraci se zpětné lomítko zdvojuje: `{ "runQuery": { "server": "SRV01\\POHODA" } }`.

## Bezpečnostní model `pohoda_run_query`

1. **Allowlist databází.** Dotazovat jde jen databáze uvedené v `POHODA_ALLOWED_DATABASES`; cokoli jiného server odmítne.
2. **Výsledky putují k modelu v cloudu.** Server výsledky nijak nefiltruje ani neanonymizuje a model je má uživateli vrátit v plném rozsahu
   (včetně názvů partnerů, IČO a částek). Rozhodnutí, jaká data půjdou modelu, je proto jen ve výběru povolených databází – reálné firmy přidávej vědomě.
3. **Textová brána** (`src/sqlgate.js`) propouští běžné vzory výkazů (`SELECT INTO #tmp`, `CREATE TABLE #tmp`, `UPDATE #tmp`, `DECLARE`, `WHILE`, `GO`, více result setů)
   a odmítá zápis do trvalých tabulek, `EXEC`, `sp_*` / `xp_*`, `OPENROWSET` / `OPENQUERY`, `BACKUP`, `COMMIT` / `ROLLBACK` a podobné. Řádky `USE` se odstraní (databázi určuje parametr).
   Je to **pojistka**, nikoli ochrana: rozhodující je **read-only SQL login** a `ROLLBACK`.
4. **Transakce se vždy vrací** a spojení je `ReadOnly`; limity: 200 řádků na result set (nejvýše 2 000) a 60 000 znaků výstupu, timeout 60 s.
5. **Heslo nikdy neopustí PowerShell** (viz [Přihlášení k SQL](#přihlášení-k-sql)).
6. **Audit** `logs\dotazy.jsonl` (ve složce serveru): čas, databáze, hash, text SQL, počty řádků – žádné hodnoty z výsledků.
7. **Zápisové skripty** se nikdy nespouštějí (brána je odmítne); asistent je jen napíše a zkontroluje.

## Konfigurační soubor

Volitelný `config.json` v kořeni serveru (vzor [`config.example.json`](config.example.json)) nebo soubor z `POHODA_MCP_CONFIG`. Proměnné prostředí mají přednost.

```json
{
  "runQuery": {
    "enabled": true,
    "server": "127.0.0.1,1433",
    "credentialFile": "C:/PohodaSQL/secrets/pohoda-sql.xml",
    "allowedDatabases": ["StwPh_12345678_2026"],
    "maxRowsPerSet": 200,
    "maxRowsHard": 2000,
    "maxChars": 60000,
    "timeoutSec": 60
  }
}
```

## Příklady zadání

- „Kolik jsme v roce 2026 vyfakturovali a kolik to bylo faktur?“
- „Potřebuji seznam největších dodavatelů a odběratelů za rok 2026. Dotaz rovnou pusť na databázi a vrať mi výsledky.“
- „Sestav rozvahu ve zkráceném rozsahu k 30. 9. 2026 včetně součtových řádků.“ (CZ)
- „Kolik dokladov patrí do jednotlivých oddielov kontrolného výkazu DPH?“ (SK)
- „Kde je v Pohodě uložená splatnost faktury?“ (struktura databáze, bez spuštění dotazu)

## Spuštění ze zdrojů a sestavení balíčku

Zdrojové soubory v repozitáři **neobsahují složku `knowledge\`** (pravidla, schémata a nápovědu), protože se generují z jiného zdroje a jejich část
(uživatelská nápověda programu) není součástí zdrojů. Pro spuštění ze zdrojů:

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

Balíček `.mcpb` se sestavuje skripty:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Sync-Knowledge.ps1   # snímek znalostí -> knowledge\ (volitelně -Zdroj <složka>)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Pack-Mcpb.ps1        # balíček dist\pohoda-mcp-<verze>.mcpb
```

`Sync-Knowledge.ps1` kopíruje zdroj znalostí a podle konfigurace `scripts\sync.local.json` (vzor [`scripts/sync.example.json`](scripts/sync.example.json), soubor s vlastními hodnotami
se do gitu nedává) vybírá schémata, přejmenovává jejich složky a nahrazuje identifikátory (IČO, názvy databází, jména firem) ve zkopírovaných textech.
Zdroj se nemění. `Pack-Mcpb.ps1` doplní produkční závislosti a zavolá `npx @anthropic-ai/mcpb pack`.

## Testy

```powershell
npm test                 # jednotkové testy: textová brána SQL, konfigurace (adresa SQL serveru)
node test/smoke.js       # server přes stdio: všechny nástroje, odmítnutí zápisu a cizí databáze
```

Kontroly `pohoda_run_query` v `smoke.js` se spustí jen s databází a souborem s přihlášením (`POHODA_CREDENTIAL_FILE`), jinak se přeskočí.
Test zároveň ověřuje, že snímek `knowledge\` neobsahuje názvy databází reálných firem (`StwPh_<8 číslic>` kromě ukázkové `StwPh_12345678`).
Vzor rozvahy použitý ve smoke testu je v `test/fixtures/`.

## Stav ověření

| Klient | Stav |
|---|---|
| Claude Desktop (`.mcpb`) | nainstalováno a funguje |
| Claude Code (`claude -p`) | ověřeno: otázka „Kolik jsme v roce 2026 vyfakturovali?“ → 1 766 656,00 Kč, 14 faktur (ukázková databáze) |
| Codex | konfigurace přijata (`codex mcp get`), spuštění přes Codex zatím neověřeno |

## Struktura repozitáře

```
src/server.js        registrace nástrojů, instrukce, prompt
src/knowledge.js     čtení pravidel, schématu a nápovědy ze složky knowledge\
src/sqlgate.js       textová brána pro pohoda_run_query
src/exec.js          volání PowerShell pomocníků, formát výsledku, audit
src/config.js        konfigurace (proměnné prostředí, config.json)
ps/                  Run-Query.ps1 (SQL běh, Import-Clixml, ROLLBACK), Check-Query.ps1 (obálka nad kontrolou skriptu)
scripts/             Sync-Knowledge.ps1, Pack-Mcpb.ps1, sync.example.json
manifest.json        popis balíčku .mcpb (formulář nastavení v Claude Desktopu)
test/                sqlgate.test.js, config.test.js, smoke.js, fixtures/
```

## Licence a upozornění

- Projekt **není oficiálním produktem společnosti STORMWARE s.r.o.**; POHODA je jejím produktem a ochrannou známkou.
- Uživatelská nápověda programu POHODA, která je součástí balíčku z Releases, je dílem společnosti STORMWARE s.r.o.; práva k ní zůstávají jejímu autorovi.
  Není součástí zdrojových souborů v tomto repozitáři.
- Zdrojový kód je vydán pod licencí [MIT](LICENSE). Licence se vztahuje na soubory tohoto repozitáře; **nevztahuje se na uživatelskou nápovědu programu POHODA** obsaženou v balíčku z Releases.
- Server posílá výsledky dotazů AI asistentovi; za volbu povolených databází a za nakládání s daty odpovídá uživatel.
