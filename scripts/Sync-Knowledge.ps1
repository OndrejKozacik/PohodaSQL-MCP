<#
.SYNOPSIS
    Zkopiruje znalosti agenta (pravidla, schema, napoveda, kontrolu dotazu) do snimku, ktery se bali do .mcpb.
.DESCRIPTION
    Zdroj = slozka agenta (vychozi C:\data\PohodaAI), cil = <projekt>\knowledge (nebo -Cil). Stejna struktura jako u agenta, takze
    server i tools\Test-PohodaQuery.ps1 funguji beze zmen. NIKDY se nekopiruje secrets\, config.json, dotazy\, logs\, tests\.
    Pravidla a schema generuje agentuv tools\Update-PohodaAI.ps1 - nejdriv ho spust, pak tento skript.

    Co presne se kopiruje a anonymizuje, urcuje konfigurace (-Konfigurace, vychozi scripts\sync.local.json; vzor sync.example.json):
      schemata      - zdrojove slozky schemat, ktera prejdou do snimku. Schemata se vybiraji jen tady; SK schema ve snimku
                      pochazi z realne databaze (obsahuje nazvy uzivatelskych sloupcu VPr a odhady poctu radku) - ICO, nazvy
                      databazi a jmena firem se anonymizuji (pole nahrady)
      prejmenovani  - prejmenovani slozek schemat ve snimku (napr. sk-<ICO> -> sk)
      nahrady       - seznam [vzor, nahrada]: ve snimku (schema, pravidla) se nahradi ICO, nazvy databazi a jmena firem;
                      vzor je doslovny text (rozlisuje velikost pismen), nebo regularni vyraz s predponou (?i)
      priklady      - [vzor, nahrada] pro schema\README.md (schemaReadme; vzor je VZDY regularni vyraz, nahrada doslovny text)
                      a pro napovedu skriptu kontroly (kontrola; vzor i nahrada doslovny text, bez diakritiky v ps1 vzoru)
    sync.local.json obsahuje skutecne identifikatory a NEPATRI do gitu. Zdroj (agent) se nemeni, anonymizuje se az kopie.
    Kontrola dotazu z techto udaju nic nepouziva (vypisuje jen meta.database a exportedAt do zahlavi vystupu).

    Pojistky:
      - snimek se stavi v docasne slozce <Cil>.new; cil se nahradi az po uspechu vcetne anonymizace a kontroly uniku
        (Test-Snapshot.ps1). Pri chybe zustane puvodni cil beze zmeny a <Cil>.new se smaze.
      - -Cil nesmi byt zdroj, jeho nadrazena slozka ani slozka uvnitr zdroje; existujici neprazdny cil musi vypadat jako
        snimek (obsahovat pravidla.md), jinak se neprepise.
      - s -BezAnonymizace se kontrola uniku preskakuje (snimek je zamerne neanonymizovany); Pack-Mcpb.ps1 ji pred balenim
        spousti vzdy.
    ASCII-only zdroj (PS 5.1).
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

# Relativni cesty prevest na uplne hned: .NET File API pouziva jinou pracovni slozku nez PowerShell.
function Get-UplnaCesta([string]$p) {
    $u = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($p))
    if ($u.Length -gt 3) { $u = $u.TrimEnd('\', '/') }
    return $u
}
# Slozka neexistuje, je prazdna, nebo obsahuje pravidla.md (= nas snimek, smi se prepsat).
function Test-SmiSePrepsat([string]$dir) {
    if (-not (Test-Path -LiteralPath $dir)) { return $true }
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return $false }
    if (Test-Path -LiteralPath (Join-Path $dir 'pravidla.md') -PathType Leaf) { return $true }
    return ([IO.Directory]::GetFileSystemEntries($dir).Length -eq 0)
}
$Zdroj = Get-UplnaCesta $Zdroj
$Cil = Get-UplnaCesta $Cil

# --- konfigurace ---
if (-not $Konfigurace) {
    $Konfigurace = Join-Path $PSScriptRoot 'sync.local.json'
    if (-not (Test-Path -LiteralPath $Konfigurace)) {
        $Konfigurace = Join-Path $PSScriptRoot 'sync.example.json'
        Write-Warning 'scripts\sync.local.json chybi - pouzit sync.example.json (kopiruje jen schema obecny, nic neanonymizuje).'
    }
}
$Konfigurace = Get-UplnaCesta $Konfigurace
if (-not (Test-Path -LiteralPath $Konfigurace -PathType Leaf)) { throw "Konfigurace neexistuje: $Konfigurace" }
# chyby konfigurace hlasit vlastnim textem - text vyjimky by mohl obsahovat skutecne identifikatory (vzor, uryvek JSON)
$cfg = $null
try { $cfg = ConvertFrom-Json ([IO.File]::ReadAllText($Konfigurace, $utf8)) } catch { }
if ($null -eq $cfg) { throw "Konfiguraci nejde nacist jako JSON: $Konfigurace" }
$Schemata = @($cfg.schemata)
$Prejmenovani = @{}
if ($cfg.prejmenovani) { foreach ($p in $cfg.prejmenovani.PSObject.Properties) { $Prejmenovani[$p.Name] = [string]$p.Value } }
$nahrady = @(); if ($cfg.nahrady) { $nahrady = @($cfg.nahrady) }
$priklady = @{}; if ($cfg.priklady) { foreach ($p in $cfg.priklady.PSObject.Properties) { $priklady[$p.Name] = @($p.Value) } }
function Get-CilSchematu([string]$s) { if ($Prejmenovani.ContainsKey($s)) { $Prejmenovani[$s] } else { $s } }

