# Diagnostyka instalacji TS3 Screen Share.
# Uruchom i wyslij cala odpowiedz:
#
#   powershell -ExecutionPolicy Bypass -File diagnostyka.ps1
#
# Skrypt niczego nie zmienia - tylko czyta i wypisuje.
# Celowo bez polskich znakow: Windows PowerShell czyta .ps1 jako ANSI
# i pliki UTF-8 bez BOM sie rozjezdzaja.

Write-Output "=== TS3 Screen Share - diagnostyka ==="
Write-Output ""

# --- 1. Czy klient jest uruchomiony --------------------------------------
$proc = Get-Process ts3client_win64, ts3client_win32 -ErrorAction SilentlyContinue
if ($proc) {
    Write-Output "[1] TeamSpeak DZIALA: $($proc.ProcessName -join ', ')"
    Write-Output "    Po instalacji trzeba go zamknac i uruchomic PONOWNIE."
} else {
    Write-Output "[1] TeamSpeak nie dziala"
}

# --- 2. Wersja i architektura klienta -------------------------------------
$kandydaci = @()
$kandydaci += "$env:ProgramFiles\TeamSpeak 3 Client\ts3client_win64.exe"
$kandydaci += "${env:ProgramFiles(x86)}\TeamSpeak 3 Client\ts3client_win32.exe"
if ($proc) { $kandydaci += ($proc | ForEach-Object { $_.Path }) }

$exe = $null
foreach ($k in $kandydaci) {
    if ($k -and (Test-Path $k)) { $exe = $k; break }
}

Write-Output ""
if ($exe) {
    $ver = (Get-Item $exe).VersionInfo.FileVersion
    if ($exe -match 'win64') { $arch = "64-bit (OK)" } else { $arch = "32-bit  <<< PROBLEM: wtyczka jest 64-bit" }
    Write-Output "[2] Klient: $ver / $arch"
    Write-Output "    $exe"
} else {
    Write-Output "[2] Nie znaleziono ts3client.exe w typowych lokalizacjach."
    Write-Output "    Podaj gdzie masz zainstalowanego TeamSpeaka."
}

# --- 3. Katalogi pluginow -------------------------------------------------
# TS3 w trybie portable trzyma konfiguracje obok .exe, a nie w %APPDATA%.
$katalogi = @("$env:APPDATA\TS3Client\plugins")
if ($exe) { $katalogi += (Join-Path (Split-Path $exe) "plugins") }

Write-Output ""
Write-Output "[3] Katalogi pluginow:"
foreach ($k in $katalogi) {
    if (Test-Path $k) {
        Write-Output "    $k  [ISTNIEJE]"
        $dll = Join-Path $k "ts3_screenshare.dll"
        if (Test-Path $dll) {
            $i = Get-Item $dll
            Write-Output "      ts3_screenshare.dll  : JEST ($([math]::Round($i.Length/1KB,1)) KB, $($i.LastWriteTime))"
        } else {
            Write-Output "      ts3_screenshare.dll  : BRAK"
        }
        $pf = Join-Path $k "ts3-screenshare.path"
        if (Test-Path $pf) {
            $app = (Get-Content $pf -Raw).Trim()
            Write-Output "      ts3-screenshare.path : JEST"
            Write-Output "        -> $app"
            Write-Output "        -> aplikacja istnieje: $(Test-Path -LiteralPath $app)"
        } else {
            Write-Output "      ts3-screenshare.path : BRAK"
        }
    } else {
        Write-Output "    $k  [nie istnieje]"
    }
}

# --- 4. Co mowi log klienta -----------------------------------------------
Write-Output ""
Write-Output "[4] Log klienta:"
$log = Get-ChildItem "$env:APPDATA\TS3Client\logs\*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($log) {
    Write-Output "    plik: $($log.Name)"
    $wzor = "screenshare|Api version|Failed to load|Loading plugin|TeamSpeak Client"
    $wpisy = Select-String -Path $log.FullName -Pattern $wzor -ErrorAction SilentlyContinue | Select-Object -Last 12
    if ($wpisy) {
        foreach ($w in $wpisy) { Write-Output "    $($w.Line.Trim())" }
    } else {
        Write-Output "    Brak wpisow o wtyczkach - czy klient byl uruchomiony PO instalacji?"
    }
} else {
    Write-Output "    Brak logow w %APPDATA%\TS3Client\logs"
}

Write-Output ""
Write-Output "=== koniec ==="
