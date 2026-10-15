<#
.SYNOPSIS
Uruchamia aplikację ponownie z flagą --diagnostics, z tymi samymi danymi pokoju,
które podała wtyczka TS3.

.DESCRIPTION
Panel diagnostyczny i pasek zużycia siedzą za flagą `--diagnostics`, a wtyczka
TS3 jej nie podaje — i nie powinna, bo normalny użytkownik nie ma płacić za
diagnostykę ani jednym cyklem procesora.

Żeby diagnozować PRAWDZIWĄ sesję, aplikacja musi trafić do tego samego pokoju,
czyli dostać ten sam identyfikator serwera i numer kanału. Przepisywanie
28-znakowego identyfikatora z dymka jest męczące i łatwo się pomylić, dlatego
ten skrypt czyta je z LINII POLECEŃ ŻYWEGO PROCESU: są wtedy dokładnie takie,
jakie podała wtyczka, bez zgadywania i bez przepisywania.

Przebieg:
  1. czeka, aż kliknięcie „Udostępnij ekran" w TS3 odpali aplikację;
  2. odczytuje jej argumenty;
  3. zamyka ją (chyba że podasz -KeepOriginal);
  4. uruchamia ją ponownie z dopisanym `--diagnostics`.

UWAGA przy edycji tego pliku: musi zostać zapisany jako UTF-8 Z BOM. Windows
PowerShell 5.1 czyta `.ps1` bez BOM jako ANSI i polskie znaki w komunikatach
wychodzą wtedy jako krzaki („ zamienia się w â€ž).

.PARAMETER TimeoutSeconds
Ile czekać na kliknięcie w TS3. Domyślnie 120 s.

.PARAMETER KeepOriginal
Nie zamykaj pierwotnego okna, tylko odpal drugie obok. UWAGA: będziesz wtedy
w pokoju DWA RAZY i nadawał dwa razy, co zmienia to, co mierzysz. Przydatne
tylko wtedy, gdy chcesz zobaczyć obie strony naraz na jednej maszynie.

.EXAMPLE
  npm run diagnostyka

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/diagnostyka.ps1 -TimeoutSeconds 300
#>
param(
    [int] $TimeoutSeconds = 120,
    [switch] $KeepOriginal
)

$ErrorActionPreference = 'Stop'
$processName = 'TS3 Screen Share.exe'

<#
Proces GŁÓWNY Electrona, nie któryś z jego rendererów.

Electron odpala kilka procesów o tej samej nazwie pliku. Rozpoznajemy główny po
tym, że ma `--ts3-server` i NIE ma `--type=` — renderery, GPU i narzędzia
dostają `--type=renderer` i spółkę, a danych pokoju nie widzą wcale.
#>
function Find-MainProcess {
    Get-CimInstance Win32_Process -Filter "Name='$processName'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -match '--ts3-server' -and
            $_.CommandLine -notmatch '--type='
        } |
        Select-Object -First 1
}

# Jakakolwiek instancja, także samodzielna (bez danych pokoju) — po to, żeby
# umieć powiedzieć „coś działa, ale nie z TS3" zamiast milczeć do końca limitu.
function Find-AnyMainProcess {
    Get-CimInstance Win32_Process -Filter "Name='$processName'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
        Select-Object -First 1
}

Write-Host ''
Write-Host 'Kliknij teraz w TeamSpeaku „Udostępnij ekran" na swoim kanale.' -ForegroundColor Cyan
Write-Host ("Czekam do {0} s. Przerwanie: Ctrl+C." -f $TimeoutSeconds) -ForegroundColor DarkGray
Write-Host ''

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$found = $null
$warnedStandalone = $false

while ((Get-Date) -lt $deadline) {
    $found = Find-MainProcess
    if ($found) { break }

    # Jednorazowe ostrzeżenie: aplikacja chodzi, ale bez danych pokoju. Czekanie
    # dalej jest sensowne (możesz jeszcze kliknąć w TS3), więc nie przerywamy.
    if (-not $warnedStandalone -and (Find-AnyMainProcess)) {
        Write-Host 'Aplikacja działa, ale BEZ danych pokoju (tryb samodzielny).' -ForegroundColor Yellow
        Write-Host 'Zamknij ją i kliknij w TS3, albo czekaj — użyję tej z TS3.' -ForegroundColor Yellow
        Write-Host ''
        $warnedStandalone = $true
    }

    Start-Sleep -Milliseconds 500
}

if (-not $found) {
    Write-Host 'Nie doczekałem się instancji uruchomionej z TS3.' -ForegroundColor Red
    Write-Host 'Sprawdź, czy wtyczka jest włączona w TS3 (Narzędzia > Opcje > Wtyczki).'
    exit 1
}

