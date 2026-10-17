# Układ siatki strumieni — plan wdrożenia (0.3.4, część 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dać widzowi sterowanie własną siatką: wyśrodkowany ostatni kafelek, ukrywanie kafelków (własnego podglądu lokalnie, cudzych z realnym zaprzestaniem odbioru) i przesuwanie kafelków przeciąganiem.

**Architecture:** Cała logika decyzyjna w nowym `src/shared/tileLayout.ts` jako cztery czyste funkcje z testami — to jedyne miejsce, w którym da się cokolwiek przetestować, bo repozytorium nie ma jsdom. Stan (`hidden`, `order`) żyje w `LobbyView` i ginie z oknem. Rezygnacja z odbioru jedzie jako nowy wariant `SignalPayload` w istniejącym przekaźniku `signal`, więc serwer sygnalizacyjny pozostaje bez zmian.

**Tech Stack:** Electron 33 (Chromium 130), React 18 w `StrictMode`, TypeScript, vitest w gołym Node, WebRTC, CSS Grid, Web Animations API.

**Spec:** `docs/superpowers/specs/2026-10-15-uklad-siatki-design.md`

---

## Stan: część 1 WYKONANA (16 października 2026)

Wszystkie jedenaście zadań zamkniętych. Ewidencją przebiegu jest dziennik SDD
`.superpowers/sdd/2026-10-15-uklad-siatki/progress.md` (kratki `- [ ]` w tym
pliku nie były odhaczane — plan był materiałem, nie listą kontrolną).

| zadanie | commit | uwaga |
|---|---|---|
| 1-7 | do `81f34c9` | czyste funkcje układu, ukrywanie, rezygnacja z odbioru w protokole |
| 8 | `6349204`, poprawki `16e80fd` | zapominanie zakończonych strumieni, `pruneLayout` z tożsamością |
| 9 | `0efc4b1`, poprawki `de80d72` | przesuwanie uchwytem, przywracanie kluczy nienarysowanych |
| 10 | `c242b3f` | animacja FLIP |
| 11 | `81282a8` | sprawdzian wyśrodkowania (NIEURUCHOMIONY) |

**Stan weryfikacji:** `tsc` bez błędów, 324 testy, pełny `npm run build`
przechodzi. Trzy rzeczy pozostają niesprawdzone, bo nie da się ich sprawdzić
bez żywego okna, a uruchamianie `e2e/` jest decyzją właściciela:

1. wyśrodkowanie przy 3, 4 i 5 kafelkach — ma to zmierzyć `npm run e2e:siatka`;
2. przeciąganie kafelków (uchwyt, przechwycenie wskaźnika, przygaszenie) —
   **świadomie** nie ma na to sprawdzianu: udawany gest przez CDP może przejść
   tam, gdzie prawdziwy nie działa, czyli dałby fałszywe poczucie bezpieczeństwa;
3. animacja przestawiania.

**Odstąpienia od planu w trakcie wykonania** (każde z uzasadnieniem w dzienniku):
`zoomAfterHide` z zadania 5 **odwołane** (zdejmowanie powiększenia robi
ogólniejszy efekt z zadania 3); animacja dostała `useLayoutEffect` i pomiar po
każdym renderze zamiast tablicy `[order]`; wczesny `return` przy wyłączonych
animacjach zamieniony na flagę, bo pomiary muszą działać dalej.

## Global Constraints

- **Nazwy w kodzie po angielsku, komentarze i teksty dla użytkownika po polsku, z PEŁNYMI diakrytykami** (`ą ć ę ł ń ó ś ź ż`). Komunikaty commitów w ASCII, spójnie z historią.
- **Komentarz mówi DLACZEGO, nie CO.** Komentarz, który kłamie, jest gorszy niż jego brak.
- **vitest chodzi w gołym Node, BEZ jsdom** — nie ma `document` ani `window`, więc testów komponentów w tym repozytorium nie ma w ogóle. Wszystko, co ma mieć test, musi mieszkać w `src/shared/` i nie importować niczego poza typami.
- **`test/**/*.ts` jest w `include` w `tsconfig.json`** — błąd typu w teście wywala `npm run build`, nie tylko `npm test`.
- Alias `@shared` działa i w aplikacji, i w vitest (`vitest.config.ts`).
- **Czas trwania mierzy się `performance.now()`, znacznik czasu `Date.now()`.** Trzy osobne błędy tej klasy naprawiono w 0.3.3.
- **Zero zapisywania na dysk.** `hidden` i `order` giną z oknem — decyzja właściciela.
- **Serwera sygnalizacyjnego NIE ruszamy.**
- **Nie uruchamiać niczego z `e2e/`** przy wykonywaniu zadań ani przy przeglądach — te skrypty otwierają prawdziwe okna na komputerze właściciela. Zadanie 11 tylko PISZE sprawdzian. **Żadnych zrzutów ekranu.**
- Stan wyjściowy: `main` na `28dce3b`, wersja 0.3.3, `npm test` 256/256, `tsc` czysto.

## Review Focus

Pięć klas wejść, których specyfikacja wymaga, a które najłatwiej przeoczyć. Każda ma przypisany test w zadaniu, które jest właścicielem kodu.

- **Ukryte WSZYSTKIE strumienie** — widok pustej siatki nie może powiedzieć „Nikt nie nadaje obrazu", gdy ludzie nadają, a Ty ich schowałeś. → Zadanie 4, krok 1.
- **Ukrycie POWIĘKSZONEGO kafelka** — `zoomed` trzyma `tileKey`, więc zostałoby wskazanie na kafelek, którego nie ma w siatce. → Zadanie 5, krok 1.
- **Jedna osoba nadająca ekran I kamerę** — ukrycie ekranu nie może ukryć kamery; klucze nie mogą się zlewać. → Zadanie 1, krok 1.
- **Własny podgląd kontra zapominanie** — `streamerRefs` zawiera tylko CUDZE strumienie, więc `presentKeys` musi obejmować też własne z `myStreamKinds`, inaczej ukrycie własnego kafelka zostanie zapomniane w tej samej klatce. → Zadanie 8, krok 1.
- **`subscribe` do osoby, która wyszła** między ukryciem i odkryciem — nie może rzucić ani zostawić wiszącego połączenia. → Zadanie 6, krok 7.

---

### Task 1: Czyste funkcje układu

**Files:**
- Create: `companion-app/src/shared/tileLayout.ts`
- Create: `companion-app/test/tile-layout.test.ts`

**Interfaces:**
- Consumes: `Tile` z `src/renderer/hooks/useLobby.ts` — **tylko jako typ**, przez `import type`. Plik `tileLayout.ts` nie może importować niczego wykonywalnego, bo wtedy test wciągnie React.
- Produces: `visibleTiles`, `applyTileOrder`, `moveTile`, `forgetMissingTiles` — sygnatury w kroku 3.

- [ ] **Step 1: Napisz testy, które padają**

Uwaga o `moveTile`: pierwszy parametr to **kolejność aktualnie wyrenderowana**, nie rzadka lista zapamiętana. Specyfikacja nazywa go `order`; tu nazywa się `currentKeys`, bo to precyzyjniej opisuje, co wywołujący podaje — po przeciągnięciu kolejność staje się w pełni jawna dla kafelków obecnych w tej chwili, a nowe i tak idą na koniec przez `applyTileOrder`.

`companion-app/test/tile-layout.test.ts`:

```ts
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
```

- [ ] **Step 2: Uruchom testy, upewnij się, że padają**

Run: `cd companion-app && npx vitest run test/tile-layout.test.ts`
Expected: FAIL — `Failed to resolve import "../src/shared/tileLayout"`

- [ ] **Step 3: Napisz implementację**

`companion-app/src/shared/tileLayout.ts`:

```ts
import type { Tile } from '../renderer/hooks/useLobby'

/*
 * Decyzje o układzie siatki, wyjęte z komponentu.
 *
 * Mieszkają w `src/shared`, bo to jedyne miejsce, w którym da się je
 * przetestować: vitest chodzi tu w gołym Node, bez jsdom, więc testów
 * komponentów nie ma w ogóle. Stąd też `import type` wyżej — gdyby to był
 * zwykły import, test wciągnąłby Reacta i cały renderer.
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
 * Generyczna i z `keyOf`, tak samo jak `useLeaveTransition`, bo pracuje dwa
 * razy w tym samym potoku: na `Tile[]` i na wierszach z przejścia wyjścia.
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

/**
 * Przycina ukryte i kolejność do strumieni, które nadal są nadawane.
 *
 * Reguła z projektu: zakończony strumień zapomina o sobie wszystko, więc gdy
 * wróci, jest nowym kafelkiem — widocznym i na końcu. Jedna zasada zamiast
 * dwóch wyjątków.
 *
 * `presentKeys` MUSI być prawdą z sygnalizacji, nie stanem połączeń ani DOM-u.
 * Kafelek znika z DOM-u na 400 ms animacji wyjścia i może zniknąć na czas
 * ponownego uzgadniania; przycinanie po stanie przejściowym zdejmowałoby
 * ukrycie przy każdym mignięciu połączenia.
 */
export function forgetMissingTiles(
  hidden: ReadonlySet<string>,
  order: readonly string[],
  presentKeys: ReadonlySet<string>
): { hidden: Set<string>; order: string[] } {
  return {
    hidden: new Set([...hidden].filter((key) => presentKeys.has(key))),
    order: order.filter((key) => presentKeys.has(key))
  }
}
```

- [ ] **Step 4: Uruchom testy, upewnij się, że przechodzą**

Run: `cd companion-app && npx vitest run test/tile-layout.test.ts`
Expected: PASS — 17 testów

- [ ] **Step 5: Potwierdź mutacjami, że testy pilnują**

Dla każdej mutacji: nałóż, uruchom `npx vitest run test/tile-layout.test.ts`, zanotuj **które** testy padły, przywróć **z kopii pliku** (nie przez `git checkout` — w repozytorium mogą leżeć niezacommitowane zmiany).

1. `applyTileOrder`: `[...byKey.values(), ...ordered]` → nowe na początku. Ma paść test „idzie na KONIEC".
2. `moveTile`: usuń przycinanie, `const target = toIndex`. Ma paść test indeksu poza zakresem.
3. `moveTile`: `if (from === -1) return []`. Ma paść test obcego klucza.
4. `forgetMissingTiles`: zwróć `order` nietknięte. Ma paść test usuwania z obu zbiorów.
5. `visibleTiles`: filtruj po `tile.peerId` zamiast `tile.tileKey`. Ma paść test ekranu i kamery tej samej osoby.

Zapisz wyniki w sprawozdaniu. Mutacja, która **przeżyje**, znaczy brakujący test — dopisz go, nie pomijaj.

- [ ] **Step 6: Sprawdź budowanie i cały pakiet**

Run: `cd companion-app && npm run build && npm test`
Expected: `tsc` bez błędów, **co najmniej 273 testy** (256 + 17) — oczekiwanie, nie sufit.

- [ ] **Step 7: Commit**

```bash
git add companion-app/src/shared/tileLayout.ts companion-app/test/tile-layout.test.ts
git commit -m "feat(siatka): czyste funkcje ukrywania, kolejnosci i zapominania kafelkow"
```

---

### Task 2: Wyśrodkowanie osieroconego kafelka

**Files:**
- Modify: `companion-app/src/renderer/components/LobbyView.tsx` (atrybut przy `.siatka`, okolice linii 344-346)
- Modify: `companion-app/src/renderer/styles.css` (przy regułach `.siatka`, okolice linii 810-830)

**Interfaces:**
- Consumes: nic
- Produces: atrybut `data-sierota` na kontenerze `.siatka`

- [ ] **Step 1: Dołóż atrybut w JSX**

W `LobbyView.tsx` kontener siatki ma dziś `data-ile={Math.min(tileRows.length, 4)}`. Dołóż obok:

```tsx
              data-ile={Math.min(tileRows.length, 4)}
              /*
               * Osierocony ostatni kafelek: nieparzysta liczba przy układzie
               * dwukolumnowym. Liczymy TUTAJ, a nie w CSS po `data-ile`, bo
               * `data-ile` jest ograniczone przez `Math.min(…, 4)` — przy pięciu
               * kafelkach wynosi też 4, więc reguła oparta na `data-ile="3"`
               * naprawiłaby trzy kafelki i zostawiła pięć z tą samą usterką.
               */
              data-sierota={tileRows.length >= 3 && tileRows.length % 2 === 1 ? '' : undefined}
```

- [ ] **Step 2: Dopisz regułę CSS**

W `styles.css`, zaraz po regule `.siatka[data-ile="2"], …[data-ile="3"], …[data-ile="4"]`:

```css
/* Osierocony ostatni kafelek na środku, nie przy lewej ściance.
   Cztery kolumny, każdy kafelek zajmuje dwie, ostatni startuje od drugiej —
   wychodzi ta sama szerokość co pozostałe, tylko wyśrodkowana. Działa dla
   trzech, pięciu i siedmiu, bo warunek liczy parzystość, a nie konkretną liczbę.

   `:last-child` jest pozycyjny, więc po przestawieniu kafelków wyśrodkowany
   jest ten, który faktycznie stoi na końcu — i to jest pożądane.

   Kafelek wychodzący wlicza się do parzystości przez 400 ms animacji, bo
   `tileRows` pochodzi z przejścia wyjścia. Skutek przyjęty świadomie: przy
   przejściu z czterech na trzy wyśrodkowanie pojawia się PO animacji.
   Liczenie bez wychodzących przestawiałoby układ W TRAKCIE zanikania, co jest
   gorsze. */
.siatka[data-sierota] {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.siatka[data-sierota] > * {
  grid-column: span 2;
}

.siatka[data-sierota] > :last-child {
  grid-column: 2 / span 2;
}
```

- [ ] **Step 3: Sprawdź, że powiększenie dalej wygrywa**

Reguła `.siatka--zoom` ma `grid-template-columns: 1fr !important`, więc powinna nadal przebijać nową regułę. **Przeczytaj oba selektory i potwierdź w sprawozdaniu**, że `!important` wygrywa z `[data-sierota]`, oraz że `> *` ze `span 2` nie psuje widoku powiększonego (przy jednej kolumnie `span 2` wykracza poza siatkę i przeglądarka dokłada kolumny domyślne).

Jeśli psuje — dołóż `.siatka--zoom > * { grid-column: auto !important; }` i napisz dlaczego.

- [ ] **Step 4: Sprawdź budowanie i testy**

Run: `cd companion-app && npm run build && npm test`
Expected: `tsc` bez błędów, co najmniej 273 testy. Tego zadania nie da się pokryć testem jednostkowym — to CSS i jeden atrybut; sprawdzian na żywo powstaje w zadaniu 11.

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/renderer/components/LobbyView.tsx companion-app/src/renderer/styles.css
git commit -m "fix(siatka): osierocony ostatni kafelek na srodku, nie przy sciance"
```

---

### Task 3: Ukrywanie własnego podglądu

Najtańszy kawałek i jednocześnie dowód, że potok działa: własny obraz jest lokalny, więc nie ma od kogo przestać go odbierać.

**Files:**
- Modify: `companion-app/src/renderer/components/LobbyView.tsx`

**Interfaces:**
- Consumes: `visibleTiles`, `applyTileOrder` z zadania 1
- Produces: stan `hidden: Set<string>`, `order: string[]` oraz `toggleHidden(tileKey: string)` w `LobbyView`

- [ ] **Step 1: Dołóż stan i wepnij funkcje w potok**

W `LobbyView.tsx`, obok pozostałych `useState`:

```tsx
  /*
   * Ukryte kafelki i kolejność. BEZ zapisywania na dysk — decyzja właściciela:
   * „za każdym razem będą inni użytkownicy strimać i inna ilość użytkowników".
   * Klucze to `tileKey`, czyli `connectionKey(peerId, kind)`.
   */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [order, setOrder] = useState<string[]>([])
```

Potok wokół istniejącego `tileRows` — **kolejność tych trzech kroków nie jest dowolna**:

```tsx
  /*
   * Odsiewanie ukrytych PRZED przejściem wyjścia, a kolejność PO nim.
   *
   * Przed: ukrycie wygląda wtedy jak każde inne zniknięcie strumienia, czyli
   * dostaje darmową animację wyjścia, a odkrycie animację wejścia.
   * Po: `useLeaveTransition` ma własną kolejność, a my chcemy, żeby decydowała
   * nasza — gasnący kafelek zachowuje klucz, więc zachowuje miejsce i nie
   * przeskakuje w trakcie zanikania.
   */
  const shownTiles = visibleTiles(tiles, hidden)
  const tileRows = applyTileOrder(
    useLeaveTransition(shownTiles, (tile) => tile.tileKey),
    order,
    (row) => row.item.tileKey
  )
