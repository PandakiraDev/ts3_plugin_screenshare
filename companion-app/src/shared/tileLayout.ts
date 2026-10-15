import type { Tile } from '../renderer/hooks/useLobby'

/*
 * Decyzje o układzie siatki, wyjęte z komponentu.
 *
 * Mieszkają w `src/shared` jako czysta logika, bez Reacta i DOM-u: vitest
 * chodzi w tym projekcie w gołym Node, bez jsdom, więc testów komponentów nie
 * ma w ogóle i wszystko, co chcemy sprawdzić, musi dać się wyjąć do zwykłych
 * funkcji. Stąd też `import type` wyżej — zwykły import wciągnąłby do tego
 * pliku Reacta, sygnalizację i całe WebRTC, a ma on zostać samodzielny.
 *
 * Wszystkie klucze to `tileKey`, czyli `connectionKey(peerId, kind)`. Ta sama
 * osoba nadająca ekran i kamerę ma DWA klucze i to jest celowe: widz ukrywa
 * i przestawia pojedyncze strumienie, nie ludzi.
 */

/** Odsiewa ukryte kafelki. */
export function visibleTiles(tiles: readonly Tile[], hidden: ReadonlySet<string>): Tile[] {
  return tiles.filter((tile) => !hidden.has(tile.tileKey))
}

/**
 * Układa elementy według zapamiętanej kolejności kluczy.
 *
 * Element NIEOBECNY w `order` idzie na KONIEC, nie w środek: nowy strumień nie
 * ma prawa wskoczyć w ułożenie, które widz właśnie zrobił, a wejście kolejnej
 * osoby zdarza się w prawie każdej sesji. Klucz z `order`, którego nie ma już
 * wśród elementów, jest pomijany i nie zostawia dziury.
 *
 * Generyczna i z `keyOf`, tak samo jak `useLeaveTransition`: w potoku pracuje
 * na wierszach z przejścia wyjścia (`{ item, leaving }`), a nie na samych
 * `Tile`, więc nie może zakładać, że element ma pole `tileKey`.
 */
export function applyTileOrder<T>(
  items: readonly T[],
  order: readonly string[],
  keyOf: (item: T) => string
): T[] {
  const byKey = new Map(items.map((item) => [keyOf(item), item]))
  const ordered: T[] = []
  for (const key of order) {
    const item = byKey.get(key)
    if (item === undefined) continue
    ordered.push(item)
    byKey.delete(key)
  }
  // Co zostało w mapie, nie było w `order` — leci na koniec w porządku
  // źródłowym, bo `Map` zachowuje kolejność wstawiania.
  return [...ordered, ...byKey.values()]
}

/**
 * Nowa kolejność po przeciągnięciu `fromKey` na pozycję `toIndex`.
 *
 * `currentKeys` to kolejność AKTUALNIE WYRENDEROWANA, nie rzadka lista
 * zapamiętana: po przeciągnięciu kolejność staje się w pełni jawna dla
 * kafelków obecnych w tej chwili, a nowe i tak idą na koniec przez
 * `applyTileOrder`.
 *
 * Indeks jest PRZYCINANY do krańców, nie odrzucany: wskaźnik potrafi wyjechać
 * za kontener, a upuszczenie kafelka „w nic" byłoby dla człowieka
 * zaskakujące — oczekuje, że wyląduje na skraju.
 */
export function moveTile(
  currentKeys: readonly string[],
  fromKey: string,
  toIndex: number
): string[] {
  const from = currentKeys.indexOf(fromKey)
  if (from === -1) return [...currentKeys]

  const rest = currentKeys.filter((key) => key !== fromKey)
  const target = Math.max(0, Math.min(toIndex, rest.length))
  return [...rest.slice(0, target), fromKey, ...rest.slice(target)]
}

/** Układ wybrany przez widza: co ukrył i w jakiej kolejności ułożył resztę. */
export interface TileLayout {
  hidden: Set<string>
  order: string[]
}