$commandLine = $found.CommandLine

# Linia poleceń ma postać: "<ścieżka do exe>" --ts3-server="..." --channel=N [--nick="..."]
# Ścieżka jest w cudzysłowach, bo zawiera spacje (CreateProcessW w plugin.c je dodaje).
if ($commandLine -match '^\s*"([^"]+)"\s*(.*)$') {
    $exePath = $Matches[1]
    $arguments = $Matches[2]
} elseif ($commandLine -match '^\s*(\S+)\s+(.*)$') {
    # Zapas na wypadek uruchomienia bez cudzysłowów (ścieżka bez spacji).
    $exePath = $Matches[1]
    $arguments = $Matches[2]
} else {
    Write-Host 'Nie rozpoznaję linii poleceń tego procesu.' -ForegroundColor Red
    exit 1
}

if ($arguments -match '--diagnostics') {
    Write-Host 'Ta instancja JUŻ ma --diagnostics. Nie ma czego robić.' -ForegroundColor Green
    Write-Host 'Panel otwiera Ctrl+Shift+D, gdy okno aplikacji ma skupienie.'
    exit 0
}

# Pokazujemy, co znaleźliśmy, ale identyfikator serwera SKRACAMY: ma 28 znaków
# base64, a do potwierdzenia „to ten pokój" wystarcza początek. Numer kanału
# pokazujemy cały, bo to jedyna wartość, która realnie różni się między osobami
# z jednego serwera TS3 — i o której się rozmawia przez telefon.
$channel = if ($arguments -match '--channel=(\d+)') { $Matches[1] } else { '?' }
$server = if ($arguments -match '--ts3-server="([^"]*)"') { $Matches[1] }
          elseif ($arguments -match '--ts3-server=(\S+)') { $Matches[1] }
          else { '' }
$serverShort = if ($server.Length -gt 10) { $server.Substring(0, 8) + '...' } else { $server }

Write-Host ('Znalazłem instancję z TS3 (PID {0}).' -f $found.ProcessId) -ForegroundColor Green
Write-Host ('  kanał:  {0}' -f $channel)
Write-Host ('  serwer: {0}' -f $serverShort)
Write-Host ''

if (-not $KeepOriginal) {
    Write-Host 'Zamykam pierwotne okno...'
    try {
        $proc = Get-Process -Id $found.ProcessId -ErrorAction Stop
        # Najpierw łagodnie: Electron domyka wtedy połączenia i serwer
        # sygnalizacyjny dowiaduje się o wyjściu. Dopiero potem siłowo.
        $null = $proc.CloseMainWindow()
        if (-not $proc.WaitForExit(5000)) {
            Write-Host '  nie zamknęło się samo, kończę proces' -ForegroundColor Yellow
            Stop-Process -Id $found.ProcessId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
    } catch {
        Write-Host ('  nie udało się zamknąć: {0}' -f $_.Exception.Message) -ForegroundColor Yellow
        Write-Host '  uruchamiam drugą instancję obok' -ForegroundColor Yellow
    }
} else {
    Write-Host 'Zostawiam pierwotne okno (-KeepOriginal).' -ForegroundColor Yellow
    Write-Host 'Będziesz w pokoju DWA RAZY i nadasz dwa razy — to zmienia pomiar.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Uruchamiam z --diagnostics...'
# Argumenty jako JEDEN łańcuch, nie tablica: zawierają już własne cudzysłowy
# (--ts3-server="..." i --nick="..."), a tablica kazałaby PowerShellowi
# przecytować je po swojemu i identyfikator serwera trafiłby do aplikacji źle.
Start-Process -FilePath $exePath -ArgumentList ($arguments + ' --diagnostics')

$logDirectory = Join-Path $env:APPDATA 'ts3-screenshare-companion\diagnostics'
Write-Host ''
Write-Host 'Gotowe.' -ForegroundColor Green
Write-Host '  Panel:  Ctrl+Shift+D — działa tylko, gdy okno aplikacji ma skupienie.'
Write-Host '          Gdy grasz, skupienie ma gra, więc panelu wtedy nie otworzysz.'
Write-Host '          Nie szkodzi: zapis leci niezależnie od panelu, bo rejestrator'
Write-Host '          siedzi w procesie głównym. Po grze otwórz panel i przewiń'
Write-Host '          suwakiem do chwili, w której lagowało.'
Write-Host '  Pasek:  prawy dolny róg — CPU, RAM, GPU, VRAM.'
Write-Host ('  Zapis:  {0}' -f $logDirectory)
Write-Host '          jeden plik na sesję, nazwa YYYY-MM-DD-HHmmss.jsonl'
Write-Host ''
