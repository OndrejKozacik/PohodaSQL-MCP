<#
.SYNOPSIS
    Sestavi instalacni balicek .mcpb (Claude Desktop: dvojklik / Settings > Extensions) v dist\.
.DESCRIPTION
    1. Sync-Knowledge.ps1 (snimek znalosti agenta do knowledge\),
    2. stage dist\stage = src, ps, manifest.json, package*.json, knowledge, node_modules (jen produkcni zavislosti),
    3. npx @anthropic-ai/mcpb pack -> dist\pohoda-mcp-<verze>.mcpb.
    Pozn.: balicek NEOBSAHUJE zadne heslo ani secrets\; soubor s prihlasenim si uzivatel zvoli pri instalaci.
#>
param([switch]$BezSync)
$ErrorActionPreference = 'Stop'
$projekt = Split-Path -Parent $PSScriptRoot
Set-Location $projekt
if (-not $BezSync) { & (Join-Path $PSScriptRoot 'Sync-Knowledge.ps1') }
$verze = (Get-Content package.json -Raw | ConvertFrom-Json).version
$stage = Join-Path $projekt 'dist\stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($p in 'src', 'ps', 'knowledge') { Copy-Item (Join-Path $projekt $p) (Join-Path $stage $p) -Recurse }
foreach ($f in 'manifest.json', 'package.json', 'package-lock.json') { Copy-Item (Join-Path $projekt $f) $stage }
Push-Location $stage
$ErrorActionPreference = 'Continue'   # npm/npx pisou "notice" na stderr; rozhoduje jen exit kod
try {
    & npm ci --omit=dev --no-audit --no-fund 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'npm ci selhal' }
    $out = Join-Path $projekt "dist\pohoda-mcp-$verze.mcpb"
    & npx --yes @anthropic-ai/mcpb pack . $out 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'mcpb pack selhal' }
} finally { Pop-Location }
Write-Output ("Hotovo: {0} ({1:N1} MB)" -f $out, ((Get-Item $out).Length / 1MB))
