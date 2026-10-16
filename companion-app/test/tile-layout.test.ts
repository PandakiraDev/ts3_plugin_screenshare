import { expect, test } from 'vitest'
import {
  applyTileOrder,
  effectiveOrder,
  forgetMissingTiles,
  hiddenAfterToggle,
  moveTile,
  orderAfterDrop,
  pruneLayout,
  restoreUnrenderedKeys,
  subscriptionAfterToggle,
  visibleTiles,
  type TileCenter,
  type TileLayout
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
    new Set(['a:screen']),
    new Set()
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
    new Set(['c:screen', 'b:camera', 'a:screen', 'b:screen']),
    new Set()
  )
  expect([...result.hidden]).toEqual(['b:screen', 'c:screen', 'a:screen'])
  expect(result.order).toEqual(['b:camera', 'c:screen', 'a:screen'])
})

test('zapominanie zachowuje kolejność zapamiętaną, a nie kolejność obecnych', () => {
  // `presentKeys` to zbiór z sygnalizacji i jego kolejność nic nie znaczy;
  // ułożenie widza siedzi w `order`. Klucza `b` nie ma w `order`, więc nie
  // wolno go tam dopisać, i nic nie wolno przestawić. Kolejność `c, a, d` nie
  // jest ani rosnąca, ani malejąca, więc sortowanie jej nie przepuści.
  const result = forgetMissingTiles(
    new Set(),
    ['c', 'a', 'd'],
    new Set(['a', 'b', 'c', 'd']),
    new Set()
  )
  expect(result.order).toEqual(['c', 'a', 'd'])
  expect([...result.hidden]).toEqual([])
})

test('brak obecnych strumieni czyści wszystko', () => {
  const result = forgetMissingTiles(new Set(['a:screen']), ['a:screen'], new Set(), new Set())
  expect([...result.hidden]).toEqual([])
  expect(result.order).toEqual([])
})

test('własny kafelek nie jest zapominany, gdy jego klucz jest w presentKeys', () => {
  /*
   * `lobby.state.streams` zawiera nasze własne strumienie obok cudzych: serwer
   * odsyła `stream-started` także nadawcy, a `LobbySession` zapisuje każde
   * ogłoszenie w `streamerRefs`, nie patrząc czyje. Więc `presentKeys` złożone
   * ze `streams` obejmuje własne klucze samo z siebie, bez doklejania ich
   * z `myStreamKinds`.
   *
   * Ten test przybija tylko stronę funkcji: nie wolno jej rozróżniać kluczy
   * własnych od cudzych (np. dopisując „pomiń siebie"). Że wywołujący składa
   * `presentKeys` ze `streams`, a nie z `remoteStreams` albo z `tiles` — tych
   * własnych nie ma — leży w warstwie komponentu, której vitest w gołym Node
   * nie sięga.
   */
  const result = forgetMissingTiles(
    new Set(['me:screen']),
    ['me:screen'],
    new Set(['me:screen']),
    new Set()
  )
  expect([...result.hidden]).toEqual(['me:screen'])
  expect(result.order).toEqual(['me:screen'])
})

test('kafelek wciąż na ekranie zachowuje miejsce w kolejności, ale nie w ukrytych', () => {
  /*
   * Strumień `b` już się skończył (nie ma go w `presentKeys`), ale jego wiersz
   * dogasa jeszcze w DOM-ie. Wypadnięcie `b` z kolejności w tej chwili
   * posłałoby go na koniec — `applyTileOrder` wysyła nieznane klucze na koniec
   * — i kafelek przeskakiwałby w trakcie zanikania. Ukryte nie mają takiego
   * powodu: kafelka ukrytego i tak nie ma w siatce.
   *
   * Kolejność `b, c, a` nie jest ani rosnąca, ani malejąca, więc sortowanie
   * wyniku w którąkolwiek stronę ją zmieni (zmierzone: ten test zabija oba
   * kierunki). Wcześniej stała tu `c, b, a`, czyli malejąca, i mutacja
   * sortująca malejąco przechodziła przez ten test bez szwanku. Drugi test
   * z tej pary ma CELOWO inny kształt (wynik rosnący): zabija sortowanie
   * malejące niezależnie od tego. Nie ujednolicać ich do jednego kształtu —
   * test, którego wynik jest już ułożony w którąś stronę, nie wykryje
   * sortowania w tę stronę.
   *
   * Klucz `x:camera` w `onScreenKeys` nie stoi w `order`, więc pilnuje, że ta
   * lista tylko ZATRZYMUJE klucze, a nie dopisuje ich.
   */
  const result = forgetMissingTiles(
    new Set(['b:screen', 'a:screen']),
    ['b:screen', 'c:screen', 'a:screen'],
    new Set(['a:screen', 'c:screen']),
    new Set(['b:screen', 'x:camera'])
  )
  expect(result.order).toEqual(['b:screen', 'c:screen', 'a:screen'])
  expect([...result.hidden]).toEqual(['a:screen'])
})

