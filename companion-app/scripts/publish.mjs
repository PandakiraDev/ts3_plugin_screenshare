// Wydanie na GitHuba jednym poleceniem: npm run release
//
// Token bierzemy z `gh auth token`, a nie ze zmiennej środowiskowej ustawianej
// na stałe — nie ma powodu, żeby leżał gdziekolwiek na dysku. electron-builder
// czyta wyłącznie GH_TOKEN, więc podajemy mu go na czas jednego wywołania.
//
// Powstaje SZKIC wydania. Publikujesz go ręcznie na GitHubie — electron-updater
// szkiców nie widzi, więc do tego kliknięcia nikt aktualizacji nie dostanie.
//
// W wydaniu MUSZĄ wylądować co najmniej dwa pliki: TS3-Screen-Share-Setup-<wersja>.exe
// ORAZ latest.yml. Bez tego drugiego electron-updater niczego nie znajdzie.
// electron-builder dokłada do tego .exe.blockmap — to normalny trzeci plik
// (służy pobieraniom różnicowym), nie powód do niepokoju.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
// `companion-app/build/` to zasoby ŹRÓDŁOWE electron-buildera — DLL wtyczki
// musi tam leżeć PRZED pakowaniem, bo nikt go tam nie kopiuje automatycznie
// (plik jest ignorowany przez git, patrz .gitignore). installer.nsh wkłada do
// instalatora dokładnie to, co akurat tam leży.
const COMPANION_DLL = join(scriptDir, '..', 'build', 'ts3_screenshare.dll')
const PLUGIN_DLL = join(scriptDir, '..', '..', 'plugin', 'build', 'ts3_screenshare.dll')

function run(command, args, options = {}) {
  // shell: true jest konieczne na Windows — npm, npx i gh to pliki .cmd,
  // których CreateProcess nie uruchomi bezpośrednio.
  execFileSync(command, args, { stdio: 'inherit', shell: true, ...options })
}

/**
 * Strażnik świeżości DLL wtyczki. Bez niego wydanie może po cichu wieźć
 * stary plugin — nikt go dla nas nie buduje ani nie porównuje.
 *
 * Brak pliku PRZERYWA wydanie: bez niego electron-builder i tak wybuchnie w
 * NSIS, tyle że bez wyjaśnienia. Różnica bajtowa z `plugin/build/` tylko
 * OSTRZEGA — to może być świadomie stara kopia (np. wtyczka nie zmieniła się
 * od dawna), więc decyzję zostawiamy człowiekowi, nie zgadujemy za niego.
 */
function checkPluginDll() {
  if (!existsSync(COMPANION_DLL)) {
    console.error(
      `Brak ${COMPANION_DLL}.\n` +
        'Ten plik nie jest w repo (patrz .gitignore) — trzeba go zbudowac i skopiowac recznie:\n' +
        '  1) plugin/build.bat\n' +
        '  2) skopiuj plugin/build/ts3_screenshare.dll do companion-app/build/ts3_screenshare.dll'
    )
    process.exit(1)
  }

  if (!existsSync(PLUGIN_DLL)) return

  const companionBytes = readFileSync(COMPANION_DLL)
  const pluginBytes = readFileSync(PLUGIN_DLL)
  if (companionBytes.equals(pluginBytes)) return

  const companionStat = statSync(COMPANION_DLL)
  const pluginStat = statSync(PLUGIN_DLL)
  console.warn(
    '\nUWAGA: companion-app/build/ts3_screenshare.dll ROZNI SIE od plugin/build/ts3_screenshare.dll.\n' +
      `  companion-app/build/ts3_screenshare.dll — zmieniony ${companionStat.mtime.toISOString()}\n` +
      `  plugin/build/ts3_screenshare.dll        — zmieniony ${pluginStat.mtime.toISOString()}\n` +
      'Jesli to nie jest zamierzone (np. zapomniana kopia po plugin/build.bat), przerwij\n' +
      'teraz (Ctrl+C) i skopiuj recznie plugin/build/ts3_screenshare.dll do companion-app/build/.\n'
  )
}

checkPluginDll()

let token = ''
try {
  token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', shell: true }).trim()
} catch {
  token = ''
}
if (!token) {
  console.error('Nie udalo sie pobrac tokenu. Zaloguj sie: gh auth login')
  process.exit(1)
}

run('npm', ['run', 'sync:native'])
run('npm', ['run', 'build'])
run('npx', ['electron-builder', '--win', '--publish', 'always'], {
  env: { ...process.env, GH_TOKEN: token }
})

console.log('\nGotowe. Szkic wydania czeka na GitHubie:')
console.log('  https://github.com/PandakiraDev/ts3_plugin_screenshare/releases')
console.log('Sprawdz, czy sa TAM co najmniej DWA pliki: .exe ORAZ latest.yml (trzeci,')
console.log('.exe.blockmap, jest normalny), i dopiero wtedy publikuj.')