```

Uwaga: istniejąca linia `const tileRows = useLeaveTransition(tiles, (tile) => tile.tileKey)` zostaje **zastąpiona** powyższym. Hook musi zostać wywołany bezwarunkowo i w tym samym miejscu kolejności wywołań.

Dołóż przełącznik:

```tsx
  const toggleHidden = useCallback((tileKey: string) => {
    setHidden((current) => {
      const next = new Set(current)
      if (next.has(tileKey)) next.delete(tileKey)
      else next.add(tileKey)
      return next
    })
  }, [])
```

`useCallback` wymaga dopisania do importu z `react`.

- [ ] **Step 2: Dołóż krzyżyk na własnym kafelku**

W miejscu renderowania kafelków przekaż do `StreamTile` nowy props. Na razie tylko dla własnego kafelka — cudze dostaną go w zadaniu 5:

```tsx
                onHide={row.item.isMe ? () => toggleHidden(row.item.tileKey) : undefined}
```

- [ ] **Step 3: Odbierz props w StreamTile**

W `StreamTile.tsx` dołóż do `StreamTileProps`:

```tsx
  /**
   * Ukryj ten kafelek w SWOJEJ siatce. `undefined` znaczy „tego kafelka nie da
   * się ukryć" — wtedy guzika nie ma wcale, zamiast nieaktywnego.
   */
  onHide?: () => void
```

i w nagłówku kafelka, wewnątrz `<div className="tile…">`, przed `tile__stage`:

```tsx
      {onHide && (
        <button
          type="button"
          className="tile__hide"
          onClick={onHide}
          title="Ukryj ten kafelek u siebie"
          aria-label="Ukryj ten kafelek u siebie"
        >
          <span aria-hidden="true">✕</span>
        </button>
      )}
```

Pamiętaj o dopisaniu `onHide` do listy rozpakowanych propsów w sygnaturze funkcji.

- [ ] **Step 4: Dopisz styl**

W `styles.css`, przy regułach `.tile*`:

```css
/* Guziki na kafelku pojawiają się pod kursorem, bo przy oglądaniu obrazu
   nie mają prawa niczego zasłaniać. `z-index` nie jest potrzebny: guzik stoi
   w DOM-ie po `tile__stage`, więc i tak jest nad nim. */
.tile__hide {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.6);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.tile:hover .tile__hide,
.tile__hide:focus-visible {
  opacity: 1;
}
```

Klawiatura: `:focus-visible` pokazuje guzik także bez myszy — inaczej byłby nieosiągalny z klawiatury.

- [ ] **Step 5: Sprawdź budowanie i testy**

Run: `cd companion-app && npm run build && npm test`
Expected: `tsc` bez błędów, co najmniej 273 testy.

- [ ] **Step 6: Commit**

```bash
git add companion-app/src/renderer/components/LobbyView.tsx \
        companion-app/src/renderer/components/StreamTile.tsx \
        companion-app/src/renderer/styles.css
git commit -m "feat(siatka): ukrywanie wlasnego podgladu bez przerywania transmisji"
```

---

### Task 4: Oczko w liście uczestników i prawdziwy komunikat pustej siatki

**Files:**
- Modify: `companion-app/src/shared/participants.ts`
- Modify: `companion-app/test/participants.test.ts` (jeśli pliku nie ma, utwórz)
- Modify: `companion-app/src/renderer/components/ParticipantRow.tsx`
- Modify: `companion-app/src/renderer/components/PeerPanel.tsx`
- Modify: `companion-app/src/renderer/components/LobbyView.tsx`
- Modify: `companion-app/src/renderer/styles.css`

**Interfaces:**
- Consumes: `hidden`, `toggleHidden` z zadania 3
- Produces: `hiddenKindsFor(peerId, hidden)` w `participants.ts`; props `onToggleStream` w `ParticipantRow` i `PeerPanel`

- [ ] **Step 1: Napisz testy, które padają**

Pierwszy test jest z listy Review Focus: **ukryte wszystkie strumienie nie mogą dawać komunikatu „nikt nie nadaje"**. Decyzję wyjmujemy do czystej funkcji, bo tylko tam da się ją przetestować.

Dopisz do `companion-app/test/participants.test.ts`:

```ts
import { emptyGridMessage, hiddenKindsFor } from '../src/shared/participants'

test('ukrycie wszystkich strumieni NIE mówi, że nikt nie nadaje', () => {
  // Najłatwiejszy sposób zablokowania sobie obrazu to ukrycie wszystkiego.
  // Komunikat „Nikt nie nadaje obrazu" byłby wtedy kłamstwem i nie
  // podpowiadałby wyjścia — człowiek uznałby to za awarię.
  expect(emptyGridMessage({ streamCount: 2, hiddenCount: 2 })).toBe('all-hidden')
})

test('brak strumieni mówi, że nikt nie nadaje', () => {
  expect(emptyGridMessage({ streamCount: 0, hiddenCount: 0 })).toBe('nobody-streaming')
})

test('strumienie są, ale obraz jeszcze nie doszedł', () => {
  expect(emptyGridMessage({ streamCount: 1, hiddenCount: 0 })).toBe('connecting')
})

test('część ukryta, a reszta jeszcze nie doszła', () => {
  // Jeden ukryty i jeden w drodze: siatka jest pusta, ale nie dlatego, że
  // wszystko ukryto — podpowiedź o oczku byłaby tu myląca.
  expect(emptyGridMessage({ streamCount: 2, hiddenCount: 1 })).toBe('connecting')
})

test('rodzaje ukryte u danej osoby', () => {
  const hidden = new Set(['a:screen', 'b:camera'])
  expect(hiddenKindsFor('a', hidden)).toEqual({ screen: true, camera: false })
  expect(hiddenKindsFor('b', hidden)).toEqual({ screen: false, camera: true })
  expect(hiddenKindsFor('c', hidden)).toEqual({ screen: false, camera: false })
})
```

- [ ] **Step 2: Uruchom testy, upewnij się, że padają**

Run: `cd companion-app && npx vitest run test/participants.test.ts`
Expected: FAIL — `emptyGridMessage is not a function`

- [ ] **Step 3: Napisz implementację w `participants.ts`**

```ts
/** Co pokazać, gdy siatka jest pusta. */
export type EmptyGridMessage = 'nobody-streaming' | 'connecting' | 'all-hidden'

/**
 * Rozstrzyga, dlaczego siatka jest pusta.
 *
 * Trzy różne przyczyny, które wyglądają identycznie: nikt nie nadaje, obraz
 * jeszcze nie doszedł, albo widz ukrył wszystko. Trzeci przypadek doszedł razem
 * z ukrywaniem i bez niego aplikacja mówiłaby „Nikt nie nadaje obrazu", gdy
 * ludzie nadają — czyli kłamała, i to w jedynym miejscu, w którym człowiek
 * szuka wyjaśnienia.
 */
export function emptyGridMessage(input: {
  streamCount: number
  hiddenCount: number
}): EmptyGridMessage {
  if (input.streamCount === 0) return 'nobody-streaming'
  if (input.hiddenCount >= input.streamCount) return 'all-hidden'
  return 'connecting'
}

/** Które rodzaje strumieni tej osoby są u nas ukryte. */
export function hiddenKindsFor(
  peerId: string,
  hidden: ReadonlySet<string>
): { screen: boolean; camera: boolean } {
  return {
    screen: hidden.has(`${peerId}:screen`),
    camera: hidden.has(`${peerId}:camera`)
  }
}
```

- [ ] **Step 4: Uruchom testy, upewnij się, że przechodzą**

Run: `cd companion-app && npx vitest run test/participants.test.ts`
Expected: PASS

- [ ] **Step 5: Potwierdź mutacją**

Zamień w `emptyGridMessage` kolejność dwóch pierwszych warunków (najpierw `all-hidden`, potem `nobody-streaming`). Ma paść test „brak strumieni mówi, że nikt nie nadaje", bo przy zerze `hiddenCount >= streamCount` jest prawdą. Przywróć z kopii i zapisz wynik w sprawozdaniu.

- [ ] **Step 6: Podepnij komunikat w `LobbyView`**

Zastąp istniejący warunek przy `tileRows.length === 0`:

```tsx
            <div className="viewer__stage">
              <div className="viewer__waiting">
                {
                  {
                    'nobody-streaming': 'Nikt nie nadaje obrazu. Możesz zacząć jako pierwszy.',
                    connecting: 'Odbieranie obrazu…',
                    'all-hidden':
                      'Wszystkie strumienie są ukryte. Oczko przy nazwie w liście uczestników przywraca je.'
                  }[
                    emptyGridMessage({
                      streamCount: tiles.length,
                      hiddenCount: tiles.filter((tile) => hidden.has(tile.tileKey)).length
                    })
                  ]
                }
              </div>
            </div>
