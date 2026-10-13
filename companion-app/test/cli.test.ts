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

test('tryb samodzielny nie ma wejść pokoju ani diagnostyki', () => {
  const result = parseLaunchArgs([])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.mode).toBe('standalone')
  expect(result.options.ts3ServerAddress).toBeNull()
  expect(result.options.channelId).toBeNull()
  expect(result.options.diagnostics).toBe(false)
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

test('flaga diagnostyki działa jako ostatni argument', () => {
  // Pułapka: readFlags gubił flagi bez wartości, więc samo `--diagnostics`
  // na końcu wiersza nigdy nie trafiało do mapy.
  const result = parseLaunchArgs(['--ts3-server=a:1', '--channel=2', '--diagnostics'])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.diagnostics).toBe(true)
})

test('flaga diagnostyki działa przed inną flagą', () => {
  const result = parseLaunchArgs(['--diagnostics', '--ts3-server=a:1', '--channel=2'])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.diagnostics).toBe(true)
})

test('flaga diagnostyki działa też w trybie samodzielnym', () => {
  const result = parseLaunchArgs(['--diagnostics'])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.mode).toBe('standalone')
  expect(result.options.diagnostics).toBe(true)
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
