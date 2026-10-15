import { expect, test } from 'vitest'
import {
  applyTileOrder,
  forgetMissingTiles,
  moveTile,
  visibleTiles
} from '../src/shared/tileLayout'
import type { Tile } from '../src/renderer/hooks/useLobby'

/**
 * Atrapa kafelka. `stream` jest rzutowany, bo `MediaStream` nie istnieje
 * w gołym Node — a te funkcje go nie dotykają, tylko przenoszą.
 */
function tile(peerId: string, kind: 'screen' | 'camera'): Tile {
  return {
    tileKey: `${peerId}:${kind}`,
    peerId,
    kind,
    stream: null as unknown as MediaStream,
    label: `${peerId} ${kind}`,
    isMe: false
  }
}

const keyOf = (item: Tile): string => item.tileKey

test('ukryty kafelek nie wychodzi, pozostałe zostają', () => {
  const tiles = [tile('a', 'screen'), tile('b', 'screen')]
  const visible = visibleTiles(tiles, new Set(['a:screen']))
  expect(visible.map(keyOf)).toEqual(['b:screen'])
})

test('ukrycie ekranu nie ukrywa kamery tej samej osoby', () => {
  // Jedna osoba może nadawać oba rodzaje naraz i to są DWA kafelki. Gdyby
  // ukrywanie działało po `peerId`, schowanie ekranu zabrałoby też kamerę —
  // a to dwie różne rzeczy, których widz chce osobno.
  const tiles = [tile('a', 'screen'), tile('a', 'camera')]
  const visible = visibleTiles(tiles, new Set(['a:screen']))
  expect(visible.map(keyOf)).toEqual(['a:camera'])
})

test('pusty zbiór ukrytych przepuszcza wszystko', () => {
  const tiles = [tile('a', 'screen'), tile('b', 'camera')]
  expect(visibleTiles(tiles, new Set()).map(keyOf)).toEqual(['a:screen', 'b:camera'])
})

test('kolejność zapamiętana jest zachowana', () => {
  const tiles = [tile('a', 'screen'), tile('b', 'screen'), tile('c', 'screen')]
  const order = ['c:screen', 'a:screen', 'b:screen']
  expect(applyTileOrder(tiles, order, keyOf).map(keyOf)).toEqual(order)
})

test('kafelek nieobecny w kolejności idzie na KONIEC, nie w środek', () => {
  // To jest reguła, która decyduje, czy ułożenie przeżyje wejście kolejnej
  // osoby. Nowy strumień nie ma prawa wskoczyć w środek tego, co widz właśnie
  // ustawił — a zdarza się to w prawie każdej sesji.
  const tiles = [tile('a', 'screen'), tile('nowy', 'screen'), tile('b', 'screen')]
  const order = ['b:screen', 'a:screen']
  expect(applyTileOrder(tiles, order, keyOf).map(keyOf)).toEqual([
    'b:screen',
    'a:screen',
    'nowy:screen'
  ])
})

test('klucz z kolejności bez kafelka jest pomijany i nie zostawia dziury', () => {
  const tiles = [tile('a', 'screen')]
  const order = ['znikniety:screen', 'a:screen']
  expect(applyTileOrder(tiles, order, keyOf).map(keyOf)).toEqual(['a:screen'])
})

test('nowe kafelki na końcu zachowują swoją wzajemną kolejność', () => {
  const tiles = [tile('x', 'screen'), tile('y', 'screen'), tile('a', 'screen')]
  expect(applyTileOrder(tiles, ['a:screen'], keyOf).map(keyOf)).toEqual([
    'a:screen',
    'x:screen',
    'y:screen'
  ])
})

test('pusta kolejność zostawia porządek źródłowy', () => {
  const tiles = [tile('a', 'screen'), tile('b', 'screen')]
  expect(applyTileOrder(tiles, [], keyOf).map(keyOf)).toEqual(['a:screen', 'b:screen'])
})

test('przeciągnięcie trzeciego kafelka na początek', () => {
  expect(moveTile(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
})

test('przeciągnięcie pierwszego na koniec', () => {
  expect(moveTile(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
})

test('przeciągnięcie na własne miejsce nic nie zmienia', () => {
  expect(moveTile(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c'])
})

test('indeks poza zakresem jest przycinany do krańców', () => {
  // Wskaźnik potrafi wyjechać za kontener; przycięcie jest tańsze i mniej
  // zaskakujące niż odrzucenie przeciągnięcia w ostatniej chwili.
  expect(moveTile(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a'])
  expect(moveTile(['a', 'b', 'c'], 'c', -5)).toEqual(['c', 'a', 'b'])
})

test('ujemny indeks ląduje na początku, a nie liczy się od końca', () => {
  // `slice` sam traktuje ujemny indeks jako liczony od końca, więc bez
  // przycinania -1 wstawiłoby kafelek PRZED ostatnim, a nie na początek.
  // Osobny test, bo -5 i 99 z poprzedniego testu `slice` obsłuży i bez
  // przycinania — tamten test przechodzi także wtedy, gdy przycinania nie ma.
  expect(moveTile(['a', 'b', 'c', 'd'], 'd', -1)).toEqual(['d', 'a', 'b', 'c'])
})

test('przeciągnięcie klucza, którego nie ma, nic nie zmienia', () => {
  expect(moveTile(['a', 'b'], 'obcy', 0)).toEqual(['a', 'b'])
})

test('jeden kafelek nie da się przestawić i to nie jest błąd', () => {
  expect(moveTile(['a'], 'a', 0)).toEqual(['a'])
  expect(moveTile([], 'a', 0)).toEqual([])
})

test('zapominanie usuwa klucz nieobecny z OBU zbiorów', () => {
  const result = forgetMissingTiles(
    new Set(['a:screen', 'znikniety:screen']),
    ['znikniety:screen', 'a:screen'],
    new Set(['a:screen'])
  )
  expect([...result.hidden]).toEqual(['a:screen'])
  expect(result.order).toEqual(['a:screen'])
})

test('zapominanie zostawia obecne klucze nietknięte', () => {
  const result = forgetMissingTiles(
    new Set(['a:screen']),
    ['a:screen', 'b:camera'],
    new Set(['a:screen', 'b:camera'])
  )
  expect([...result.hidden]).toEqual(['a:screen'])
  expect(result.order).toEqual(['a:screen', 'b:camera'])
})

test('brak obecnych strumieni czyści wszystko', () => {
  const result = forgetMissingTiles(new Set(['a:screen']), ['a:screen'], new Set())
  expect([...result.hidden]).toEqual([])
  expect(result.order).toEqual([])
})