# regularni vyrazy prelozit predem: chyba se ukaze pred kopirovanim a jen jako poradi vzoru
$nahradyRe = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt $nahrady.Count; $i++) {
    $n = @($nahrady[$i])
    if ($n.Count -lt 2 -or -not [string]$n[0]) { throw "Konfigurace: nahrady[$i] neni dvojice [vzor, nahrada] s neprazdnym vzorem." }
    $vzor = if ([string]$n[0] -like '(?i)*') { [string]$n[0] } else { [regex]::Escape([string]$n[0]) }
    $re = $null
    try { $re = New-Object regex $vzor } catch { }
    if ($null -eq $re) { throw "Konfigurace: nahrady[$i] neni platny regularni vyraz." }
    $nahradyRe.Add([pscustomobject]@{ Regex = $re; Nahrada = ([string]$n[1]).Replace('$', '$$') })
}
$schemaReadmeRe = $null
if ($priklady.ContainsKey('schemaReadme')) {
    if ($priklady['schemaReadme'].Count -lt 2) { throw 'Konfigurace: priklady.schemaReadme neni dvojice [vzor, nahrada].' }
    try { $schemaReadmeRe = New-Object regex ([string]$priklady['schemaReadme'][0]) } catch { }
    if ($null -eq $schemaReadmeRe) { throw 'Konfigurace: priklady.schemaReadme[0] neni platny regularni vyraz.' }
}
if ($priklady.ContainsKey('kontrola') -and $priklady['kontrola'].Count -lt 2) { throw 'Konfigurace: priklady.kontrola neni dvojice [vzor, nahrada].' }

