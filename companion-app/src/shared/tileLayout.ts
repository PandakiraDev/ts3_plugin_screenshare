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
 * Czy po kliknięciu oczka albo krzyżyka przy kafelku mamy ODBIERAĆ ten
 * strumień. `null` = nie ma od kogo przestać odbierać ani kogo prosić
 * o powrót, bo własny podgląd jest lokalny i nie przychodzi z sieci.
 *
 * Jedno wyrażenie zamiast podwójnej negacji rozłożonej na dwie warstwy.
 * Wcześniej komponent liczył `hiding = !hidden.has(tileKey)` i wołał
 * `setStreamSubscribed(…, !hiding)`, a hook rozstrzygał z tego rezygnację
 * albo powrót. Odwrócenie KTÓREJKOLWIEK z tych negacji przechodziło
 * kompilację — oba warianty są `boolean` — i nie ruszało żadnego testu,
 * a dla człowieka znaczyło, że krzyżyk na kafelku każe nadawcy PRZYSŁAĆ
 * obraz, a odkrycie kafelka każe mu przestać nadawać. `!hiding` zwija się
 * do `hidden.has(tileKey)`: kliknięcie ukrywa to, co widać, więc odbierać
 * mamy dokładnie to, co było ukryte.
 *
 * `hidden` MUSI być stanem SPRZED aktualizacji. Liczenie kierunku w środku
 * aktualizatora `setLayout` jest wykluczone: ten musi być czysty, bo React
 * w StrictMode wywołuje go dwa razy, a wiadomość do sieci czysta nie jest —
 * na jedno kliknięcie poszłyby DWIE.
 */
export function subscriptionAfterToggle(
  hidden: ReadonlySet<string>,
  tileKey: string,
  isMe: boolean
): boolean | null {
  if (isMe) return null
  return hidden.has(tileKey)
}

/**
 * Zbiór ukrytych po tym samym kliknięciu: widoczny kafelek znika, ukryty wraca.
 *
 * Para dla `subscriptionAfterToggle`, i tutaj z tego samego powodu — w
 * `src/shared` da się ją sprawdzić testem, w komponencie nie. Zgodności tej
 * pary (dokładamy klucz do `hidden` wtedy i tylko wtedy, gdy przestajemy
 * odbierać) pilnuje osobna asercja w teście: rozjazd byłby cichy, bo kafelek
 * zniknąłby z siatki, a obraz dalej by się odbierał i dekodował.
 *
 * Nowy zbiór, nie mutacja wejścia: wynik idzie wprost do stanu Reacta, który
 * rozpoznaje zmianę po referencji.
 */