/**
 * Przycina ukryte i kolejność do strumieni, które nadal są nadawane.
 *
 * Reguła z projektu: zakończony strumień zapomina o sobie wszystko, więc gdy
 * wróci, jest nowym kafelkiem — widocznym i na końcu. Jedna zasada zamiast
 * dwóch wyjątków.
 *
 * `presentKeys` MUSI być prawdą z sygnalizacji, nie stanem połączeń ani DOM-u.
 * Oba są przejściowe: kafelek wisi w DOM-ie jeszcze 400 ms animacji wyjścia po
 * końcu strumienia, a połączenie bywa zrywane i zestawiane od nowa, choć
 * strumień trwa. Przycinanie po takim stanie zdejmowałoby ukrycie przy każdym
 * mignięciu połączenia.
 *
 * Sygnalizacja zmienia się jednak w chwili końca strumienia, a wiersz dogasa
 * jeszcze po niej. `onScreenKeys` to klucze wierszy, które nadal stoją na
 * ekranie (też tych dogasających): zostają w KOLEJNOŚCI, bo `applyTileOrder`
 * posyła klucze spoza `order` na koniec, więc bez tego gasnący kafelek
 * przeskakiwałby w trakcie zanikania. Ukrytych to nie dotyczy — kafelka
 * ukrytego nie ma w siatce, więc nie ma czego zatrzymywać, a trzymanie
 * ukrycia dłużej przetrwałoby szybki restart strumienia, który ma wracać
 * widoczny.
 *
 * `onScreenKeys` tylko ZATRZYMUJE klucze już stojące w `order`; nie dopisuje
 * nowych. Parametr jest WYMAGANY: pominięty po cichu przywróciłby przeskok
 * gasnącego kafelka, a kompilator nie ma jak tego zauważyć.
 *
 * ZNANA SZPARA, przyjęta świadomie: strumień OGŁOSZONY na nowo w ciągu 400 ms
 * od swojego końca wraca na STARE miejsce w kolejności, a nie na koniec. Liczy
 * się ogłoszenie, nie powrót kafelka — kafelek wróci dopiero z obrazem, ale
 * klucz jest już wtedy w `presentKeys` i nigdy nie został zapomniany. To
 * odstępstwo od litery reguły „zakończony strumień zapomina o sobie wszystko”.
 * Zamknięcie szpary wymagałoby pamiętania, że strumień danego klucza się
 * skończył, czyli drugiego źródła prawdy obok sygnalizacji. Ukrytych szpara
 * nie dotyczy: te przycinamy samą sygnalizacją.
 */
export function forgetMissingTiles(
  hidden: ReadonlySet<string>,
  order: readonly string[],
  presentKeys: ReadonlySet<string>,
  onScreenKeys: ReadonlySet<string>
): TileLayout {
  return {
    hidden: new Set([...hidden].filter((key) => presentKeys.has(key))),
    order: order.filter((key) => presentKeys.has(key) || onScreenKeys.has(key))
  }
}

/**
 * `forgetMissingTiles` na całym układzie, z TOŻSAMOŚCIĄ: gdy nic nie wypadło,
 * zwraca ten sam obiekt, a nie jego kopię.
 *
 * To nie jest drobna optymalizacja, tylko warunek zatrzymania pętli. Efekt,
 * który wywołuje tę funkcję w `setLayout`, chodzi po KAŻDYM renderze (nie ma
 * tablicy zależności), więc zawsze nowy obiekt oznaczałby nowy stan, nowy
 * render, ten sam efekt i tak w kółko. React porzuca aktualizację dopiero
 * wtedy, gdy nowy stan jest identyczny ze starym.
 *
 * Porównanie rozmiarów wystarcza, ale tylko dlatego, że `forgetMissingTiles`
 * wyłącznie UJMUJE: wynik jest podzbiorem wejścia, więc równa liczność oznacza,
 * że nic nie wypadło. Funkcja, która by też dopisywała albo zamieniała klucze,
 * wymagałaby porównania element po elemencie.
 */
export function pruneLayout(
  layout: TileLayout,
  presentKeys: ReadonlySet<string>,
  onScreenKeys: ReadonlySet<string>
): TileLayout {
  const pruned = forgetMissingTiles(layout.hidden, layout.order, presentKeys, onScreenKeys)
  const nothingForgotten =
    pruned.hidden.size === layout.hidden.size && pruned.order.length === layout.order.length
  return nothingForgotten ? layout : pruned
}
