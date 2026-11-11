<#
.SYNOPSIS
    Spusti T-SQL skript na lokalni Pohoda DB v transakci, ktera se VZDY vrati (ROLLBACK), a vysledek ulozi jako JSON (UTF-8).
.DESCRIPTION
    Pomocnik pro MCP server pohoda-mcp. Heslo se cte primo tady (Import-Clixml, DPAPI) a nikdy neopousti tento proces.
    Stejne principy jako dotazy\_analyza\qdb.ps1 a tests\Run-GoldenTests.ps1: dava se GO jako oddelovac davek, vsechny result sety,
    PRINT zpravy. Vystup: JSON do -OutFile (hodnoty uz formatovane jako text, NULL = null). ASCII-only zdroj (PS 5.1).
    rolledBack v JSON: true = Rollback() probehl, false = selhal (text v rollbackError), null = transakce vubec nezacala.
#>
param(
    [Parameter(Mandatory)][string]$SqlFile,
    [Parameter(Mandatory)][string]$Database,
    [Parameter(Mandatory)][string]$OutFile,
    [Parameter(Mandatory)][string]$CredentialFile,
    [string]$Server = '127.0.0.1,1433',
    [int]$MaxRowsPerSet = 200,
    [int]$TimeoutSec = 60
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
$rolledBack = $null
$rollbackError = $null
$batchNo = 0
$batchCount = 0
try {
    $sql = [IO.File]::ReadAllText($SqlFile, [Text.Encoding]::UTF8)
    $batches = @(SplitBatches $sql)
    $batchCount = $batches.Count
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
    } finally { $cn.Close() }
    Save ([ordered]@{ ok = $true; sets = $sets.ToArray(); messages = $msgs.ToArray(); rolledBack = $rolledBack; rollbackError = $rollbackError })
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
    Save ([ordered]@{ ok = $false; error = $m; rolledBack = $rolledBack; rollbackError = $rollbackError })
    exit 1
}
