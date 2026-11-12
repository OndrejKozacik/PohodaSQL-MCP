<#
.SYNOPSIS
    Spusti T-SQL skript na lokalni Pohoda DB v transakci, ktera se VZDY vrati (ROLLBACK), a vysledek ulozi jako JSON (UTF-8).
.DESCRIPTION
    Pomocnik pro MCP server pohoda-mcp. Heslo se cte primo tady (Import-Clixml, DPAPI) a nikdy neopousti tento proces.
    Stejne principy jako dotazy\_analyza\qdb.ps1 a tests\Run-GoldenTests.ps1: dava se GO jako oddelovac davek, vsechny result sety,
    PRINT zpravy. Vystup: JSON do -OutFile (hodnoty uz formatovane jako text, NULL = null). ASCII-only zdroj (PS 5.1).
    rolledBack v JSON: true = Rollback() probehl, false = selhal (text v rollbackError), null = transakce vubec nezacala.
    Pred skriptem uzivatele bezi na stejnem spojeni kontrola opravneni loginu (preflight, nic nezapisuje): login = { writable,
    reasons (kody duvodu, cesky text doplni src\exec.js), otherDatabases (pocet dalsich dostupnych DB mimo -AllowedDatabases,
    null = nepodarilo se zjistit), otherWritableDatabases (v kolika z nich ma login zapisove opravneni na urovni databaze,
    null = nezjisteno), otherDatabaseNames a otherWritableDatabaseNames (jen pro log serveru, nikdy pro model) }. Kdyz login smi
    zapisovat a neni -AllowWritableLogin, skript uzivatele se vubec nespusti: { ok:false, loginRefused:true, login }.
    -Probe = jen kontrola loginu. stage v JSON chyby: connect / preflight / run - kde beh skoncil; kdyz uz kontrola loginu
    probehla, nese i JSON chyby jeji vysledek (login).