export function hiddenAfterToggle(hidden: ReadonlySet<string>, tileKey: string): Set<string> {
  const next = new Set(hidden)
  if (next.has(tileKey)) next.delete(tileKey)
  else next.add(tileKey)
  return next
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
 * skończył, czyli drugiego źródła prawdy obok sygnalizacji.
 *
 * Ukrytych ta szpara nie dotyczy, ale uczciwie: nie dlatego, że mechanizm jest
 * inny, tylko dlatego, że jest WĘŻSZY. Ukryte przycina samo `presentKeys`, bez
 * `onScreenKeys`, więc wystarczy JEDEN render między końcem i ponownym
 * ogłoszeniem strumienia, żeby ukrycie zostało zapomniane. Gdyby oba zdarzenia
 * trafiły do tego samego taktu pętli zdarzeń, React zgrupowałby je w jeden
 * render i ukrycie przeżyłoby restart. W praktyce nieosiągalne — zdjęcie
 * i ponowny start transmisji to dwa kliknięcia człowieka i dwa obiegi do
 * serwera — ale to własność grupowania renderów, nie samej sygnalizacji.
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

/** Środek narysowanego kafelka we współrzędnych okna. */
export interface TileCenter {
  key: string
  x: number
  y: number
}

/**
 * Nowa kolejność po upuszczeniu kafelka `fromKey` w punkcie `point`: zajmuje
 * on pozycję kafelka o NAJBLIŻSZYM środku. Przeciągnięty w dół/w prawo ląduje
 * więc za celem, w górę/w lewo — przed nim; upuszczony na siebie nic nie
 * zmienia.
 *
 * Liczy się ze ŚRODKÓW, nie z odstępów między kafelkami: środek jest
 * jednoznaczny także wtedy, gdy kafelki mają różne rozmiary (powiększony,
 * osierocony), a liczenie od krawędzi wymagałoby zgadywania, do której szczeliny
 * człowiek celował. Remis odległości rozstrzyga pierwszy na liście.
 *
 * `centers` to WSZYSTKO, co jest narysowane, także wiersze jeszcze dogasające:
 * tak widzi to człowiek i tylko wtedy najbliższy cel zawsze stoi na liście, więc
 * indeks nigdy nie wypada poza nią (`moveTile` przycięłby -1 do zera i kafelek
 * wskoczyłby na początek, a nie tam, gdzie celowano).
 *
 * Wynik jest permutacją kluczy z `centers` i niczego do nich nie dopisuje.
 * Dlatego wywołujący nie może jej wołać, gdy narysowana jest tylko część
 * układu (powiększenie zostawia jeden kafelek): zapisana kolejność miałaby
 * wtedy jeden klucz i wyrzuciłaby wszystkie pozostałe.
 *
 * `null` = nie ma czego zapisywać (pusta lista albo ciągnięty kafelek zniknął
 * w trakcie gestu); nie zwracamy kopii wejścia, żeby wywołujący nie zapisał
 * kolejności, o którą nikt nie prosił.
 */
export function orderAfterDrop(
  centers: readonly TileCenter[],
  fromKey: string,
  point: { x: number; y: number }
): string[] | null {
  if (!centers.some((center) => center.key === fromKey)) return null

  const distance = (center: TileCenter): number =>
    (center.x - point.x) ** 2 + (center.y - point.y) ** 2
  const nearest = centers.reduce((best, center) =>
    distance(center) < distance(best) ? center : best
  )

  const keys = centers.map((center) => center.key)
  return moveTile(keys, fromKey, keys.indexOf(nearest.key))
}

/**
 * Dokłada do nowej kolejności klucze, których w chwili przeciągania nie było na
 * ekranie — każdy ZA SWOIM POPRZEDNIKIEM z poprzedniej kolejności.
 *
 * Bez tego ukrywanie i przestawianie psują się w zderzeniu: `orderAfterDrop`
 * zwraca permutację tego, co NARYSOWANE, a kafelek ukryty przez widza
 * narysowany nie jest. Pierwsze przeciągnięcie czegokolwiek gubiłoby więc jego
 * klucz i po odkryciu wracałby na koniec zamiast na swoje miejsce. To samo
 * dotyczy strumienia ogłoszonego, ale jeszcze bez obrazu (połączenie zestawiane
 * od nowa).
 *
 * Poprzednik to najbliższy klucz stojący PRZED danym w `previousOrder`, który
 * w `nextOrder` jest. Gdy takiego nie ma, klucz wraca na początek. Klucze
 * dzielące poprzednika zachowują swoją wzajemną kolejność.
 *
 * Wskrzeszenie zakończonego strumienia nie jest tą drogą możliwe, więc reguła
 * „zakończony strumień zapomina o sobie wszystko" zostaje nietknięta:
 * `pruneLayout` zdejmuje jego klucz z `order`, gdy wiersz przestaje stać na
 * ekranie, a dopóki stoi (400 ms animacji wyjścia), jest narysowany — trafia
 * więc do `nextOrder` i nie jest tu niczym dokładanym.
 */
export function restoreUnrenderedKeys(
  previousOrder: readonly string[],
  nextOrder: readonly string[]
): string[] {
  const rendered = new Set(nextOrder)
  // Klucz `null` zbiera te, które nie mają przed sobą żadnego narysowanego.
  const missingAfter = new Map<string | null, string[]>()
  let anchor: string | null = null

  for (const key of previousOrder) {
    if (rendered.has(key)) {
      anchor = key
      continue
    }
    const waiting = missingAfter.get(anchor)
    if (waiting) waiting.push(key)
    else missingAfter.set(anchor, [key])
  }

  const result = [...(missingAfter.get(null) ?? [])]
  for (const key of nextOrder) {
    result.push(key)
    const waiting = missingAfter.get(key)
    if (waiting) result.push(...waiting)
  }
  return result
}

/**
 * OBOWIĄZUJĄCA kolejność kluczy wszystkich kafelków — także ukrytych i tych,
 * które jeszcze nie mają obrazu.
 *
 * To ta sama reguła, którą układa się siatkę (`applyTileOrder`), więc przy
 * pustym `order` wychodzi z niej porządek źródłowy. Osobna funkcja, bo jest to
 * odniesienie dla `restoreUnrenderedKeys` przy upuszczeniu kafelka i pomyłka
 * w jego doborze jest cicha: samo `order` jest PUSTE do pierwszego upuszczenia
 * w każdej sesji (układ nie jest zapamiętywany), a klucz ukryty przed pierwszym
 * przeciągnięciem nigdy do niego nie trafił. Odniesienie z samego `order`
 * gubiłoby więc ukryty kafelek na koniec siatki przy pierwszym przestawieniu,
 * a objaw byłby widoczny dopiero po odkryciu — nikt by go nie powiązał
 * z przeciąganiem.
 */
export function effectiveOrder<T>(
  tiles: readonly T[],
  order: readonly string[],
  keyOf: (tile: T) => string
): string[] {
  return applyTileOrder(tiles, order, keyOf).map(keyOf)
}
