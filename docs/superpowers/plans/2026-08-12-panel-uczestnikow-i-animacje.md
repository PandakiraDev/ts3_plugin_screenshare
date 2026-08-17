# Panel uczestników i animacje transmisji — plan wdrożenia

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Panel uczestników pokazuje krążek z inicjałami i plakietki stanu (co nadaje, czy nas ogląda i jak mu obraz dochodzi, czy w ogóle się z nim połączyliśmy), a start i koniec transmisji widać ruchem.

**Architecture:** Cała logika ląduje w bezimportowych modułach `src/shared/participants.ts` i `src/shared/leaveTransition.ts`, testowanych w gołym Node. Zegary siedzą w jednym hooku `useLeaveTransition`. Komponenty tylko rysują. Animacje wejścia uruchamia dobór `key` — element montuje się dokładnie wtedy, kiedy ruch ma zagrać, więc nie ma ani jednego nowego `useEffect` porównującego poprzedni stan.

**Tech Stack:** TypeScript, React 18, Electron 33 (Chromium 130), vitest w gołym Node (bez jsdom), CSS bez preprocesora.

**Spec:** `docs/superpowers/specs/2026-08-12-panel-uczestnikow-i-animacje-design.md`

## Global Constraints

- **Identyfikatory w kodzie po ANGIELSKU** — nazwy zmiennych, funkcji, typów, pól, stałych, klas CSS. Bez wyjątków, także w testach i skryptach `.mjs`.
- **Komentarze, nazwy testów i komunikaty dla użytkownika po POLSKU, z pełnymi diakrytykami** (`ą ć ę ł ń ó ś ź ż`). Nie „polaczenie" tylko „połączenie".
- **TDD**: każdy krok kodu poprzedza test, który najpierw ma nie przejść. Uruchomienie testu w stanie RED jest osobnym krokiem i nie wolno go pominąć.
- **Vitest chodzi bez jsdom** — nie ma `document`, `window` ani renderowania komponentów. Wszystko, co ma być przetestowane, musi zamieszkać w `src/shared/*`. Nic w `test/` nie może importować `electron`.
- Testy uruchamiamy z katalogu `companion-app`: `npm test`. Pojedynczy plik: `npx vitest run test/<plik>.test.ts`.
- Po każdym zadaniu `npm test` musi być zielone w całości, a `npm run build` (zawiera `tsc --noEmit`) musi przechodzić.
- Commity po polsku, w konwencji `typ(zakres): opis` używanej w repo.

## Struktura plików

| Plik | Odpowiedzialność |
|---|---|
| `companion-app/vitest.config.ts` | **Nowy.** Alias `@shared` dla testów |
| `companion-app/src/shared/participants.ts` | **Nowy.** Inicjały, kolor krążka, plakietki, model wiersza, podział na sekcje |
| `companion-app/src/shared/leaveTransition.ts` | **Nowy.** Kto jeszcze dogasa i na której pozycji |
| `companion-app/src/renderer/hooks/useLeaveTransition.ts` | **Nowy.** Zegar dogasania, odczyt `prefers-reduced-motion` |
| `companion-app/src/renderer/components/ParticipantRow.tsx` | **Nowy.** Jeden wiersz listy |
| `companion-app/src/renderer/components/PeerPanel.tsx` | Sekcje i pętla po wierszach |
| `companion-app/src/renderer/components/StreamTile.tsx` | Przyjmuje `leaving` i dokłada klasę |
| `companion-app/src/renderer/components/LobbyView.tsx` | Buduje model, woła hook, przekazuje wiersze i kafelki |
| `companion-app/src/renderer/styles.css` | Style wiersza i plakietek, klatki kluczowe, `prefers-reduced-motion` |
| `companion-app/test/participants.test.ts` | **Nowy.** |
| `companion-app/test/leave-transition.test.ts` | **Nowy.** |
| `companion-app/test/shared-alias.test.ts` | **Nowy.** Pilnuje aliasu `@shared` |
| `companion-app/e2e/panel-uczestnikow.mjs` | **Nowy.** Sprawdzian z dwiema instancjami |
| `companion-app/e2e/jakosc-odbioru.mjs` | Czyta plakietkę zamiast usuniętej kropki |

---

### Task 1: Alias `@shared` w testach

Dziś `vitest` nie ma żadnej konfiguracji, więc alias `@shared` z `tsconfig` nie działa w testach. Uratowało nas dotąd tylko to, że wszystkie importy z `src/shared` w kodzie sięgalnym z testów były importami **typów**, które znikają przy kompilacji. To zadanie usuwa pułapkę, zanim wejdą w nią kolejne moduły.

**Files:**
- Create: `companion-app/vitest.config.ts`
- Create: `companion-app/test/shared-alias.test.ts`

**Interfaces:**
- Consumes: nic
- Produces: możliwość pisania `from '@shared/...'` w kodzie sięgalnym z testów

- [ ] **Step 1: Napisz test, który wymusza działanie aliasu**

`companion-app/test/shared-alias.test.ts`:

```ts
import { expect, test } from 'vitest'
// Import WARTOŚCI, nie typu — typ zniknąłby przy kompilacji i test niczego by
// nie pilnował. Ta stała istnieje od 0.3.1 i nie zmienia się.
import { QUALITY_REPORT_INTERVAL_MS } from '@shared/viewerQuality'

test('alias @shared działa w testach, a nie tylko w budowaniu', () => {
  // Ten test nie sprawdza logiki jakości odbioru — sprawdza, czy vitest
  // w ogóle potrafi rozwiązać ścieżkę @shared. Bez konfiguracji wywala się
  // na imporcie i nie dochodzi nawet do asercji.
  expect(QUALITY_REPORT_INTERVAL_MS).toBe(5_000)
})
```

- [ ] **Step 2: Uruchom test, żeby zobaczyć, że nie przechodzi**

Run: `cd companion-app && npx vitest run test/shared-alias.test.ts`
Expected: FAIL — `Failed to resolve import "@shared/viewerQuality"`

- [ ] **Step 3: Dodaj konfigurację**

`companion-app/vitest.config.ts`:

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Vitest nie czyta `paths` z tsconfig.json, a electron-vite podaje ten alias
// tylko procesowi budowania. Bez tego pliku każdy import WARTOŚCI z @shared
// wywala testy — importy typów przechodzą tylko dlatego, że znikają przy
// kompilacji. Trafiliśmy na to w 0.3.1 i obeszliśmy ścieżką względną.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  }
})
```

- [ ] **Step 4: Uruchom testy i sprawdź, że przechodzą**

Run: `cd companion-app && npm test`
Expected: PASS — 104 testy (103 dotychczasowe plus nowy)

- [ ] **Step 5: Commit**

```bash
git add companion-app/vitest.config.ts companion-app/test/shared-alias.test.ts
git commit -m "test: alias @shared dziala takze w vitest"
```

---

### Task 2: Inicjały i kolor krążka

**Files:**
- Create: `companion-app/src/shared/participants.ts`
- Create: `companion-app/test/participants.test.ts`

**Interfaces:**
- Consumes: nic
- Produces: `initialsFrom(displayName: string): string`, `avatarColorFrom(displayName: string): string`, `AVATAR_COLORS: readonly string[]`

- [ ] **Step 1: Napisz testy inicjałów i koloru**

`companion-app/test/participants.test.ts`:

```ts
import { expect, test } from 'vitest'
import { AVATAR_COLORS, avatarColorFrom, initialsFrom } from '../src/shared/participants'

test('dwa słowa dają dwie pierwsze litery', () => {
  expect(initialsFrom('Jan Kowalski')).toBe('JK')
})

test('jedno słowo daje jego dwie pierwsze litery', () => {
  expect(initialsFrom('Marek')).toBe('MA')
})

test('polskie litery mają wyjść wielkie, a nie zniknąć', () => {
  expect(initialsFrom('Łukasz Żak')).toBe('ŁŻ')
})

test('nick z samych ozdobników daje znak zapytania', () => {
  // Na TS3 to normalny nick, a nie przypadek brzegowy z podręcznika.
  expect(initialsFrom('⭐⭐⭐')).toBe('?')
})

test('cyfry i podkreślenia nie trafiają do inicjałów', () => {
  expect(initialsFrom('xXx_Marek_xXx')).toBe('XM')
  expect(initialsFrom('3maniak')).toBe('MA')
})

test('pusta nazwa nie wywraca inicjałów', () => {
  expect(initialsFrom('')).toBe('?')
})

test('ta sama nazwa zawsze daje ten sam kolor', () => {
  // Kolor liczony z nazwy, a nie z peerId: peerId zmienia się między sesjami,
  // więc kolor skakałby po każdym ponownym wejściu do kanału.
  expect(avatarColorFrom('Marek')).toBe(avatarColorFrom('Marek'))
})

