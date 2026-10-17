import { expect, test } from 'vitest'
import { DEFAULT_SIGNALING_URL, parseLaunchArgs } from '../src/shared/cli'
import { deriveRoomId } from '../src/shared/room'

test('bez argumentów startuje tryb samodzielny', () => {
  const result = parseLaunchArgs([])
  if (!result.ok) throw new Error(result.error)
  expect(result.options.mode).toBe('standalone')
  expect(result.options.roomId).toBeNull()
})

test('serwer TS3 i kanał uruchamiają lobby', () => {
  // Nie ma już podziału na "streamera" i "widza" — jest jedno lobby,
  // w którym każdy ogląda i każdy może zacząć nadawać.
  const result = parseLaunchArgs(['--ts3-server=ts.przyklad.pl:9987', '--channel=42'])
  if (!result.ok) throw new Error(result.error)
  expect(result.options.mode).toBe('lobby')
  expect(result.options.roomId).toBe(deriveRoomId('ts.przyklad.pl:9987', '42'))
})

test('dwie instancje z tymi samymi danymi trafiają do tego samego pokoju', () => {
  const args = ['--ts3-server=ts.przyklad.pl:9987', '--channel=42']
  const a = parseLaunchArgs(args)
  const b = parseLaunchArgs(args)
  if (!a.ok || !b.ok) throw new Error('miało się udać')
  expect(a.options.roomId).toBe(b.options.roomId)
})

test('domyślny adres sygnalizacji, gdy nie podano', () => {
  const result = parseLaunchArgs(['--ts3-server=a.pl', '--channel=1'])
  if (!result.ok) throw new Error(result.error)
  expect(result.options.signalingUrl).toBe(DEFAULT_SIGNALING_URL)
})

test('adres sygnalizacji da się nadpisać do testów lokalnych', () => {
  const result = parseLaunchArgs([
    '--ts3-server=a.pl',
    '--channel=1',
    '--signaling=ws://127.0.0.1:8080'
  ])
  if (!result.ok) throw new Error(result.error)
  expect(result.options.signalingUrl).toBe('ws://127.0.0.1:8080')
})

test('sam serwer TS3 bez kanału to błąd, nie cichy standalone', () => {
  // Gdyby to przeszło jako standalone, plugin odpaliłby okno, które
  // nigdzie się nie łączy, i nikt by nie wiedział dlaczego.
  expect(parseLaunchArgs(['--ts3-server=a.pl']).ok).toBe(false)
})

test('sam kanał bez serwera TS3 to błąd', () => {
  expect(parseLaunchArgs(['--channel=1']).ok).toBe(false)
})

test('argumenty Electrona przed nazwą pliku nie mylą parsera', () => {
  const result = parseLaunchArgs([
    'C:\\Program Files\\TS3 Screen Share\\app.exe',
    '--inspect',
    '--ts3-server=a.pl',
    '--channel=1'
  ])
  if (!result.ok) throw new Error(result.error)
  expect(result.options.mode).toBe('lobby')
})

test('obsługuje zapis z pojedynczą spacją zamiast znaku równości', () => {
  const result = parseLaunchArgs(['--ts3-server', 'a.pl', '--channel', '1'])
  if (!result.ok) throw new Error(result.error)
  expect(result.options.roomId).toBe(deriveRoomId('a.pl', '1'))
})

test('nick z TS3 trafia do opcji uruchomienia', () => {
  const result = parseLaunchArgs([
    '--ts3-server=a.pl',
    '--channel=1',
    '--nick=Konrad'
  ])
  if (!result.ok) throw new Error(result.error)
  expect(result.options.displayName).toBe('Konrad')
})

test('brak nicku zostawia null — zastępnik nada serwer', () => {
  const result = parseLaunchArgs(['--ts3-server=a.pl', '--channel=1'])
  if (!result.ok) throw new Error(result.error)
  expect(result.options.displayName).toBeNull()
})