```

Uwaga: `tiles` to lista **przed** odsianiem ukrytych, więc `streamCount` liczy wszystko, co faktycznie jest nadawane — w tym własne kafelki.

- [ ] **Step 7: Dołóż oczko do `ParticipantRow`**

Do `ParticipantRowProps`:

```tsx
  /**
   * Które rodzaje strumieni tej osoby są ukryte u nas, i przełącznik.
   * `onToggleStream` jest `undefined` dla własnego wiersza i dla osób, które
   * nic nie nadają — nie ma wtedy czego ukrywać.
   */
  hiddenKinds: { screen: boolean; camera: boolean }
  onToggleStream?: (kind: StreamKind) => void
```

Oczko renderuj przy każdej plakietce `screen`/`camera`, jako guzik:

```tsx
        {onToggleStream && badge.kind === 'screen' && (
          <button
            type="button"
            className={`participant__eye${hiddenKinds.screen ? ' participant__eye--off' : ''}`}
            onClick={() => onToggleStream('screen')}
            title={hiddenKinds.screen ? 'Pokaż ekran tej osoby' : 'Ukryj ekran tej osoby'}
            aria-label={hiddenKinds.screen ? 'Pokaż ekran tej osoby' : 'Ukryj ekran tej osoby'}
            aria-pressed={hiddenKinds.screen}
          >
            <span aria-hidden="true">{hiddenKinds.screen ? '🚫' : '👁'}</span>
          </button>
        )}
```

To samo dla `badge.kind === 'camera'` z `hiddenKinds.camera` i tekstem „kamerę tej osoby". Powtarzam kod świadomie — wykonawca może czytać zadania nie po kolei.

- [ ] **Step 8: Przekaż przez `PeerPanel`**

`PeerPanel` dostaje `hidden: ReadonlySet<string>` i `onToggleStream: (peerId: string, kind: StreamKind) => void`, a dla każdego wiersza liczy `hiddenKindsFor(row.item.peerId, hidden)` i podaje `onToggleStream` tylko wtedy, gdy wiersz **nie jest nasz** (`!row.item.isMe`).

W `LobbyView` przekaż `hidden={hidden}` i `onToggleStream={(peerId, kind) => toggleHidden(connectionKey(peerId, kind))}`. `connectionKey` importuj z `../webrtc/session` — jest już eksportowany.

- [ ] **Step 9: Dopisz styl oczka**

```css
/* Oczko przy plakietce strumienia. Wyciszone, bo to sterowanie, a nie
   informacja — ma być pod ręką, nie przyciągać wzroku. */
.participant__eye {
  border: none;
  background: transparent;
  padding: 0 2px;
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  opacity: 0.65;
}

.participant__eye:hover,
.participant__eye:focus-visible {
  opacity: 1;
}

/* Wyłączony strumień: oczko zostaje widoczne, bo to jedyna droga powrotu. */
.participant__eye--off {
  opacity: 1;
}
```

- [ ] **Step 10: Sprawdź budowanie i testy**

Run: `cd companion-app && npm run build && npm test`
Expected: `tsc` bez błędów, **co najmniej 278 testów**.

- [ ] **Step 11: Commit**

```bash
git add companion-app/src/shared/participants.ts companion-app/test/participants.test.ts \
        companion-app/src/renderer/components/ParticipantRow.tsx \
        companion-app/src/renderer/components/PeerPanel.tsx \
        companion-app/src/renderer/components/LobbyView.tsx \
        companion-app/src/renderer/styles.css
git commit -m "feat(siatka): oczko ukrywania w liscie uczestnikow i prawdziwy komunikat pustej siatki"
```

---

### Task 5: Krzyżyk na cudzym kafelku i zdjęcie powiększenia

**Files:**
- Modify: `companion-app/src/shared/tileLayout.ts`
- Modify: `companion-app/test/tile-layout.test.ts`
- Modify: `companion-app/src/renderer/components/LobbyView.tsx`

> **ODWOLANE W TRAKCIE WYKONANIA (Ruling 11).** Kroki 1-5 tego zadania NIE
> zostaly wykonane i nie maja byc. Funkcja `zoomAfterHide` **nie istnieje**.
> Zdejmowanie powiekszenia robi efekt w `LobbyView` dolozony przy zadaniu 3,
> ktory sprawdza `shownTiles` i lapie KAZDA przyczyne zniknięcia kafelka
> (ukrycie, koniec strumienia, wyjscie osoby) — czyli jest ogolniejszy. Dwa
> mechanizmy na jeden niezmiennik to drugie zrodlo prawdy. Z tego zadania
> wykonano wylacznie krok 6 (krzyzyk na kazdym kafelku) plus przeniesione
> porzadki w plikach testow.

**Interfaces:**
- Consumes: `toggleHidden` z zadania 3
- Produces: nic (patrz odwolanie wyzej)

- [ ] **Step 1: Napisz test z listy Review Focus**

Dopisz do `test/tile-layout.test.ts`:

```ts
import { zoomAfterHide } from '../src/shared/tileLayout'

test('ukrycie powiększonego kafelka zdejmuje powiększenie', () => {
  // `zoomed` trzyma tileKey. Bez tego zostałoby wskazanie na kafelek, którego
  // nie ma w siatce — czyli powiększona pustka i brak drogi powrotu, bo
  // zmniejsza się kliknięciem w kafelek.
  expect(zoomAfterHide('a:screen', 'a:screen')).toBeNull()
})

test('ukrycie innego kafelka nie rusza powiększenia', () => {
  expect(zoomAfterHide('a:screen', 'b:camera')).toBe('a:screen')
})

test('brak powiększenia zostaje brakiem', () => {
  expect(zoomAfterHide(null, 'a:screen')).toBeNull()
})
```

- [ ] **Step 2: Uruchom test, upewnij się, że pada**

Run: `cd companion-app && npx vitest run test/tile-layout.test.ts`
Expected: FAIL — `zoomAfterHide is not a function`

- [ ] **Step 3: Napisz implementację**

W `tileLayout.ts`:

```ts
/**
 * Co zrobić z powiększeniem, gdy ukrywany jest kafelek.
 *
 * Powiększenie zdejmuje się kliknięciem w sam kafelek, więc powiększenie
 * wskazujące kafelek nieobecny w siatce byłoby pułapką bez wyjścia.
 */
export function zoomAfterHide(zoomed: string | null, hiddenKey: string): string | null {
  return zoomed === hiddenKey ? null : zoomed
}
```

- [ ] **Step 4: Uruchom test, upewnij się, że przechodzi**

Run: `cd companion-app && npx vitest run test/tile-layout.test.ts`
Expected: PASS

- [ ] **Step 5: Podepnij w `LobbyView`**

Rozszerz `toggleHidden` tak, żeby przy **ukrywaniu** (nie przy odkrywaniu) zdejmował powiększenie:

```tsx
  const toggleHidden = useCallback((tileKey: string) => {
    setHidden((current) => {
      const next = new Set(current)
      if (next.has(tileKey)) {
        next.delete(tileKey)
      } else {
        next.add(tileKey)
        // Tylko przy ukrywaniu: odkrycie nie ma powodu ruszać powiększenia.
        setZoomed((zoom) => zoomAfterHide(zoom, tileKey))
      }
      return next
    })
  }, [])
```

Uwaga o `StrictMode`: aktualizator `setHidden` wykona się w trybie rozwojowym dwa razy, więc `setZoomed` w jego środku też. `zoomAfterHide` jest idempotentna (drugie wywołanie dostaje już `null`), więc to nic nie psuje — **potwierdź to w sprawozdaniu**, bo gdyby wywołanie nie było idempotentne, byłaby to cicha usterka widoczna tylko w dev.

- [ ] **Step 6: Daj krzyżyk wszystkim kafelkom**

Zmień przekazanie z zadania 3 tak, żeby `onHide` dostawał **każdy** kafelek, nie tylko własny:

```tsx
                onHide={() => toggleHidden(row.item.tileKey)}