test('kolor pochodzi z palety', () => {
  expect(AVATAR_COLORS).toContain(avatarColorFrom('Ania'))
})

test('różne nazwy nie lądują wszystkie na jednym kolorze', () => {
  const names = ['Ala', 'Marek', 'Ania', 'Piotrek', 'Kasia', 'Tomek', 'Zosia', 'Bartek']
  const used = new Set(names.map(avatarColorFrom))
  expect(used.size).toBeGreaterThan(1)
})
```

- [ ] **Step 2: Uruchom testy, żeby zobaczyć, że nie przechodzą**

Run: `cd companion-app && npx vitest run test/participants.test.ts`
Expected: FAIL — `Failed to resolve import "../src/shared/participants"`

- [ ] **Step 3: Napisz moduł**

`companion-app/src/shared/participants.ts`:

```ts
/**
 * Barwy krążków. Dobrane pod tło `--bg-raised` (#2b2d31) — każda ma dawać
 * czytelny biały tekst i różnić się od sąsiadek na tyle, żeby dwie osoby obok
 * siebie nie wyglądały tak samo.
 */
export const AVATAR_COLORS: readonly string[] = [
  '#5865f2',
  '#b5591f',
  '#3a7d5c',
  '#6b4d94',
  '#a8434f',
  '#2f6f8f',
  '#8a6d1f',
  '#4f5d75'
]

/**
 * Dwie litery na krążek. Nicki na TS3 bywają ozdobne (`⭐⭐⭐`, `xXx_Marek_xXx`,
 * `3maniak`), więc dzielimy nazwę po WSZYSTKIM, co nie jest literą — dzięki
 * temu w słowach zostają same litery i pierwszy znak słowa jest zawsze literą.
 * Gdy liter nie ma w ogóle, zostaje `?`: lepszy uczciwy znak zapytania niż
 * pusty krążek, który wygląda na błąd renderowania.
 */
export function initialsFrom(displayName: string): string {
  const words = displayName.split(/[^\p{L}]+/u).filter((word) => word.length > 0)
  if (words.length === 0) return '?'
  const raw = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]
  return raw.toLocaleUpperCase('pl')
}

/**
 * Kolor krążka z NAZWY, nie z `peerId`. `peerId` jest losowany na sesję, więc
 * kolor skakałby przy każdym ponownym wejściu do kanału; nazwa jest stała, więc
 * ta sama osoba ma zawsze ten sam kolor — również u wszystkich pozostałych
 * uczestników, bo liczą to z tej samej nazwy.
 *
 * Hash djb2: nie potrzebujemy tu kryptografii, tylko powtarzalności.
 */