test('gdy wiersz zniknie z ekranu, klucz wypada z kolejności', () => {
  // Ta sama sytuacja, co w teście wyżej, ale wiersz już zniknął z DOM-u
  // (`onScreenKeys` puste): od tej chwili wygrywa reguła „zakończony strumień
  // zapomina o sobie wszystko". Wynik `a, c` jest rosnący CELOWO: sortowanie
  // malejące zmieniłoby go na `c, a`, a rosnące go nie rusza, więc ten test
  // zabija tylko jeden kierunek (rosnący zabija test wyżej). Nie ujednolicać
  // z testem wyżej, patrz tamten komentarz.
  const result = forgetMissingTiles(
    new Set(),
    ['b:screen', 'a:screen', 'c:screen'],
    new Set(['a:screen', 'c:screen']),
    new Set()
  )
  expect(result.order).toEqual(['a:screen', 'c:screen'])
})

/*
 * `pruneLayout`: tożsamość wyniku jest warunkiem zatrzymania pętli przerysowań
 * w `LobbyView` (efekt chodzi po każdym renderze), więc ma własne testy, a nie
 * tylko opis w komentarzu. Fixtury celowo nieposortowane w żadną stronę.
 */
function layout(hidden: string[], order: string[]): TileLayout {
  return { hidden: new Set(hidden), order }
}

test('pruneLayout oddaje TEN SAM obiekt, gdy nic nie wypada', () => {
  // `toBe`, nie `toEqual`: kopia o tej samej zawartości jest nowym stanem
  // Reacta i uruchamia kolejny render, a z nim ten sam efekt — nieskończoną
  // pętlę. Klucz `b` stoi w `order` tylko dzięki `onScreenKeys`, więc jego
  // zatrzymanie też nie jest zmianą.
  const before = layout(['c:screen', 'a:screen'], ['b:screen', 'c:screen', 'a:screen'])
  const after = pruneLayout(before, new Set(['a:screen', 'c:screen']), new Set(['b:screen']))
  expect(after).toBe(before)
})

test('pruneLayout zwraca nowy układ, gdy ubywa tylko z ukrytych', () => {
  // Zmiana TYLKO w `hidden` wyłapuje warunek liczony wyłącznie po `order`,
  // a ukryte muszą być naprawdę przefiltrowane, nie przepuszczone dalej.
  const before = layout(['x:screen', 'a:screen'], ['b:screen', 'a:screen'])
  const after = pruneLayout(before, new Set(['a:screen', 'b:screen']), new Set())
  expect(after).not.toBe(before)
  expect([...after.hidden]).toEqual(['a:screen'])
  expect(after.order).toEqual(['b:screen', 'a:screen'])
})

test('pruneLayout zwraca nowy układ, gdy ubywa tylko z kolejności', () => {
  // Zmiana TYLKO w `order` wyłapuje warunek liczony wyłącznie po `hidden`,
  // a przycięta kolejność musi do wyniku naprawdę trafić, nie zostać
  // przepisana ze starego układu.
  const before = layout(['a:screen'], ['b:screen', 'x:screen', 'a:screen'])
  const after = pruneLayout(before, new Set(['a:screen', 'b:screen']), new Set())
  expect(after).not.toBe(before)
  expect(after.order).toEqual(['b:screen', 'a:screen'])
  expect([...after.hidden]).toEqual(['a:screen'])
})