test('tryb samodzielny nie ma wejść pokoju', () => {
  const result = parseLaunchArgs([])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.mode).toBe('standalone')
  expect(result.options.ts3ServerAddress).toBeNull()
  expect(result.options.channelId).toBeNull()
})

test('wejścia pokoju przeżywają drogę do opcji', () => {
  // Bez tego odcisk palca lobby pokazywałby wartości, z których skrótu
  // NIE wyliczono — czyli diagnostykę gorszą niż jej brak.
  const result = parseLaunchArgs(['--ts3-server=ts.serwer.pl:9987', '--channel=42'])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.ts3ServerAddress).toBe('ts.serwer.pl:9987')
  expect(result.options.channelId).toBe('42')
})

test('identyfikator pokoju nadal zgadza się ze skrótem z tych samych wejść', () => {
  const result = parseLaunchArgs(['--ts3-server=ts.serwer.pl:9987', '--channel=42'])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.roomId).toBe(deriveRoomId('ts.serwer.pl:9987', '42'))
})

test('--diagnostics jest flagą NIEZNANĄ i nie trafia do opcji', () => {
  /*
   * W 0.3.4 flaga zniknęła: podgląd zużycia i dziennik należą do każdego,
   * a zapis na dysk ma własne pole wyboru w ustawieniach. Od tej chwili
   * `--diagnostics` jest dla parsera tym samym co `--inspect` wyżej — ma być
   * IGNOROWANA, a nie wywalać wywołania.
   *
   * Ten test pilnuje DWÓCH rzeczy naraz, bo obie zepsułyby się po cichu:
   * 1. stary skrót `.lnk` właściciela nadal odpala aplikację do tego samego
   *    pokoju (tryb i wejścia bez zmian), zamiast dostać błąd;
   * 2. pole `diagnostics` nie wraca do `LaunchOptions` — wróciłoby jako
   *    martwe, bo w całym `src/` nie ma już ani jednego jego czytelnika.
   */
  const lobby = parseLaunchArgs(['--ts3-server=a:1', '--channel=2', '--diagnostics'])
  if (!lobby.ok) throw new Error(lobby.error)
  expect(lobby.options.mode).toBe('lobby')
  expect(lobby.options.channelId).toBe('2')
  expect('diagnostics' in lobby.options).toBe(false)

  // Także na początku wiersza, w trybie samodzielnym i powtórzona — to trzy
  // różne gałęzie `readFlags`, a każda z nich miała kiedyś własny test.
  const standalone = parseLaunchArgs(['--diagnostics', '--diagnostics'])
  if (!standalone.ok) throw new Error(standalone.error)
  expect(standalone.options.mode).toBe('standalone')
  expect('diagnostics' in standalone.options).toBe(false)
})

test('obsługa flag logicznych nie psuje flag z wartością', () => {
  const result = parseLaunchArgs(['--ts3-server', 'a:1', '--channel', '2', '--nick', 'Marek'])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.ts3ServerAddress).toBe('a:1')
  expect(result.options.channelId).toBe('2')
  expect(result.options.displayName).toBe('Marek')
})

test('puste --signaling cofa się do adresu domyślnego, nie do pustego', () => {
  // Naprawa flag logicznych wprowadziła tu pułapkę: `--signaling` bez wartości
  // trafia do mapy jako pusty łańcuch, a `??` cofa się do domyślnego tylko przy
  // `null` i `undefined`. Bez tego aplikacja próbowałaby łączyć się z pustym adresem.
  const result = parseLaunchArgs(['--signaling', '--ts3-server=a:1', '--channel=2'])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.signalingUrl).toBe(DEFAULT_SIGNALING_URL)
})