export function avatarColorFrom(displayName: string): string {
  let hash = 5381
  for (const char of displayName) {
    hash = ((hash << 5) + hash + (char.codePointAt(0) ?? 0)) | 0
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}
```

- [ ] **Step 4: Uruchom testy i sprawdź, że przechodzą**

Run: `cd companion-app && npx vitest run test/participants.test.ts`
Expected: PASS — 9 testów

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/shared/participants.ts companion-app/test/participants.test.ts
git commit -m "feat(panel): inicjaly i kolor krazka z nazwy uczestnika"
```

---

### Task 3: Plakietki stanu

**Files:**
- Modify: `companion-app/src/shared/participants.ts`
- Modify: `companion-app/test/participants.test.ts`

**Interfaces:**
- Consumes: `ViewerQuality` z `./viewerQuality`
- Produces: `ParticipantBadge`, `BadgeInput`, `badgesFor(input: BadgeInput): ParticipantBadge[]`

- [ ] **Step 1: Dopisz testy plakietek**

Dopisz na końcu `companion-app/test/participants.test.ts` (i rozszerz istniejący import o `badgesFor`):

```ts
test('kolejność plakietek jest stała', () => {
  expect(
    badgesFor({
      hasScreen: true,
      hasCamera: true,
      isWatchingUs: true,
      quality: 'ok',
      isUnreachable: true
    })
  ).toEqual([
    { kind: 'screen' },
    { kind: 'camera' },
    { kind: 'watching', quality: 'ok' },
    { kind: 'unreachable' }
  ])
})

test('plakietka „Ogląda" tylko dla osób, które nas oglądają', () => {
  const badges = badgesFor({
    hasScreen: false,
    hasCamera: false,
    isWatchingUs: false,
    quality: 'ok',
    isUnreachable: false
  })
  expect(badges).toEqual([])
})

test('nieznana jakość zostaje nieznana, a nie zamienia się w „płynnie"', () => {
  // Reguła z 0.3.1: cisza nie jest dobrą wiadomością. Gdyby brak raportu
  // dawał tu 'ok', wskaźnik kłamałby przez pierwsze sekundy oglądania.
  const badges = badgesFor({
    hasScreen: false,
    hasCamera: false,
    isWatchingUs: true,
    quality: 'unknown',
    isUnreachable: false
  })
  expect(badges).toEqual([{ kind: 'watching', quality: 'unknown' }])
})

test('brak połączenia widać także u osoby, która nic nie nadaje', () => {
  const badges = badgesFor({
    hasScreen: false,
    hasCamera: false,
    isWatchingUs: false,
    quality: 'unknown',
    isUnreachable: true
  })
  expect(badges).toEqual([{ kind: 'unreachable' }])
})

test('sama kamera bez ekranu daje jedną plakietkę', () => {
  const badges = badgesFor({
    hasScreen: false,
    hasCamera: true,
    isWatchingUs: false,
    quality: 'unknown',
    isUnreachable: false
  })
  expect(badges).toEqual([{ kind: 'camera' }])
})
```

- [ ] **Step 2: Uruchom testy, żeby zobaczyć, że nie przechodzą**

Run: `cd companion-app && npx vitest run test/participants.test.ts`
Expected: FAIL — `badgesFor is not a function` / błąd importu

- [ ] **Step 3: Dopisz typy i funkcję**

Dopisz na początku `companion-app/src/shared/participants.ts` (import) i na końcu (reszta):

```ts
import type { ViewerQuality } from './viewerQuality'

export type ParticipantBadge =
  | { kind: 'screen' }
  | { kind: 'camera' }
  | { kind: 'watching'; quality: ViewerQuality }
  | { kind: 'unreachable' }

export interface BadgeInput {
  hasScreen: boolean
  hasCamera: boolean
  /** Nas samych nie ma na liście widzów, więc własny wiersz tego nie dostaje. */
  isWatchingUs: boolean
  quality: ViewerQuality
  isUnreachable: boolean
}

/**
 * Plakietki w stałej kolejności: co nadaje, potem czy nas ogląda, na końcu
 * kłopot z połączeniem. Kolejność jest stała celowo — wiersz ma wyglądać
 * tak samo za każdym razem, żeby oko wiedziało, gdzie patrzeć.
 */
export function badgesFor(input: BadgeInput): ParticipantBadge[] {
  const badges: ParticipantBadge[] = []
  if (input.hasScreen) badges.push({ kind: 'screen' })
  if (input.hasCamera) badges.push({ kind: 'camera' })
  if (input.isWatchingUs) badges.push({ kind: 'watching', quality: input.quality })
  if (input.isUnreachable) badges.push({ kind: 'unreachable' })
  return badges
}
```

- [ ] **Step 4: Uruchom testy i sprawdź, że przechodzą**

Run: `cd companion-app && npx vitest run test/participants.test.ts`
Expected: PASS — 14 testów

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/shared/participants.ts companion-app/test/participants.test.ts
git commit -m "feat(panel): plakietki stanu uczestnika"
```

---

### Task 4: Model listy i podział na sekcje

**Files:**
- Modify: `companion-app/src/shared/participants.ts`
- Modify: `companion-app/test/participants.test.ts`

**Interfaces:**
- Consumes: `initialsFrom`, `avatarColorFrom`, `badgesFor` z Task 2 i 3; `StreamKind` z `./types`
- Produces: `ParticipantView`, `ParticipantsInput`, `buildParticipants(input): ParticipantView[]`, `splitByStreaming<T>(items, isStreaming)`

- [ ] **Step 1: Dopisz testy modelu**

Dopisz na końcu `companion-app/test/participants.test.ts` (rozszerz import o `buildParticipants` i `splitByStreaming`):

```ts
const EMPTY_QUALITY = new Map<string, 'ok' | 'poor' | 'unknown'>()

test('nasz wiersz stoi pierwszy i jest oznaczony jako nasz', () => {
  const views = buildParticipants({
    me: { peerId: 'me', displayName: 'Konrad' },
    peers: [{ peerId: 'p1', displayName: 'Marek' }],
    streams: [],
    viewerPeerIds: [],
    viewerQuality: EMPTY_QUALITY,
    unreachablePeerIds: []
  })
  expect(views.map((view) => view.peerId)).toEqual(['me', 'p1'])
  expect(views[0].isMe).toBe(true)
  expect(views[1].isMe).toBe(false)
})

test('osoba z ekranem i kamerą naraz dostaje obie plakietki', () => {
  const views = buildParticipants({
    me: null,
    peers: [{ peerId: 'p1', displayName: 'Marek' }],
    streams: [
      { peerId: 'p1', kind: 'screen' },
      { peerId: 'p1', kind: 'camera' }
    ],
    viewerPeerIds: [],
    viewerQuality: EMPTY_QUALITY,
    unreachablePeerIds: []
  })
  expect(views[0].badges).toEqual([{ kind: 'screen' }, { kind: 'camera' }])
  expect(views[0].isStreaming).toBe(true)
})

test('widz bez raportu jakości dostaje plakietkę „nie wiadomo"', () => {
  const views = buildParticipants({
    me: null,
    peers: [{ peerId: 'p1', displayName: 'Marek' }],
    streams: [],
    viewerPeerIds: ['p1'],
    viewerQuality: EMPTY_QUALITY,
    unreachablePeerIds: []
  })
  expect(views[0].badges).toEqual([{ kind: 'watching', quality: 'unknown' }])
})

test('nieosiągalny peer jest oznaczony', () => {
  const views = buildParticipants({
    me: null,
    peers: [{ peerId: 'p1', displayName: 'Piotrek' }],
    streams: [],
    viewerPeerIds: [],
    viewerQuality: EMPTY_QUALITY,
    unreachablePeerIds: ['p1']
  })
  expect(views[0].badges).toEqual([{ kind: 'unreachable' }])
})

test('nasz wiersz nie dostaje ani „Ogląda", ani „Brak połączenia"', () => {
  // Nie łączymy się sami ze sobą, więc nie ma nas ani w viewerPeerIds, ani
  // w unreachablePeerIds. Test pilnuje, żeby nikt tego nie „naprawił"
  // dopisując nas do którejś z tych list.
  const views = buildParticipants({
    me: { peerId: 'me', displayName: 'Konrad' },
    peers: [],
    streams: [{ peerId: 'me', kind: 'screen' }],
    viewerPeerIds: ['me'],
    viewerQuality: EMPTY_QUALITY,
    unreachablePeerIds: ['me']
  })
  // Gdyby buildParticipants brał te listy bezkrytycznie, byłyby tu trzy
  // plakietki. Ma być jedna — ta o ekranie.
  expect(views[0].badges).toEqual([{ kind: 'screen' }])
})

test('podział na sekcje wstawia nas po stronie nadających, gdy nadajemy', () => {
  const views = buildParticipants({
    me: { peerId: 'me', displayName: 'Konrad' },
    peers: [{ peerId: 'p1', displayName: 'Marek' }],
    streams: [{ peerId: 'me', kind: 'screen' }],
    viewerPeerIds: [],
    viewerQuality: EMPTY_QUALITY,
    unreachablePeerIds: []
  })
  const sections = splitByStreaming(views, (view) => view.isStreaming)
  expect(sections.streaming.map((view) => view.peerId)).toEqual(['me'])
  expect(sections.others.map((view) => view.peerId)).toEqual(['p1'])
})

test('podział działa też na wierszach opakowanych w znacznik wyjścia', () => {
  // To NIE jest ten sam test co wyżej: sekcje dzielimy dopiero PO przejściu
  // wyjścia, więc do splitByStreaming trafia opakowany wiersz, a nie goły
  // ParticipantView. Gdyby funkcja nie była generyczna, tu by się wywaliła.
  const rows = [
    { item: { isStreaming: true, peerId: 'a' }, leaving: false },
    { item: { isStreaming: false, peerId: 'b' }, leaving: true }
  ]
  const sections = splitByStreaming(rows, (row) => row.item.isStreaming)
  expect(sections.streaming).toHaveLength(1)
  expect(sections.others).toHaveLength(1)
  expect(sections.others[0].leaving).toBe(true)
})
```

- [ ] **Step 2: Uruchom testy, żeby zobaczyć, że nie przechodzą**

Run: `cd companion-app && npx vitest run test/participants.test.ts`
Expected: FAIL — `buildParticipants is not a function`

- [ ] **Step 3: Dopisz model**

Dopisz do importów w `companion-app/src/shared/participants.ts`:

```ts
import type { StreamKind } from './types'
```

i na końcu pliku:

```ts
export interface ParticipantView {
  peerId: string
  displayName: string
  isMe: boolean
  initials: string
  color: string
  /** Nadaje cokolwiek — decyduje o przydziale do sekcji. */
  isStreaming: boolean
  badges: ParticipantBadge[]
}

export interface ParticipantsInput {
  me: { peerId: string; displayName: string } | null
  peers: readonly { peerId: string; displayName: string }[]
  streams: readonly { peerId: string; kind: StreamKind }[]
  viewerPeerIds: readonly string[]
  viewerQuality: ReadonlyMap<string, ViewerQuality>
  unreachablePeerIds: readonly string[]
}

/**
 * Płaska lista w kolejności wyświetlania: my, potem pozostali w kolejności
 * z serwera. PŁASKA, a nie od razu podzielona na sekcje — podział musi się
 * odbyć dopiero po przejściu wyjścia, inaczej osoba kończąca transmisję byłaby
 * przez chwilę widoczna dwa razy naraz (dogasająca w „Nadają" i już wstawiona
 * do „W kanale").
 */
export function buildParticipants(input: ParticipantsInput): ParticipantView[] {
  const viewers = new Set(input.viewerPeerIds)
  const unreachable = new Set(input.unreachablePeerIds)
  const everyone = [
    ...(input.me ? [{ ...input.me, isMe: true }] : []),
    ...input.peers.map((peer) => ({ ...peer, isMe: false }))
  ]

  return everyone.map((person) => {
    const kinds = input.streams.filter((stream) => stream.peerId === person.peerId)
    const hasScreen = kinds.some((stream) => stream.kind === 'screen')
    const hasCamera = kinds.some((stream) => stream.kind === 'camera')
    return {
      peerId: person.peerId,
      displayName: person.displayName,
      isMe: person.isMe,
      initials: initialsFrom(person.displayName),
      color: avatarColorFrom(person.displayName),
      isStreaming: hasScreen || hasCamera,
      badges: badgesFor({
        hasScreen,
        hasCamera,
        // `!person.isMe` to strażnik, nie ozdobnik. Nie łączymy się sami ze
        // sobą, więc nas na tych listach BYĆ NIE POWINNO — ale gdyby kiedyś
        // trafiły tam przez pomyłkę, własny wiersz twierdziłby, że sam siebie
        // ogląda i sam do siebie nie może się dobić. Reguła zamiast założenia.
        isWatchingUs: !person.isMe && viewers.has(person.peerId),
        quality: input.viewerQuality.get(person.peerId) ?? 'unknown',
        isUnreachable: !person.isMe && unreachable.has(person.peerId)
      })
    }
  })
}

/**
 * Generyczne, bo w chwili podziału wiersz jest już opakowany w znacznik
 * `leaving` i nie jest gołym `ParticipantView`.
 */
export function splitByStreaming<T>(
  items: readonly T[],
  isStreaming: (item: T) => boolean
): { streaming: T[]; others: T[] } {
  return {
    streaming: items.filter((item) => isStreaming(item)),
    others: items.filter((item) => !isStreaming(item))
  }
}
```

- [ ] **Step 4: Uruchom testy i sprawdź, że przechodzą**

Run: `cd companion-app && npm test`
Expected: PASS — 21 testów w `participants.test.ts`, całość zielona

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/shared/participants.ts companion-app/test/participants.test.ts
git commit -m "feat(panel): model wiersza uczestnika i podzial na sekcje"
```

---

### Task 5: Przejście wyjścia

**Files:**
- Create: `companion-app/src/shared/leaveTransition.ts`
- Create: `companion-app/test/leave-transition.test.ts`

**Interfaces:**
- Consumes: nic
- Produces: `LEAVE_DURATION_MS`, `LeaveState<T>`, `emptyLeaveState<T>()`, `advanceLeaving<T>(state, current, keyOf, now, durationMs)`, `visibleItems<T>(state)`, `nextDeadlineAt<T>(state, durationMs)`

> **Poprawka po przeglądzie.** `nextDeadlineAt` i jego trzy testy niżej nie
> należały do pierwotnej wersji tego zadania — doszły razem z poprawką opisaną
> w nocie przy Task 6, gdzie właśnie ta funkcja usuwa błąd zgubionego budzika.
> Zamieszczone tu od razu, żeby ktoś wykonujący ten plan od nowa napisał
> od razu poprawną wersję.

- [ ] **Step 1: Napisz testy przejścia**

`companion-app/test/leave-transition.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  LEAVE_DURATION_MS,
  advanceLeaving,
  emptyLeaveState,
  visibleItems,
  nextDeadlineAt,
  type LeaveState
} from '../src/shared/leaveTransition'

interface Item {
  id: string
  payload: string
}

const item = (id: string, payload = id): Item => ({ id, payload })
const keyOf = (value: Item): string => value.id
const ids = (state: LeaveState<Item>): string[] =>
  visibleItems(state).map((entry) => entry.item.id)

test('element, który wypadł, zostaje jeszcze na liście ze znacznikiem', () => {
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, 10, LEAVE_DURATION_MS)

  const visible = visibleItems(state)
  expect(visible.map((entry) => entry.item.id)).toEqual(['a', 'b'])
  expect(visible.find((entry) => entry.item.id === 'b')?.leaving).toBe(true)
  expect(visible.find((entry) => entry.item.id === 'a')?.leaving).toBe(false)
})

test('wychodzący ze środka dogasa w środku, a nie na końcu', () => {
  // Bez tego kafelek wypadający ze środka siatki przeskakiwałby na koniec
  // i dopiero stamtąd gasł — ruch w zupełnie złą stronę.
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b'), item('c')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a'), item('c')], keyOf, 10, LEAVE_DURATION_MS)

  expect(ids(state)).toEqual(['a', 'b', 'c'])
})

test('powrót przed upływem czasu nie zostawia duplikatu', () => {
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, 10, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 20, LEAVE_DURATION_MS)

  const visible = visibleItems(state)
  expect(visible.map((entry) => entry.item.id)).toEqual(['a', 'b'])
  expect(visible.every((entry) => !entry.leaving)).toBe(true)
})

test('po upływie czasu element znika', () => {
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, LEAVE_DURATION_MS, LEAVE_DURATION_MS)

  expect(ids(state)).toEqual(['a'])
})

test('tuż przed upływem czasu element jeszcze jest', () => {
  // Granica przybita z obu stron — inaczej test przechodziłby także wtedy,
  // gdyby element znikał od razu.
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, LEAVE_DURATION_MS - 1, LEAVE_DURATION_MS)

  expect(ids(state)).toEqual(['a', 'b'])
})

test('zerowy czas usuwa natychmiast', () => {
  // Tak działa prefers-reduced-motion: nie ma czego animować, więc nie ma
  // powodu trzymać martwego elementu w DOM-ie.
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 0, 0)
  state = advanceLeaving(state, [item('a')], keyOf, 0, 0)

  expect(ids(state)).toEqual(['a'])
})

test('wychodzący element zachowuje swój ładunek', () => {
  // To jest test pilnujący zamrożonej klatki: kafelek dogasa z tym samym
  // MediaStreamem, bo stan trzyma cały element, a nie sam klucz. Gdyby
  // trzymał klucz, gasł by czarny prostokąt.
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b', 'obraz')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, 10, LEAVE_DURATION_MS)

  const leaving = visibleItems(state).find((entry) => entry.leaving)
  expect(leaving?.item.payload).toBe('obraz')
})

test('dwa elementy wychodzące naraz zachowują swoją kolejność', () => {
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(
    state,
    [item('a'), item('b'), item('c'), item('d')],
    keyOf,
    0,
    LEAVE_DURATION_MS
  )
  state = advanceLeaving(state, [item('a'), item('d')], keyOf, 10, LEAVE_DURATION_MS)

  expect(ids(state)).toEqual(['a', 'b', 'c', 'd'])
})

test('nextDeadlineAt: pusty stan zwraca null', () => {
  const state = emptyLeaveState<Item>()
  expect(nextDeadlineAt(state, LEAVE_DURATION_MS)).toBe(null)
})

test('nextDeadlineAt: jeden wygasający zwraca jego termin', () => {
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 100, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, 100, LEAVE_DURATION_MS)

  // b wypadł w chwili 100, dogaśnie w 100 + 400 = 500
  expect(nextDeadlineAt(state, LEAVE_DURATION_MS)).toBe(500)
})

test('nextDeadlineAt: dwa wygasające zwracają wcześniejszy termin (regresja: wielokrotne wychodzące)', () => {
  // To jest test regresji dokładnie na błąd: gdy A dogaśnie, a B wciąż wygasa,
  // zależnością hooka musi być termin, a nie flaga, inaczej efekt się nie odpalił
  // dla B i B zostaje w DOM-ie bez zaplanowanego wybudzenia.
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b'), item('c')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a'), item('c')], keyOf, 100, LEAVE_DURATION_MS) // b wypadł w 100
  state = advanceLeaving(state, [item('a')], keyOf, 150, LEAVE_DURATION_MS) // c wypadł w 150

  // b dogaśnie w 100 + 400 = 500 (wcześniej)
  // c dogaśnie w 150 + 400 = 550 (później)
  // powinna zwrócić 500
  expect(nextDeadlineAt(state, LEAVE_DURATION_MS)).toBe(500)
})
```

- [ ] **Step 2: Uruchom testy, żeby zobaczyć, że nie przechodzą**

Run: `cd companion-app && npx vitest run test/leave-transition.test.ts`
Expected: FAIL — `Failed to resolve import "../src/shared/leaveTransition"`

- [ ] **Step 3: Napisz moduł**

`companion-app/src/shared/leaveTransition.ts`:

```ts
/** Zgodne z czasem animacji wyjścia w styles.css. Jedno miejsce, nie dwa. */
export const LEAVE_DURATION_MS = 400

interface LeavingEntry<T> {
  item: T
  /** Kiedy element zniknął ze źródła. */
  since: number
  /** Na której pozycji stał — żeby dogasał tam, gdzie był. */
  index: number
}

export interface LeaveState<T> {
  /** Elementy widziane przy ostatnim wywołaniu, w kolejności ze źródła. */
  readonly present: readonly T[]
  readonly leaving: ReadonlyMap<string, LeavingEntry<T>>
}

export function emptyLeaveState<T>(): LeaveState<T> {
  return { present: [], leaving: new Map() }
}

/**
 * Stan po jednym takcie. `durationMs` jest PARAMETREM, a nie stałą w środku:
 * przy `prefers-reduced-motion` hook podaje zero i element znika natychmiast,
 * zamiast wisieć w DOM-ie bez powodu przez czas nieistniejącej animacji.
 *
 * Funkcja jest idempotentna dla tego samego `now` i `current` — React w trybie
 * ścisłym renderuje dwa razy, więc to nie jest luksus.
 */
export function advanceLeaving<T>(
  state: LeaveState<T>,
  current: readonly T[],
  keyOf: (item: T) => string,
  now: number,
  durationMs: number
): LeaveState<T> {
  const currentKeys = new Set(current.map((item) => keyOf(item)))
  const leaving = new Map<string, LeavingEntry<T>>()

  // Kto już dogasał: zostaje, o ile nie wrócił i nie wyczerpał czasu.
  for (const [key, entry] of state.leaving) {
    if (currentKeys.has(key)) continue
    if (now - entry.since >= durationMs) continue
    leaving.set(key, entry)
  }

  // Kto właśnie wypadł: zaczyna dogasać na swojej dotychczasowej pozycji.
  state.present.forEach((item, index) => {
    if (durationMs <= 0) return
    const key = keyOf(item)
    if (currentKeys.has(key) || leaving.has(key)) return
    leaving.set(key, { item, since: now, index })
  })

  return { present: current, leaving }
}

/**
 * Lista do wyrenderowania: obecne elementy plus dogasające, wstawione z powrotem
 * na swoje dawne pozycje. Wstawiamy od najmniejszego indeksu, żeby kolejne
 * wstawienia nie przesuwały pozycji jeszcze niewstawionych elementów.
 */
export function visibleItems<T>(state: LeaveState<T>): { item: T; leaving: boolean }[] {
  const result = state.present.map((item) => ({ item, leaving: false }))
  const departing = [...state.leaving.values()].sort((left, right) => left.index - right.index)
  for (const entry of departing) {
    result.splice(Math.min(entry.index, result.length), 0, { item: entry.item, leaving: true })
  }
  return result
}

/**
 * Moment, w którym pierwszy wygasający element dogaśnie i powinien zostać usunięty
 * z DOM-u. Zwraca null, jeśli nic nie wygasa.
 *
 * Najwcześniejszy termin: gdy któryś element dogaśnie, reszta następuje w swoim czasie.
 * Jeśli zależnością efektu będzie ten moment, każde przesunięcie terminu (nowy element
 * wychodzący wcześniej/później niż poprzedni) przeplanuje budzik — to rozwiązuje regresję,
 * gdzie drugi element wychodzący utknął w DOM-ie bez zaplanowanego wybudzenia.
 */
export function nextDeadlineAt<T>(state: LeaveState<T>, durationMs: number): number | null {
  let earliest: number | null = null
  for (const entry of state.leaving.values()) {
    const deadline = entry.since + durationMs
    if (earliest === null || deadline < earliest) {
      earliest = deadline
    }
  }
  return earliest
}
```

- [ ] **Step 4: Uruchom testy i sprawdź, że przechodzą**

Run: `cd companion-app && npm test`
Expected: PASS — 11 testów w `leave-transition.test.ts` (8 z reduktora + 3 dla
`nextDeadlineAt`), całość zielona

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/shared/leaveTransition.ts companion-app/test/leave-transition.test.ts
git commit -m "feat(panel): przejscie wyjscia z zapamietana pozycja i ladunkiem"
```

---

### Task 6: Hook `useLeaveTransition`

Hooka nie da się przetestować jednostkowo — vitest chodzi bez jsdom, więc nie ma ani `window.matchMedia`, ani renderera Reacta. Cała arytmetyka, którą można sprawdzić, została w Task 5. To zadanie jest wyłącznie połączeniem zegara z gotowym reduktorem i sprawdza się przez `npm run build`.

**Files:**
- Create: `companion-app/src/renderer/hooks/useLeaveTransition.ts`

**Interfaces:**
- Consumes: `LEAVE_DURATION_MS`, `advanceLeaving`, `emptyLeaveState`, `visibleItems`, `nextDeadlineAt`, `LeaveState` z Task 5
- Produces: `useLeaveTransition<T>(current: readonly T[], keyOf: (item: T) => string): { item: T; leaving: boolean }[]`

> **Poprawka po przeglądzie.** Kod poniżej to już naprawiona wersja. Pierwotnie
> zależnością efektu budzącego była flaga logiczna `hasLeaving` („coś jeszcze
> wygasa"). Błąd: gdy drugi element zaczynał wygasać, zanim pierwszy skończył,
> `hasLeaving` zostawała `true` przed i po, więc React efekt pomijał i dla
> późniejszego terminu nikt nie planował budzika — element zostawał w DOM-ie
> na zawsze. Naprawa zamienia flagę na `nextDeadlineAt`: konkretny TERMIN
> najwcześniejszego wybudzenia, który zmienia się przy każdym wejściu/wyjściu
> w grupie wygasających, więc efekt odpala się dla każdego z nich.

- [ ] **Step 1: Napisz hook**

`companion-app/src/renderer/hooks/useLeaveTransition.ts`:

```ts
import { useEffect, useRef, useState } from 'react'
import {
  LEAVE_DURATION_MS,
  advanceLeaving,
  emptyLeaveState,
  nextDeadlineAt,
  visibleItems,
  type LeaveState
} from '@shared/leaveTransition'

/**
 * Windows wystawia to pod „Efekty wizualne → Efekty animacji". Ludzie wyłączają
 * je na słabszych maszynach po to, żeby aplikacje przestały mielić — trzymanie
 * martwego elementu w DOM-ie przez 400 ms działałoby wtedy wbrew intencji.
 */
function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Zwraca listę do wyrenderowania: obecne elementy plus te, które właśnie
 * wypadły ze źródła i jeszcze dogasają.
 *
 * Stan siedzi w `useRef` i jest przeliczany W TRAKCIE renderowania, a nie
 * w efekcie: gdyby liczył się w efekcie, pierwsza klatka po zniknięciu elementu
 * pokazałaby listę już bez niego, a animacja wyjścia nie miałaby czego animować.
 * Reduktor jest idempotentny, więc podwójne renderowanie w trybie ścisłym nic
 * nie psuje.
 */
export function useLeaveTransition<T>(
  current: readonly T[],
  keyOf: (item: T) => string
): { item: T; leaving: boolean }[] {
  const stateRef = useRef<LeaveState<T>>(emptyLeaveState<T>())
  const [, bumpRender] = useState(0)

  const durationMs = reducedMotion() ? 0 : LEAVE_DURATION_MS
  stateRef.current = advanceLeaving(stateRef.current, current, keyOf, Date.now(), durationMs)
  const visible = visibleItems(stateRef.current)

  /*
   * Gdy element dogaśnie, źródło już się nie zmieni — nikt nas nie obudzi.
   * Bez tego zegara wychodzący element zostałby w DOM-ie na zawsze, wygaszony
   * i nieklikany, ale zajmujący miejsce w siatce.
   *
   * Zależnością musi być TERMIN wybudzenia, a nie flaga „coś się wygasa". Gdyby była flaga:
   * gdy A dogaśnie i znika, a B wciąż wygasa, flaga by została na true, efekt by się nie
   * odpalił, i żaden budzik by się nie zaplanował dla B. Termin ma tę zaletę, że zmienia się
   * przy każdym wejściu/wyjściu, więc efekt się odpalił dla każdego pierwszego/ostatniego
   * elementu w grupie wychodzących.
   */
  const nextDeadline = nextDeadlineAt(stateRef.current, durationMs)
  useEffect(() => {
    if (nextDeadline === null) return
    const delayMs = Math.max(0, nextDeadline - Date.now())
    const timer = setTimeout(() => bumpRender((count) => count + 1), delayMs)
    return () => clearTimeout(timer)
  }, [nextDeadline, durationMs])

  return visible
}
```

- [ ] **Step 2: Sprawdź, że kompiluje się i alias działa**

Run: `cd companion-app && npm run build`
Expected: PASS — `tsc --noEmit` bez błędów, budowanie kończy się sukcesem

- [ ] **Step 3: Sprawdź, że nic nie zepsuło testów**

Run: `cd companion-app && npm test`
Expected: PASS — całość zielona

- [ ] **Step 4: Commit**

```bash
git add companion-app/src/renderer/hooks/useLeaveTransition.ts
git commit -m "feat(panel): hook przejscia wyjscia z odczytem prefers-reduced-motion"
```

---

### Task 7: Wiersz uczestnika i przebudowa panelu

**Files:**
- Create: `companion-app/src/renderer/components/ParticipantRow.tsx`
- Modify: `companion-app/src/renderer/components/PeerPanel.tsx` (przepisany)
- Modify: `companion-app/src/renderer/components/LobbyView.tsx:309-316` (wywołanie `PeerPanel`)
- Modify: `companion-app/src/renderer/styles.css:619-774` (sekcja panelu uczestników)

**Interfaces:**
- Consumes: `ParticipantView`, `ParticipantBadge`, `buildParticipants`, `splitByStreaming` z Task 4; `useLeaveTransition` z Task 6
- Produces: `ParticipantRow`, nowe `PeerPanelProps` z polem `rows: { item: ParticipantView; leaving: boolean }[]`

- [ ] **Step 1: Napisz komponent wiersza**

`companion-app/src/renderer/components/ParticipantRow.tsx`:

```tsx
import type { ParticipantBadge, ParticipantView } from '@shared/participants'

interface ParticipantRowProps {
  view: ParticipantView
  /** Osoba wyszła z kanału i wiersz właśnie dogasa. */
  leaving: boolean
}

function badgeLabel(badge: ParticipantBadge): string {
  switch (badge.kind) {
    case 'screen':
      return '🖥 Ekran'
    case 'camera':
      return '📷 Kamera'
    case 'unreachable':
      return '⚠ Brak połączenia'
    case 'watching':
      if (badge.quality === 'ok') return '👁 Ogląda · płynnie'
      if (badge.quality === 'poor') return '👁 Ogląda · zacina'
      // Brak dopisku to NIE to samo co „płynnie" — to „jeszcze nie wiadomo".
      return '👁 Ogląda'
  }
}

function badgeModifier(badge: ParticipantBadge): string {
  return badge.kind === 'watching' ? `watching-${badge.quality}` : badge.kind
}

export function ParticipantRow({ view, leaving }: ParticipantRowProps): JSX.Element {
  return (
    <li className={`participant${leaving ? ' participant--leaving' : ''}`}>
      {/*
        `key` z `isStreaming` jest tu jedynym mechanizmem uruchamiającym puls:
        zmiana klucza montuje element od nowa, a animacja CSS gra przy montowaniu.
        Klasa z pulsem wisi tylko przy `true`, więc przejście `true → false`
        (koniec transmisji) przemontowuje krążek BEZ animacji — i tak ma być,
        koniec transmisji ma być spokojny.
      */}
      <span
        key={`${view.peerId}-${view.isStreaming}`}
        className={`participant__avatar${view.isStreaming ? ' participant__avatar--started' : ''}`}
        style={{ background: view.color }}
        aria-hidden="true"
      >
        {view.initials}
      </span>

      <div className="participant__body">
        <span className="participant__name" title={view.displayName}>
          {view.displayName}
          {view.isMe && <span className="participant__you"> (Ty)</span>}
        </span>

        {view.badges.length > 0 && (
          <span className="participant__badges">
            {view.badges.map((badge) => (
              /*
                `key` to sam `kind`, CELOWO bez `quality`. Gdyby jakość weszła
                do klucza, plakietka „Ogląda" montowałaby się od nowa przy każdej
                zmianie jakości — czyli podskakiwałaby co pięć sekund, przy każdym
                raporcie z 0.3.1. Zmiana „płynnie" ↔ „zacina" ma być przemalowaniem
                istniejącej plakietki, nie nową plakietką.
              */
              <span key={badge.kind} className={`badge badge--${badgeModifier(badge)}`}>
                {badgeLabel(badge)}
              </span>
            ))}
          </span>
        )}
      </div>
    </li>
  )
}
```

- [ ] **Step 2: Przepisz panel**

Zastąp CAŁĄ zawartość `companion-app/src/renderer/components/PeerPanel.tsx`:

```tsx
import { splitByStreaming, type ParticipantView } from '@shared/participants'
import { ParticipantRow } from './ParticipantRow'

interface PeerPanelProps {
  /**
   * Wiersze PO przejściu wyjścia. Podział na sekcje robimy tutaj, a nie przed
   * przejściem: inaczej osoba kończąca transmisję byłaby przez chwilę widoczna
   * dwa razy naraz — dogasająca w „Nadają" i już wstawiona do „W kanale".
   */
  rows: { item: ParticipantView; leaving: boolean }[]
  collapsed: boolean
  onToggle: () => void
}

/**
 * Lista uczestników kanału. Zwijana, bo przy oglądaniu na pełnym ekranie
 * obraz jest ważniejszy niż lista — ale zwinięta zostawia pasek z liczbą osób,
 * żeby nie znikała bez śladu.
 */
export function PeerPanel({ rows, collapsed, onToggle }: PeerPanelProps): JSX.Element {
  if (collapsed) {
    return (
      <aside className="peers peers--collapsed">
        <button
          type="button"
          className="peers__toggle"
          onClick={onToggle}
          title="Pokaż listę uczestników"
          aria-expanded={false}
        >
          <span aria-hidden="true">‹</span>
          {/* Licznik na zwiniętym pasku jest ŁĄCZNY — tu nie ma podziału na sekcje. */}
          <span className="peers__count-badge">{rows.length}</span>
        </button>
      </aside>
    )
  }

  const { streaming, others } = splitByStreaming(rows, (row) => row.item.isStreaming)

  return (
    <aside className="peers">
      <header className="peers__header">
        <h2 className="peers__title">Uczestnicy</h2>
        <button
          type="button"
          className="peers__toggle"
          onClick={onToggle}
          title="Ukryj listę uczestników"
          aria-expanded={true}
        >
          <span aria-hidden="true">›</span>
        </button>
      </header>

      {streaming.length > 0 && (
        <>
          <h3 className="peers__section">
            Nadają <span className="peers__section-count">{streaming.length}</span>
          </h3>
          <ul className="peers__list">
            {streaming.map((row) => (
              <ParticipantRow key={row.item.peerId} view={row.item} leaving={row.leaving} />
            ))}
          </ul>
        </>
      )}

      {others.length > 0 && (
        <>
          <h3 className="peers__section">
            W kanale <span className="peers__section-count">{others.length}</span>
          </h3>
          <ul className="peers__list">
            {others.map((row) => (
              <ParticipantRow key={row.item.peerId} view={row.item} leaving={row.leaving} />
            ))}
          </ul>
        </>
      )}

      {rows.length <= 1 && (
        <p className="settings__hint">Nikt inny nie dołączył jeszcze do kanału.</p>
      )}
    </aside>
  )
}
```

- [ ] **Step 3: Podepnij to w LobbyView**

W `companion-app/src/renderer/components/LobbyView.tsx` dodaj do importów:

```tsx
import { buildParticipants } from '@shared/participants'
import { useLeaveTransition } from '../hooks/useLeaveTransition'
```

Zaraz po wyliczeniu `tiles` (linia ~75), **przed wszystkimi wcześniejszymi wyjściami z komponentu** (`if (lobby.state.connection === 'bad-key') return …` i `if (pickerOpen) return …`), dołóż:

```tsx
  /*
   * UWAGA: oba hooki MUSZĄ stać tutaj, przed instrukcjami `return` niżej.
   * LobbyView wychodzi wcześniej przy `bad-key` i przy otwartym wyborze źródła,
   * a hook wywołany po takim wyjściu łamie zasady Reacta i wywala aplikację
   * przy pierwszym otwarciu okna wyboru.
   */
  const participants = buildParticipants({
    me: lobby.state.me,
    peers: lobby.state.peers,
    streams: lobby.state.streams,
    viewerPeerIds: lobby.state.viewerPeerIds,
    viewerQuality,
    unreachablePeerIds: lobby.state.unreachablePeerIds
  })
  const participantRows = useLeaveTransition(participants, (view) => view.peerId)
  const tileRows = useLeaveTransition(tiles, (tile) => tile.tileKey)
```

Zamień wywołanie `PeerPanel` (linie ~309-316) na:

```tsx
        <PeerPanel
          rows={participantRows}
          collapsed={panelCollapsed}
          onToggle={() => setPanelCollapsed((current) => !current)}
        />
```

- [ ] **Step 4: Zamień style panelu**

W `companion-app/src/renderer/styles.css` zamień cały blok od `.peers {` do `.peers__quality--unknown { … }` włącznie (dziś linie ~632-774) na:

```css
.peers {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 16px;
  border-left: 1px solid var(--border);
  background: var(--bg-raised);
  overflow-y: auto;
  transition: width 0.15s ease;
}

/* Zwinięty panel zostawia wąski pasek z licznikiem — lista nie znika bez śladu. */
.peers--collapsed {
  width: 52px;
  padding: 12px 8px;
  align-items: center;
}

.peers__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 14px;
}

.peers__title,
.peers__section {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  font-weight: 600;
}

/* Nagłówek sekcji oddycha nad listą, ale nie nad samym sobą przy pierwszej. */
.peers__section {
  margin: 14px 0 8px;
}

.peers__section:first-of-type {
  margin-top: 0;
}

.peers__section-count {
  font-variant-numeric: tabular-nums;
}

.peers__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-input);
  color: var(--text-muted);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}

