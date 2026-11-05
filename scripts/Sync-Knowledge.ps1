<#
.SYNOPSIS
    Zkopiruje znalosti agenta (pravidla, schema, napoveda, kontrolu dotazu) do snimku, ktery se bali do .mcpb.
.DESCRIPTION
    Zdroj = slozka agenta (vychozi C:\data\PohodaAI), cil = <projekt>\knowledge (nebo -Cil). Stejna struktura jako u agenta, takze
    server i tools\Test-PohodaQuery.ps1 funguji beze zmen. NIKDY se nekopiruje secrets\, config.json, dotazy\, logs\, tests\.
    Pravidla a schema generuje agentuv tools\Update-PohodaAI.ps1 - nejdriv ho spust, pak tento skript.

    Co presne se kopiruje a anonymizuje, urcuje konfigurace (-Konfigurace, vychozi scripts\sync.local.json; vzor sync.example.json):
      schemata      - zdrojove slozky schemat, ktera prejdou do snimku (schemata realnych firem sem nepatri)
      prejmenovani  - prejmenovani slozek schemat ve snimku (napr. sk-<ICO> -> sk)
      nahrady       - seznam [vzor, nahrada]: ve snimku (schema, pravidla) se nahradi ICO, nazvy databazi a jmena firem;
                      vzor je doslovny text, nebo regularni vyraz s predponou (?i)
      priklady      - [vzor, nahrada] pro schema\README.md a pro napovedu skriptu kontroly (bez diakritiky v ps1 vzoru)
    sync.local.json obsahuje skutecne identifikatory a NEPATRI do gitu. Zdroj (agent) se nemeni, anonymizuje se az kopie.
    Kontrola dotazu z techto udaju nic nepouziva (vypisuje jen meta.database a exportedAt do zahlavi vystupu).
