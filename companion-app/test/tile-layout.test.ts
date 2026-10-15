import { expect, test } from 'vitest'
import {
  applyTileOrder,
  forgetMissingTiles,
  moveTile,
  visibleTiles
} from '../src/shared/tileLayout'
import type { Tile } from '../src/renderer/hooks/useLobby'
import { connectionKey } from '../src/renderer/webrtc/session'

/**
 * Atrapa kafelka. `stream` jest rzutowany, bo `MediaStream` nie istnieje
 * w gołym Node — a te funkcje go nie dotykają, tylko przenoszą. Klucz składa
 * `connectionKey`, tak jak `buildTiles` w prawdziwym kafelku, więc sama atrapa
 * nie ma własnej kopii formatu. Literały w oczekiwaniach (`'a:screen'`) już tak:
 * celowa zmiana formatu rozwali tu sporo testów logiki układu, które o formacie
 * nic nie mówią. Sam format pilnuje `participants.test.ts` (klucz składany
 * ręcznie w `hiddenKindsFor` ma się zgadzać z `connectionKey`).
 */
function tile(peerId: string, kind: 'screen' | 'camera'): Tile {
  return {
    tileKey: connectionKey(peerId, kind),
    peerId,
    kind,
    stream: null as unknown as MediaStream,
    label: `${peerId} ${kind}`,
    isMe: false
  }
}

const keyOf = (item: Tile): string => item.tileKey

test('ukryty kafelek nie wychodzi, pozostałe zostają', () => {
  // Pozostałe trzy kafelki stoją w kolejności, która nie jest ani rosnąca, ani
  // malejąca: filtr, który przy okazji sortuje po kluczu, w którąkolwiek
  // stronę, zmieniłby wynik. Przy dwóch pozostałych taki układ nie istnieje —
  // dwa elementy zawsze są posortowane w jedną ze stron.
  const tiles = [
    tile('b', 'screen'),
    tile('d', 'screen'),
    tile('c', 'screen'),
    tile('a', 'screen')
  ]
  const visible = visibleTiles(tiles, new Set(['d:screen']))
  expect(visible.map(keyOf)).toEqual(['b:screen', 'c:screen', 'a:screen'])
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
  // Kolejność nieposortowana w żadną stronę z tego samego powodu co wyżej.
  const tiles = [tile('b', 'camera'), tile('c', 'screen'), tile('a', 'screen')]
  expect(visibleTiles(tiles, new Set()).map(keyOf)).toEqual([
    'b:camera',
    'c:screen',
    'a:screen'
  ])
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

test('klucz-duch w kolejności nie przerywa układania kafelków za nim', () => {
  // Ukrywanie rusza tylko zbiór `hidden`, a nie `order`, więc klucz bez
  // kafelka to codzienność, nie przypadek brzegowy. Gdyby pierwszy taki klucz
  // przerywał pętlę, ułożenie wszystkich kafelków za nim przepadłoby po cichu —
  // a test z jednym kafelkiem nie odróżnia „pomiń" od „przerwij".
  const tiles = [tile('a', 'screen'), tile('b', 'screen'), tile('c', 'screen')]
  const order = ['duch:screen', 'c:screen', 'a:screen']
  expect(applyTileOrder(tiles, order, keyOf).map(keyOf)).toEqual([
    'c:screen',
    'a:screen',
    'b:screen'
  ])
})

test('nowe kafelki na końcu zachowują swoją wzajemną kolejność', () => {
  // `y` stoi przed `x` celowo: przy danych ułożonych alfabetycznie ten test
  // przeszedłby także wtedy, gdy nowe kafelki są sortowane po kluczu, a mają
  // zostać w porządku źródłowym.
  const tiles = [tile('y', 'screen'), tile('x', 'screen'), tile('a', 'screen')]
  expect(applyTileOrder(tiles, ['a:screen'], keyOf).map(keyOf)).toEqual([
    'a:screen',
    'y:screen',
    'x:screen'
  ])
})

test('pusta kolejność zostawia porządek źródłowy', () => {
  const tiles = [tile('a', 'screen'), tile('b', 'screen')]
  expect(applyTileOrder(tiles, [], keyOf).map(keyOf)).toEqual(['a:screen', 'b:screen'])
})

test('układanie działa też na wierszach opakowanych w znacznik wyjścia', () => {
  // Potok układa wiersze `{ item, leaving }` z przejścia wyjścia, nie same
  // `Tile` — dlatego funkcja jest generyczna i bierze `keyOf`. Test pilnuje
  // dwóch rzeczy:
  // 1) w czasie wykonania — że używa przekazanego `keyOf`, a nie sięga sztywno
  //    po `tileKey` na opakowanym obiekcie, gdzie byłoby undefined;
  // 2) na poziomie typów — że tsc (test/ jest w tsconfig.json) wyłapie
  //    zwężenie sygnatury do `Tile`, które samo vitest przepuszcza, bo
  //    esbuild wycina typy.
  const rows = [
    { item: tile('a', 'screen'), leaving: false },
    { item: tile('b', 'screen'), leaving: true },
    { item: tile('nowy', 'screen'), leaving: false },
    { item: tile('c', 'screen'), leaving: false }
  ]
  const ordered = applyTileOrder(
    rows,
    ['c:screen', 'b:screen', 'a:screen'],
    (row) => row.item.tileKey
  )
  expect(ordered.map((row) => row.item.tileKey)).toEqual([
    'c:screen',
    'b:screen',
    'a:screen',
    'nowy:screen'
  ])
  // Opakowanie idzie nietknięte: znacznik wyjścia nie może się zgubić po drodze.
  expect(ordered[1].leaving).toBe(true)
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
  // Ukryte i kolejność zapamiętana mają po trzy klucze ułożone ani rosnąco, ani
  // malejąco, więc posortowanie w którąkolwiek stronę zmieniłoby wynik. Żaden
  // z tych porządków nie pokrywa się też z kolejnością w `presentKeys`, więc
  // nie da się go przy okazji odtworzyć z niej.
  const result = forgetMissingTiles(
    new Set(['b:screen', 'c:screen', 'a:screen']),
    ['b:camera', 'c:screen', 'a:screen'],
    new Set(['c:screen', 'b:camera', 'a:screen', 'b:screen'])
  )
  expect([...result.hidden]).toEqual(['b:screen', 'c:screen', 'a:screen'])
  expect(result.order).toEqual(['b:camera', 'c:screen', 'a:screen'])
})

test('zapominanie zachowuje kolejność zapamiętaną, a nie kolejność obecnych', () => {
  // `presentKeys` to zbiór z sygnalizacji i jego kolejność nic nie znaczy;
  // ułożenie widza siedzi w `order`. Klucza `b` nie ma w `order`, więc nie
  // wolno go tam dopisać, i nic nie wolno przestawić. Kolejność `c, a, d` nie
  // jest ani rosnąca, ani malejąca, więc sortowanie jej nie przepuści.
  const result = forgetMissingTiles(new Set(), ['c', 'a', 'd'], new Set(['a', 'b', 'c', 'd']))
  expect(result.order).toEqual(['c', 'a', 'd'])
  expect([...result.hidden]).toEqual([])
})

test('brak obecnych strumieni czyści wszystko', () => {
  const result = forgetMissingTiles(new Set(['a:screen']), ['a:screen'], new Set())
  expect([...result.hidden]).toEqual([])
  expect(result.order).toEqual([])
})