.peers__toggle:hover {
  color: var(--text);
  background: #35373c;
}

.peers__count-badge {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.peers__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.participant {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 6px;
}

.participant__avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
}

.participant__body {
  min-width: 0;
  flex: 1;
}

.participant__name {
  display: block;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.participant__you {
  color: var(--text-muted);
}

.participant__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 5px;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(88, 101, 242, 0.2);
  color: #a5adff;
  white-space: nowrap;
}

.badge--watching-ok {
  background: rgba(87, 167, 115, 0.18);
  color: #57a773;
}

.badge--watching-poor {
  background: rgba(240, 198, 116, 0.18);
  color: #f0c674;
}

/* „Nie wiadomo" ma wyglądać inaczej niż każda odpowiedź — stąd szarość. */
.badge--watching-unknown {
  background: rgba(148, 155, 164, 0.16);
  color: var(--text-muted);
}

.badge--unreachable {
  background: rgba(218, 55, 60, 0.18);
  color: #ff9a9d;
}
```

- [ ] **Step 5: Sprawdź, że kompiluje się i testy są zielone**

Run: `cd companion-app && npm run build && npm test`
Expected: PASS — brak błędów `tsc`, całość testów zielona

Jeśli `tsc` zgłosi nieużywany import w `PeerPanel.tsx` albo `LobbyView.tsx` (np. `StreamRef`, `ViewerQuality`), usuń go — po przebudowie panel nie potrzebuje już tych typów.

- [ ] **Step 6: Commit**

```bash
git add companion-app/src/renderer/components/ParticipantRow.tsx \
        companion-app/src/renderer/components/PeerPanel.tsx \
        companion-app/src/renderer/components/LobbyView.tsx \
        companion-app/src/renderer/styles.css
