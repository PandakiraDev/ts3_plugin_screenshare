// Sprawdzian założenia, na którym stoi cicha aktualizacja wtyczki.
//
// Podczas autoaktualizacji TeamSpeak ZAWSZE działa — to on uruchomił aplikację
// przez CreateProcessW — więc ts3_screenshare.dll jest załadowany i zablokowany.
// Instalator nie może go nadpisać, ale MOŻE go przemianować. Na tym opiera się
// cała podmiana wtyczki (patrz build/installer.nsh i spec zadania 3.1).
//
// Ten skrypt bada zachowanie Windows, nie nasz kod, więc przechodzi od pierwszego
// uruchomienia. Jest po to, żeby zmiana w systemie albo blokada antywirusa nie
// zepsuła autoaktualizacji po cichu.
//
// Blokadę trzyma proces pomocniczy z LoadLibraryW (e2e/dll-lock.mjs) —
// uruchomiony TeamSpeak nie jest potrzebny. Pracujemy na KOPII w katalogu
// tymczasowym, nigdy na pliku zainstalowanym w %APPDATA%.
//
// Uruchomienie: npm run e2e:dll-swap
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockDll } from './dll-lock.mjs'

const SOURCE_DLL = join(import.meta.dirname, '..', 'build', 'ts3_screenshare.dll')

const workDir = mkdtempSync(join(tmpdir(), 'dll-swap-'))
const dllPath = join(workDir, 'ts3_screenshare.dll')
const oldPath = `${dllPath}.old`

copyFileSync(SOURCE_DLL, dllPath)
const originalBytes = readFileSync(dllPath)

const failures = []
function check(name, condition, detail) {
  if (condition) {
    console.log(`  OK   ${name}`)
  } else {
    console.log(`  BLAD ${name} — ${detail}`)
    failures.push(name)
  }
}

// Sprzatanie katalogu tymczasowego — wolane i z bloku finally ponizej,
// i z gałęzi „lockDll odrzucil", bo awaria moze wystapic zanim wejdziemy
// w try/finally (np. brak powershell.exe w PATH).
function cleanupWorkDir() {
  // Ubicie procesu jest asynchroniczne — Windows moze jeszcze przez chwile
  // trzymac zamapowany obraz, wiec kasowanie z ponowieniami. Zaleglosc
  // w katalogu tymczasowym jest nieszkodliwa, wiec bledu tu nie eskalujemy.
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    console.warn(`Nie udalo sie posprzatac ${workDir} — mozna skasowac recznie.`)
  }
}

let lock
try {
  lock = await lockDll(dllPath)
} catch (err) {
  cleanupWorkDir()
  throw err
}

try {
  console.log('DLL zaladowany przez proces pomocniczy — zaczynam sprawdzian.\n')

  // 1. Nadpisanie MUSI się nie udać. Gdyby się udało, cała ostrożność
  //    instalatora byłaby zbędna — ale i tak nieszkodliwa.
  let overwriteRefused = false
  try {
    writeFileSync(dllPath, Buffer.from([1, 2, 3]))
  } catch {
    overwriteRefused = true
  }
  check('nadpisanie zaladowanego DLL odrzucone', overwriteRefused, 'zapis sie udal')

  // 2. Przemianowanie MUSI się udać — to jest sedno mechanizmu.
  let renamed = false
  let renameError = ''
  try {
    renameSync(dllPath, oldPath)
    renamed = true
  } catch (err) {
    renameError = String(err)
  }
  check('przemianowanie zaladowanego DLL na .old', renamed, renameError)

  // 3. Nowy plik pod starą nazwą — to robi instalator zaraz po przemianowaniu.
  const newBytes = Buffer.from([9, 9, 9])
  let wroteNew = false
  try {
    writeFileSync(dllPath, newBytes)
    wroteNew = true
  } catch (err) {
    check('zapis nowego DLL pod stara nazwa', false, String(err))
  }
  if (wroteNew) {
    check('zapis nowego DLL pod stara nazwa', true)
    check(
      'nowy plik ma nowa tresc',
      readFileSync(dllPath).equals(newBytes),
      'tresc sie nie zgadza'
    )
  }

  // 4. Stary plik nietkniety — TeamSpeak dalej go wykonuje aż do restartu.
  if (renamed) {
    check(
      'stary DLL zachowany bajt w bajt pod .old',
      readFileSync(oldPath).equals(originalBytes),
      'tresc .old rozni sie od oryginalu'
    )
  }
} finally {
  lock.release()
  cleanupWorkDir()
}

if (failures.length > 0) {
  console.error(`\nNIEUDANE: ${failures.length} — autoaktualizacja wtyczki nie ma sie na czym oprzec.`)
  process.exit(1)
}
console.log('\nWszystko przeszlo. Mechanizm podmiany wtyczki ma podstawy.')