```

- [ ] **Step 7: Sprawdź budowanie i testy**

Run: `cd companion-app && npm run build && npm test`
Expected: `tsc` bez błędów, **co najmniej 281 testów**.

- [ ] **Step 8: Commit**

```bash
git add companion-app/src/shared/tileLayout.ts companion-app/test/tile-layout.test.ts \
        companion-app/src/renderer/components/LobbyView.tsx
git commit -m "feat(siatka): krzyzyk ukrywania na kazdym kafelku, ze zdjeciem powiekszenia"
```

---

### Task 6: Rezygnacja z odbioru w protokole

Najbardziej delikatne zadanie w planie: dotyka zgodności ze starszymi wersjami aplikacji, które są u ludzi.

**Files:**
- Modify: `companion-app/src/renderer/webrtc/session.ts`
- Create: `companion-app/test/signal-compat.test.ts`

**Interfaces:**
- Consumes: istniejące `createOutgoing(peerId, kind)`, `dropOutgoing(peerId, kind)`, `closeIncoming(streamerId, kind)`
- Produces: `unsubscribeFrom(peerId, kind)` i `subscribeTo(peerId, kind)` jako publiczne metody `LobbySession`; nowy wariant `SignalPayload`; `unsubscribePayload(kind)` jako eksportowana czysta funkcja

- [ ] **Step 1: Napisz test zgodności, który pada**

To najważniejszy test tego zadania. Pilnuje nazwy pola, od której zależy, czy starsze wersje aplikacji nie zaczną się psuć u ludzi.

`companion-app/test/signal-compat.test.ts`:

```ts
import { expect, test } from 'vitest'
import { unsubscribePayload } from '../src/renderer/webrtc/signalCompat'

/*
 * Dlaczego ten plik istnieje.
 *
 * `onSignal` w WYDANYCH wersjach aplikacji (0.3.3 i starszych) nie ma gałęzi
 * „nieznany rodzaj": wszystko, co nie jest `quality`, `offer` ani `answer`,
 * spada na ścieżkę kandydata ICE i wykonuje
 * `incomingBuffers.get(connectionKey(from, payload.stream))?.add(payload.candidate)`.
 *
 * Przy polu `streamKind` klucz wychodzi „peer:undefined", nie pasuje do
 * żadnego bufora, operator `?.` wycisza wywołanie i stary klient ignoruje
 * wiadomość DOWODNIE. Gdyby pole nazywało się `stream`, klucz trafiłby
 * w prawdziwy bufor i wywołał `addIceCandidate(undefined)`, co w WebRTC znaczy
 * „koniec kandydatów" — w środku uzgadniania mogłoby to zepsuć zestawianie
 * połączenia u kogoś, kto nawet nie ma tej funkcji.
 *
 * Ten sam wzorzec i z tego samego powodu ma wiadomość `quality` z 0.3.1 —
 * patrz jej komentarz w `session.ts`.
 */

test('treść rezygnacji NIE MA pola `stream` — to warunek zgodności wstecz', () => {
  const payload = unsubscribePayload('screen')
  expect('stream' in payload).toBe(false)
})

test('rodzaj strumienia jedzie w polu `streamKind`', () => {
  expect(unsubscribePayload('screen').streamKind).toBe('screen')
  expect(unsubscribePayload('camera').streamKind).toBe('camera')
})

test('treść rezygnacji nie ma pola `candidate` ani `owner`', () => {
  // Oba są czytane przez starą ścieżkę ICE. `candidate: undefined` byłoby
  // nieszkodliwe tylko przez przypadek, a `owner` równy nam skierowałby
  // starego klienta do drugiego bufora.
  const payload = unsubscribePayload('screen')
  expect('candidate' in payload).toBe(false)
  expect('owner' in payload).toBe(false)
})
```

- [ ] **Step 2: Uruchom test, upewnij się, że pada**

Run: `cd companion-app && npx vitest run test/signal-compat.test.ts`
Expected: FAIL — nie da się rozwiązać importu `signalCompat`

- [ ] **Step 3: Wydziel czystą część do nowego pliku**

`companion-app/src/renderer/webrtc/signalCompat.ts` — osobny plik, bo `session.ts` importuje rzeczy przeglądarkowe i nie da się go wciągnąć do gołego Node:

```ts
import type { StreamKind } from '../../shared/types'

/** Treść wiadomości o rezygnacji z odbioru i o powrocie do odbioru. */
export interface SubscriptionPayload {
  kind: 'unsubscribe' | 'subscribe'
  streamKind: StreamKind
}

/*
 * Pole nazywa się `streamKind`, a NIE `stream`, i to jest warunek zgodności
 * wstecz, nie kwestia gustu — pełne uzasadnienie w `test/signal-compat.test.ts`.
 * Ten sam wzorzec ma wiadomość `quality` z 0.3.1.
 *
 * NIE ZMIENIAJ tej nazwy na krótszą. Skutek byłby widoczny wyłącznie u osób
 * ze starszą wersją aplikacji, jako nieudane zestawianie połączenia, i nikt nie
 * powiązałby tego z tą zmianą.
 */
export function unsubscribePayload(streamKind: StreamKind): SubscriptionPayload {
  return { kind: 'unsubscribe', streamKind }
}

export function subscribePayload(streamKind: StreamKind): SubscriptionPayload {
  return { kind: 'subscribe', streamKind }
}
```

- [ ] **Step 4: Uruchom test, upewnij się, że przechodzi**

Run: `cd companion-app && npx vitest run test/signal-compat.test.ts`
Expected: PASS — 3 testy

- [ ] **Step 5: Potwierdź mutacją, że test pilnuje nazwy**

Zmień w `signalCompat.ts` pole `streamKind` na `stream` (w interfejsie i w obu funkcjach). Uruchom `npx vitest run test/signal-compat.test.ts` — mają paść dwa testy. Przywróć z kopii i zapisz wynik w sprawozdaniu.

- [ ] **Step 6: Wepnij wariant do `SignalPayload` i obsłuż go**

W `session.ts` dołóż do typu `SignalPayload`:

```ts
  /**
   * Widz rezygnuje z odbioru tego strumienia albo wraca do niego.
   *
   * CELOWO bez pola `stream` — ta sama reguła zgodności co przy `quality`
   * wyżej. Rodzaj jedzie w `streamKind`.
   */
  | { kind: 'unsubscribe'; streamKind: StreamKind }
  | { kind: 'subscribe'; streamKind: StreamKind }
```

W `onSignal`, **przed** wyliczeniem `const kind = payload.stream` (bo te warianty go nie mają, dokładnie jak `quality`):

```ts
    if (payload.kind === 'unsubscribe') {
      // Widz nie chce już tego strumienia: zwijamy nadawanie do niego.
      // `dropOutgoing` jest bezpieczne także wtedy, gdy połączenia nie ma.
      this.dropOutgoing(from, payload.streamKind)
      return
    }

    if (payload.kind === 'subscribe') {
      /*
       * Widz wraca. NIE dublujemy tu warunków: `callPeer` już sprawdza, czy
       * sesja nie jest zamknięta, czy połączenie już nie istnieje i czy ten
       * rodzaj FAKTYCZNIE nadajemy (`!this.localStreams.has(kind)`).
       * Powtórzenie tych sprawdzeń tworzyłoby drugie źródło tej samej prawdy,
       * które rozjedzie się przy pierwszej zmianie w `callPeer`.
       */
      void this.callPeer(from, payload.streamKind)
      return
    }
```

Nazwy są sprawdzone w kodzie i są prawdziwe: `callPeer(peerId, kind)` (prywatna, `async`, linia ~471) z gardą
`if (this.disposed || this.outgoing.has(key) || !this.localStreams.has(kind)) return`,
oraz `this.peers` jako `Map<string, string>` (peerId → nazwa, linia 185).

- [ ] **Step 7: Dołóż metody publiczne i test wyjścia osoby**

```ts
  /** Rezygnuje z odbioru: zamyka swoją stronę i prosi nadawcę, żeby przestał. */
  unsubscribeFrom(peerId: string, kind: StreamKind): void {
    this.closeIncoming(peerId, kind)
    this.signaling.signal(peerId, unsubscribePayload(kind))
  }

  /** Wraca do odbioru: prosi nadawcę o ofertę. */
  subscribeTo(peerId: string, kind: StreamKind): void {
    // Osoba mogła wyjść między ukryciem i odkryciem. Wysyłanie do nieobecnego
    // peera kończy się u serwera błędem „Nieznany peer: …", który trafiłby do
    // użytkownika jako komunikat o awarii — a to nie jest awaria.
    if (!this.peers.has(peerId)) return
    this.signaling.signal(peerId, subscribePayload(kind))
  }