git commit -m "feat(panel): krazki, plakietki i podzial listy na sekcje"
```

---

### Task 8: Animacje

**Files:**
- Modify: `companion-app/src/renderer/components/StreamTile.tsx` (nowy props `leaving`)
- Modify: `companion-app/src/renderer/components/LobbyView.tsx` (renderowanie kafelków z `tileRows`)
- Modify: `companion-app/src/renderer/styles.css` (klatki kluczowe na końcu pliku)

**Interfaces:**
- Consumes: `tileRows` z Task 7
- Produces: nic dla dalszych zadań

- [ ] **Step 1: Dołóż `leaving` do kafelka**

W `companion-app/src/renderer/components/StreamTile.tsx` dopisz do `StreamTileProps`:

```tsx
  /** Nadawca zakończył transmisję i kafelek właśnie odjeżdża. */
  leaving: boolean
```

dodaj `leaving` do listy rozpakowanych propsów w sygnaturze funkcji i zamień korzeń komponentu:

```tsx
    <div className={`tile${zoomed ? ' tile--zoom' : ''}${leaving ? ' tile--leaving' : ''}`}>
```

- [ ] **Step 2: Renderuj kafelki z listy po przejściu**

W `companion-app/src/renderer/components/LobbyView.tsx` zamień pętlę renderującą kafelki (dziś `tiles.filter(…).map(…)`) na:

```tsx
              {tileRows
                .filter((row) => !zoomed || row.item.tileKey === zoomed)
                .map((row) => (
                  <StreamTile
                    key={row.item.tileKey}
                    stream={row.item.stream}
                    name={row.item.label}
                    kind={row.item.kind}
                    isMe={row.item.isMe}
                    leaving={row.leaving}
                    zoomed={zoomed === row.item.tileKey}
                    onToggleZoom={() =>
                      setZoomed((current) => (current === row.item.tileKey ? null : row.item.tileKey))
                    }
                  />
                ))}
