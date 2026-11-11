<#
.SYNOPSIS
    Sestavi instalacni balicek .mcpb (Claude Desktop: dvojklik / Settings > Extensions) v dist\.
.DESCRIPTION
    1. kontrola shody verze v package.json a manifest.json,
    2. Sync-Knowledge.ps1 (snimek znalosti agenta do knowledge\; vynecha se s -BezSync),
    3. Test-Snapshot.ps1 nad knowledge\ - kontrola uniku identifikatoru realnych firem, VZDY (i s -BezSync),
    4. stage dist\stage = src, ps, manifest.json, package*.json, knowledge, node_modules (jen produkcni zavislosti),
    5. npx @anthropic-ai/mcpb@<pripnuta verze> pack -> dist\pohoda-mcp-<verze>.mcpb.
    -SmazatStarsi po uspesnem sestaveni smaze ostatni dist\pohoda-mcp-*.mcpb (vychozi: nemaze nic).
    Pracovni slozku volajiciho skript nemeni.
    Pozn.: balicek NEOBSAHUJE zadne heslo ani secrets\; soubor s prihlasenim si uzivatel zvoli pri instalaci.
    ASCII-only zdroj (PS 5.1).
#>
param([switch]$BezSync, [switch]$SmazatStarsi)
$ErrorActionPreference = 'Stop'
# Pripnuta verze balicku @anthropic-ai/mcpb (zjisteno: npm view @anthropic-ai/mcpb version). Zvysovat vedome, ne samovolne pres npx.
$mcpbVerze = '2.1.2'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$projekt = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $projekt 'dist'
$knowledge = Join-Path $projekt 'knowledge'

$verze = [string](ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $projekt 'package.json'), $utf8))).version
$verzeManifestu = [string](ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $projekt 'manifest.json'), $utf8))).version
if (-not $verze) { throw 'package.json neobsahuje verzi.' }
if ($verze -ne $verzeManifestu) { throw "Verze se lisi: package.json $verze, manifest.json $verzeManifestu - sjednot je pred sestavenim." }

if (-not $BezSync) { & (Join-Path $PSScriptRoot 'Sync-Knowledge.ps1') }

# kontrola uniku vzdy - i kdyz snimek vznikl drive nebo jinak (-BezSync, -BezAnonymizace)
& (Join-Path $PSScriptRoot 'Test-Snapshot.ps1') -Cesta $knowledge
if ($LASTEXITCODE -ne 0) { throw "Kontrola uniku neprosla (Test-Snapshot.ps1, kod $LASTEXITCODE) - balicek se nesestavi." }

$stage = Join-Path $dist 'stage'
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($p in 'src', 'ps', 'knowledge') { Copy-Item (Join-Path $projekt $p) (Join-Path $stage $p) -Recurse }
foreach ($f in 'manifest.json', 'package.json', 'package-lock.json') { Copy-Item (Join-Path $projekt $f) $stage }
$out = Join-Path $dist "pohoda-mcp-$verze.mcpb"
Push-Location -LiteralPath $stage   # npm ci a mcpb pack pracuji v aktualni slozce; finally ji vrati
try {
    $ErrorActionPreference = 'Continue'   # npm/npx pisou "notice" na stderr; rozhoduje jen exit kod
    & npm ci --omit=dev --no-audit --no-fund 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'npm ci selhal' }
    & npx --yes "@anthropic-ai/mcpb@$mcpbVerze" pack . $out 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'mcpb pack selhal' }
} finally {
    $ErrorActionPreference = 'Stop'
    Pop-Location
}
if (-not (Test-Path -LiteralPath $out -PathType Leaf)) { throw "mcpb pack neskoncil chybou, ale balicek nevznikl: $out" }
if ($SmazatStarsi) {
    foreach ($s in @(Get-ChildItem -LiteralPath $dist -Filter 'pohoda-mcp-*.mcpb' -File | Where-Object { $_.FullName -ne $out })) {
        Remove-Item -LiteralPath $s.FullName -Force
        Write-Output "Smazan starsi balicek: $($s.Name)"
    }
}
Write-Output ("Hotovo: {0} ({1:N1} MB)" -f $out, ((Get-Item -LiteralPath $out).Length / 1MB))