```

Wysyłanie jest sprawdzone w kodzie: `this.signaling.signal(peerId, payload)` — tak samo
jak przy ofercie w `callPeer` (linia ~477). Komunikat serwera przy nieobecnym
adresacie to dosłownie `Nieznany peer: <id>` (`signaling-server/src/server.ts`, ~299).

- [ ] **Step 8: Sprawdź budowanie i testy**

Run: `cd companion-app && npm run build && npm test`
Expected: `tsc` bez błędów, **co najmniej 284 testy**.

- [ ] **Step 9: Commit**

```bash
git add companion-app/src/renderer/webrtc/signalCompat.ts \
        companion-app/test/signal-compat.test.ts \
        companion-app/src/renderer/webrtc/session.ts
git commit -m "feat(siatka): rezygnacja z odbioru i powrot, zgodne ze starszymi wersjami"
```

---

### Task 7: Podpięcie rezygnacji do ukrywania

**Files:**
- Modify: `companion-app/src/renderer/hooks/useLobby.ts`
- Modify: `companion-app/src/renderer/components/LobbyView.tsx`

**Interfaces:**
- Consumes: `unsubscribeFrom`, `subscribeTo` z zadania 6; `toggleHidden` z zadania 5
- Produces: `setStreamSubscribed(peerId, kind, subscribed)` w interfejsie `Lobby`

- [ ] **Step 1: Wystaw metodę w `useLobby`**

Do interfejsu `Lobby`:

```ts
  /**
   * Włącza i wyłącza odbiór pojedynczego strumienia.
   *
   * Metoda, nie stan: to rozkaz do sesji WebRTC, a nie dana do wyrenderowania.
   */
  setStreamSubscribed: (peerId: string, kind: StreamKind, subscribed: boolean) => void
```

Do zwracanego obiektu:

```ts
    setStreamSubscribed: (peerId, kind, subscribed) => {
      const session = sessionRef.current
      if (!session) return
      if (subscribed) session.subscribeTo(peerId, kind)
      else session.unsubscribeFrom(peerId, kind)
    },
```

- [ ] **Step 2: Potwierdź, że nieosiągalność JUŻ jest obsłużona — i nic nie dokładaj**

Ten krok nie zmienia kodu. Jest tu po to, żeby **nie dopisać** zabezpieczenia, które już istnieje.

Rezygnacja zamyka połączenie z własnej woli, więc na pierwszy rzut oka grozi zapaleniem ostrzeżenia „Brak połączenia". **Nie grozi**, z dwóch powodów, oba już w kodzie:

1. `closeIncoming` (linia ~542) i `dropOutgoing` (linia ~485) kończą się wywołaniem
   `markReachability` z trzecim argumentem `false` (prefiks `in:` albo `out:` plus
   `connectionKey`) — czyli **czyszczą** wpis o awarii.
   Komentarz w `closeIncoming` mówi wprost: „bez tej linii wpis o awarii przeżyłby
   zdjęcie transmisji — dokładnie ten błąd, który cały rejestr miał wyeliminować".
2. `close()` w WebRTC 1.0 ustawia `connectionState` na `closed` **bez** emitowania
   `connectionstatechange`, więc nasłuch się nie odpala i nowa awaria nie powstaje.

Czyli po `unsubscribeFrom` para wypada z `failedConnections`, a `onUnreachableChange`
dostaje zbiór bez niej.

**Zweryfikuj to czytając oba miejsca i napisz w sprawozdaniu, że potwierdzasz.** Jeśli
mimo to uznasz, że zabezpieczenie jest potrzebne, napisz **jaki konkretny przebieg**
je wymaga — nie dokładaj zbioru „na wszelki wypadek". Dodatkowy stan, który duplikuje
istniejący rejestr `failedConnections`, rozjedzie się z nim przy pierwszej zmianie.

- [ ] **Step 3: Podepnij do przełącznika ukrywania**

W `LobbyView` rozszerz `toggleHidden` tak, żeby dla **cudzych** kafelków dodatkowo przestawiał odbiór. Własne pomijamy — swój obraz jest lokalny, nie ma od kogo przestać go odbierać:

```tsx
  const toggleHidden = useCallback(
    (tileKey: string, peerId: string, kind: StreamKind, isMe: boolean) => {
      setHidden((current) => {
        const next = new Set(current)
        const hiding = !next.has(tileKey)
        // UWAGA: wczesniejsza wersja tego planu wolala tu odwolana funkcje
        // `zoomAfterHide`. Powiekszenia NIE ruszamy w tym zadaniu wcale —
        // zdejmuje je efekt na `shownTiles` dolozony przy zadaniu 3.
        if (hiding) next.add(tileKey)
        else next.delete(tileKey)
        // Własny podgląd jest lokalny — sieci nie dotyczy.
        if (!isMe) setStreamSubscribed(peerId, kind, !hiding)
        return next
      })
    },
    [setStreamSubscribed]
  )
```

Dopasuj wszystkie miejsca wywołania (kafelek i lista uczestników), żeby podawały cztery argumenty. Dla listy uczestników `isMe` bierz z wiersza, a `tileKey` z `connectionKey(peerId, kind)`.

- [ ] **Step 4: Sprawdź budowanie i testy**

Run: `cd companion-app && npm run build && npm test`
Expected: `tsc` bez błędów, co najmniej 284 testy.

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/renderer/hooks/useLobby.ts \
        companion-app/src/renderer/webrtc/session.ts \
        companion-app/src/renderer/components/LobbyView.tsx
git commit -m "feat(siatka): ukrycie cudzego strumienia naprawde przestaje go odbierac"
```

---

### Task 8: Zapominanie zakończonych strumieni

**Files:**
- Modify: `companion-app/test/tile-layout.test.ts`
- Modify: `companion-app/src/renderer/components/LobbyView.tsx`

**Interfaces:**
- Consumes: `forgetMissingTiles` z zadania 1
- Produces: nic dla dalszych zadań

- [ ] **Step 1: Napisz test z listy Review Focus**

Dopisz do `test/tile-layout.test.ts`:

```ts
test('własny kafelek nie jest zapominany, choć nie ma go w streamerRefs', () => {
  /*
   * `streamerRefs` w sesji trzyma CUDZE nadawane strumienie — własnych tam nie
   * ma, bo do samych siebie nic nie wysyłamy. Gdyby `presentKeys` brało tylko
   * tę mapę, ukrycie własnego podglądu zostałoby zapomniane w tej samej
   * klatce, w której je włączono: kafelek wróciłby natychmiast i guzik
   * wyglądałby na zepsuty.
   *
   * Dlatego wywołujący MUSI złożyć `presentKeys` z cudzych strumieni ORAZ
   * własnych rodzajów. Ten test pilnuje kontraktu po stronie funkcji: własny
   * klucz obecny w `presentKeys` przeżywa.
   */
  const result = forgetMissingTiles(
    new Set(['ja:screen']),
    ['ja:screen'],
    new Set(['ja:screen'])
  )
  expect([...result.hidden]).toEqual(['ja:screen'])
  expect(result.order).toEqual(['ja:screen'])
})
```

- [ ] **Step 2: Uruchom test, upewnij się, że przechodzi**

Run: `cd companion-app && npx vitest run test/tile-layout.test.ts`
Expected: PASS — funkcja już to robi; ten test **przybija kontrakt**, którego łatwo nie dopełnić po stronie wywołującego. Napisz w sprawozdaniu, że przeszedł od razu, i że dlatego prawdziwą ochroną jest krok 3.

- [ ] **Step 3: Podepnij zapominanie w `LobbyView`**