#>
param(
    [string]$SqlFile,
    [Parameter(Mandatory)][string]$Database,
    [Parameter(Mandatory)][string]$OutFile,
    [Parameter(Mandatory)][string]$CredentialFile,
    [string]$Server = '127.0.0.1,1433',
    [int]$MaxRowsPerSet = 200,
    [int]$TimeoutSec = 60,
    # povolene databaze oddelene strednikem (pole se pres powershell -File predat neda)
    [string]$AllowedDatabases = '',
    [switch]$AllowWritableLogin,
    [switch]$Probe
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$inv = [Globalization.CultureInfo]::InvariantCulture
function Save([object]$o) { [IO.File]::WriteAllText($OutFile, ($o | ConvertTo-Json -Depth 8 -Compress), $utf8) }
function Fmt($v) {
    if ($null -eq $v -or $v -is [DBNull]) { return $null }
    if ($v -is [string]) { return ($v -replace '\r\n|\r|\n', ' ') }
    # decimal si nese meritko z SQL (25.10 zustane 25.10); zadne zaokrouhlovani
    if ($v -is [decimal]) { return $v.ToString($inv) }
    if ($v -is [double] -or $v -is [single]) { return $v.ToString('R', $inv) }
    # zlomky sekundy jen kdyz nejsou nulove (F = bez koncovych nul, pri nule zmizi i tecka)
    if ($v -is [datetime]) { return $v.ToString('yyyy-MM-dd HH:mm:ss.FFFFFFF', $inv) }
    if ($v -is [DateTimeOffset]) { return $v.ToString('yyyy-MM-dd HH:mm:ss.FFFFFFF zzz', $inv) }
    if ($v -is [byte[]]) {
        $n = [Math]::Min($v.Length, 16)
        $hex = '0x' + [BitConverter]::ToString($v, 0, $n).Replace('-', '')
        if ($v.Length -gt 16) { $hex += '... (' + $v.Length + ' B)' }
        return $hex
    }
    return (([string]$v) -replace '\r\n|\r|\n', ' ')
}
# Radek GO jako oddelovac davek: GO, GO; i GO -- komentar. Musi odpovidat RE_GO_LINE v src\sqlgate.js.
function SplitBatches([string]$sql) {
    return @([regex]::Split($sql, '(?im)^[ \t]*GO[ \t]*;?[ \t]*(?:--[^\n]*)?\r?$') | Where-Object { $_.Trim() })
}
# Precte vsechny result sety z readeru do $sets (nejvys $max radku na set, total = skutecny pocet).
function ReadSets($rd, $sets, [int]$max) {
    do {
        $n = $rd.FieldCount
        if ($n -gt 0) {
            # [object[]]::new, ne New-Object: ten pole obali PSObjectem a ConvertTo-Json pak vypise {value,Count}
            $cols = [object[]]::new($n)
            for ($i = 0; $i -lt $n; $i++) { $cols[$i] = $rd.GetName($i) }
            $rows = New-Object System.Collections.Generic.List[object]
            $total = 0
            $v = [object[]]::new($n)
            while ($rd.Read()) {
                $total++
                if ($rows.Count -lt $max) {
                    [void]$rd.GetValues($v)
                    $row = [object[]]::new($n)
                    for ($i = 0; $i -lt $n; $i++) { $row[$i] = Fmt $v[$i] }
                    $rows.Add($row)
                }
            }
            $sets.Add([ordered]@{ cols = $cols; rows = $rows.ToArray(); total = $total })
        }
    } while ($rd.NextResult())
}
# Smi login zapisovat? Pocita se na serveru, jen cteni metadat, zadne docasne objekty. Kazdy nalez = kod duvodu; jakykoli duvod
# = writable. Kontrola, kterou nejde vyhodnotit (funkce vrati NULL), NENI "nezapisuje": hlasi se kodem unknown a beh se
# odmitne (fail closed). Overeno na SQL Serveru 2022: NULL vraci nazev opravneni nebo role, ktery server nezna (napr. jina
# verze serveru); nenalezena databaze, schema nebo objekt vraci 0, ne NULL.
# 1) serverove a databazove role, opravneni na urovni databaze (HAS_PERMS_BY_NAME nad QUOTENAME(DB_NAME())),
# 2) vse ostatni, co login na urovni databaze a serveru ma (sys.fn_my_permissions) mimo seznam opravneni, ktera nic nemeni.
#    Seznam zavisi na verzi SQL Serveru (overeno na SQL Server 2022): opravneni, ktere seznam nezna, vede k odmitnuti
#    (perm_db_other / perm_server_other) - to je bezpecny smer; neskodne opravneni se pak do seznamu doplni.
# 3) granty na urovni schematu a objektu, ktere kontrola na urovni databaze nevidi (GRANT INSERT ON SCHEMA::dbo,
#    GRANT UPDATE ON dbo.FA, GRANT EXECUTE ON procedura). Schemata vlastnena pevnymi rolemi (db_datareader, ...) se
#    vynechavaji: clen role ma nad stejnojmennym schematem CONTROL a odmitl by se i login jen pro cteni.
$PreflightSql = @'
SET NOCOUNT ON;
DECLARE @r varchar(1000), @u int, @v int, @db nvarchar(300);
SET @r = ''; SET @u = 0; SET @db = QUOTENAME(DB_NAME());
SET @v = IS_SRVROLEMEMBER('sysadmin'); IF @v = 1 SET @r = @r + 'sysadmin;'; IF @v IS NULL SET @u = 1;
SET @v = HAS_PERMS_BY_NAME(NULL, NULL, 'CONTROL SERVER'); IF @v = 1 SET @r = @r + 'control_server;'; IF @v IS NULL SET @u = 1;
SET @v = IS_MEMBER('db_owner'); IF @v = 1 SET @r = @r + 'db_owner;'; IF @v IS NULL SET @u = 1;
SET @v = IS_MEMBER('db_datawriter'); IF @v = 1 SET @r = @r + 'db_datawriter;'; IF @v IS NULL SET @u = 1;
SET @v = IS_MEMBER('db_ddladmin'); IF @v = 1 SET @r = @r + 'db_ddladmin;'; IF @v IS NULL SET @u = 1;
SET @v = IS_MEMBER('db_securityadmin'); IF @v = 1 SET @r = @r + 'db_securityadmin;'; IF @v IS NULL SET @u = 1;
SET @v = IS_MEMBER('db_accessadmin'); IF @v = 1 SET @r = @r + 'db_accessadmin;'; IF @v IS NULL SET @u = 1;
SET @v = HAS_PERMS_BY_NAME(@db, 'DATABASE', 'INSERT'); IF @v = 1 SET @r = @r + 'perm_INSERT;'; IF @v IS NULL SET @u = 1;
SET @v = HAS_PERMS_BY_NAME(@db, 'DATABASE', 'UPDATE'); IF @v = 1 SET @r = @r + 'perm_UPDATE;'; IF @v IS NULL SET @u = 1;
SET @v = HAS_PERMS_BY_NAME(@db, 'DATABASE', 'DELETE'); IF @v = 1 SET @r = @r + 'perm_DELETE;'; IF @v IS NULL SET @u = 1;
SET @v = HAS_PERMS_BY_NAME(@db, 'DATABASE', 'ALTER'); IF @v = 1 SET @r = @r + 'perm_ALTER;'; IF @v IS NULL SET @u = 1;
SET @v = HAS_PERMS_BY_NAME(@db, 'DATABASE', 'CONTROL'); IF @v = 1 SET @r = @r + 'perm_CONTROL;'; IF @v IS NULL SET @u = 1;
IF EXISTS (SELECT 1 FROM sys.fn_my_permissions(NULL, 'DATABASE') WHERE permission_name NOT IN ('CONNECT','SELECT','REFERENCES','SHOWPLAN','VIEW DEFINITION','VIEW DATABASE STATE','VIEW DATABASE PERFORMANCE STATE','VIEW DATABASE SECURITY STATE','VIEW PERFORMANCE DEFINITION','VIEW SECURITY DEFINITION','VIEW ANY COLUMN ENCRYPTION KEY DEFINITION','VIEW ANY COLUMN MASTER KEY DEFINITION','VIEW CHANGE TRACKING','VIEW LEDGER CONTENT')) SET @r = @r + 'perm_db_other;';
IF EXISTS (SELECT 1 FROM sys.fn_my_permissions(NULL, 'SERVER') WHERE permission_name NOT IN ('CONNECT SQL','VIEW ANY DATABASE','VIEW ANY DEFINITION','VIEW SERVER STATE','VIEW SERVER PERFORMANCE STATE','VIEW SERVER SECURITY STATE','VIEW ANY PERFORMANCE DEFINITION','VIEW ANY SECURITY DEFINITION','VIEW ANY ERROR LOG')) SET @r = @r + 'perm_server_other;';
IF EXISTS (SELECT 1 FROM sys.schemas AS s JOIN sys.database_principals AS p ON p.principal_id = s.principal_id CROSS APPLY (SELECT QUOTENAME(s.name) AS n) AS x WHERE p.is_fixed_role = 0 AND s.name NOT IN ('sys','INFORMATION_SCHEMA') AND (HAS_PERMS_BY_NAME(x.n,'SCHEMA','INSERT')=1 OR HAS_PERMS_BY_NAME(x.n,'SCHEMA','UPDATE')=1 OR HAS_PERMS_BY_NAME(x.n,'SCHEMA','DELETE')=1 OR HAS_PERMS_BY_NAME(x.n,'SCHEMA','ALTER')=1 OR HAS_PERMS_BY_NAME(x.n,'SCHEMA','EXECUTE')=1)) SET @r = @r + 'schema_write;';
IF EXISTS (SELECT 1 FROM sys.schemas AS s JOIN sys.database_principals AS p ON p.principal_id = s.principal_id WHERE p.is_fixed_role = 0 AND s.name NOT IN ('sys','INFORMATION_SCHEMA') AND HAS_PERMS_BY_NAME(QUOTENAME(s.name),'SCHEMA','INSERT') IS NULL) SET @u = 1;
IF EXISTS (SELECT 1 FROM sys.objects AS o CROSS APPLY (SELECT QUOTENAME(SCHEMA_NAME(o.schema_id)) + '.' + QUOTENAME(o.name) AS n) AS x WHERE o.is_ms_shipped = 0 AND o.type IN ('U','V') AND (HAS_PERMS_BY_NAME(x.n,'OBJECT','INSERT')=1 OR HAS_PERMS_BY_NAME(x.n,'OBJECT','UPDATE')=1 OR HAS_PERMS_BY_NAME(x.n,'OBJECT','DELETE')=1 OR HAS_PERMS_BY_NAME(x.n,'OBJECT','ALTER')=1)) SET @r = @r + 'object_write;';
IF EXISTS (SELECT 1 FROM sys.objects AS o WHERE o.is_ms_shipped = 0 AND o.type IN ('U','V') AND HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id)) + '.' + QUOTENAME(o.name),'OBJECT','INSERT') IS NULL) SET @u = 1;
IF EXISTS (SELECT 1 FROM sys.objects AS o WHERE o.is_ms_shipped = 0 AND o.type IN ('P','PC','X') AND HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id)) + '.' + QUOTENAME(o.name),'OBJECT','EXECUTE') = 1) SET @r = @r + 'proc_execute;';
IF EXISTS (SELECT 1 FROM sys.objects AS o WHERE o.is_ms_shipped = 0 AND o.type IN ('P','PC','X') AND HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id)) + '.' + QUOTENAME(o.name),'OBJECT','EXECUTE') IS NULL) SET @u = 1;
IF @u = 1 SET @r = @r + 'unknown;';
SELECT CAST(CASE WHEN @r = '' THEN 0 ELSE 1 END AS bit) AS writable, @r AS reasons;
'@
# Kontrola opravneni loginu. Chyba prvniho dotazu = vyjimka (skript uzivatele se nespusti); seznam dalsich databazi je jen
# informace: kdyz se nepodari zjistit, otherDatabases i otherWritableDatabases = null. U dalsich databazi se zjistuje jen
# zapisove opravneni na urovni databaze (INSERT/UPDATE/DELETE/ALTER/CONTROL), ne granty na schema a objekty uvnitr nich.
# Nazvy povolenych DB jdou jako parametry dotazu (zadne skladani do textu SQL; nezavisi na STRING_SPLIT ani na urovni
# kompatibility databaze). $budgetSec = spolecny strop casu obou dotazu, at kontrola neukrajuje cas skriptu uzivatele.
function Preflight($cn, [string[]]$allowed, [int]$budgetSec) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $cmd = $cn.CreateCommand(); $cmd.CommandTimeout = [Math]::Max(1, $budgetSec); $cmd.CommandText = $PreflightSql
    $rd = $cmd.ExecuteReader()
    try {
        if (-not $rd.Read()) { throw 'Kontrola loginu nevratila zadny radek.' }
        $writable = [bool]$rd.GetValue(0)
        $codes = [string]$rd.GetValue(1)
    } finally { $rd.Close() }
    $reasons = [string[]]@($codes.Split(';') | Where-Object { $_ })
    $count = $null
    $wcount = $null
    $names = New-Object System.Collections.Generic.List[string]
    $wnames = New-Object System.Collections.Generic.List[string]
    try {
        # CommandTimeout 0 = bez limitu, proto nejmene 1 s
        $cmd = $cn.CreateCommand(); $cmd.CommandTimeout = [Math]::Max(1, $budgetSec - [int][Math]::Ceiling($sw.Elapsed.TotalSeconds))
        $hp = 'HAS_PERMS_BY_NAME(QUOTENAME(d.name), ''DATABASE'', '
        $q = 'SELECT d.name, CAST(CASE WHEN ' + $hp + '''INSERT'') = 1 OR ' + $hp + '''UPDATE'') = 1 OR ' + $hp + '''DELETE'') = 1 OR ' +
            $hp + '''ALTER'') = 1 OR ' + $hp + '''CONTROL'') = 1 THEN 1 ELSE 0 END AS int) AS w' +
            ' FROM sys.databases AS d WHERE d.database_id > 4 AND HAS_DBACCESS(d.name) = 1 AND d.name <> DB_NAME()'
        $ph = New-Object System.Collections.Generic.List[string]
        for ($i = 0; $i -lt $allowed.Length; $i++) {
            $ph.Add('@p' + $i)
            $p = $cmd.Parameters.Add('@p' + $i, [System.Data.SqlDbType]::NVarChar, 128)
            $p.Value = $allowed[$i]
        }
        if ($ph.Count -gt 0) { $q += ' AND d.name NOT IN (' + ($ph -join ', ') + ')' }
        $cmd.CommandText = $q + ' ORDER BY d.name'
        $rd = $cmd.ExecuteReader()
        try {
            while ($rd.Read()) {
                $n = [string]$rd.GetValue(0)
                $names.Add($n)
                if ([int]$rd.GetValue(1) -eq 1) { $wnames.Add($n) }
            }
        } finally { $rd.Close() }
        $count = $names.Count
        $wcount = $wnames.Count
    } catch { $count = $null; $wcount = $null; $names.Clear(); $wnames.Clear() }
    return [ordered]@{
        writable = $writable; reasons = $reasons; otherDatabases = $count; otherWritableDatabases = $wcount
        otherDatabaseNames = $names.ToArray(); otherWritableDatabaseNames = $wnames.ToArray()
    }
}
$rolledBack = $null
$rollbackError = $null
$stage = 'connect'
$login = $null
$refused = $false
$batchNo = 0
$batchCount = 0
try {
    $batches = @()
    if (-not $Probe) {
        if (-not $SqlFile) { throw 'Chybi parametr -SqlFile.' }
        $sql = [IO.File]::ReadAllText($SqlFile, [Text.Encoding]::UTF8)
        $batches = @(SplitBatches $sql)
        $batchCount = $batches.Count
    }
    $allowed = [string[]]@($AllowedDatabases.Split(';') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $cred = Import-Clixml $CredentialFile
    $csb = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    $csb.set_DataSource($Server); $csb.set_InitialCatalog($Database)
    $csb.set_UserID($cred.UserName); $csb.set_Password($cred.GetNetworkCredential().Password)
    $csb.set_Encrypt($true); $csb.set_TrustServerCertificate($true); $csb.set_ApplicationName('PohodaMCP')
    $csb.set_ApplicationIntent([System.Data.SqlClient.ApplicationIntent]::ReadOnly)
    $msgs = New-Object System.Collections.Generic.List[string]
    $sets = New-Object System.Collections.Generic.List[object]
    $cn = New-Object System.Data.SqlClient.SqlConnection $csb.ConnectionString
    $cn.add_InfoMessage([System.Data.SqlClient.SqlInfoMessageEventHandler] { param($s, $e) $msgs.Add($e.Message) }.GetNewClosure())
    $cn.Open()
    try {
        # kontrola loginu pred transakci a pred jakymkoli SQL uzivatele; kdyz selze, skript se nespusti
        $stage = 'preflight'
        # vlastni strop casu: kontrola nesmi ukrojit cas skriptu ani prekrocit limit procesu (TimeoutSec + 30 s na strane serveru)
        $login = Preflight $cn $allowed ([Math]::Min($TimeoutSec, 15))
        $stage = 'run'
        $refused = $login.writable -and -not $AllowWritableLogin
        if (-not $Probe -and -not $refused) {
            $tr = $cn.BeginTransaction()
            $rolledBack = $false
            try {
                foreach ($b in $batches) {
                    $batchNo++
                    $cmd = $cn.CreateCommand(); $cmd.Transaction = $tr; $cmd.CommandTimeout = $TimeoutSec; $cmd.CommandText = $b
                    $rd = $cmd.ExecuteReader()
                    try { ReadSets $rd $sets $MaxRowsPerSet } finally { $rd.Close() }
                }
            } finally {
                # vyjimka z Rollback se neztrati (jde do JSON), ale nesmi prekryt puvodni chybu SQL
                try { $tr.Rollback(); $rolledBack = $true } catch { $rollbackError = $_.Exception.Message }
            }
        }
    } finally { $cn.Close() }
    if ($Probe) {
        Save ([ordered]@{ ok = $true; probe = $true; login = $login })
    } elseif ($refused) {
        # login smi zapisovat: zadna transakce, zadny SQL uzivatele
        Save ([ordered]@{ ok = $false; loginRefused = $true; login = $login; rolledBack = $null; rollbackError = $null })
        exit 3
    } else {
        Save ([ordered]@{ ok = $true; sets = $sets.ToArray(); messages = $msgs.ToArray(); rolledBack = $rolledBack; rollbackError = $rollbackError; login = $login })
    }
} catch {
    $ex = $_.Exception
    while ($ex.InnerException -and $ex -isnot [System.Data.SqlClient.SqlException]) { $ex = $ex.InnerException }
    $m = $ex.Message
    if ($batchNo -gt 0) {
        # jen poradi davky a cislo radku v davce - zadna data
        $where = 'D' + [char]0xE1 + 'vka ' + $batchNo + '/' + $batchCount
        if ($ex -is [System.Data.SqlClient.SqlException] -and $ex.LineNumber -gt 0) { $where += ', ' + [char]0x159 + [char]0xE1 + 'dek ' + $ex.LineNumber }
        $m = $where + ': ' + $m
    }
    $out = [ordered]@{ ok = $false; error = $m; stage = $stage; rolledBack = $rolledBack; rollbackError = $rollbackError }
    # vysledek kontroly loginu, pokud uz probehla: z auditu pak jde poznat, ze neuspesny skript bezel se zapisujicim loginem
    if ($null -ne $login) { $out.login = $login }
    Save $out
    exit 1
}