test('wejścia pokoju zostają w postaci surowej, nie znormalizowanej', () => {
  // Wartości dobrane tak, żeby normalizacja w `deriveRoomId` je ZMIENIŁA:
  // wielkie litery w adresie i spacje wokół numeru kanału. Poprzedni test
  // tego nie pilnował, bo używał wartości, których normalizacja nie dotyka —
  // przechodził także wtedy, gdy pola zapisywano znormalizowane.
  const result = parseLaunchArgs(['--ts3-server=TS.Serwer.PL:9987', '--channel= 42 '])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.ts3ServerAddress).toBe('TS.Serwer.PL:9987')
  expect(result.options.channelId).toBe(' 42 ')
  // Skrót liczy się nadal ze znormalizowanych wejść — to jest w porządku
  // i ma tak zostać; surowa postać służy wyłącznie pokazaniu człowiekowi,
  // co naprawdę podał.
  expect(result.options.roomId).toBe(deriveRoomId('TS.Serwer.PL:9987', ' 42 '))
})

test('powtórzona flaga bez wartości nie kasuje wartości podanej wcześniej', () => {
  // Obsługa flag logicznych ustawiała znacznik obecności BEZWARUNKOWO, więc
  // drugie `--signaling` cicho porzucało jawnie podany adres i aplikacja szła
  // do serwera produkcyjnego. Realne przy ręcznym wywołaniu z dopiskiem, a
  // ręczne wywołanie było jedynym trybem, w którym używało się `--diagnostics`.
  const result = parseLaunchArgs([
    '--signaling=ws://127.0.0.1:8080',
    '--signaling',
    '--ts3-server=a:1',
    '--channel=2'
  ])
  if (!result.ok) throw new Error(result.error)
  expect(result.options.signalingUrl).toBe('ws://127.0.0.1:8080')
})

test('powtórzona flaga bez wartości nie kasuje nicku', () => {
  // `--diagnostics` na końcu zostaje w tym wywołaniu świadomie, choć flaga już
  // nie istnieje: to jest dokładnie ten wiersz, który ma w skrócie `.lnk`
  // właściciel, czyli jedyny realny sposób, żeby obok wartościowych flag stanęła
  // flaga bez wartości.
  const result = parseLaunchArgs([
    '--ts3-server=a:1',
    '--channel=2',
    '--nick',
    'Marek',
    '--nick',
    '--diagnostics'
  ])
  if (!result.ok) throw new Error(result.error)
  expect(result.options.displayName).toBe('Marek')
})

test('powtórzone flagi bez wartości nie zamieniają lobby na standalone', () => {
  // Ta ścieżka jest wprost zabroniona komentarzem w cli.ts: cichy powrót do
  // standalone dałby okno, które donikąd się nie łączy, bez śladu dlaczego.
  const result = parseLaunchArgs([
    '--channel=42',
    '--ts3-server',
    '-x',
    '--channel',
    '--ts3-server'
  ])
  if (!result.ok) throw new Error(result.error)
  expect(result.options.mode).toBe('lobby')
  expect(result.options.channelId).toBe('42')
  expect(result.options.ts3ServerAddress).toBe('-x')
})

test('kolejność odwrotna nadal wygrywa wartością, nie obecnością', () => {
  // Druga kolejność (`--klucz` przed `--klucz=wartość`) chodzi inną gałęzią:
  // tu wartość ma nadpisać sam znacznik obecności, a nie odwrotnie.
  const result = parseLaunchArgs([
    '--nick',
    '--nick=Marek',
    '--ts3-server=a:1',
    '--channel=2'
  ])
  if (!result.ok) throw new Error(result.error)
  expect(result.options.displayName).toBe('Marek')
})

/*
 * Test „dwa razy ta sama flaga logiczna nadal ją włącza" został USUNIĘTY razem
 * z flagą, a nie przepisany na coś innego: po 0.3.4 `LaunchOptions` nie ma ani
 * jednego pola logicznego, więc obecności powtórzonej flagi bez wartości nie da
 * się już z zewnątrz zobaczyć. Powtórzenie sprawdza teraz test nieznanej flagi
 * wyżej, a jedyne, co z tej gałęzi `readFlags` nadal da się zmierzyć — że
 * `flags.set` jest WARUNKOWY i nie kasuje wartości podanej wcześniej —
 * pilnują trzy testy nad tym miejscem (sygnalizacja, nick, lobby).
 */
