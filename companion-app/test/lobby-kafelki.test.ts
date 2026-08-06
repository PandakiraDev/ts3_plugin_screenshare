import { expect, test } from 'vitest'
import { connectionKey } from '../src/renderer/webrtc/session'
import type { RemoteStream } from '../src/renderer/hooks/useLobby'
import { odsiejNieobecnych, podpisKafelka, ulozKafelki } from '../src/renderer/hooks/useLobby'

// Kafelki nie dotykaja MediaStreamu — wystarczy atrapa z wlasna tozsamoscia.
const obraz = (): MediaStream => ({}) as MediaStream

test('ekran ma dopisek w podpisie, kamera sama nazwe', () => {
  expect(podpisKafelka('Konrad', 'screen')).toBe('Konrad — ekran')
  expect(podpisKafelka('Konrad', 'camera')).toBe('Konrad')
})

// Sedno zadania: jedna osoba nadajaca oba rodzaje ma dwa kafelki, a nie jeden.
// Wspolny klucz kazalby Reactowi uznac je za ten sam element listy.
test('ekran i kamera jednej osoby to dwa kafelki o roznych kluczach', () => {
  const zdalne: RemoteStream[] = [
    { peerId: 'p1', kind: 'screen', stream: obraz() },
    { peerId: 'p1', kind: 'camera', stream: obraz() }
  ]
  const kafelki = ulozKafelki([], zdalne, null, [{ peerId: 'p1', displayName: 'Ala' }])
  expect(kafelki.map((k) => k.klucz)).toEqual([
    connectionKey('p1', 'screen'),
    connectionKey('p1', 'camera')
  ])
  expect(kafelki.map((k) => k.podpis)).toEqual(['Ala — ekran', 'Ala'])
})

test('wlasne strumienie ida pierwsze i sa oznaczone jako nasze', () => {
  const kafelki = ulozKafelki(
    [{ kind: 'camera', stream: obraz() }],
    [{ peerId: 'p1', kind: 'screen', stream: obraz() }],
    { peerId: 'ja', displayName: 'Ja' },
    [{ peerId: 'p1', displayName: 'Ala' }]
  )
  expect(kafelki[0]).toMatchObject({ klucz: connectionKey('ja', 'camera'), toJa: true })
  expect(kafelki[1]).toMatchObject({ klucz: connectionKey('p1', 'screen'), toJa: false })
})

// Bez wlasnego wpisu nie ma czym podpisac kafelka ani czym go zakluczowac —
// lepiej go pominac niz pokazac bezimienny prostokat.
test('bez wlasnego wpisu nie ma wlasnych kafelkow', () => {
  expect(ulozKafelki([{ kind: 'camera', stream: obraz() }], [], null, [])).toEqual([])
})

test('nadajacy spoza listy uczestnikow dostaje zastepcza nazwe', () => {
  const kafelki = ulozKafelki([], [{ peerId: 'x', kind: 'camera', stream: obraz() }], null, [])
  expect(kafelki[0]?.podpis).toBe('Uczestnik')
})

// peer-left musi zabrac OBA strumienie odchodzacego. Usuniecie jednego zostawia
// osierocony kafelek, ktorego juz nic nie odswiezy ani nie sprzatnie.
test('odejscie osoby zabiera wszystkie jej strumienie', () => {
  const mapa = new Map<string, RemoteStream>([
    [connectionKey('p1', 'screen'), { peerId: 'p1', kind: 'screen', stream: obraz() }],
    [connectionKey('p1', 'camera'), { peerId: 'p1', kind: 'camera', stream: obraz() }],
    [connectionKey('p2', 'screen'), { peerId: 'p2', kind: 'screen', stream: obraz() }]
  ])
  expect([...odsiejNieobecnych(mapa, ['p2']).keys()]).toEqual([connectionKey('p2', 'screen')])
})

// Nowa mapa przy kazdym zdarzeniu o uczestnikach przerysowalaby cala siatke —
// brak zmian ma zwrocic to samo, zeby wideo nie mrugalo.
test('gdy nikt nie odszedl, mapa zostaje ta sama', () => {
  const mapa = new Map<string, RemoteStream>([
    [connectionKey('p1', 'screen'), { peerId: 'p1', kind: 'screen', stream: obraz() }]
  ])
  expect(odsiejNieobecnych(mapa, ['p1'])).toBe(mapa)
})
