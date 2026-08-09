// Blokada DLL na potrzeby sprawdzianow autoaktualizacji.
//
// Windows blokuje plik DLL dopiero wtedy, gdy jest ZALADOWANY jako obraz
// (LoadLibrary) — zwykle otwarcie do odczytu nie wystarczy. Node tego nie
// potrafi: process.dlopen przyjmuje wylacznie dodatki N-API, a plugin TS3 nim
// nie jest. Stad proces pomocniczy w PowerShellu.
//
// Wspolny modul, bo blokady potrzebuja dwa sprawdziany: dll-swap.mjs (sam
// mechanizm) i silent-install.mjs (caly instalator). Ten sam wzorzec co
// e2e/cdp.mjs, ktory jest wspolnym harnessem dla sprawdzianow w Electronie.
import { spawn } from 'node:child_process'

const LOAD_TIMEOUT_MS = 30_000

/**
 * Laduje DLL w osobnym procesie i trzyma go, dopoki nie zawolasz release().
 *
 * Rzuca, gdy:
 * - nie da sie uruchomic procesu pomocniczego PowerShell (`error` na `spawn`);
 * - proces pomocniczy zakonczy sie (padnie) zanim wypisze `LOADED` — np.
 *   `Add-Type` nie znajdzie kompilatora C# — komunikat bledu niesie zebrany
 *   stderr, zeby prawdziwa przyczyna nie zniknela w nieczytanym strumieniu;
 * - `LoadLibraryW` jawnie odmowi (`LOAD-FAILED`);
 * - minie `LOAD_TIMEOUT_MS` bez zadnego z powyzszych.
 *
 * Sprawdzian bez PRAWDZIWEJ blokady niczego nie dowodzi, wiec we wszystkich
 * tych przypadkach lepiej przerwac niz zaraportowac falszywy sukces.
 */
export async function lockDll(dllPath) {
  // Apostrofy w sciezce podwajamy — PowerShell tak escapuje w napisach
  // pojedynczo cytowanych.
  const script = `
Add-Type -Name N -Namespace W -MemberDefinition '[DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibraryW(string p);'
$h = [W.N]::LoadLibraryW('${dllPath.replace(/'/g, "''")}')
if ($h -eq [IntPtr]::Zero) { Write-Output 'LOAD-FAILED'; exit 1 }
Write-Output 'LOADED'
while ($true) { Start-Sleep -Seconds 3600 }
`

  const holder = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])

  // Zbieramy stderr od poczatku, nie tylko po awarii — inaczej tresc
  // wypisana PRZED wyjsciem procesu bylaby juz utracona w momencie, gdy
  // dopiero zaczynamy jej sluchac.
  let stderr = ''
  holder.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      holder.kill()
      reject(new Error(`proces pomocniczy nie zaladowal DLL w ${LOAD_TIMEOUT_MS / 1000} s`))
    }, LOAD_TIMEOUT_MS)

    // Gdy powershell.exe w ogole nie da sie uruchomic (brak w PATH, polityka
    // grupy, blokada antywirusa) — bez tego nasluchu Node rzucilby
    // nieobsluzonym wyjatkiem zamiast odrzucic obietnice.
    holder.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`nie udalo sie uruchomic procesu pomocniczego PowerShell: ${err.message}`))
    })

    // Proces moze wystartowac, a mimo to paresc PRZED wypisaniem LOADED/
    // LOAD-FAILED (np. Add-Type nie znajdzie kompilatora C#). Bez tego
    // nasluchu skrypt czekalby pelen LOAD_TIMEOUT_MS i zaraportowal mylacy
    // komunikat "nie zaladowal DLL", milczac o prawdziwym powodzie.
    holder.on('exit', (code) => {
      clearTimeout(timer)
      reject(
        new Error(
          `proces pomocniczy PowerShell zakonczyl sie przedwczesnie (kod ${code}), ` +
            `zanim zaladowal DLL. stderr: ${stderr.trim() || '(puste)'}`
        )
      )
    })

    holder.stdout.on('data', (chunk) => {
      const text = String(chunk)
      if (text.includes('LOADED')) {
        clearTimeout(timer)
        holder.removeAllListeners('exit')
        resolve()
      }
      if (text.includes('LOAD-FAILED')) {
        clearTimeout(timer)
        holder.removeAllListeners('exit')
        holder.kill()
        reject(new Error('LoadLibraryW odmowil zaladowania DLL — sprawdzian bylby bezwartosciowy'))
      }
    })
  })

  return { release: () => holder.kill() }
}
