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