# --- pojistky cile ---
$cmp = [StringComparison]::OrdinalIgnoreCase
$zdrojS = $Zdroj.TrimEnd('\', '/') + '\'
$cilS = $Cil.TrimEnd('\', '/') + '\'
if ($zdrojS.StartsWith($cilS, $cmp)) { throw "-Cil nesmi byt zdroj ani jeho nadrazena slozka (cil $Cil, zdroj $Zdroj)." }
if ($cilS.StartsWith($zdrojS, $cmp)) { throw "-Cil nesmi lezet uvnitr zdroje (cil $Cil, zdroj $Zdroj)." }
$novy = "$Cil.new"
$stary = "$Cil.old"
if (Test-Path -LiteralPath $Cil -PathType Leaf) { throw "-Cil je soubor, ne slozka: $Cil" }
if (-not (Test-SmiSePrepsat $Cil)) { throw "-Cil existuje, neni prazdny a nevypada jako snimek znalosti (chybi pravidla.md) - neprepisuji: $Cil" }
foreach ($d in $novy, $stary) {
    if (-not (Test-SmiSePrepsat $d)) { throw "Pracovni slozka $d existuje a nevypada jako snimek znalosti (chybi pravidla.md) - smaz ji rucne." }
}

foreach ($p in 'pravidla.md', 'pravidla', 'schema', 'tools\Test-PohodaQuery.ps1', 'reference\napoveda', 'reference\napoveda-sk') {
    if (-not (Test-Path -LiteralPath (Join-Path $Zdroj $p))) { throw "Ve zdroji chybi: $p ($Zdroj)" }
}
foreach ($s in $Schemata) {
    if (-not (Test-Path -LiteralPath (Join-Path $Zdroj "schema\$s\schema.json"))) { throw "Schema '$s' ve zdroji neexistuje ($Zdroj\schema)" }
}

# zbytky po prerusenem behu (slozky jsou nase - overeno vyse)
foreach ($d in $novy, $stary) { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } }

$hotovo = $false
try {
    # --- kopie do docasne slozky vedle cile; pravidla.md jako prvni (podle nej se pozna nas snimek) ---
    New-Item -ItemType Directory -Path $novy -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $Zdroj 'pravidla.md') -Destination $novy
    New-Item -ItemType Directory -Path (Join-Path $novy 'tools'), (Join-Path $novy 'reference'), (Join-Path $novy 'schema') -Force | Out-Null
    Copy-Item (Join-Path $Zdroj 'pravidla') (Join-Path $novy 'pravidla') -Recurse
    foreach ($s in $Schemata) { Copy-Item (Join-Path $Zdroj "schema\$s") (Join-Path $novy ("schema\" + (Get-CilSchematu $s))) -Recurse }

    # schema\README.md (prehled schemat): jen radky zkopirovanych schemat; priklad s konkretni firmou nahradit obecnym
    $readme = [IO.File]::ReadAllText((Join-Path $Zdroj 'schema\README.md'), $utf8)
    $radky = foreach ($r in ($readme -split "\r?\n")) {
        if ($r -match '^\|\s*`([^`]+)`') { if ($Schemata -contains $Matches[1]) { $r } } else { $r }
    }
    $readme = ($radky -join "`n")
    if ($schemaReadmeRe) { $readme = $schemaReadmeRe.Replace($readme, ([string]$priklady['schemaReadme'][1]).Replace('$', '$$')) }
    [IO.File]::WriteAllText((Join-Path $novy 'schema\README.md'), $readme, $utf8)

    Copy-Item (Join-Path $Zdroj 'tools\Test-PohodaQuery.ps1') (Join-Path $novy 'tools')
    Copy-Item (Join-Path $Zdroj 'reference\napoveda') (Join-Path $novy 'reference\napoveda') -Recurse
    Copy-Item (Join-Path $Zdroj 'reference\napoveda-sk') (Join-Path $novy 'reference\napoveda-sk') -Recurse

    # --- anonymizace kopie ve snimku (poradi nahrad je dulezite: nejdriv delsi vzory) ---
    if (-not $BezAnonymizace -and ($nahradyRe.Count -gt 0 -or $priklady.ContainsKey('kontrola'))) {
        $soubory = @(Get-ChildItem (Join-Path $novy 'schema'), (Join-Path $novy 'pravidla') -Recurse -File -Include *.md, *.json, *.txt) + (Get-Item (Join-Path $novy 'pravidla.md'))
        $zmeneno = 0
        foreach ($f in $soubory) {
            $t = [IO.File]::ReadAllText($f.FullName, $utf8)
            $text = $t
            foreach ($n in $nahradyRe) { $text = $n.Regex.Replace($text, $n.Nahrada) }
            if ($f.Name -eq 'schema.json') { $text = [regex]::Replace($text, '"server"\s*:\s*"[^"]*"', '"server":"sql"', 1) }
            if ($text -ne $t) { [IO.File]::WriteAllText($f.FullName, $text, $utf8); $zmeneno++ }
        }
        # priklad v napovede skriptu kontroly; soubor ma BOM (diakritika, PS 5.1) - zachovat
        if ($priklady.ContainsKey('kontrola')) {
            $kontrola = Join-Path $novy 'tools\Test-PohodaQuery.ps1'
            $tk = [IO.File]::ReadAllText($kontrola)
            $nk = $tk.Replace([string]$priklady['kontrola'][0], [string]$priklady['kontrola'][1])
            if ($nk -ne $tk) { [IO.File]::WriteAllText($kontrola, $nk, (New-Object System.Text.UTF8Encoding($true))); $zmeneno++ }
        }
        Write-Output "Anonymizace: upraveno $zmeneno souboru"
    }

    # --- kontrola uniku: pri nalezu se cil nenahradi ---
    if ($BezAnonymizace) {
        Write-Warning 'Kontrola uniku preskocena (-BezAnonymizace): snimek obsahuje neanonymizovane udaje a nesmi se balit ani zverejnit.'
    } else {
        & (Join-Path $PSScriptRoot 'Test-Snapshot.ps1') -Cesta $novy -Konfigurace $Konfigurace
        if ($LASTEXITCODE -ne 0) { throw "Kontrola uniku neprosla (Test-Snapshot.ps1, kod $LASTEXITCODE) - cil zustava beze zmeny: $Cil" }
    }

    # --- vymena: puvodni cil odsunout, novy prejmenovat, puvodni smazat (prejmenovani slozky je jedna operace) ---
    $bylStary = Test-Path -LiteralPath $Cil
    if ($bylStary) { [IO.Directory]::Move($Cil, $stary) }
    try { [IO.Directory]::Move($novy, $Cil) } catch {
        if ($bylStary) { [IO.Directory]::Move($stary, $Cil) }
        throw
    }
    $hotovo = $true
    if ($bylStary) {
        try { Remove-Item -LiteralPath $stary -Recurse -Force } catch { Write-Warning "Puvodni snimek se nepodarilo smazat, smaz ho rucne: $stary" }
    }
} finally {
    if (-not $hotovo -and (Test-Path -LiteralPath $novy)) {
        try { Remove-Item -LiteralPath $novy -Recurse -Force } catch { Write-Warning "Nedokonceny snimek se nepodarilo smazat, smaz ho rucne (muze obsahovat neanonymizovane udaje): $novy" }
    }
}

$n = (Get-ChildItem $Cil -Recurse -File | Measure-Object).Count
$mb = [math]::Round((Get-ChildItem $Cil -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Output "Snimek znalosti: $Cil ($n souboru, $mb MB)"