#>
param(
    [string]$Zdroj = 'C:\data\PohodaAI',
    [string]$Cil,
    [string]$Konfigurace,
    [switch]$BezAnonymizace
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$projekt = Split-Path -Parent $PSScriptRoot
if (-not $Cil) { $Cil = Join-Path $projekt 'knowledge' }

# --- konfigurace ---
if (-not $Konfigurace) {
    $Konfigurace = Join-Path $PSScriptRoot 'sync.local.json'
    if (-not (Test-Path -LiteralPath $Konfigurace)) {
        $Konfigurace = Join-Path $PSScriptRoot 'sync.example.json'
        Write-Warning 'scripts\sync.local.json chybi - pouzit sync.example.json (kopiruje jen schema obecny, nic neanonymizuje).'
    }
}
$cfg = ConvertFrom-Json ([IO.File]::ReadAllText($Konfigurace, $utf8))
$Schemata = @($cfg.schemata)
$Prejmenovani = @{}
if ($cfg.prejmenovani) { foreach ($p in $cfg.prejmenovani.PSObject.Properties) { $Prejmenovani[$p.Name] = [string]$p.Value } }
$nahrady = @(); if ($cfg.nahrady) { $nahrady = @($cfg.nahrady) }
$priklady = @{}; if ($cfg.priklady) { foreach ($p in $cfg.priklady.PSObject.Properties) { $priklady[$p.Name] = @($p.Value) } }
function Get-CilSchematu([string]$s) { if ($Prejmenovani.ContainsKey($s)) { $Prejmenovani[$s] } else { $s } }

foreach ($p in 'pravidla.md', 'pravidla', 'schema', 'tools\Test-PohodaQuery.ps1', 'reference\napoveda', 'reference\napoveda-sk') {
    if (-not (Test-Path -LiteralPath (Join-Path $Zdroj $p))) { throw "Ve zdroji chybi: $p ($Zdroj)" }
}
foreach ($s in $Schemata) {
    if (-not (Test-Path -LiteralPath (Join-Path $Zdroj "schema\$s\schema.json"))) { throw "Schema '$s' ve zdroji neexistuje ($Zdroj\schema)" }
}

if (Test-Path -LiteralPath $Cil) { Remove-Item -LiteralPath $Cil -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $Cil 'tools'), (Join-Path $Cil 'reference'), (Join-Path $Cil 'schema') -Force | Out-Null
Copy-Item (Join-Path $Zdroj 'pravidla.md') $Cil
Copy-Item (Join-Path $Zdroj 'pravidla') (Join-Path $Cil 'pravidla') -Recurse
foreach ($s in $Schemata) { Copy-Item (Join-Path $Zdroj "schema\$s") (Join-Path $Cil ("schema\" + (Get-CilSchematu $s))) -Recurse }

# schema\README.md (prehled schemat): jen radky zkopirovanych schemat; priklad s konkretni firmou nahradit obecnym
$readme = [IO.File]::ReadAllText((Join-Path $Zdroj 'schema\README.md'), $utf8)
$radky = foreach ($r in ($readme -split "\r?\n")) {
    if ($r -match '^\|\s*`([^`]+)`') { if ($Schemata -contains $Matches[1]) { $r } } else { $r }
}
$readme = ($radky -join "`n")
if ($priklady.ContainsKey('schemaReadme')) { $readme = [regex]::Replace($readme, $priklady['schemaReadme'][0], $priklady['schemaReadme'][1].Replace('$', '$$')) }
[IO.File]::WriteAllText((Join-Path $Cil 'schema\README.md'), $readme, $utf8)

Copy-Item (Join-Path $Zdroj 'tools\Test-PohodaQuery.ps1') (Join-Path $Cil 'tools')
Copy-Item (Join-Path $Zdroj 'reference\napoveda') (Join-Path $Cil 'reference\napoveda') -Recurse
Copy-Item (Join-Path $Zdroj 'reference\napoveda-sk') (Join-Path $Cil 'reference\napoveda-sk') -Recurse

# --- anonymizace kopie ve snimku (poradi nahrad je dulezite: nejdriv delsi vzory) ---
if (-not $BezAnonymizace -and ($nahrady.Count -gt 0 -or $priklady.ContainsKey('kontrola'))) {
    $soubory = @(Get-ChildItem (Join-Path $Cil 'schema'), (Join-Path $Cil 'pravidla') -Recurse -File -Include *.md, *.json, *.txt) + (Get-Item (Join-Path $Cil 'pravidla.md'))
    $zmeneno = 0
    foreach ($f in $soubory) {
        $t = [IO.File]::ReadAllText($f.FullName, $utf8)
        $novy = $t
        foreach ($n in $nahrady) {
            $vzor = if ([string]$n[0] -like '(?i)*') { [string]$n[0] } else { [regex]::Escape([string]$n[0]) }
            $novy = [regex]::Replace($novy, $vzor, ([string]$n[1]).Replace('$', '$$'))
        }
        if ($f.Name -eq 'schema.json') { $novy = [regex]::Replace($novy, '"server"\s*:\s*"[^"]*"', '"server":"sql"', 1) }
        if ($novy -ne $t) { [IO.File]::WriteAllText($f.FullName, $novy, $utf8); $zmeneno++ }
    }
    # priklad v napovede skriptu kontroly; soubor ma BOM (diakritika, PS 5.1) - zachovat
    if ($priklady.ContainsKey('kontrola')) {
        $kontrola = Join-Path $Cil 'tools\Test-PohodaQuery.ps1'
        $tk = [IO.File]::ReadAllText($kontrola)
        $nk = $tk.Replace([string]$priklady['kontrola'][0], [string]$priklady['kontrola'][1])
        if ($nk -ne $tk) { [IO.File]::WriteAllText($kontrola, $nk, (New-Object System.Text.UTF8Encoding($true))); $zmeneno++ }
    }
    Write-Output "Anonymizace: upraveno $zmeneno souboru"
}

$n = (Get-ChildItem $Cil -Recurse -File | Measure-Object).Count
$mb = [math]::Round((Get-ChildItem $Cil -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Output "Snimek znalosti: $Cil ($n souboru, $mb MB)"