```

Warunek `tiles.length === 0` sterujący ekranem „Nikt nie nadaje obrazu" zamień na `tileRows.length === 0`, a atrybut siatki na `data-ile={Math.min(tileRows.length, 4)}` — inaczej siatka przeskoczyłaby na inny układ w połowie animacji wyjścia.

Zostaw bez zmian `tiles.some(...)` w efekcie pilnującym powiększenia (linie ~129-131): powiększony kafelek ma wrócić do siatki, gdy transmisja NAPRAWDĘ się skończy, a nie czekać, aż dogaśnie.

- [ ] **Step 3: Dopisz klatki kluczowe**

Dopisz na końcu `companion-app/src/renderer/styles.css`:

```css
/* ---------- animacje transmisji ---------- */

/*
 * Krzywa z odbiciem: przeskakuje ponad docelowy rozmiar i wraca. To ona daje
 * różnicę między „element się pojawił" a „element wszedł".
 */
@keyframes tile-in {
  0% {
    opacity: 0;
    transform: scale(0.78) translateY(16px);
  }
  65% {
    transform: scale(1.04) translateY(0);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes tile-out {
  to {
    opacity: 0;
    transform: scale(0.84) translateY(12px);
  }
}

@keyframes participant-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
}

@keyframes participant-out {
  to {
    opacity: 0;
    transform: translateY(6px);
  }
}

@keyframes badge-in {
  0% {
    opacity: 0;
    transform: scale(0.5);
  }
  60% {
    transform: scale(1.15);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

/* Dwa uderzenia, nie jedno: jeden puls ginie wśród innych zmian na ekranie. */
@keyframes avatar-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(88, 101, 242, 0.55);
  }
  25% {
    box-shadow: 0 0 0 7px rgba(88, 101, 242, 0);
  }
  50% {
    box-shadow: 0 0 0 0 rgba(88, 101, 242, 0.45);
  }
  75% {
    box-shadow: 0 0 0 7px rgba(88, 101, 242, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(88, 101, 242, 0);
  }
}

.tile {
  animation: tile-in 400ms cubic-bezier(0.22, 1.4, 0.36, 1);
}

/* `forwards` trzyma końcową klatkę, żeby element nie mrugnął z powrotem
   w pełną widoczność między końcem animacji a usunięciem z DOM-u. */
.tile--leaving {
  animation: tile-out 400ms ease forwards;
  pointer-events: none;
}

.participant {
  animation: participant-in 400ms cubic-bezier(0.22, 1.4, 0.36, 1);
}

.participant--leaving {
  animation: participant-out 400ms ease forwards;
  pointer-events: none;
}

.participant__avatar--started {
  animation: avatar-pulse 900ms ease-out;
}

.badge {
  animation: badge-in 300ms cubic-bezier(0.22, 1.4, 0.36, 1);
}

/*
 * Windows: „Efekty wizualne → Efekty animacji". Hook osobno skraca wtedy czas
 * dogasania do zera, więc element nie tylko przestaje się ruszać, ale też nie
 * wisi w DOM-ie przez czas nieistniejącej animacji.
 */
@media (prefers-reduced-motion: reduce) {
  .tile,
  .tile--leaving,
  .participant,
  .participant--leaving,
  .participant__avatar--started,
  .badge {
    animation: none;
  }
}
```

- [ ] **Step 4: Sprawdź kompilację i testy**

Run: `cd companion-app && npm run build && npm test`
Expected: PASS — bez błędów `tsc`, testy zielone

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/renderer/components/StreamTile.tsx \
        companion-app/src/renderer/components/LobbyView.tsx \
        companion-app/src/renderer/styles.css
git commit -m "feat(panel): animacje startu i konca transmisji"
```

---

### Task 9: Sprawdziany z prawdziwym oknem

Usunięcie `.peers__quality` **psuje istniejący** `e2e/jakosc-odbioru.mjs` — czyta ten selektor i bez poprawki zgłosiłby fałszywą awarię łańcucha raportów z 0.3.1. Naprawa idzie razem z nowym sprawdzianem, bo to ta sama zmiana selektora.

Oba skrypty wymagają działającego serwera sygnalizacyjnego (`cd signaling-server && npm start`) i **nie robią zrzutów ekranu** — czytają DOM.

**Files:**
- Modify: `companion-app/e2e/jakosc-odbioru.mjs:216-269`
- Create: `companion-app/e2e/panel-uczestnikow.mjs`
- Modify: `companion-app/package.json` (skrypt `e2e:panel`)

**Interfaces:**
- Consumes: klasy CSS `badge--watching-*`, `badge--screen`, `peers__section` z Task 7
- Produces: nic dla dalszych zadań

- [ ] **Step 1: Przestaw stary sprawdzian na plakietki**

W `companion-app/e2e/jakosc-odbioru.mjs` zamień blok odczytu u nadawcy:

```js
  // --- strona nadawcy: co widać w interfejsie ---
  const badges = JSON.parse(
    await A.evaluate(`
      JSON.stringify([...document.querySelectorAll('.badge')]
        .filter((el) => /badge--watching-/.test(el.className))
        .map((el) => ({ className: el.className, description: el.textContent })))
    `)
  )
```

a niżej zamień odpowiadające im wypisywanie i sprawdzenie:

```js
  console.log('\n=== U NADAWCY (plakietki w panelu) ===')
  if (badges.length === 0) {
    console.error('  BRAK PLAKIETEK — łańcuch nie działa albo nikt nie ogląda')
    exitCode = 1
  }
  for (const badge of badges) {
    console.log(`  ${badge.className}  "${badge.description}"`)
  }

  const allUnknown =
    badges.length > 0 && badges.every((badge) => badge.className.includes('watching-unknown'))
  if (allUnknown) {
    console.error(`\nBŁĄD: po ${WAIT_MS / 1000} s wszystkie plakietki nadal mówią „Ogląda" bez dopisku.`)
    console.error('Raporty nie dolatują — wróć do diagnozy zamiast dopisywać kod.')
    exitCode = 1
  }
```

Popraw też komentarz nagłówkowy pliku (linie 8-9): zamiast „kropki w panelu uczestników" ma być „plakietki w panelu uczestników", oraz ostatni komunikat sukcesu — „plakietki mają stan inny niż «nie wiadomo»".

- [ ] **Step 2: Napisz nowy sprawdzian panelu**

`companion-app/e2e/panel-uczestnikow.mjs`:

```js
// Czy panel uczestników pokazuje to, co ma pokazywać, gdy ktoś zaczyna nadawać?
//
// Sprawdzamy DOM u OBU stron, bo każda widzi co innego:
//   - u WIDZA (B): nadawca ma wylądować w sekcji „Nadają" z plakietką ekranu;
//   - u NADAWCY (A): widz ma dostać plakietkę „Ogląda".
//
// Czytamy DOM, a nie stan Reacta, i NIE robimy zrzutów ekranu — sprawdzamy
// dokładnie te klasy, na których stoi interfejs.
//
// Wymaga działającego serwera sygnalizacyjnego:
//   cd signaling-server && npm start
//
// Uruchomienie: npm run build && npm run e2e:panel
import { attach, launchApp } from './cdp.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const CHANNEL = process.env.CHANNEL ?? `panel-e2e-${Date.now()}`
const PORT_A = 9381
const PORT_B = 9382

function instanceArgs() {
  return [
    '--ts3-server=ts.test.pl:9987',
    `--channel=${CHANNEL}`,
    '--signaling=ws://127.0.0.1:8080',
    '--use-fake-device-for-media-stream',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling'
  ]
}

const SHARE_BUTTON = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Udostępnij ekran/.test(x.textContent))
  return b ? (b.disabled ? 'NIEAKTYWNY' : 'AKTYWNY') : 'BRAK'
})()`

async function waitReady(cdp, label) {
  for (let i = 0; i < 40; i++) {
    if ((await cdp.evaluate(SHARE_BUTTON)) === 'AKTYWNY') return
    await sleep(500)
  }
  throw new Error(`${label}: nie doczekałem się połączenia z serwerem sygnalizacyjnym`)
}

async function shareScreen(cdp) {
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b=>/Udostępnij ekran/.test(b.textContent)).click()`
  )
  await sleep(2_500)
  await cdp.evaluate(
    `[...document.querySelectorAll('.source-card')].find(c=>/Ekran/.test(c.textContent)).click()`
  )
  await sleep(2_500)
  return cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x=>/Rozpocznij udostępnianie/.test(x.textContent))
    if (!b) return 'BRAK PRZYCISKU'
    if (b.disabled) return 'NIEAKTYWNY'
    b.click(); return 'ok'
  })()`)
}

/** Zrzut panelu: nagłówki sekcji oraz wiersze z inicjałami i plakietkami. */
const PANEL = `(() => {
  const sections = [...document.querySelectorAll('.peers__section')].map(el => el.textContent.trim())
  const rows = [...document.querySelectorAll('.participant')].map(el => ({
    initials: el.querySelector('.participant__avatar')?.textContent ?? '',
    name: el.querySelector('.participant__name')?.textContent ?? '',
    badges: [...el.querySelectorAll('.badge')].map(b => b.className)
  }))
  return JSON.stringify({ sections, rows })
})()`

async function waitForBadge(cdp, pattern, attempts = 30) {
  let panel = null
  for (let i = 0; i < attempts; i++) {
    panel = JSON.parse(await cdp.evaluate(PANEL))
    if (panel.rows.some((row) => row.badges.some((cls) => pattern.test(cls)))) return panel
    await sleep(500)
  }
  return panel
}

const processes = []
let exitCode = 0
let A = null
let B = null

try {
  for (const port of [PORT_A, PORT_B]) processes.push(launchApp(port, instanceArgs()))

  A = await attach(PORT_A)
  B = await attach(PORT_B)

  await waitReady(A, 'A (nadawca)')
  await waitReady(B, 'B (widz)')
  console.log('Obie instancje w kanale. A zaczyna udostępniać ekran...')
  console.log('start udostępniania u A:', await shareScreen(A))

  // --- u widza: nadawca w sekcji „Nadają", z plakietką ekranu ---
  const atViewer = await waitForBadge(B, /badge--screen/)
  console.log('\n=== PANEL U WIDZA ===')
  console.log('  sekcje:', JSON.stringify(atViewer.sections))
  for (const row of atViewer.rows) {
    console.log(`  [${row.initials}] ${row.name}  ${JSON.stringify(row.badges)}`)
  }

  if (!atViewer.sections.some((text) => /Nadają/.test(text))) {
    console.error('BŁĄD: u widza nie ma sekcji „Nadają", choć ktoś nadaje.')
    exitCode = 1
  }
  if (!atViewer.rows.some((row) => row.badges.some((cls) => /badge--screen/.test(cls)))) {
    console.error('BŁĄD: u widza nie ma plakietki ekranu przy nadawcy.')
    exitCode = 1
  }
  if (atViewer.rows.some((row) => row.initials.trim() === '')) {
    console.error('BŁĄD: któryś krążek jest pusty — inicjały się nie wyliczyły.')
    exitCode = 1
  }

  // --- u nadawcy: widz z plakietką „Ogląda" ---
  const atStreamer = await waitForBadge(A, /badge--watching-/)
  console.log('\n=== PANEL U NADAWCY ===')
  console.log('  sekcje:', JSON.stringify(atStreamer.sections))
  for (const row of atStreamer.rows) {
    console.log(`  [${row.initials}] ${row.name}  ${JSON.stringify(row.badges)}`)
  }

  if (!atStreamer.rows.some((row) => row.badges.some((cls) => /badge--watching-/.test(cls)))) {
    console.error('BŁĄD: u nadawcy nie ma plakietki „Ogląda" przy widzu.')
    exitCode = 1
  }

  if (exitCode === 0) {
    console.log('\nOK: sekcje, krążki i plakietki są po obu stronach.')
  }
} catch (err) {
  console.error('\nBŁĄD sprawdzianu:', err instanceof Error ? err.message : String(err))
  exitCode = 1
} finally {
  A?.close()
  B?.close()
  for (const proc of processes) proc.kill()
  await sleep(500)
}

process.exit(exitCode)
```

