// Cichy instalator na ZABLOKOWANYM DLL wtyczki — dokładnie sytuacja każdej
// autoaktualizacji: TeamSpeak działa, więc ts3_screenshare.dll jest załadowany.
//
// UWAGA: TEN SKRYPT NAPRAWDĘ INSTALUJE APLIKACJĘ. Dotyka
// %LOCALAPPDATA%\Programs i %APPDATA%\TS3Client\plugins. Nie wchodzi do
// `npm test` i nie uruchamia się sam.
//
// Blokadę DLL trzyma proces pomocniczy z LoadLibraryW, więc uruchomiony
// TeamSpeak nie jest potrzebny.
//
// Co dokładnie sprawdzamy:
//   1. instalator KOŃCZY SIĘ w rozsądnym czasie — przed poprawką wisi na
//      MessageBoksie "zamknij TeamSpeaka", bo MessageBox w NSIS wyświetla się
//      także przy /S;
//   2. powstał ts3_screenshare.dll.old ze STARĄ zawartością — dowód, że poszła
//      ścieżka z przemianowaniem, a nie zwykłe nadpisanie;
//   3. DRUGI cichy przebieg BEZ zwalniania blokady też przechodzi. To realny
//      przypadek "dwie aktualizacje bez restartu TeamSpeaka": .old jest wtedy
//      zablokowany i nie da się go skasować, a ts3_screenshare.dll to już nowy
//      plik, którego nikt nie trzyma — instalator musi pójść zwykłym
//      nadpisaniem i nie próbować przemianowywać na zajętą nazwę.
//
// Uruchomienie: npm run installer && npm run e2e:silent-install
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { lockDll } from './dll-lock.mjs'

const LIMIT_MS = 180_000

const pluginsDir = join(process.env.APPDATA ?? '', 'TS3Client', 'plugins')
const installedDll = join(pluginsDir, 'ts3_screenshare.dll')
const oldDll = `${installedDll}.old`

const releaseDir = join(import.meta.dirname, '..', 'release')
const setup = readdirSync(releaseDir).find(
  (name) => name.startsWith('TS3-Screen-Share-Setup-') && name.endsWith('.exe')
)
if (!setup) {
  console.error('Brak instalatora w release/. Zbuduj go: npm run installer')
  process.exit(1)
}
if (!existsSync(installedDll)) {
  console.error(`Brak ${installedDll}. Zainstaluj aplikacje recznie raz, potem wroc tutaj.`)
  process.exit(1)
}

const beforeBytes = readFileSync(installedDll)

// Sprzątamy zaległość po poprzednim przebiegu, żeby wynik był jednoznaczny.
// Jeśli się nie da (TeamSpeak trzyma stary plik), mówimy o tym wprost — wynik
// byłby wtedy nie do odczytania.
try {
  rmSync(oldDll, { force: true })
} catch {
  console.error(`Nie moge skasowac ${oldDll} — ktos go trzyma. Zamknij TeamSpeaka i sprobuj ponownie.`)
  process.exit(1)
}

// Rzucamy wyjatkiem zamiast process.exit — `finally` musi zwolnic proces
// pomocniczy, a process.exit blokow finally NIE wykonuje.
function fail(message) {
  throw new Error(message)
}

/** Jeden cichy przebieg instalatora. Zwraca kod wyjscia albo rzuca po limicie czasu. */
function runInstaller(label) {
  console.log(`\n[${label}] uruchamiam ${setup} z /S...`)
  const installer = spawn(join(releaseDir, setup), ['/S'])
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      installer.kill()
      reject(
        new Error(
          `[${label}] instalator nie skonczyl w ${LIMIT_MS / 1000} s.\n` +
            'Prawie na pewno wisi na MessageBoksie "zamknij TeamSpeaka" z customInit.\n' +
            'Przed poprawka w build/installer.nsh to jest OCZEKIWANY stan RED.'
        )
      )
    }, LIMIT_MS)
    installer.on('exit', (code) => {
      clearTimeout(timer)
      console.log(`[${label}] instalator zakonczyl sie z kodem ${code}.`)
      resolve(code)
    })
  })
}

const lock = await lockDll(installedDll)

try {
  console.log('DLL zablokowany przez proces pomocniczy.')

  // PRZEBIEG 1 — zablokowany DLL, spodziewamy sie sciezki z przemianowaniem.
  const exitCode1 = await runInstaller('przebieg 1')
  if (exitCode1 !== 0) {
    fail(`[przebieg 1] instalator zakonczyl sie kodem ${exitCode1}, oczekiwano 0`)
  }

  if (!existsSync(oldDll)) {
    fail(`nie powstal ${oldDll} — sciezka z przemianowaniem sie nie wykonala`)
  }
  if (!readFileSync(oldDll).equals(beforeBytes)) {
    fail('.old nie zawiera starego DLL')
  }
  if (!existsSync(installedDll)) {
    fail(`nie ma ${installedDll} — instalator nie polozyl nowego pliku`)
  }
  console.log('  OK  stary DLL czeka w .old, nowy lezy pod wlasciwa nazwa')

  // PRZEBIEG 2 — bez zwalniania blokady. To "dwie aktualizacje bez restartu
  // TeamSpeaka": .old jest zajety i nie da sie go skasowac, ale
  // ts3_screenshare.dll to juz nowy plik, ktorego nikt nie trzyma — instalator
  // ma pojsc zwyklym nadpisaniem, a NIE probowac przemianowac na zajete .old.
  //
  // UWAGA na granice tego sprawdzenia — NIE probowac go "wzmocnic" ponizszymi
  // pomyslami, obie sa slepe uliczki:
  //   - porownanie tresci installedDll nic nie da: oba przebiegi instaluja
  //     ten sam build/ts3_screenshare.dll, wiec bajty przed i po sa
  //     identyczne z definicji, niezaleznie czy przebieg 2 cokolwiek zrobil;
  //   - znacznik czasu (mtime) prawdopodobnie tez nie pomoze: polecenie File
  //     w NSIS zwykle zachowuje date modyfikacji pliku zrodlowego, wiec mtime
  //     po obu przebiegach bylby ten sam. Nie sprawdzano tego empirycznie —
  //     wymagaloby to uruchomienia instalatora, na co ten skrypt (etap
  //     pisania, przed zgoda na wykonanie) nie pozwala.
  // Realny sygnal, jaki ten test daje: instalator skonczyl bez dialogu (czyli
  // NIE wpadl w sciezke z nagiem przy zajetym .old), wyszedl kodem 0 i NIE
  // ruszyl .old. To NIE dowodzi, ze przebieg 2 faktycznie nadpisal
  // installedDll nowa tresca — tylko ze nie zepsul .old i nie zawisl.
  const exitCode2 = await runInstaller('przebieg 2')
  if (exitCode2 !== 0) {
    fail(`[przebieg 2] instalator zakonczyl sie kodem ${exitCode2}, oczekiwano 0`)
  }

  if (!readFileSync(oldDll).equals(beforeBytes)) {
    fail('.old zmienil sie w drugim przebiegu — cos nadpisalo zablokowany plik')
  }
  if (!existsSync(installedDll)) {
    fail(`nie ma ${installedDll} po drugim przebiegu`)
  }
  console.log('  OK  drugi przebieg bez restartu TS3 tez przeszedl')

  console.log('\nOK: cichy instalator dziala przy zablokowanym DLL, dwa razy z rzedu.')
} catch (err) {
  console.error(`\nBLAD: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  lock.release()
}
