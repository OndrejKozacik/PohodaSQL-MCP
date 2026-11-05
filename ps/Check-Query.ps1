<#
.SYNOPSIS
    Obalka nad Test-PohodaQuery.ps1 agenta: spusti kontrolu a vystup + exit kod ulozi do JSON (UTF-8). ASCII-only zdroj (PS 5.1).
#>
param(
    [Parameter(Mandatory)][string]$Checker,
    [Parameter(Mandatory)][string]$SqlFile,
    [Parameter(Mandatory)][string]$OutFile,
    [string]$Firma
)
$ErrorActionPreference = 'Continue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $utf8 } catch { }
$a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Checker, '-SqlFile', $SqlFile)
if ($Firma) { $a += @('-Firma', $Firma) }
$out = (& powershell @a 2>&1 | Out-String)
$code = $LASTEXITCODE
[IO.File]::WriteAllText($OutFile, (@{ exit = $code; output = $out } | ConvertTo-Json -Compress), $utf8)