- [ ] **Step 3: Dodaj skrypt npm**

W `companion-app/package.json`, w `scripts`, obok `"e2e:jakosc"` dopisz:

```json
    "e2e:panel": "node e2e/panel-uczestnikow.mjs",
```

- [ ] **Step 4: Uruchom oba sprawdziany**

W jednym terminalu: `cd signaling-server && npm start`

W drugim:

```bash
cd companion-app && npm run build && npm run e2e:panel
```

Expected: `OK: sekcje, krążki i plakietki są po obu stronach.` i kod wyjścia 0.

Potem, dla pewności, że stary sprawdzian nadal działa po zmianie selektora:

```bash
cd companion-app && npm run e2e:jakosc
```

Expected: `OK: raporty dolatują, plakietki mają stan inny niż „nie wiadomo".`

Jeśli którykolwiek zgłosi błąd — **to jest prawdziwa usterka do zdiagnozowania, a nie powód do rozluźnienia sprawdzianu.**

- [ ] **Step 5: Commit**

```bash
git add companion-app/e2e/panel-uczestnikow.mjs companion-app/e2e/jakosc-odbioru.mjs companion-app/package.json
git commit -m "test(panel): sprawdzian panelu na dwoch instancjach, plakietki zamiast kropki"
```

---

### Task 10: Wersja 0.3.2 i dokumentacja