```tsx
  /*
   * Zakończony strumień zapomina o sobie wszystko: wypada z ukrytych i z
   * kolejności, więc gdy wróci, jest nowym kafelkiem — widocznym i na końcu.
   *
   * `presentKeys` składamy z DWÓCH źródeł. Cudze strumienie z
   * `lobby.state.streams` (to `streamerRefs` w sesji), a własne z
   * `myStreamKinds` — bo do samych siebie nic nie wysyłamy, więc nasze kafelki
   * w `streamerRefs` nie istnieją. Pominięcie drugiego źródła sprawiłoby, że
   * ukrycie własnego podglądu zdejmowałoby się natychmiast.
   *
   * Prawda z SYGNALIZACJI, nie ze stanu połączeń ani z DOM-u: kafelek znika
   * z DOM-u na 400 ms animacji wyjścia i na czas ponownego uzgadniania.
   */
  const presentKeys = useMemo(() => {
    const keys = new Set(
      lobby.state.streams.map((ref) => connectionKey(ref.peerId, ref.kind))
    )
    const myPeerId = lobby.state.me?.peerId
    if (myPeerId) {
      for (const kind of lobby.state.myStreamKinds) keys.add(connectionKey(myPeerId, kind))
    }
    return keys
  }, [lobby.state.streams, lobby.state.me, lobby.state.myStreamKinds])

  useEffect(() => {
    setHidden((currentHidden) => {
      setOrder((currentOrder) => forgetMissingTiles(currentHidden, currentOrder, presentKeys).order)
      return forgetMissingTiles(currentHidden, [], presentKeys).hidden
    })
  }, [presentKeys])
```

Uwaga: zagnieżdżony ustawiacz wyżej jest nieelegancki. Jeśli przy wykonaniu zobaczysz czystszy sposób trzymania obu zbiorów spójnie (na przykład jeden `useState` z obiektem `{ hidden, order }`, tak jak `PanelTimeline` w diagnostyce 0.3.3), **zrób to i opisz w sprawozdaniu** — to jest dokładnie ten sam problem dwóch stanów aktualizowanych razem, który tam rozstrzygnięto scaleniem w jeden.

**Sprawdź `StreamRef`** — czy ma pola `peerId` i `kind`. Jeśli nazywają się inaczej, dopasuj.

- [ ] **Step 4: Sprawdź budowanie i testy**

Run: `cd companion-app && npm run build && npm test`
Expected: `tsc` bez błędów. Faktycznie po zadaniu 8: **312 testów** (307 przed rundą poprawek).

- [ ] **Step 5: Commit**

```bash
git add companion-app/test/tile-layout.test.ts companion-app/src/renderer/components/LobbyView.tsx
git commit -m "feat(siatka): zakonczony strumien zapomina ukrycie i miejsce w kolejnosci"
```

---

### Task 9: Przesuwanie kafelków

**Files:**
- Modify: `companion-app/src/renderer/components/StreamTile.tsx`
- Modify: `companion-app/src/renderer/components/LobbyView.tsx`
- Modify: `companion-app/src/renderer/styles.css`

**Interfaces:**
- Consumes: `moveTile` z zadania 1
- Produces: props `onDragStart` w `StreamTile`; obsługa przeciągania w `LobbyView`

- [ ] **Step 1: Dołóż uchwyt do kafelka**

Uchwyt, nie całe kafelek: `.tile__stage` ma już kliknięcie powiększające, a przeciąganie z dowolnego miejsca kolidowałoby z nim przy każdym drgnięciu myszy.

Do `StreamTileProps`:

```tsx
  /**
   * Zaczyna przeciąganie tego kafelka. `undefined` znaczy „nie da się
   * przestawić" — wtedy uchwytu nie ma wcale.
   */
  onDragStart?: (event: React.PointerEvent) => void
```

W kafelku, symetrycznie do krzyżyka:

```tsx
      {onDragStart && (
        <button
          type="button"
          className="tile__grip"
          onPointerDown={onDragStart}
          title="Przeciągnij, żeby zmienić kolejność"
          aria-label="Przeciągnij, żeby zmienić kolejność"
        >
          <span aria-hidden="true">⠿</span>
        </button>
      )}
```

- [ ] **Step 2: Obsłuż przeciąganie w `LobbyView`**

Zdarzenia wskaźnika, nie HTML5 drag-and-drop: HTML5 DnD rysuje własny obraz przeciąganego elementu, czego przy kafelku z żywym wideo nie da się opanować, nie działa sensownie z dotykiem i nie pozwala animować.

```tsx
  const gridRef = useRef<HTMLDivElement>(null)
  const dragKeyRef = useRef<string | null>(null)

  const onTileDragStart = useCallback(
    (tileKey: string) =>
      (event: React.PointerEvent): void => {
        event.preventDefault()
        dragKeyRef.current = tileKey
        const target = event.currentTarget as HTMLElement
        // Przechwycenie wskaźnika: bez niego ruch poza element gubi zdarzenia,
        // a przeciąganie zacina się przy szybkim ruchu myszy.
        target.setPointerCapture(event.pointerId)
      },
    []
  )

  const onTileDragEnd = useCallback((event: React.PointerEvent): void => {
    const fromKey = dragKeyRef.current
    dragKeyRef.current = null
    if (!fromKey || !gridRef.current) return

    /*
     * Pozycję docelową liczymy ze ŚRODKÓW kafelków, nie z odstępów między
     * nimi: środek jest jednoznaczny także wtedy, gdy kafelki mają różne
     * rozmiary (powiększony, osierocony), a liczenie od krawędzi wymagałoby
     * zgadywania, do której szczeliny człowiek celował.
     */
    const children = [...gridRef.current.children] as HTMLElement[]
    const centers = children.map((child) => {
      const box = child.getBoundingClientRect()
      return { key: child.dataset.tileKey ?? '', x: box.left + box.width / 2, y: box.top + box.height / 2 }
    })
    const distance = (c: { x: number; y: number }): number =>
      (c.x - event.clientX) ** 2 + (c.y - event.clientY) ** 2
    const nearest = centers.reduce((best, c) => (distance(c) < distance(best) ? c : best), centers[0])
    if (!nearest) return

    const currentKeys = centers.map((c) => c.key)
    setOrder(moveTile(currentKeys, fromKey, currentKeys.indexOf(nearest.key)))
  }, [])
```

Podepnij `onPointerUp={onTileDragEnd}` i `onPointerCancel={onTileDragEnd}` do kontenera `.siatka`, dodaj mu `ref={gridRef}`, a każdemu kafelkowi `data-tile-key`.

- [ ] **Step 3: Dołóż `data-tile-key` do kafelka**

W `StreamTile.tsx`, na korzeniu kafelka: `data-tile-key={tileKey}`. Wymaga dołożenia `tileKey` do propsów — **nie wyliczaj go ponownie z `peerId` i `kind` w komponencie**, bo wtedy istniałyby dwa źródła tej samej prawdy.

- [ ] **Step 4: Dopisz styl uchwytu**

```css
/* Uchwyt przeciągania, symetrycznie do krzyżyka: pod kursorem, po lewej.
   `touch-action: none` jest konieczne — bez niego przeglądarka przechwytuje
   gest jako przewijanie i `pointermove` nie dochodzi. */
.tile__grip {
  position: absolute;
  top: 6px;
  left: 6px;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.6);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  cursor: grab;
  touch-action: none;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.tile:hover .tile__grip,
.tile__grip:focus-visible {
  opacity: 1;
}

.tile__grip:active {
  cursor: grabbing;
}
```

- [ ] **Step 5: Sprawdź budowanie i testy**

Run: `cd companion-app && npm run build && npm test`
Expected: `tsc` bez błędów. Faktycznie **318 testów**, a po poprawce gubionych kluczy **324**. Samej obsługi wskaźnika nie da się przetestować bez jsdom — testy mają `moveTile`, `orderAfterDrop` i `restoreUnrenderedKeys` z `tileLayout.ts`.

- [ ] **Step 6: Commit**

```bash
git add companion-app/src/renderer/components/StreamTile.tsx \
        companion-app/src/renderer/components/LobbyView.tsx \
        companion-app/src/renderer/styles.css
git commit -m "feat(siatka): przesuwanie kafelkow uchwytem, zdarzeniami wskaznika"
```

---

### Task 10: Animacja przestawiania

**Files:**
- Create: `companion-app/src/renderer/hooks/useReorderAnimation.ts`
- Modify: `companion-app/src/renderer/components/LobbyView.tsx`

**Interfaces:**
- Consumes: `order` z zadania 3
- Produces: `useReorderAnimation(containerRef, order)`

- [ ] **Step 1: Napisz hook**

Technika FLIP, bo innej możliwości nie ma: zmiana pozycji w siatce CSS **nie jest animowalna** przez `transition`.