test('pruneLayout przycina OBA zbiory i nie rusza wejścia', () => {
  const before = layout(
    ['c:screen', 'x:screen', 'a:screen'],
    ['b:screen', 'y:camera', 'c:screen', 'a:screen']
  )
  const after = pruneLayout(before, new Set(['a:screen', 'b:screen', 'c:screen']), new Set())
  expect([...after.hidden]).toEqual(['c:screen', 'a:screen'])
  expect(after.order).toEqual(['b:screen', 'c:screen', 'a:screen'])
  // Wejście zostaje takie, jakie było: stan Reacta nie może być mutowany.
  expect([...before.hidden]).toEqual(['c:screen', 'x:screen', 'a:screen'])
  expect(before.order).toEqual(['b:screen', 'y:camera', 'c:screen', 'a:screen'])
})

/*
 * `orderAfterDrop`: nowa kolejność po upuszczeniu kafelka. Środki to układ 2x2:
 *   a(0,0)   b(100,0)
 *   c(0,100) d(100,100)
 * Punkty upuszczenia są dobrane tak, żeby odległość liczona po SAMYM x albo
 * SAMYM y wskazywała inny kafelek niż odległość euklidesowa.
 */
const GRID_2X2: TileCenter[] = [
  { key: 'a', x: 0, y: 0 },
  { key: 'b', x: 100, y: 0 },
  { key: 'c', x: 0, y: 100 },
  { key: 'd', x: 100, y: 100 }
]

test('upuszczenie zajmuje miejsce najbliższego środka, liczonego w obu osiach', () => {
  // Punkt (10, 90): po samym x remisują a i c (wygrałby pierwszy, `a`), po
  // samym y — c i d. Najbliższy naprawdę jest `c`, więc `d` wchodzi na jego miejsce.
  expect(orderAfterDrop(GRID_2X2, 'd', { x: 10, y: 90 })).toEqual(['a', 'b', 'd', 'c'])
  // Punkt (95, 10): po samym y remisują a i b (wygrałby `a`), najbliższy jest `b`.
  expect(orderAfterDrop(GRID_2X2, 'c', { x: 95, y: 10 })).toEqual(['a', 'c', 'b', 'd'])
})

test('przeciągnięcie w dół zajmuje miejsce za celem, w górę — przed nim', () => {
  // Kafelek zajmuje POZYCJĘ celu, więc kierunek decyduje, po której stronie
  // sąsiada wyląduje. Kolejność `b, c, a` nie jest ani rosnąca, ani malejąca.
  const centers: TileCenter[] = [
    { key: 'b', x: 0, y: 0 },
    { key: 'c', x: 100, y: 0 },
    { key: 'a', x: 200, y: 0 }
  ]
  expect(orderAfterDrop(centers, 'b', { x: 205, y: 0 })).toEqual(['c', 'a', 'b'])
  expect(orderAfterDrop(centers, 'a', { x: -5, y: 0 })).toEqual(['a', 'b', 'c'])
})

test('upuszczenie na samego siebie niczego nie zmienia', () => {
  const centers: TileCenter[] = [
    { key: 'b', x: 0, y: 0 },
    { key: 'c', x: 100, y: 0 },
    { key: 'a', x: 200, y: 0 }
  ]
  expect(orderAfterDrop(centers, 'c', { x: 90, y: 10 })).toEqual(['b', 'c', 'a'])
})

test('remis odległości rozstrzyga pierwszy na liście', () => {
  const centers: TileCenter[] = [
    { key: 'b', x: 0, y: 0 },
    { key: 'c', x: 100, y: 0 },
    { key: 'a', x: 200, y: 0 }
  ]
  // Punkt (50, 0) jest równo odległy od `b` i `c`; ciągnięty `a` zajmuje miejsce `b`.
  expect(orderAfterDrop(centers, 'a', { x: 50, y: 0 })).toEqual(['a', 'b', 'c'])
})

