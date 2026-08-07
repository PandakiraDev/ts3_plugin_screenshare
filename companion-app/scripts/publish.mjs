// Wydanie na GitHuba jednym poleceniem: npm run release
//
// Token bierzemy z `gh auth token`, a nie ze zmiennej środowiskowej ustawianej
// na stałe — nie ma powodu, żeby leżał gdziekolwiek na dysku. electron-builder
// czyta wyłącznie GH_TOKEN, więc podajemy mu go na czas jednego wywołania.
//
// Powstaje SZKIC wydania. Publikujesz go ręcznie na GitHubie — electron-updater
// szkiców nie widzi, więc do tego kliknięcia nikt aktualizacji nie dostanie.
//
// W wydaniu MUSZĄ wylądować dwa pliki: TS3-Screen-Share-Setup-<wersja>.exe
// ORAZ latest.yml. Bez tego drugiego electron-updater niczego nie znajdzie.
import { execFileSync } from 'node:child_process'

function run(command, args, options = {}) {
  // shell: true jest konieczne na Windows — npm, npx i gh to pliki .cmd,
  // których CreateProcess nie uruchomi bezpośrednio.
  execFileSync(command, args, { stdio: 'inherit', shell: true, ...options })
}

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
console.log('Sprawdz, czy sa TAM DWA pliki: .exe ORAZ latest.yml, i dopiero wtedy publikuj.')