```ts
import { useEffect, useRef } from 'react'

/** Krócej niż wejście i wyjście kafelka (400 ms) — przestawianie ma być żywe. */
const REORDER_DURATION_MS = 200

/**
 * Animuje zmianę miejsca kafelków techniką FLIP.
 *
 * Mierzymy położenia przed przerysowaniem, po przerysowaniu liczymy różnicę
 * i przejeżdżamy ją transformacją. `transition` tu nie zadziała, bo zmiana
 * pozycji w siatce CSS nie jest animowalna.
 *
 * Kafelki wchodzące i wychodzące są POMIJANE: mają własne animacje po 400 ms
 * (`LEAVE_DURATION_MS`) i dwie animacje na jednym elemencie biłyby się o ten
 * sam transform.
 *
 * Transformacja na elemencie z żywym wideo wymusza kompozytowanie. Trwa to
 * ułamek sekundy i tylko przy świadomym przeciąganiu, więc jest przyjęte —
 * ale dlatego czas jest krótki i nie animujemy nic poza przesunięciem.
 */
export function useReorderAnimation(
  containerRef: React.RefObject<HTMLElement>,
  order: readonly string[]
): void {
  const boxesRef = useRef<Map<string, DOMRect>>(new Map())

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const previous = boxesRef.current
    const next = new Map<string, DOMRect>()

    for (const child of [...container.children] as HTMLElement[]) {
      const key = child.dataset.tileKey
      if (!key) continue
      const box = child.getBoundingClientRect()
      next.set(key, box)

      const before = previous.get(key)
      // Brak poprzedniego pomiaru znaczy, że kafelek właśnie wszedł — ma
      // własną animację wejścia, nie dokładamy drugiej.
      if (!before || child.classList.contains('tile--leaving')) continue

      const dx = before.left - box.left
      const dy = before.top - box.top
      if (dx === 0 && dy === 0) continue

      child.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: REORDER_DURATION_MS, easing: 'ease' }
      )
    }

    boxesRef.current = next
  }, [containerRef, order])
}
```

- [ ] **Step 2: Podepnij w `LobbyView`**

```tsx
  useReorderAnimation(gridRef, order)
```

Hook musi stać **przed** instrukcjami `return`, razem z pozostałymi — `LobbyView` ma wczesne wyjścia przy `bad-key` i przy otwartym wyborze źródła, a hook wywołany po takim wyjściu łamie zasady Reacta i wywala aplikację. Ta pułapka wystąpiła już dwa razy w tym projekcie.

- [ ] **Step 3: Uszanuj wyłączone animacje systemowe**

Windows wystawia to pod „Efekty wizualne → Efekty animacji", a `useLeaveTransition` już to czyta. Dołóż to samo:

```ts
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
```

na początku efektu, **po** pobraniu kontenera i **przed** animowaniem — pomiary zapisuj dalej, inaczej pierwszy ruch po włączeniu animacji skoczyłby z pustego stanu.

- [ ] **Step 4: Sprawdź budowanie i testy**

Run: `cd companion-app && npm run build && npm test`
Expected: `tsc` bez błędów, **324 testy**. Animacji nie da się przetestować bez jsdom — do sprawdzenia ludzkim okiem.

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/renderer/hooks/useReorderAnimation.ts \
        companion-app/src/renderer/components/LobbyView.tsx
git commit -m "feat(siatka): animacja przestawiania kafelkow technika FLIP"
```

---

### Task 11: Sprawdzian wyśrodkowania z prawdziwym oknem

**Files:**
- Create: `companion-app/e2e/siatka.mjs`
- Modify: `companion-app/package.json`

**Interfaces:**
- Consumes: atrybut `data-sierota`, klasa `.siatka`, `data-tile-key`
- Produces: skrypt `e2e:siatka`

**NIE URUCHAMIAJ tego skryptu.** Otwiera prawdziwe okna Electrona i przechwytuje pulpit właściciela projektu — uruchomienie jest jego decyzją. Dozwolone: `node --check`, `npm run build`, `npm test`.

- [ ] **Step 1: Napisz sprawdzian**

Wzoruj się na `e2e/diagnostyka.mjs`: ten sam `launchApp`/`attach` z `cdp.mjs`, czekanie **warunkowe** (nie sztywne `sleep`), ta sama droga przez wybór źródła.

Sprawdzian musi potwierdzić **dwie** liczby kafelków, nie jedną:

```js
// Trzy ORAZ pięć kafelków. Sprawdzian tylko na trzech przeszedłby także dla
// reguły opartej na `data-ile="3"`, czyli nie odróżniłby poprawki pełnej od
// połowicznej — a to jest dokładnie ta różnica, którą wykryto przy czytaniu
// kodu: przy pięciu kafelkach `data-ile` wynosi też 4 (przez `Math.min`),
// więc piąty też był osierocony.
const CENTERING = `(() => {
  const grid = document.querySelector('.siatka')
  if (!grid) return JSON.stringify({ error: 'brak siatki' })
  const kids = [...grid.children]
  const last = kids[kids.length - 1]
  if (!last) return JSON.stringify({ error: 'brak kafelkow' })
  const g = grid.getBoundingClientRect()
  const l = last.getBoundingClientRect()
  return JSON.stringify({
    count: kids.length,
    sierota: grid.hasAttribute('data-sierota'),
    gridCenter: g.left + g.width / 2,
    lastCenter: l.left + l.width / 2,
    lastWidth: l.width,
    firstWidth: kids[0].getBoundingClientRect().width
  })
})()`
```

Asercje, każda z własnym komunikatem:

1. przy **trzech** kafelkach `data-sierota` jest obecne, a `|lastCenter - gridCenter| <= 2` (dwa piksele na zaokrąglenia układu);
2. przy trzech kafelkach `lastWidth` jest w granicach 2 px od `firstWidth` — osierocony ma mieć **tę samą szerokość**, nie podwójną; bez tej asercji reguła `grid-column: 1 / -1` (na całą szerokość) też przeszłaby test wyśrodkowania;
3. przy **pięciu** kafelkach to samo;
4. przy **czterech** kafelkach `data-sierota` **nie ma** i `lastCenter` **nie** jest środkiem siatki — inaczej reguła zapalałaby się zawsze.

Liczba instancji i dobór liczby kafelków — rozstrzygnięte, nie do zgadywania:

**Trzy instancje: A (widz, z niej czytamy DOM), B i C.** Kafelki u A to cudze strumienie plus własne. Stąd:

| kafelków u A | co nadaje B | co nadaje C | co nadaje A |
|---|---|---|---|
| 3 | ekran + kamera | ekran | nic |
| 4 | ekran + kamera | ekran + kamera | nic |
| 5 | ekran + kamera | ekran + kamera | ekran |

Czyli **jeden przebieg, narastająco**: najpierw B daje ekran i kamerę, C ekran → sprawdzasz trzy. C dokłada kamerę → sprawdzasz cztery (tu `data-sierota` ma **nie** być). A dokłada swój ekran → sprawdzasz pięć. Nie trzeba restartować instancji ani liczyć na konkretną kolejność dochodzenia obrazu — po każdej zmianie **czekaj warunkowo**, aż `.siatka` ma oczekiwaną liczbę dzieci, i dopiero wtedy mierz.

Włączanie kamery u B i C robi się tą samą drogą co w `e2e/kamera.mjs` — przeczytaj go i użyj istniejącego sposobu, nie wymyślaj nowego.

- [ ] **Step 2: Dopisz skrypt npm**

W `companion-app/package.json`, obok `"e2e:diagnostyka"`:

```json
    "e2e:siatka": "node e2e/siatka.mjs",
```

- [ ] **Step 3: Weryfikacja statyczna**

Run: `cd companion-app && node --check e2e/siatka.mjs && npm run build && npm test`
Expected: składnia OK, `tsc` bez błędów, **324 testy**.

- [ ] **Step 4: Commit**

```bash
git add companion-app/e2e/siatka.mjs companion-app/package.json
git commit -m "test(siatka): sprawdzian wysrodkowania przy trzech i pieciu kafelkach"
```

---

## Na koniec części 1

Nie scalamy i nie wydajemy — wydanie 0.3.4 obejmuje **także** część drugą (diagnostyka dla wszystkich), która dostanie własną specyfikację i własny plan. Po tej części:

1. przegląd całej dotychczasowej pracy na gałęzi;
2. przejście do specyfikacji części drugiej;
3. scalenie i wydanie dopiero po obu.

Właściciel poprosił o to wprost: „ale żeby obydwa były w jednym scaleniu i releasie".
