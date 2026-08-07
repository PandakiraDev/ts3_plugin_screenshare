import { expect, test } from 'vitest'
import { connectionKey } from '../src/renderer/webrtc/session'
import type { RemoteStream } from '../src/renderer/hooks/useLobby'
import { pruneAbsent, tileLabel, buildTiles } from '../src/renderer/hooks/useLobby'

// Kafelki nie dotykaja MediaStreamu — wystarczy atrapa z wlasna tozsamoscia.
const image = (): MediaStream => ({}) as MediaStream

test('ekran ma dopisek w podpisie, kamera sama nazwe', () => {
  expect(tileLabel('Konrad', 'screen')).toBe('Konrad — ekran')
  expect(tileLabel('Konrad', 'camera')).toBe('Konrad')
})

// Sedno zadania: jedna osoba nadajaca oba rodzaje ma dwa kafelki, a nie jeden.
// Wspolny klucz kazalby Reactowi uznac je za ten sam element listy.
test('ekran i kamera jednej osoby to dwa kafelki o roznych kluczach', () => {
  const remote: RemoteStream[] = [
    { peerId: 'p1', kind: 'screen', stream: image() },
    { peerId: 'p1', kind: 'camera', stream: image() }
  ]
  const tiles = buildTiles([], remote, null, [{ peerId: 'p1', displayName: 'Ala' }])
  expect(tiles.map((t) => t.tileKey)).toEqual([
    connectionKey('p1', 'screen'),
    connectionKey('p1', 'camera')
  ])
  expect(tiles.map((t) => t.label)).toEqual(['Ala — ekran', 'Ala'])
})

test('wlasne strumienie ida pierwsze i sa oznaczone jako nasze', () => {
  const tiles = buildTiles(
    [{ kind: 'camera', stream: image() }],
    [{ peerId: 'p1', kind: 'screen', stream: image() }],
    { peerId: 'ja', displayName: 'Ja' },
    [{ peerId: 'p1', displayName: 'Ala' }]
  )
  expect(tiles[0]).toMatchObject({ tileKey: connectionKey('ja', 'camera'), isMe: true })
  expect(tiles[1]).toMatchObject({ tileKey: connectionKey('p1', 'screen'), isMe: false })
})

// Bez wlasnego wpisu nie ma czym podpisac kafelka ani czym go zakluczowac —
// lepiej go pominac niz pokazac bezimienny prostokat.
test('bez wlasnego wpisu nie ma wlasnych kafelkow', () => {
  expect(buildTiles([{ kind: 'camera', stream: image() }], [], null, [])).toEqual([])
})

test('nadajacy spoza listy uczestnikow dostaje zastepcza nazwe', () => {
  const tiles = buildTiles([], [{ peerId: 'x', kind: 'camera', stream: image() }], null, [])
  expect(tiles[0]?.label).toBe('Uczestnik')
})

// peer-left musi zabrac OBA strumienie odchodzacego. Usuniecie jednego zostawia
// osierocony kafelek, ktorego juz nic nie odswiezy ani nie sprzatnie.
test('odejscie osoby zabiera wszystkie jej strumienie', () => {
  const map = new Map<string, RemoteStream>([
    [connectionKey('p1', 'screen'), { peerId: 'p1', kind: 'screen', stream: image() }],
    [connectionKey('p1', 'camera'), { peerId: 'p1', kind: 'camera', stream: image() }],
    [connectionKey('p2', 'screen'), { peerId: 'p2', kind: 'screen', stream: image() }]
  ])
  expect([...pruneAbsent(map, ['p2']).keys()]).toEqual([connectionKey('p2', 'screen')])
})

// Nowa mapa przy kazdym zdarzeniu o uczestnikach przerysowalaby cala siatke —
// brak zmian ma zwrocic to samo, zeby wideo nie mrugalo.
test('gdy nikt nie odszedl, mapa zostaje ta sama', () => {
  const map = new Map<string, RemoteStream>([
    [connectionKey('p1', 'screen'), { peerId: 'p1', kind: 'screen', stream: image() }]
  ])
  expect(pruneAbsent(map, ['p1'])).toBe(map)
})