test('brak ciągniętego kafelka wśród narysowanych nie daje żadnej kolejności', () => {
  // Kafelek mógł zniknąć w trakcie gestu. Bez tego `moveTile` dostałby klucz,
  // którego nie ma, oddałby kopię wejścia i zapisalibyśmy kolejność, o którą
  // nikt nie prosił. `null` znaczy „nic nie zapisuj".
  expect(orderAfterDrop(GRID_2X2, 'zniknal', { x: 0, y: 0 })).toBeNull()
  expect(orderAfterDrop([], 'a', { x: 0, y: 0 })).toBeNull()
})

test('wynik jest permutacją narysowanych kluczy i niczego nie dopisuje', () => {
  /*
   * To jest powód, dla którego `LobbyView` nie woła tej funkcji przy
   * powiększeniu: siatka ma wtedy JEDEN narysowany kafelek, więc wynik ma
   * jeden klucz, a zapisany jako kolejność wyrzuciłby z niej wszystkie
   * pozostałe — po wyjściu z powiększenia poleciałyby na koniec. Funkcja
   * przestawia tylko to, co dostała; pilnuje tego wywołujący.
   */
  expect(orderAfterDrop([{ key: 'b', x: 0, y: 0 }], 'b', { x: 5, y: 5 })).toEqual(['b'])
})

test('ukryty w środku wraca za swojego poprzednika', () => {
  /*
   * Układ `c, a, b`, widz ukrył `a`. Przeciągnięcie przestawia tylko to, co
   * narysowane (`c, b`), więc bez przywracania klucz `a` wypadłby z kolejności
   * i po odkryciu wrócił na koniec.
   */
  expect(restoreUnrenderedKeys(['c', 'a', 'b'], ['b', 'c'])).toEqual(['b', 'c', 'a'])
})

test('ukryty na początku wraca na początek', () => {
  // `a` nie ma przed sobą żadnego narysowanego klucza, więc nie ma za czym stanąć.
  expect(restoreUnrenderedKeys(['a', 'b', 'c'], ['c', 'b'])).toEqual(['a', 'c', 'b'])
})

test('dwa ukryte za tym samym poprzednikiem zachowują swoją kolejność', () => {
  expect(restoreUnrenderedKeys(['c', 'a', 'b', 'd'], ['d', 'c'])).toEqual(['d', 'c', 'a', 'b'])
})

test('klucz nowy w nowej kolejności przechodzi, brakujący wraca przed niego', () => {
  // `n` nie stał w poprzedniej kolejności — nowy kafelek, nie ma czego pamiętać,
  // więc przechodzi na swoim miejscu. `a` nie ma przed sobą nic narysowanego,
  // więc wraca na początek, czyli PRZED nowy klucz.
  expect(restoreUnrenderedKeys(['a', 'b'], ['n', 'b'])).toEqual(['a', 'n', 'b'])
})

