<#
.SYNOPSIS
    Kontrola uniku: overi, ze ve snimku znalosti nezbyly identifikatory realnych firem (ICO, nazvy databazi, jmena firem).
.DESCRIPTION
    Projde textove soubory snimku (-Cesta): pravidla.md, pravidla\, schema\, tools\ (obsah i relativni cestu souboru) a hleda:
      a) zdrojove vzory z pole "nahrady" konfigurace (-Konfigurace, vychozi scripts\sync.local.json, jinak sync.example.json).
         Stejne pravidlo jako Sync-Knowledge.ps1: vzor s predponou (?i) je regularni vyraz, jinak doslovny text; tady se ale
         hleda VZDY bez ohledu na velikost pismen. Vzor, ktery se najde ve sve vlastni nahrade, se preskakuje (po nahrazeni by
         se nasel vzdy); kontroluji se jen zdrojove vzory, nikdy nahrady.
      b) obecny vzor nazvu databaze realne firmy: StwPh(SK)?_(?!12345678|<ICO>)[0-9]{8} bez ohledu na velikost pismen
         (modelova firma 12345678 a zastupny text <ICO> jsou v poradku).
    reference\ (napoveda programu) se nekontroluje - nahrady se na ni neaplikuji.

    Vypisuje jen soubor a oznaceni vzoru (nahrady[poradi od 0] nebo "obecny"), NIKDY nalezeny text, jeho okoli ani obsah
    konfigurace. Navratovy kod: 0 = bez nalezu, 1 = nalez, 2 = kontrolu nejde provest (chybi snimek, vadna konfigurace).
    Vola ji Sync-Knowledge.ps1 (pred nahrazenim cile) a Pack-Mcpb.ps1 (vzdy pred balenim). ASCII-only zdroj (PS 5.1).
#>
param(
    [Parameter(Mandatory)][string]$Cesta,
    [string]$Konfigurace
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$maxVypis = 50

# Chyba kontroly: jen nas text - text vyjimky by mohl obsahovat kus konfigurace (vzor, uryvek JSON).
function Stop-Kontrola([string]$zprava) {
    Write-Output "Kontrola uniku: NELZE PROVEST - $zprava"
    exit 2
}

# .NET File API pouziva jinou pracovni slozku nez PowerShell - relativni cesty prevest hned
$Cesta = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Cesta))
if (-not $Konfigurace) {
    $Konfigurace = Join-Path $PSScriptRoot 'sync.local.json'
    if (-not (Test-Path -LiteralPath $Konfigurace)) { $Konfigurace = Join-Path $PSScriptRoot 'sync.example.json' }
}
$Konfigurace = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Konfigurace))

if (-not (Test-Path -LiteralPath $Cesta -PathType Container)) { Stop-Kontrola "slozka snimku neexistuje: $Cesta" }
if (-not (Test-Path -LiteralPath (Join-Path $Cesta 'pravidla.md') -PathType Leaf)) { Stop-Kontrola "slozka nevypada jako snimek znalosti (chybi pravidla.md): $Cesta" }
if (-not (Test-Path -LiteralPath $Konfigurace -PathType Leaf)) { Stop-Kontrola "konfigurace neexistuje: $Konfigurace" }

$cfg = $null
try { $cfg = ConvertFrom-Json ([IO.File]::ReadAllText($Konfigurace, $utf8)) } catch { }
if ($null -eq $cfg) { Stop-Kontrola "konfiguraci nejde nacist jako JSON: $Konfigurace" }

# --- vzory ---
$vzory = New-Object System.Collections.Generic.List[object]
$vzory.Add([pscustomobject]@{ Nazev = 'obecny (nazev databaze StwPh_<8 cislic>)'; Regex = (New-Object regex '(?i)StwPh(SK)?_(?!12345678|<ICO>)[0-9]{8}') })
$preskoceno = 0
$nahrady = @(); if ($cfg.nahrady) { $nahrady = @($cfg.nahrady) }
for ($i = 0; $i -lt $nahrady.Count; $i++) {
    $n = @($nahrady[$i])
    if ($n.Count -lt 2) { Stop-Kontrola "nahrady[$i] v konfiguraci neni dvojice [vzor, nahrada]" }
    $zdroj = [string]$n[0]
    $nahrada = [string]$n[1]
    if (-not $zdroj) { Stop-Kontrola "nahrady[$i] v konfiguraci ma prazdny vzor" }
    $re = $null
    try {
        if ($zdroj -like '(?i)*') { $re = New-Object regex $zdroj }
        else { $re = New-Object regex ([regex]::Escape($zdroj)), ([System.Text.RegularExpressions.RegexOptions]::IgnoreCase) }
    } catch { }
    if ($null -eq $re) { Stop-Kontrola "nahrady[$i] v konfiguraci neni platny regularni vyraz" }
    if ($re.IsMatch($nahrada)) { $preskoceno++; continue }
    $vzory.Add([pscustomobject]@{ Nazev = "nahrady[$i]"; Regex = $re })
}

# --- soubory ---
$soubory = New-Object System.Collections.Generic.List[string]
$soubory.Add((Join-Path $Cesta 'pravidla.md'))
foreach ($d in 'pravidla', 'schema', 'tools') {
    $p = Join-Path $Cesta $d
    if (Test-Path -LiteralPath $p -PathType Container) {
        foreach ($f in [IO.Directory]::GetFiles($p, '*', [IO.SearchOption]::AllDirectories)) { $soubory.Add($f) }
    }
}

$nalezy = New-Object System.Collections.Generic.List[string]
foreach ($f in $soubory) {
    $rel = $f.Substring($Cesta.TrimEnd('\', '/').Length + 1)
    $text = [IO.File]::ReadAllText($f, $utf8)
    foreach ($v in $vzory) {
        if ($v.Regex.IsMatch($text)) { $nalezy.Add("UNIK: $rel - vzor $($v.Nazev)") }
        if ($v.Regex.IsMatch($rel)) { $nalezy.Add("UNIK: $rel - vzor $($v.Nazev) (v nazvu souboru nebo slozky)") }
    }
}

$souhrn = "$($soubory.Count) souboru, $($vzory.Count) vzoru"
if ($preskoceno) { $souhrn += ", $preskoceno vzoru preskoceno (jsou obsazeny ve sve nahrade)" }
if ($nalezy.Count -gt 0) {
    $nalezy | Select-Object -First $maxVypis | ForEach-Object { Write-Output $_ }
    if ($nalezy.Count -gt $maxVypis) { Write-Output "... a dalsich $($nalezy.Count - $maxVypis) nalezu" }
    Write-Output "Kontrola uniku: NALEZENO $($nalezy.Count) (dvojic soubor - vzor) v $Cesta; $souhrn. Dopln nahrady v konfiguraci a snimek sestav znovu."
    exit 1
}
Write-Output "Kontrola uniku: v poradku ($souhrn) - $Cesta"
exit 0