**Files:**
- Modify: `companion-app/package.json` (pole `version`)
- Modify: `TODO.md` (sekcja 3)

**Interfaces:**
- Consumes: wszystko powyżej
- Produces: nic

- [ ] **Step 1: Podnieś wersję**

W `companion-app/package.json` zmień `"version": "0.3.1"` na `"version": "0.3.2"`.

- [ ] **Step 2: Dopisz podsumowanie do TODO.md**

W `TODO.md`, w sekcji 3, po bloku „Widać, jak im idzie — jakość odbioru u widzów (0.3.1, 2026-08-10)", dopisz:

```markdown
### Panel uczestników i animacje (0.3.2, 2026-08-12)

Krążki z inicjałami, plakietki stanu zamiast 13-pikselowych emoji, podział listy
na „Nadają" i „W kanale", animacje startu i końca transmisji. Spec:
`docs/superpowers/specs/2026-08-12-panel-uczestnikow-i-animacje-design.md`.

**Kropka jakości z 0.3.1 zniknęła** — jej informacja przeszła do plakietki
„Ogląda · płynnie / zacina". To przeprowadzka, nie wycofanie funkcji.

**Rzecz, która okazała się sednem:** animacja wyjścia w Reakcie nie ma czego
animować, bo element znika z DOM-u w tej samej klatce, w której wypada z listy.
Stąd `src/shared/leaveTransition.ts` — reduktor trzymający wychodzące elementy
jeszcze przez 400 ms, na ich dawnych pozycjach. Jest generyczny PO ELEMENCIE,
a nie po kluczu, bo kafelek musi dogasać z tym samym `MediaStream` — inaczej
zamiast obrazu gasłby czarny prostokąt.

**Animacje wejścia nie mają ani jednego zegara:** uruchamia je dobór `key`.
Krążek pulsuje, bo jego `key` zawiera `isStreaming`; plakietka ma `key` równy
samemu `kind` CELOWO bez `quality`, inaczej podskakiwałaby przy każdym raporcie
jakości, czyli co pięć sekund.

**Odrzucone:** View Transitions API (Chromium 130 je ma i załatwiłoby nawet
przejazd wiersza między sekcjami, ale robi migawkę całego dokumentu — z żywym
`<video>` grozi to mrugnięciem czarną klatką, i nie da się tego przetestować
bez przeglądarki). Przejazd wiersza między sekcjami został więc natychmiastowy.

**Dług spłacony przy okazji:** `vitest.config.ts` z aliasem `@shared`.

Ustawienia (szufladka nad obrazem, karty, segmenty, suwak bitrate) → 0.3.3.
Powiadomienia w rogu przy wejściu i wyjściu osoby → 0.3.4.
```

- [ ] **Step 3: Sprawdź całość przed zamknięciem**

Run: `cd companion-app && npm test && npm run build`
Expected: PASS — wszystkie testy zielone, budowanie bez błędów

- [ ] **Step 4: Commit**

```bash
git add companion-app/package.json TODO.md
git commit -m "docs: wersja 0.3.2 i domkniecie panelu uczestnikow"
```

---

## Kolejność i zależności

Zadania 1-5 są niezależne od interfejsu i można je zrobić w dowolnej kolejności
po Task 1 (alias). Zadania 6-8 idą po kolei i po Task 4-5. Task 9 wymaga Task 7
(potrzebuje klas CSS). Task 10 na końcu.

Po Task 7 aplikacja **wygląda** już docelowo, ale nie ma ruchu — to dobry moment
na pierwsze obejrzenie okiem, zanim dojdą animacje.