test('gdy nic nie brakuje, wynik jest równy nowej kolejności', () => {
  expect(restoreUnrenderedKeys(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b'])
})

test('pusta poprzednia kolejność niczego nie dokłada', () => {
  expect(restoreUnrenderedKeys([], ['b', 'a'])).toEqual(['b', 'a'])
})

test('effectiveOrder przy pustej kolejności daje porządek źródłowy', () => {
  // To jest cały powód istnienia tej funkcji: `order` jest pusta do pierwszego
  // upuszczenia w każdej sesji, a odniesienie dla `restoreUnrenderedKeys` musi
  // wtedy mimo to znać wszystkie kafelki.
  const tiles = [tile('a', 'screen'), tile('b', 'screen'), tile('c', 'screen')]
  expect(effectiveOrder(tiles, [], (t) => t.tileKey)).toEqual([
    'a:screen',
    'b:screen',
    'c:screen'
  ])
})

test('effectiveOrder szanuje ustawioną kolejność i dokleja nowe na koniec', () => {
  const tiles = [tile('a', 'screen'), tile('b', 'screen'), tile('c', 'screen')]
  expect(effectiveOrder(tiles, ['c:screen', 'a:screen'], (t) => t.tileKey)).toEqual([
    'c:screen',
    'a:screen',
    'b:screen'
  ])
})

test('pierwsze przestawienie nie gubi kafelka ukrytego przed nim', () => {
  /*
   * Powtórzenie usterki z przeglądu gałęzi, złożone DOKŁADNIE tak, jak składa to
   * `LobbyView` przy upuszczeniu kafelka. Cztery kafelki w porządku źródłowym,
   * widz chowa `b`, potem przeciąga `d` na początek. Wcześniej odniesieniem było
   * samo `order` — puste w tej chwili — więc `b` wypadał z kolejności i po
   * odkryciu wracał na KONIEC, choć widz nigdy go nie ruszał.
   */
  const tiles = [tile('a', 'screen'), tile('b', 'screen'), tile('c', 'screen'), tile('d', 'screen')]
  const everyKey = effectiveOrder(tiles, [], (t) => t.tileKey)
  // To, co zwraca `orderAfterDrop`: permutacja samych NARYSOWANYCH kluczy,
  // czyli bez ukrytego `b`.
  const dropped = ['d:screen', 'a:screen', 'c:screen']

  expect(restoreUnrenderedKeys(everyKey, dropped)).toEqual([
    'd:screen',
    'a:screen',
    'b:screen',
    'c:screen'
  ])
})

/*
 * Kliknięcie oczka przy nazwie albo krzyżyka na kafelku. Dwie funkcje, bo jedno
 * kliknięcie robi dwie rzeczy naraz — zmienia siatkę i rusza sieć — a przedtem
 * liczył je sam komponent podwójną negacją rozłożoną na dwie warstwy
 * (`hiding = !hidden.has(tileKey)` w widoku i `!hiding` przekazane dalej).
 * Tutaj obie decyzje da się sprawdzić: testów komponentów w tym projekcie nie
 * ma w ogóle, bo vitest chodzi w gołym Node, bez jsdom.
 */

test('kliknięcie kafelka UKRYTEGO wraca do odbioru, WIDOCZNEGO — rezygnuje', () => {
  const hidden = new Set(['a:screen'])
  expect(subscriptionAfterToggle(hidden, 'a:screen', false)).toBe(true)
  expect(subscriptionAfterToggle(hidden, 'b:camera', false)).toBe(false)
})

test('własny podgląd nie ma od kogo być odbierany', () => {
  // `null`, nie `false`: „nie wysyłaj nic" to inna decyzja niż „poproś, żeby
  // przestał nadawać" — a ta druga poszłaby do nas samych.
  expect(subscriptionAfterToggle(new Set(), 'ja:camera', true)).toBe(null)
  expect(subscriptionAfterToggle(new Set(['ja:camera']), 'ja:camera', true)).toBe(null)
})

test('kliknięcie przełącza ukrycie jednego klucza i nie rusza pozostałych', () => {
  const hidden = new Set(['a:screen', 'b:camera'])
  expect([...hiddenAfterToggle(hidden, 'c:screen')]).toEqual([
    'a:screen',
    'b:camera',
    'c:screen'
  ])
  expect([...hiddenAfterToggle(hidden, 'a:screen')]).toEqual(['b:camera'])
  // Wejście zostaje nietknięte: wynik idzie do stanu Reacta jako NOWY zbiór.
  expect([...hidden]).toEqual(['a:screen', 'b:camera'])
})

test('obie decyzje jednego kliknięcia są zgodne: ukrywamy to, czego przestajemy odbierać', () => {
  // Rozjazd tej pary byłby cichy w obie strony: kafelek zniknąłby z siatki,
  // a obraz dalej by się odbierał i dekodował, albo odwrotnie — kafelek zostałby
  // widoczny, a nadawca dostałby prośbę, żeby przestać nadawać.
  for (const hidden of [new Set<string>(), new Set(['a:screen'])]) {
    const subscribed = subscriptionAfterToggle(hidden, 'a:screen', false)
    expect(hiddenAfterToggle(hidden, 'a:screen').has('a:screen')).toBe(!subscribed)
  }
})
