<#
.SYNOPSIS
    Spusti T-SQL skript na lokalni Pohoda DB v transakci, ktera se VZDY vrati (ROLLBACK), a vysledek ulozi jako JSON (UTF-8).
.DESCRIPTION
    Pomocnik pro MCP server pohoda-mcp. Heslo se cte primo tady (Import-Clixml, DPAPI) a nikdy neopousti tento proces.
    Stejne principy jako dotazy\_analyza\qdb.ps1 a tests\Run-GoldenTests.ps1: dava se GO jako oddelovac davek, vsechny result sety,
    PRINT zpravy. Vystup: JSON do -OutFile (hodnoty uz formatovane jako text, NULL = null). ASCII-only zdroj (PS 5.1).
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
    if ($v -is [DBNull] -or $null -eq $v) { return $null }
    if ($v -is [datetime]) { return $v.ToString('yyyy-MM-dd HH:mm:ss', $inv) }
    if ($v -is [decimal] -or $v -is [double] -or $v -is [single]) { return ([decimal]$v).ToString('0.00##', $inv) }
    if ($v -is [byte[]]) { return '0x' + (($v | Select-Object -First 16 | ForEach-Object { $_.ToString('X2') }) -join '') }
    return (([string]$v) -replace '\r?\n', ' ')
}
try {
    $sql = [IO.File]::ReadAllText($SqlFile, [Text.Encoding]::UTF8)
    $batches = @([regex]::Split($sql, '(?im)^\s*GO\s*$') | Where-Object { $_.Trim() })
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
        try {
            foreach ($b in $batches) {
                $cmd = $cn.CreateCommand(); $cmd.Transaction = $tr; $cmd.CommandTimeout = $TimeoutSec; $cmd.CommandText = $b
                $rd = $cmd.ExecuteReader()
                try {
                    do {
                        if ($rd.FieldCount -gt 0) {
                            $cols = @(for ($i = 0; $i -lt $rd.FieldCount; $i++) { $rd.GetName($i) })
                            $rows = New-Object System.Collections.Generic.List[object]
                            $total = 0
                            while ($rd.Read()) {
                                $total++
                                if ($rows.Count -lt $MaxRowsPerSet) {
                                    $v = New-Object object[] $rd.FieldCount; [void]$rd.GetValues($v)
                                    $rows.Add(@($v | ForEach-Object { Fmt $_ }))
                                }
                            }
                            $sets.Add([ordered]@{ cols = $cols; rows = $rows.ToArray(); total = $total })
                        }
                    } while ($rd.NextResult())
                } finally { $rd.Close() }
            }
        } finally { try { $tr.Rollback() } catch { } }
    } finally { $cn.Close() }
    Save ([ordered]@{ ok = $true; sets = $sets.ToArray(); messages = $msgs.ToArray() })
} catch {
    $m = $_.Exception.Message
    if ($_.Exception.InnerException) { $m = $_.Exception.InnerException.Message }
    Save ([ordered]@{ ok = $false; error = $m })
    exit 1
}
