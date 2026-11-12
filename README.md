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

**Změna chování ve verzi 0.3.1:** `pohoda_run_query` před každým během ověří oprávnění SQL loginu a **login, který smí zapisovat, odmítne** (např. `sa` nebo člena `db_owner`) – i když s ním dřívější verze fungovaly. Řešení: login jen s rolí `db_datareader`, nejlépe jen do povolených databází; případně vědomé povolení v nastavení. Podrobnosti: [Kontrola oprávnění SQL loginu](#kontrola-oprávnění-sql-loginu).

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
- [Měření kvality (zlaté testy přes MCP)](#měření-kvality-zlaté-testy-přes-mcp)
- [CI a repozitář](#ci-a-repozitář)
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
| `pohoda_rules` | doménová pravidla: bez parametru jádro s rejstříkem kapitol (v režimu `compact` kompaktní jádro), s `chapter` celá kapitola (`ucetnictvi`, `sklad`, `dph`, `historie`, `parametry`, `ulozene-dotazy`, `sk`), se `section` jedna sekce, se `search` hledání v pravidlech – viz [Pravidla po sekcích a režim pravidel](#pravidla-po-sekcích-a-režim-pravidel) |
| `pohoda_schema` | přehled schémat, popis tabulky (`table`), hledání v popisech a sloupcích (`search`); `schema` = `obecny` (obecná CZ Pohoda, výchozí) nebo `sk` (slovenská Pohoda) |
| `pohoda_help` | fulltext v uživatelské nápovědě programu (`query`, `lang` `cz` / `sk`), celá stránka přes `page`, pokračování dlouhé stránky přes `offset` |
| `pohoda_check_query` | statická kontrola skriptu proti schématu, k databázi se nepřipojuje |
| `pohoda_run_query` | čtecí běh na povolené databázi: textová brána SQL, **kontrola oprávnění SQL loginu** (login, který smí zapisovat, se odmítne), transakce se vždy vrací (ROLLBACK), limity řádků a znaků. **Nabízí se jen při zapnutém spouštění** – při vypnutém se nástroj vůbec neregistruje |
| `pohoda_status` | co server používá: verze, složka znalostí, schémata, kapitoly, režim pravidel (`rulesMode`), zda je zapnuté spouštění, povolené databáze, adresa SQL serveru, **chyby nastavení** (`configErrors`) a upozornění (`configWarnings`). Bez parametrů se k databázi nepřipojuje; s `probe: true` ověří oprávnění SQL loginu – viz [Stav serveru a kontrola loginu](#stav-serveru-a-kontrola-loginu-pohoda_status) |

Server posílá klientovi `instructions` s pracovním postupem (pravidla → schéma → skript → kontrola → volitelně běh) a prompt `pohoda_sql`.
Instrukce i prompt se přizpůsobí nastavení: při vypnutém spouštění o `pohoda_run_query` nemluví a postup končí zkontrolovaným skriptem; první krok (pravidla) se liší podle režimu pravidel.

Hledání (`pohoda_schema` s `search`, `pohoda_help` s `query`):

- víc slov = musí se najít **všechna** (AND), nejvýš 12 slov; na velikosti písmen ani na **diakritice** nezáleží („castka“ najde „Částka“),
- prázdný dotaz je chyba (ne prázdný výsledek),
- `pohoda_help` s `page` vrací stránku po úsecích 30 000 znaků; konec úseku uvádí `offset` pro pokračování,
- parametr `schema` se jen porovnává se seznamem složek schémat ve `knowledge\schema` (bez ohledu na velikost písmen) – neznámý název, `..\..\x` nebo absolutní cesta skončí chybou a mimo `knowledge\` se server nedostane; stránka nápovědy se bere jen jménem souboru.

### Pravidla po sekcích a režim pravidel

Pravidla tvoří **jádro** (`pravidla.md`) a **kapitoly** (`pravidla\<kapitola>.md`). `pohoda_rules` má tři volitelné parametry:

| Volání | Co vrátí |
|---|---|
| bez parametrů | jádro pravidel a seznam kapitol; podoba závisí na režimu pravidel (níže) |
| `chapter` | celou kapitolu |
| `section` | jednu sekci jádra **včetně podsekcí**; spolu s `chapter` sekci z kapitoly |
| `search` | seznam sekcí z jádra i kapitol, které obsahují hledaná slova; spolu s `chapter` jen z té kapitoly |

`section` a `search` nejde zadat v jednom volání (chyba) – nejdřív se hledá, potom se vybraná sekce načte.

**Sekce a jejich id.** Jádro i kapitoly se dělí podle nadpisů `##` a `###` (nadpisy uvnitř bloků kódu se neberou):

- číslovaný nadpis (`## 5. Faktury`, `### 11.15. Rozvaha` – za číslem musí být tečka) má id podle čísla: `5`, `11.15`. Sekce `5` zahrnuje podsekce `5.x` a končí u dalšího číslovaného nadpisu, který pod ni nepatří,
- `uvod` je vše před prvním číslovaným nadpisem (v jádru hlavička a rejstřík kapitol),
- nadpis bez čísla dostane id z titulku: malá písmena bez diakritiky, ostatní znaky jako `-`, nejvýš 40 znaků (`## Časté chyby` → `caste-chyby`); opakované id dostane příponu `-2`, `-3` …, id jen z číslic předponu `sekce-`,
- id se jen hledá mezi sekcemi, cesta se z něj neskládá. V zápisu se nerozlišuje velikost písmen ani diakritika a koncová tečka se ignoruje (`5.1.` = `5.1`).

Neznámé id skončí chybou, která vypíše platná id a napoví, kde sekce toho čísla je (v jádru, nebo v které kapitole).
**Odkazová sekce** je sekce jádra, pod jejímž nadpisem je jen řádek `→ Obsah je v kapitole …` (text je přesunutý do kapitoly). Přes `section` se vrátí s poučením, jak načíst kapitolu (a tutéž sekci v ní); hledání ji přeskakuje, protože skutečný text najde v kapitole.

**Hledání (`search`):**

- víc slov = **všechna musí být v jedné sekci**; nejvýš 12 různých slov (o dalších se ve výsledku napíše, že použita nebyla), na velikosti písmen ani diakritice nezáleží; slova se dělí na mezerách, čárkách, středníkách, závorkách a uvozovkách, tečka a podtržítko zůstávají součástí slova (`dbo.FA`, `FA.RefAD`),
- prázdný dotaz je chyba; nic nenalezeno je běžná odpověď s radou,
- výsledek: `Nalezeno N sekcí pravidel (zobrazeno M)` a u každé sekce řádek `### <id> · jádro | kapitola <název> · <titulek> (<velikost> znaků)` s nejvýš třemi řádky, kde se shoda našla; nejvýš **15 sekcí**,
- když se shoduje podsekce, nadřazená sekce se vedle ní uvede jen tehdy, má-li všechna slova i ve vlastním textu,
- řazení: shoda **celého slova** má přednost před shodou uvnitř slova (`AD` najde dřív `dbo.AD` než „sklad“) – nejdřív počet hledaných slov jako celé slovo v titulku, pak počet výskytů celého slova v textu, pak slova kdekoli v titulku, pak počet výskytů kdekoli (každé slovo se počítá nejvýš 20×), pak jádro před kapitolami a pořadí v souboru.

**Režim pravidel** určuje, co vrátí `pohoda_rules` bez parametrů. Nastavuje se proměnnou `POHODA_RULES_MODE` nebo polem `rules.mode` v `config.json` (výchozí hodnota je v tabulce v oddílu [Konfigurace](#konfigurace)); skutečný režim ukazuje `pohoda_status` v poli `rulesMode`.

| Režim | `pohoda_rules` bez parametrů | První krok v instrukcích serveru a v promptu |
|---|---|---|
| `full` | celé jádro pravidel a seznam kapitol | načíst jádro, potom celou kapitolu k tématu |
| `compact` | úvod a sekce `0`, `1`, `2`, `3`, `4`, `5.2`, `5.3`, `8.1`, `8.2`, `9`, `10`, `11.6` v plném znění; za nimi patička s pokyny, **rejstřík ostatních sekcí jádra** (id, titulek, velikost) a seznam kapitol | načíst kompaktní jádro, potom ještě před psaním SQL potřebné sekce (`section`) a celou kapitolu k tématu; když není jasné, kde pravidlo je, hledat (`search`) |

- Kompaktní sada je pevně daná v kódu (`RULES_COMPACT_SECTIONS` v `src/knowledge.js`): pravidla potřebná u většiny dotazů bez ohledu na agendu. Patička říká, že sekce z rejstříku jsou stejně závazné, a jmenuje nejčastější z nich. U sekce, jejíž podsekce už kompaktní jádro vrátilo, uvádí rejstřík velikost zbytku; u odkazové sekce kapitolu, kde je text.
- V režimu `compact` se mění také popis nástroje `pohoda_rules`. Ostatní volání (`chapter`, `section`, `search`) fungují v obou režimech stejně.
- **Velikosti** (měřeno nad současným snímkem znalostí, s jiným snímkem se změní): `full` 46 103 znaků, `compact` 25 421 znaků.
- Režim `compact` šetří úvodní kontext, ale spoléhá na to, že si asistent potřebné sekce sám dočte. **Měření (22 zlatých testů nad ukázkovou databází, model Sonnet, jeden běh každého režimu, 2026-11-12):** oba režimy dopadly stejně – 20 testů PROŠLO a 2 ČÁSTEČNĚ (u obou režimů jen kvůli vzorům v kontrole skriptu, ne kvůli hodnotám; shoda hodnot 88/88). `compact` vyšel o 19 % levněji (3,56 USD proti 4,41 USD) a asistent si přečetl zhruba o 30 % méně textu pravidel (877 tis. proti 1 226 tis. znaků dohromady). Jediný rozdíl v kvalitě se ukázal u zápisu s DPH (T10): `compact` vynechal kontrolní dotaz na sazbu DPH z posledních dokladů, který `full` zařadil (pravidlo je v sekci o zápisu a DPH, kterou `compact` neobsahuje). Vzorek je malý (jeden běh na režim), proto zůstává výchozí `full`; `compact` je rozumná volba, když záleží na ceně. Postup měření viz [Měření kvality](#měření-kvality-zlaté-testy-přes-mcp).
- Neplatná hodnota režimu není chyba nastavení: zapíše se do `configWarnings`, použije se výchozí režim a **spouštění dotazů se nevypíná**. Když v jádru pravidel chybí sekce z kompaktní sady (přečíslovaný zdroj) nebo je z ní jen odkaz na kapitolu, server to v režimu `compact` vypíše při startu a ukáže v `configWarnings`; kompaktní jádro se vrátí bez ní.

### Stav serveru a kontrola loginu (`pohoda_status`)

`pohoda_status` bez parametrů vrací JSON s poli `version`, `agentDir`, `configFile`, `configFound`, `configErrors`, `configWarnings`, `schemas`, `ruleChapters`, `rulesMode` a `runQuery` (`enabled`, `allowedDatabases`, `server`, `maxRowsPerSet`, `maxRowsHard`). K databázi se nepřipojuje.

- `configErrors` – chyby nastavení; každá vypíná spouštění dotazů (viz [Konfigurace](#konfigurace)),
- `configWarnings` – upozornění, která spouštění nevypínají: neplatný režim pravidel a neúplná kompaktní sada sekcí,
- `rulesMode` – skutečně použitý režim pravidel (`full` / `compact`).

S parametrem **`probe: true`** (volitelně `database` – název z povolených, výchozí první povolená) se server připojí k databázi, provede jen kontrolu oprávnění loginu (žádný skript uživatele, žádná transakce, žádný dotaz do dat) a přidá pole `loginProbe`:

```json
"loginProbe": { "database": "StwPh_12345678_2026", "writable": false, "reasons": [], "otherDatabases": 0, "otherWritableDatabases": 0 }
```

- `writable`, `reasons` – zda login smí zapisovat a proč (české texty důvodů, viz [Kontrola oprávnění SQL loginu](#kontrola-oprávnění-sql-loginu)),
- `otherDatabases` – do kolika dalších databází mimo povolené se login dostane, `otherWritableDatabases` – v kolika z nich má oprávnění zapisovat; **jen počty, názvy nikdy** (`null` = nepodařilo se zjistit),
- kontrola jen hlásí stav: na nastavení `allowWritableLogin` nezávisí a nic neodmítá,
- když kontrolu nejde provést, zbytek stavu zůstane a v `loginProbe` je jen `error` s důvodem – nepovolená databáze, chybějící soubor s přihlášením, nedostupný server, selhání kontroly. Při vypnutém spouštění je to `pohoda_run_query je vypnuté – kontrolu loginu nelze provést.` a k SQL serveru se server nepřipojí,
- každé volání s `probe` zanechá v auditu jeden záznam `login_probe` (i neúspěšné).

Protože se nástroj s `probe` připojuje k SQL serveru, má stejné anotace jako `pohoda_run_query` (`readOnlyHint: true`, `openWorldHint: true`); ostatní nástroje mají `openWorldHint: false`.

## Požadavky

- **Windows** (kontrola dotazu i spuštění SQL jsou PowerShell pomocníci) s Windows PowerShell 5.1, který je součástí systému.
- **Node.js ≥ 18 v PATH** pro Codex, Claude Code a ruční instalaci do Claude Desktopu. Balíček `.mcpb` v Claude Desktopu vlastní Node nepotřebuje. (Jednotkové testy při vývoji potřebují Node ≥ 18.13, viz [Testy](#testy).)
- Jen pro `pohoda_run_query` (a `pohoda_status` s `probe: true`): dosažitelný SQL Server (adresa se nastavuje, viz [Adresa SQL serveru](#adresa-sql-serveru)), SQL login s právem jen číst a soubor s přihlášením (viz [Přihlášení k SQL](#přihlášení-k-sql)). Bez toho funguje všechno ostatní.

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
`Copy-Item pohoda-mcp-0.3.1.mcpb pohoda-mcp.zip; Expand-Archive pohoda-mcp.zip C:\PohodaSQL` vytvoří použitelnou složku (`C:\PohodaSQL\src\server.js`).
V balíčku ani v `knowledge\` **není žádné heslo** ani složka `secrets\`.

## Instalace

V příkladech je `<SLOŽKA>` kořen serveru, tj. složka, kam rozbalíš balíček z Releases (viz níže), např. `C:/PohodaSQL`.
V cestách se používají lomítka `/` (v TOML a JSON by se zpětná musela zdvojovat).

Název serveru je všude **`pohoda-sql`** (kdybys už měl jiný server s názvem `pohoda`, názvy se tak nekříží).

### Nastavení serveru (stejné ve všech klientech)

Server se nastavuje čtyřmi základními proměnnými prostředí. Claude Desktop je nabízí jako formulář, ostatním klientům se zadávají ručně.
Další proměnné ve formuláři nejsou: `POHODA_RULES_MODE` (režim pravidel), `POHODA_ALLOW_WRITABLE_LOGIN` (vědomé povolení loginu, který smí zapisovat – ve formuláři není záměrně) a dvě jen pro vývoj, `POHODA_AGENT_DIR` a `POHODA_MCP_CONFIG` – viz [Konfigurace](#konfigurace).

| Formulář v Claude Desktopu | Proměnná | Hodnota |
|---|---|---|
| Povolit spouštění dotazů (`pohoda_run_query`) | `POHODA_RUN_QUERY` | zapnuto `1` / `true` / `yes` / `on`, vypnuto `0` / `false` / `no` / `off`; jiná hodnota je chyba nastavení. Bez proměnné je zapnuto (pokud to nevypíná `config.json`) |
| Adresa SQL serveru | `POHODA_SQL_SERVER` | `host`, `host,port` nebo `host\instance`; výchozí `127.0.0.1,1433` |
| Povolené databáze (oddělené čárkou) | `POHODA_ALLOWED_DATABASES` | např. `StwPh_12345678_2026` (výchozí) |
| Soubor s přihlášením k SQL (Export-Clixml) | `POHODA_CREDENTIAL_FILE` | cesta k souboru, výchozí `<SLOŽKA>\secrets\pohoda-sql.xml` |

Nastavení se čte **striktně** a při chybě se spouštění dotazů vypne (fail closed), viz [Konfigurace](#konfigurace).
Nastavení se čte jen při startu serveru – po změně klienta restartuj (nebo rozšíření vypni a zapni).

Soubor s přihlášením musí patřit **SQL loginu, který smí jen číst** – login s právem zápisu `pohoda_run_query` odmítne (viz [Přihlášení k SQL](#přihlášení-k-sql)). Oprávnění loginu ověříš bez spuštění dotazu: `pohoda_status` s `probe: true`.

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
Copy-Item pohoda-mcp-0.3.1.mcpb pohoda-mcp.zip
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

- jen právo číst (`db_datareader`), žádná práva zápisu, `EXECUTE` ani role serveru – **to server při každém běhu kontroluje** a login, který smí zapisovat, odmítne dřív, než se skript spustí (viz [Kontrola oprávnění SQL loginu](#kontrola-oprávnění-sql-loginu)),
- namapovaný **jen do povolených databází** – login, který vidí i jiné databáze na serveru, by je modelu zpřístupnil, kdyby textová brána selhala (viz [Omezení brány SQL](#omezení-brány-sql)). Tohle server **nevynucuje**, jen hlásí: počet dalších dostupných databází je v `pohoda_status` s `probe: true`, jejich názvy jen v logu serveru (stderr).

**Přechod z verze 0.3.0 a starších.** Starší verze login nekontrolovaly, takže fungovaly i s `sa`, členem `db_owner` nebo `db_datawriter`. Od verze 0.3.1 takový login skončí chybou `Běh odmítnut: SQL login smí zapisovat …` a skript se nespustí. Co s tím:

1. **Doporučeno:** vytvoř na SQL Serveru login, který má v povolených databázích jen roli `db_datareader` (a do jiných databází se nedostane), a ulož ho do souboru s přihlášením (příkaz výše). Příklad pro správce SQL Serveru – názvy a heslo doplň vlastní:
   ```sql
   CREATE LOGIN pohoda_cteni WITH PASSWORD = N'<silné heslo>';
   USE [StwPh_12345678_2026];
   CREATE USER pohoda_cteni FOR LOGIN pohoda_cteni;
   ALTER ROLE db_datareader ADD MEMBER pohoda_cteni;
   ```
2. **Vědomé povolení:** `runQuery.allowWritableLogin = true` v `config.json` nebo proměnná `POHODA_ALLOW_WRITABLE_LOGIN=1`. Běh pak proběhne s výrazným varováním v hlavičce výsledku; ochranou zůstává jen textová brána a ROLLBACK.

Výsledek ověříš voláním `pohoda_status` s `probe: true` – u správného loginu je `writable: false` a `reasons` prázdné.

## Adresa SQL serveru

Kam se `pohoda_run_query` (a `pohoda_status` s `probe: true`) připojuje, určuje (od nejvyšší priority) proměnná `POHODA_SQL_SERVER`, pole `runQuery.server` v `config.json`, výchozí hodnota `127.0.0.1,1433`.
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

1. **Read-only SQL login** je hlavní ochrana (viz [Přihlášení k SQL](#přihlášení-k-sql)): co login nesmí, to se nestane, ať model napíše cokoli. Server to **ověřuje před každým během**: login, který smí zapisovat, odmítne dřív, než se skript uživatele spustí (viz [Kontrola oprávnění SQL loginu](#kontrola-oprávnění-sql-loginu)).
2. **Transakce se vždy vrací.** Celý skript běží v jedné transakci a končí `ROLLBACK`. Záhlaví výsledku uvádí **skutečný stav**: „transakce vrácena (ROLLBACK)“ jen tehdy, když vrácení proběhlo; jinak výrazné varování, že se vrácení nepodařilo potvrdit (spojení je v tu chvíli zavřené, čímž SQL Server otevřenou transakci ruší).
3. **Allowlist databází.** Výchozí je jen modelová firma `StwPh_12345678_2026`. Reálné firmy se přidávají výslovně (`POHODA_ALLOWED_DATABASES` nebo `config.json`).
4. **Výsledky putují k modelu v cloudu.** Server výsledky nijak nefiltruje ani neanonymizuje a model je má uživateli vrátit v plném rozsahu (včetně názvů partnerů, IČO a částek). Rozhodnutí, jaká data půjdou modelu, je proto jen ve výběru povolených databází – reálné firmy přidávej do `POHODA_ALLOWED_DATABASES` vědomě.
5. **Textová brána** (`src/sqlgate.js`) je **pojistka, ne ochrana** – zachytí zjevné omyly dřív, než dojdou na server. Propouští vzory výkazů (`SELECT`, `SELECT INTO #tmp`, `CREATE TABLE #tmp`, `INSERT`/`UPDATE`/`DELETE`/`DROP` nad `#dočasnými` tabulkami a `@tabulkovými` proměnnými, `DECLARE`, `WHILE`, `GO`, více result setů). Odmítá:
   - zápis do trvalých tabulek; `UPDATE`/`DELETE` přes alias projde jen tehdy, když ho klauzule `FROM` téhož příkazu váže na `#`/`@` objekt (`UPDATE t SET … FROM #tmp AS t`),
   - `EXEC`/`EXECUTE`, `sp_*`/`xp_*`, `{call …}` i **holé volání procedury bez `EXEC`** (dávka musí začínat příkazem – `SELECT`, `WITH`, `DECLARE`, `SET`, `IF`, `CREATE TABLE #…` …),
   - **vícedílné názvy objektů mimo aktuální databázi** – `db.schema.tab`, `db..tab`, `server.db.schema.tab` (výjimka: `tempdb..#x` a `tempdb.dbo.#x`); jinou databázi určuje parametr `database`,
   - `OPENROWSET`/`OPENQUERY`/`OPENDATASOURCE`, `BACKUP`/`RESTORE`, `ALTER`, `MERGE`, `BULK INSERT`, `TRUNCATE` trvalé tabulky, `GRANT`/`DENY`/`REVOKE`, `DBCC`, `WAITFOR`, `KILL`, `SHUTDOWN` …,
   - **odkazy na seznam databází serveru** – `sys.databases`, `sys.sysdatabases`, `sys.master_files`, `sys.sysaltfiles`, holé `sysdatabases` a `sysaltfiles`, funkci `HAS_DBACCESS` a `DB_NAME` s argumentem (`DB_NAME()` bez argumentu = aktuální databáze projde). Důvod je soukromí: názvy dalších databází na serveru (u Pohody obsahují IČO firem) se nemají dostat k modelu,
   - vlastní řízení transakce (`BEGIN TRAN`, `COMMIT`, `ROLLBACK`, `SAVE TRAN`),
   - řídicí znaky v kódu (SQL Server je čte jako mezery), neukončený řetězec nebo komentář, `GO <počet>` (opakování dávky) a řádek `GO` uvnitř víceřádkového řetězce nebo komentáře.

   `USE <databáze>` se odstraní jen jako samostatný příkaz (s poznámkou ve výsledku; databázi určuje parametr) – `OPTION (USE HINT(…))` projde beze změny. Jiné použití slova `USE` se odmítne (sloupec toho jména piš `[use]`).
6. **Heslo nikdy neopustí PowerShell.** `ps\Run-Query.ps1` načte `Import-Clixml`, Node vidí jen cestu k souboru.
7. **Audit** `logs\dotazy.jsonl` (JSON Lines): každé volání zanechá právě jeden záznam – úspěch i **selhání** (odmítnutí bránou, nepovolená databáze, chyba SQL, timeout, pád pomocníka). Obsahuje čas, databázi, hash celého textu, text SQL oříznutý na 20 000 znaků (s původní délkou), dobu běhu, počty řádků a stav rollbacku, u selhání důvod – **žádné hodnoty z výsledků**. Soubor větší než 5 MB se přejmenuje na `dotazy.jsonl.1` (starší `.1` se přepíše). Ke kontrole loginu se zapisuje navíc: odmítnutý běh má `loginRefused: true` a `reasons`, běh povolený přes `allowWritableLogin` (úspěšný i ten, jehož skript skončil chybou SQL) má `writableLogin` s důvody, selhání samotné kontroly má `error` začínající `Kontrola loginu:`. Volání `pohoda_status` s `probe: true` zanechá záznam `tool: "login_probe"` (databáze, doba, `writable`, `reasons`, `otherDatabases`, `otherWritableDatabases`, nebo `error`). **Názvy dalších databází se do auditu nezapisují.**
8. Zápisové skripty se nikdy nespouštějí (brána je odmítne); asistent je jen napíše a zkontroluje.

### Kontrola oprávnění SQL loginu

Před skriptem uživatele proběhne **na stejném spojení** kontrola oprávnění (preflight) – ještě před zahájením transakce. Jen čte metadata, nic nezapisuje a nevytváří žádné objekty. Když zjistí, že login smí zapisovat, **skript se vůbec nespustí** (výchozí chování). Důvody a jejich texty:

| Kód | Text ve výstupu | Co se kontroluje |
|---|---|---|
| `sysadmin` | člen serverové role sysadmin | `IS_SRVROLEMEMBER` |
| `control_server` | oprávnění CONTROL SERVER | oprávnění na úrovni serveru |
| `db_owner`, `db_datawriter`, `db_ddladmin` | člen role db_owner / db_datawriter / db_ddladmin | členství v roli databáze (`IS_MEMBER`) |
| `db_securityadmin` | člen role db_securityadmin (smí měnit oprávnění) | členství v roli databáze |
| `db_accessadmin` | člen role db_accessadmin (smí spravovat přístup do databáze) | členství v roli databáze |
| `perm_INSERT`, `perm_UPDATE`, `perm_DELETE`, `perm_ALTER`, `perm_CONTROL` | oprávnění INSERT / UPDATE / DELETE / ALTER / CONTROL v databázi | oprávnění na úrovni databáze |
| `perm_db_other` | další oprávnění v databázi mimo čtení (např. EXECUTE nebo CREATE) | cokoli na úrovni databáze mimo pevný výčet oprávnění, která nic nemění (`CONNECT`, `SELECT`, `REFERENCES`, `SHOWPLAN` a vyjmenovaná oprávnění `VIEW …`; úplný výčet je v `ps\Run-Query.ps1`) |
| `perm_server_other` | další oprávnění na serveru mimo čtení | cokoli na úrovni serveru mimo pevný výčet (`CONNECT SQL` a vyjmenovaná oprávnění `VIEW …`; výčet tamtéž) |
| `schema_write` | oprávnění zápisu nebo EXECUTE na úrovni schématu | `INSERT` / `UPDATE` / `DELETE` / `ALTER` / `EXECUTE` na některém schématu (kromě `sys`, `INFORMATION_SCHEMA` a schémat vlastněných pevnými rolemi) |
| `object_write` | oprávnění zápisu (INSERT/UPDATE/DELETE/ALTER) k některé tabulce nebo pohledu | uživatelské tabulky a pohledy |
| `proc_execute` | oprávnění EXECUTE k některé uložené proceduře | uživatelské uložené procedury |
| `unknown` | některou kontrolu oprávnění se nepodařilo vyhodnotit (bere se jako možnost zápisu) | některá kontrola vrátila `NULL` – server ji nezná nebo nevyhodnotil (fail closed) |

**Odmítnutí** je chyba nástroje s tímto textem (důvody jsou vyjmenované čárkou):

```
Běh odmítnut: SQL login smí zapisovat (<databáze> na <adresa>) – <důvody>. Skript se nespustil. pohoda_run_query je určený pro login, který smí jen číst: vytvoř login jen s rolí db_datareader, nejlépe s přístupem jen do povolených databází, a ulož ho do souboru s přihlášením. Vědomě to lze povolit nastavením runQuery.allowWritableLogin = true v config.json nebo proměnnou POHODA_ALLOW_WRITABLE_LOGIN=1; ochranou pak zůstává jen textová brána a ROLLBACK.
```

**Selhání samotné kontroly** (např. dotaz kontroly skončil chybou nebo vypršel její čas – nejvýš 15 s, nejvýš `timeoutSec`) běh také zastaví: `Kontrola oprávnění SQL loginu selhala (<databáze> na <adresa>): <chyba>. Skript se nespustil.` Výsledek se nevydá ani tehdy, když pomocník žádný výsledek kontroly nevrátí (jiná verze `ps\Run-Query.ps1` než serveru).

**Vědomé povolení.** `runQuery.allowWritableLogin = true` v `config.json` nebo proměnná `POHODA_ALLOW_WRITABLE_LOGIN` (`1` / `true` / `yes` / `on`) kontrolu nevypne, jen přestane běh odmítat. Když login opravdu smí zapisovat, nese hlavička výsledku varování

```
**POZOR: login smí zapisovat (<důvody>); ochranou zůstává jen textová brána a ROLLBACK.**
```

a audit pole `writableLogin`. Nastavení **není ve formuláři rozšíření** v Claude Desktopu – jde zadat jen proměnnou prostředí nebo souborem `config.json`; `pohoda_status` jeho hodnotu nevypisuje. Povolení platí i pro důvod `unknown`.

**Ošetření hlášení.** K modelu jdou jen české texty důvodů z tabulky. Kód, který server nezná (jiná verze pomocníka), se vypíše jako `důvod „<kód>“` – jen písmena, číslice, `_` a `-`, nejvýš 40 znaků; důvodů je nejvýš 30. Když pomocník ohlásí možnost zápisu bez důvodu, uvede se `důvod pomocník neuvedl`. Názvy dalších databází se z výsledku pomocníka oddělí hned po načtení a do odpovědi ani do auditu se nedostanou.

**Další databáze, do kterých login smí.** Kontrola zároveň spočítá databáze mimo povolené (bez systémových), do kterých se login dostane, a v kolika z nich má oprávnění zapisovat na úrovni databáze. Běh to **neblokuje**. K modelu jde jen počet (`otherDatabases`, `otherWritableDatabases` v `pohoda_status` s `probe: true`), **názvy se vypisují jen do logu serveru (stderr)** – poprvé, když nějaké jsou, a pak jen při změně jejich sady – s doporučením nechat loginu přístup jen do povolených databází. Když se seznam nepodaří zjistit, jsou oba počty `null` a běh pokračuje.

**Co kontrola nevidí a kde se může mýlit** (odvozeno z dotazu kontroly v `ps\Run-Query.ps1`):

- **Sloupcová oprávnění** (`GRANT UPDATE (Sloupec) ON …`): kontrola se ptá jen na oprávnění k celé tabulce nebo pohledu, na sloupce ne. Jak se takový grant projeví, není ověřeno – počítej s tím, že ho kontrola nezachytí.
- **Jiné typy objektů a oprávnění:** na úrovni objektů se kontrolují jen tabulky, pohledy a uložené procedury. Oprávnění k jiným objektům (funkce, sekvence, typy …) ani oprávnění udělená k jednotlivým uživatelům či loginům (`IMPERSONATE`) se samostatně nekontrolují.
- **Jen databáze daného běhu.** Podrobná kontrola (role, schémata, objekty) platí pro databázi, ke které se běh připojuje. U dalších databází se zjišťuje jen oprávnění zápisu na úrovni databáze a jen pro informaci.
- **`DENY` se nezohledňuje u rolí** – falešně pozitivní odmítnutí: člen `db_datawriter`, který je zároveň v `db_denydatawriter`, se odmítne, i když zapisovat nemůže. Řešení je odebrat roli `db_datawriter`.
- **Jiná verze SQL Serveru než 2022:** seznamy oprávnění, která „nic nemění“, jsou podle komentáře v kódu ověřené na SQL Serveru 2022. Oprávnění, které seznam nezná, vede k odmítnutí (`perm_db_other` / `perm_server_other`), název oprávnění nebo role, který nezná server, k `unknown`. Chyba je tedy na bezpečnou stranu (odmítnutí loginu, který smí jen číst), ne naopak.
- Kontrola neposuzuje, co dělají pohledy a funkce, které login smí číst.

**Stav ověření:** odmítnutí a všechny důvody pokrývají jednotkové testy s náhradou pomocníka (bez SQL Serveru); smoke test proti ukázkové databázi kontroluje jen opačný směr – že login určený ke čtení projde (`writable: false`, žádné důvody). **Odmítnutí loginu se skutečně uděleným oprávněním zápisu (`GRANT`) proti SQL Serveru zatím ověřeno není.**

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
- **Seznam databází serveru hlídá jen podle vyjmenovaných názvů** (`sys.databases`, `sys.sysdatabases`, `sys.master_files`, `sys.sysaltfiles`, `sysdatabases`, `sysaltfiles`, `HAS_DBACCESS(…)`, `DB_NAME(<argument>)`) – kdekoli v kódu, bez ohledu na velikost písmen, i v hranatých závorkách nebo uvozovkách; v řetězcích a komentářích ne. **Nepokrývá každou cestu k názvům jiných databází:** jiné systémové funkce a pohledy brána nehlídá (propustí např. `DB_ID('<název>')` nebo dynamické pohledy správy `sys.dm_…`). Pravidlo je proto jen pojistka; skutečné řešení je oprava oprávnění loginu – odebrat mu přístup do cizích databází, případně `DENY VIEW ANY DATABASE`.
- Kvůli tomu pravidlu brána odmítne i neškodný zápis: sloupec nebo alias pojmenovaný `sysdatabases` či `sysaltfiles` (i v závorkách) a dvojici `sys.databases` apod., i když `sys` je alias tabulky.

**Doporučení:** nespoléhej na bránu. Použij SQL login, který smí **jen číst a jen do povolených databází** – jinak by model mohl číst i jiné databáze na serveru, kdyby brána selhala nebo ji některý z uvedených zápisů obešel. První polovinu (jen číst) server před během kontroluje, druhou (jen povolené databáze) pouze hlásí – viz [Kontrola oprávnění SQL loginu](#kontrola-oprávnění-sql-loginu).

## Konfigurace

Volitelný `config.json` v kořeni serveru (vzor `config.example.json`) nebo soubor z `POHODA_MCP_CONFIG`; proměnné prostředí mají přednost.

| Proměnná | Význam |
|---|---|
| `POHODA_RUN_QUERY` | `1` / `true` / `yes` / `on` zapne, `0` / `false` / `no` / `off` vypne `pohoda_run_query`; jiná hodnota je chyba nastavení |
| `POHODA_SQL_SERVER` | adresa SQL serveru (výchozí `127.0.0.1,1433`) |
| `POHODA_ALLOWED_DATABASES` | povolené DB, oddělené čárkou |
| `POHODA_CREDENTIAL_FILE` | soubor Clixml s přihlášením (výchozí `<SLOŽKA>\secrets\pohoda-sql.xml`) |
| `POHODA_ALLOW_WRITABLE_LOGIN` | `1` / `true` / `yes` / `on` = neodmítat SQL login, který smí zapisovat (běh pak nese varování); `0` / `false` / `no` / `off` = odmítat (výchozí); jiná hodnota je chyba nastavení. Není ve formuláři rozšíření |
| `POHODA_RULES_MODE` | režim pravidel `full` nebo `compact` (bez ohledu na velikost písmen); **výchozí `full`**. Neplatná hodnota je jen upozornění (`configWarnings`) a použije se výchozí režim |
| `POHODA_AGENT_DIR` | jen vývoj: číst znalosti z jiné složky stejné struktury než `knowledge\` |
| `POHODA_MCP_CONFIG` | cesta k jinému `config.json` |

Pole `config.json`: `agentDir`, `auditLog`, sekce `runQuery` – `enabled` (`true`/`false`, bez uvozovek), `allowWritableLogin` (`true`/`false`, bez uvozovek; výchozí `false`), `server`, `credentialFile`, `allowedDatabases` (pole názvů), `maxRowsPerSet` (výchozí 200), `maxRowsHard` (2000; oba nejvýš 100 000), `maxChars` (60 000, nejvýš 1 000 000), `timeoutSec` (60, nejvýš 600) – a sekce `rules` s polem `mode` (`"full"` / `"compact"`).

**Nastavení je striktní a při chybě se zavírá (fail closed).** Každá chybná hodnota – neplatný JSON nebo nečitelný `config.json`, špatný typ, číslo mimo rozsah, `maxRowsPerSet` větší než `maxRowsHard`, neplatná adresa serveru, **středník v názvu databáze v poli `allowedDatabases`** (každá databáze musí být samostatná položka pole), neznámá hodnota `POHODA_RUN_QUERY` nebo `POHODA_ALLOW_WRITABLE_LOGIN` – se zapíše do `configErrors`, nahradí se výchozí hodnotou a **spouštění dotazů se vypne**, dokud chybu neopravíš a server nespustíš znovu. Chyby jsou vidět v `pohoda_status` a v logu serveru (stderr). Chybějící `config.json` chyba není. Prázdná proměnná nebo nevyplněný zástupný text z manifestu (`${user_config.…}`) se bere jako nenastavená; u `POHODA_RUN_QUERY` znamená zástupný text **vypnuto** a u `POHODA_ALLOW_WRITABLE_LOGIN` **zakázáno**.

Výjimka je nastavení, které se spouštění dotazů netýká – **režim pravidel**: neplatná hodnota `POHODA_RULES_MODE` nebo `rules.mode` (i `rules`, které není objekt) se zapíše do `configWarnings`, použije se výchozí režim a spouštění zůstává zapnuté. Proměnná `POHODA_ALLOWED_DATABASES` se dělí na čárce i středníku.

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

## Měření kvality (zlaté testy přes MCP)

Runner `eval/run-golden-mcp.mjs` (`npm run golden`) měří, jestli asistent **jen s nástroji tohoto serveru** napíše správné SQL a dodrží postup. Pro každý test spustí Claude Code v neinteraktivním režimu (`claude -p`) s dočasnou konfigurací MCP, zadá mu otázku, uloží celý průběh a vyhodnotí ho proti očekávaným hodnotám. Slouží k porovnání verzí serveru, znalostí, modelů a režimů pravidel (`full` proti `compact`).

**Nároky:**

- Claude Code CLI (`claude`) v PATH nebo v `~/.local/bin`, přihlášený; běh je **placený** – v dosavadních bězích vyšel jeden test na 0,29–0,38 USD (orientačně ~0,3 USD), strop na test určuje `--max-budget-usd`,
- snímek `knowledge\`, dosažitelný SQL Server s ukázkovou databází a soubor s přihlášením (runner ho nečte, jen ověří, že existuje, a předá serveru cestu),
- soubor s testy **`golden.md`, který není součástí repozitáře** – cesta se zadává volbou `--golden`.

```powershell
# všechny testy nad modelovou databází
npm run golden -- --golden <cesta>\golden.md --credential <SLOŽKA>\secrets\pohoda-sql.xml
# vybrané testy, kompaktní režim pravidel, popis běhu do reportu
node eval/run-golden-mcp.mjs --golden <cesta>\golden.md --credential <soubor> --id T1,T2 --rules-mode compact --label "compact"
# znovu vyhodnotit uložený běh (agent se nespouští, nic nestojí)
node eval/run-golden-mcp.mjs --golden <cesta>\golden.md --znovu eval/results/<běh>
```

| Volba | Význam |
|---|---|
| `--golden <soubor>` | soubor s testy; **povinné vždy**, i se `--znovu` |
| `--id T1,T2` | jen vybrané testy. Výchozí: všechny testy **bez řádku `**DB:**`**, tedy nad modelovou databází; test nad jinou databází se spustí jen výslovným výčtem |
| `--credential <soubor>` | soubor Export-Clixml s přihlášením k SQL (nebo proměnná `POHODA_CREDENTIAL_FILE`); u nového běhu povinné |
| `--database <název>` | databáze běhu (výchozí `StwPh_12345678_2026`) |
| `--rules-mode full\|compact` | předá se serveru jako `POHODA_RULES_MODE`; bez volby platí výchozí režim serveru |
| `--model <model>` | model pro `claude -p` (výchozí podle klienta) |
| `--effort <úroveň>` | `low` / `medium` / `high` / `xhigh` / `max` |
| `--parallel <n>` | počet souběžných testů 1–6 (výchozí 3) |
| `--max-budget-usd <n>` | strop ceny na jeden test (výchozí 3) |
| `--timeout-min <n>` | časový limit jednoho testu v minutách (výchozí 15) |
| `--label <text>` | popis běhu do reportu |
| `--clean on\|off` | čisté prostředí agenta (výchozí `on`), viz níže |
| `--out <složka>` | kam uložit výsledky (výchozí `eval/results`); běh si v ní založí podsložku s časem |
| `--znovu <složka>` | znovu vyhodnotit uložené výstupy běhu |
| `--help` | nápověda |

Volby lze psát i jako `--volba=hodnota`. Neznámá volba nebo hodnota mimo rozsah je chyba a běh nezačne.

**Formát `golden.md`.** Každý test je sekce `## T<číslo> – <název>` s řádky:

| Řádek | Význam |
|---|---|
| `**Otázka:**` | zadání pro asistenta (odstavec); test bez otázky runner odmítne spustit |
| `**Kontrola:**` | očekávané hodnoty: skupiny oddělené `;` musí být nalezeny **všechny**, z alternativ oddělených `\|` stačí jedna. Zápisový test: `ZAPIS <tabulky>` (např. `ZAPIS FApol FA`) |
| `**Obsahuje:**` | regulární výrazy oddělené ` ;; `, které musí výsledný skript obsahovat (hledá se v kódu bez komentářů a řetězců) |
| `**DB:**` | volitelně jiná databáze než výchozí |
| `**Známá hodnota:**`, `**Musí:**` | jen do reportu, k ručnímu posouzení |

**Jak běh probíhá.**

- Server se spustí z tohoto projektu se zapnutým spouštěním, **jedinou povolenou databází** (databáze běhu, u testu s `**DB:**` jeho databáze) a s `POHODA_MCP_CONFIG` mířícím na neexistující soubor, takže místní `config.json` výsledek neovlivní. Proměnné `POHODA_*` z okolí se agentovi nepředávají.
- **Před prvním placeným testem** se runner zeptá serveru na `pohoda_status` a skončí chybou, když server nenaběhne, hlásí chyby nastavení, má vypnuté spouštění nebo běží v jiném režimu pravidel, než byl zadán.
- Agent běží v prázdné dočasné složce a smí volat jen nástroje serveru (`--strict-mcp-config`, `--allowedTools mcp__pohoda-sql`, `--permission-mode dontAsk`, `--no-session-persistence`). Zadání říká, že jde o automatický běh bez doplňujících otázek, že čtecí dotaz má rovnou pustit a zápisový skript jen napsat a zkontrolovat; u jiné než modelové databáze žádá jen agregáty bez názvů partnerů.
- **Čisté prostředí (`--clean on`)** přidá volby `--tools ""` (žádné vestavěné nástroje klienta), `--disable-slash-commands` (žádné skills a příkazy z profilu a pluginů) a `--setting-sources project,local` (nenačte se uživatelské nastavení – pluginy, hooky, výchozí model; přihlášení zůstává). Skutečný stav ukazuje řádek „Prostředí agenta“ v reportu: počty vestavěných nástrojů, nástrojů MCP, pluginů, skills, příkazů, agentů a hooků podle úvodní zprávy klienta. V dosavadním běhu s čistým prostředím to bylo 0 vestavěných nástrojů, 6 nástrojů MCP, 0 skills a 0 hooků; pluginy, příkazy a agenty klient přesto nějaké hlásil – ber ten řádek jako měření, ne jako záruku nul. `--clean off` tyto volby vynechá.
- Po běhu runner ukončí zbylé procesy, smaže dočasnou složku a po klientovi uklidí jen prázdné složky projektu, které k ní patří. Při přerušení (Ctrl+C) zapíše report z toho, co stihlo začít.

**Co se vyhodnocuje.**

- **Stav testu:** `PROŠLO`, `ČÁSTEČNĚ`, `NEPROŠLO`, `CHYBA AGENTA` (časový limit, agent nevrátil výsledek nebo skončil chybou, server se nepřipojil), `BEZ KONTROLY` (test nemá řádek Kontrola).
- **Shoda hodnot** (čtecí test). Hodnota v řádku Kontrola je číslo nebo text; text se hledá jako celá hodnota buňky výsledku nebo jako výskyt v odpovědi (bez ohledu na velikost písmen a mezery). Čísla se píší česky (desetinná čárka, mezery mezi tisíci) a porovnávají s tolerancí ±0,005; bez znaménka se porovnává absolutní hodnota. Hodnoty se berou z **posledního úspěšného** `pohoda_run_query` (dřívější běhy jsou pokusy) – buňky, součty číselných sloupců nezkrácené tabulky, zprávy PRINT, počet řádků posledního result setu – a z textu odpovědi. Report rozlišuje shodu doloženou výsledkem nástroje od shody jen v textu odpovědi a upozorní, když je hodnota jen v dřívějším běhu.
- **Pravidla proti falešným shodám:** z odpovědi se před hledáním čísel odstraní bloky kódu, data, procenta a číslování seznamů; celá čísla pod 1000 (počty) se z výsledku nástroje neberou z textových buněk (`FV-2026-0014`), ze sloupců `ID` / `Ref*` / `Rel*` ani ze součtů sloupců. Plná shoda bez jediného úspěšného běhu dotazu je jen `ČÁSTEČNĚ`; čtecí otázka, na kterou asistent odpoví zapisujícím skriptem, je `NEPROŠLO`.
- **Zápisový test:** výsledný skript musí zapisovat právě do očekávaných trvalých tabulek (cíle `INSERT` / `UPDATE` / `DELETE` / `MERGE` / `SELECT INTO`; aliasy a CTE se převádějí na tabulku, dočasné tabulky se nepočítají), musí projít `pohoda_check_query` s výsledkem 0 a `pohoda_run_query` nesmí být použito na zapisující skript. Jinak `ČÁSTEČNĚ`, bez zapisujícího skriptu `NEPROŠLO`.
- **Výsledný skript:** poslední blok SQL z odpovědi, pokud ho asistent také zkontroloval nebo spustil; jinak poslední skript, který prošel kontrolou a úspěšně běžel; jinak poslední odeslaný skript. Chybějící vzor z řádku Obsahuje sníží `PROŠLO` na `ČÁSTEČNĚ`.
- **Metriky postupu:** zda první volání bylo `pohoda_rules` bez `section` a `search` („Rules první“), zda každému `pohoda_run_query` předcházelo `pohoda_check_query` („Check před run“) a kolik běhů pustilo skript, který kontrolou neprošel, počty volání jednotlivých nástrojů a jejich chyb, co si asistent z pravidel načetl (jádro, kapitoly, sekce, hledání) a kolik to bylo znaků, cena v USD, počet tahů a čas.

**Výstup** je ve složce `eval/results/<čas běhu>/` (složka `eval/results/` je v `.gitignore`):

| Soubor | Obsah |
|---|---|
| `meta.json` | údaje o běhu (databáze, režim pravidel podle `pohoda_status`, verze serveru a klienta, volby); zapisuje se hned na začátku, aby šel vyhodnotit i přerušený běh |
| `report.md` | hlavička běhu, souhrn, tabulka testů a kritéria „Musí“ k ručnímu posouzení |
| `souhrn.json` | totéž strojově (meta, souhrn, výsledky testů) |
| `<Tn>/stream.jsonl` | celý průběh agenta (výstup `stream-json`), zapisuje se průběžně |
| `<Tn>/odpoved.md`, `<Tn>/sql.sql`, `<Tn>/vyhodnoceni.json` | odpověď asistenta, výsledný skript, vyhodnocení testu |
| `<Tn>/agent-stderr.txt`, `<Tn>/beh.json` | chybový výstup klienta; návratový kód, doba a příznak časového limitu |

**`--znovu <složka běhu>`** agenta nespouští: znovu vyhodnotí uložené `stream.jsonl` (bez `--id` všechny testy, které výstup mají) a přepíše report, souhrn a vyhodnocení. Hodí se po změně pravidel vyhodnocení nebo souboru s testy. Databázi bere z uložených údajů běhu; u běhu bez nich je nutné ji zadat (`--database`).

**Ochrana dat u jiné než modelové databáze.** V `report.md`, `souhrn.json` a `vyhodnoceni.json` se u takového testu neuvádí otázka, známé hodnoty ani očekávané hodnoty – jen pořadí skupin (`#1`, `#2`) a počty. **`stream.jsonl`, `odpoved.md` a `sql.sql` ale obsahují průběh a odpověď v plném znění, tedy i skutečná data.** Název testu, řádek `**Musí:**` a vzory z řádku `**Obsahuje:**` se do reportu vypisují i u takového testu – skutečné hodnoty do nich nepiš. Výsledky takového běhu nikam nekopíruj a nezveřejňuj.

## CI a repozitář

- **`.github/workflows/ci.yml`** běží při `push` do větve `main` a u pull requestů do `main`, na `windows-latest`, pro Node 18, 20 a 22 (všechny tři verze doběhnou, i když jedna selže). Kroky: `npm ci`, `npm test` a kontrola zdrojů – každý `ps\*.ps1` a `scripts\*.ps1` musí projít parserem PowerShellu a obsahovat **jen znaky ASCII** (PowerShell 5.1 čte soubor bez BOM jako Windows-1250), každý `src\*.js`, `eval\*.mjs` a `test\*.js` musí projít `node --check`. Smoke test ani nic, co potřebuje SQL Server nebo snímek `knowledge\`, v CI neběží. Workflow má jen právo číst obsah repozitáře. **Na GitHubu zatím neběželo – neověřeno.**
- **`.github/dependabot.yml`** – návrhy aktualizací závislostí npm (týdně) a akcí GitHub Actions (měsíčně).
- **`.gitattributes`** – všechny textové soubory včetně `*.ps1` mají v repozitáři i v pracovní kopii konce řádků LF (`*.png` a `*.mcpb` jsou binární). Důvod: bez toho by Git na Windows při `core.autocrlf=true` převedl soubory na CRLF a testy, které čtou vzorové soubory z `test\fixtures`, by na Windows a v CI pracovaly s jinými konci řádků.

## Testy

```powershell
npm test                 # jen jednotkové testy: brána SQL, konfigurace, čtení znalostí (hledání, schémata, nápověda, sekce pravidel), formát výsledků, kontrola loginu a audit, vyhodnocení zlatých testů
npm run smoke            # = node test/smoke.js: server přes stdio, všechny nástroje, zapnuté i vypnuté spouštění, kompaktní režim pravidel
npm run golden -- …      # placené měření kvality přes claude -p, viz oddíl Měření kvality
```
`npm test` spouští výslovně pět souborů (`test/sqlgate.test.js`, `config.test.js`, `knowledge.test.js`, `exec.test.js`, `golden-lib.test.js`) – nyní **162 testů**; nepotřebuje `knowledge\`, SQL Server ani přihlášení. Čtení znalostí zkouší nad malou vymyšlenou sadou `test\fixtures\knowledge-mini`, kontrolu loginu a běh dotazu s náhradou PowerShell pomocníka, vyhodnocení zlatých testů nad vymyšlenými výstupy. Dva akceptační testy brány navíc procházejí skripty agenta (jeho složky `dotazy\_analyza` a `tests\vysledky`); když složka agenta neexistuje, přeskočí se. Vyžaduje Node ≥ 18.13 (hooky `after` v `node:test`: globální od 18.8, `t.after` od 18.13).

`npm run smoke` potřebuje snímek `knowledge\`. Server spouští s izolovaným prostředím (proměnné `POHODA_*` z okolí se nepřebírají, kromě `POHODA_CREDENTIAL_FILE`) třikrát:

1. **zapnuté spouštění** (6 nástrojů): anotace nástrojů, instrukce a prompt, stav, pravidla (jádro, kapitola, `section`, `search`, obojí současně = chyba, výchozí režim pravidel), schémata, nápověda, kontrola dotazu, odmítnutí odkazů na seznam databází bránou;
2. **vypnuté spouštění** (5 nástrojů bez `pohoda_run_query`): instrukce o běhu nemluví, `pohoda_status` s `probe: true` vrátí `loginProbe.error`;
3. **kompaktní režim pravidel** (`POHODA_RULES_MODE=compact`): `rulesMode`, kratší jádro s rejstříkem, načtení sekce mimo kompaktní sadu.

Ověřuje také, že snímek obsahuje jen schémata `obecny` a `sk`, že v něm nezbyl název databáze reálné firmy (stejný vzor jako `Test-Snapshot.ps1`) a že pokusy o únik mimo `knowledge\` (`..\..\x`) končí chybou.
Kontroly nad databází běží jen proti modelové DB a jen když existuje soubor s přihlášením (`POHODA_CREDENTIAL_FILE` nebo `secrets\pohoda-sql.xml`), jinak se přeskočí:

- **kontrola loginu** (`pohoda_status` s `probe: true`; přeskočí se také, když SQL Server neodpovídá): `loginProbe` má přesně pole `database`, `writable`, `reasons`, `otherDatabases`, `otherWritableDatabases`, login smí jen číst (`writable: false`, žádné důvody – **s loginem, který smí zapisovat, tedy smoke test neprojde**), v odpovědi není název databáze reálné firmy, nepovolená databáze dá `loginProbe.error`;
- **`pohoda_run_query`**: výsledek s diakritikou, potvrzený ROLLBACK v hlavičce, vzor rozvahy z golden testu T19 (výsledek 2 983 375,54; je v `test\fixtures\`), odmítnutí zápisu, odkazu mimo databázi a nepovolené databáze, chyba SQL jako chyba nástroje.

## Stav ověření

| Co | Stav |
|---|---|
| Claude Desktop (`.mcpb`) | verze 0.3.0 nainstalována a funguje (ověřil uživatel); verze 0.3.1 v Claude Desktopu zatím neověřena |
| Claude Code (`claude -p`) | ověřeno: otázka z golden testu T1 → 1 766 656,00 Kč, 14 faktur; stejnou cestou běží i runner zlatých testů |
| Codex | konfigurace přijata (`codex mcp get`), spuštění přes Codex zatím neověřeno |
| SQL Server | jen smoke test proti ukázkové (modelové) databázi; dotaz kontroly loginu je podle komentáře v kódu ověřen na SQL Serveru 2022, jiné verze neověřeny |
| Odmítnutí zapisujícího loginu | jen jednotkové testy (náhrada pomocníka); se skutečným `GRANT` proti SQL Serveru neověřeno |
| Režim pravidel `compact` | změřeno na 22 zlatých testech (jeden běh každého režimu, model Sonnet): stejná úspěšnost jako `full` (20 PROŠLO, 2 ČÁSTEČNĚ), cena o 19 % nižší; u zápisu s DPH (T10) o něco méně důkladný; malý vzorek, výchozí zůstává `full` |
| CI na GitHubu | workflow je v repozitáři, na GitHubu zatím neběželo – neověřeno |

## Struktura repozitáře

```
src/server.js        registrace nástrojů, prompt
src/instructions.js  instrukce serveru a text promptu (podle toho, zda je zapnuté spouštění, a podle režimu pravidel)
src/knowledge.js     čtení pravidel (jádro, kapitoly, sekce, hledání, kompaktní jádro), schématu a nápovědy ze složky knowledge\
src/sqlgate.js       textová brána pro run_query
src/exec.js          volání PowerShell pomocníků, vyhodnocení kontroly loginu, formát výsledku, audit
src/config.js        konfigurace (striktní, fail closed)
ps/                  Run-Query.ps1 (kontrola oprávnění loginu, SQL běh, Import-Clixml, ROLLBACK), Check-Query.ps1 (obálka nad kontrolou dotazu)
scripts/             Sync-Knowledge.ps1 (snímek znalostí), Test-Snapshot.ps1 (kontrola úniku), Pack-Mcpb.ps1 (balíček)
eval/                run-golden-mcp.mjs (runner zlatých testů přes MCP, npm run golden), golden-lib.mjs (čisté funkce vyhodnocení), results/ (výstupy běhů, nejsou v gitu)
.github/             workflows/ci.yml (testy a kontrola zdrojů na Windows, Node 18/20/22), dependabot.yml
.gitattributes       konce řádků LF pro textové soubory
manifest.json        popis balíčku .mcpb (formulář nastavení v Claude Desktopu)
config.example.json  vzor volitelného config.json
knowledge/           snímek znalostí (negeneruje se do gitu)
test/                sqlgate.test.js, config.test.js, knowledge.test.js, exec.test.js, golden-lib.test.js (npm test), smoke.js (npm run smoke), fixtures/
```

## Licence a upozornění

- Projekt **není oficiálním produktem společnosti STORMWARE s.r.o.**; POHODA je jejím produktem a ochrannou známkou.
- Uživatelská nápověda programu POHODA, která je součástí balíčku z Releases, je dílem společnosti STORMWARE s.r.o.; práva k ní zůstávají jejímu autorovi.
  Není součástí zdrojových souborů v tomto repozitáři.
- Zdrojový kód je vydán pod licencí [MIT](LICENSE). Licence se vztahuje na soubory tohoto repozitáře; **nevztahuje se na uživatelskou nápovědu programu POHODA** obsaženou v balíčku z Releases.
- Server posílá výsledky dotazů AI asistentovi; za volbu povolených databází a za nakládání s daty odpovídá uživatel.
