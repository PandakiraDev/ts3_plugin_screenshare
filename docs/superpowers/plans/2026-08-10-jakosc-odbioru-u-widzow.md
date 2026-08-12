# Widać, jak im idzie — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Przy każdej osobie, która nas ogląda, widać, czy obraz do niej dochodzi — mierzone tym, ile czasu jej obraz stał zamrożony, a nie naszymi statystykami nadawania.

**Architecture:** Widz co 5 s czyta własne `inbound-rtp`, liczy przyrost `totalFreezesDuration` i odsyła go nadawcy istniejącą drogą sygnalizacji (payload jest dla serwera nieprzezroczysty, więc zero zmian w serwerze i protokole). Nadawca trzyma ostatni raport od każdego widza; logika progu i starzenia siedzi w czystym module `src/shared/viewerQuality.ts`, timery w rendererze.

**Tech Stack:** Electron 33, React 18, TypeScript, vitest, WebRTC `getStats()`.

**Spec:** `docs/superpowers/specs/2026-08-10-jakosc-odbioru-u-widzow-design.md`

## Global Constraints

- **Identyfikatory w kodzie po angielsku; komentarze i komunikaty dla użytkownika po polsku**, z polskimi znakami diakrytycznymi.
- **Testy w `companion-app/test/*.test.ts` NIE mogą importować `electron`.** Vitest chodzi w gołym Node bez konfiguracji; importy względne (`../src/...`) — wzorzec: `test/cli.test.ts`.
- **`src/shared/viewerQuality.ts` ma mieć zero zależności** — granica architektoniczna, tak samo jak `connectionHealth.ts`.
- **Brak jsdom** — komponentów i hooków nie da się testować jednostkowo. Weryfikacja: `npm run build` (obejmuje `tsc --noEmit`) plus `npm test`. Nie próbuj dopisywać testów komponentów.
- **Zero zmian w `signaling-server/`, w protokole sygnalizacji, w `plugin/`, `build/`, `src/main/`, `src/preload/`.**
- **Payload raportu NIE MOŻE zawierać pola `stream`.** To warunek zgodności wstecz: `onSignal` w starszych klientach liczy `connectionKey(from, payload.stream)` i bez tego pola klucz nigdy nie pasuje, więc wiadomość jest ignorowana. Z polem `stream` stary klient próbowałby dodać `undefined` jako kandydata ICE.
- `tsconfig.json` ma `noUnusedLocals` i `noUnusedParameters`.
- Komunikaty commitów po polsku, konwencja `typ: opis`.
- Platforma docelowa: wyłącznie Windows. Wszystkie polecenia z katalogu `companion-app/`.

## File Structure

| Plik | Odpowiedzialność | Zadanie |
|---|---|---|
| `src/shared/viewerQuality.ts` | **Nowy.** Typ stanu, próg, starzenie, reguła „wszystkim się zacina". Zero zależności. | 1 |
| `test/viewer-quality.test.ts` | **Nowy.** Testy powyższego. | 1 |
| `src/renderer/webrtc/session.ts` | `viewerPeerIds` zamiast `countViewers`; wysyłka i odbiór raportów jakości | 2, 3 |
| `test/session-keys.test.ts` | Modyfikacja: testy listy zamiast liczby | 2 |
| `src/renderer/hooks/useLobby.ts` | Stan: lista widzów, ostatnie raporty; wystawienie wysyłki | 4 |
| `src/renderer/components/LobbyView.tsx` | Licznik widzów z długości listy; osadzenie hooka i propsów | 4, 5, 6 |
| `src/renderer/hooks/useViewerQuality.ts` | **Nowy.** Timer 5 s na wysyłkę, 1 s na starzenie | 5 |
| `src/renderer/components/PeerPanel.tsx` | Kropka przy nazwisku | 5 |
| `src/renderer/styles.css` | Style kropki | 5 |
| `src/shared/connectionHealth.ts` | Nowy rodzaj problemu `viewers-struggling` | 6 |
| `src/renderer/hooks/useConnectionHealth.ts` | Nowe wejście do `pickProblem` | 6 |
| `e2e/jakosc-odbioru.mjs` | **Nowy.** Pomiar: czy raport realnie dolatuje | 7 |
| `package.json`, `TODO.md` | Wersja 0.3.1, domknięcie tematu | 8 |

---

### Task 1: Czysta logika jakości odbioru

**Files:**
- Create: `companion-app/src/shared/viewerQuality.ts`
- Test: `companion-app/test/viewer-quality.test.ts`

**Interfaces:**
- Consumes: nic.
- Produces:
  - `type ViewerQuality = 'ok' | 'poor' | 'unknown'`
  - `interface FreezeReport { frozenMs: number; windowMs: number }`
  - `const QUALITY_REPORT_INTERVAL_MS`, `QUALITY_STALE_AFTER_MS`, `FROZEN_FRACTION_POOR`
  - `function qualityFromReport(report: FreezeReport | null, ageMs: number): ViewerQuality`
  - `function allViewersStruggling(qualities: ViewerQuality[]): boolean`

- [ ] **Step 1: Napisz test, który ma nie przejść**

Utwórz `companion-app/test/viewer-quality.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  FROZEN_FRACTION_POOR,
  QUALITY_STALE_AFTER_MS,
  allViewersStruggling,
  qualityFromReport,
  type ViewerQuality
} from '../src/shared/viewerQuality'

test('brak raportu to nie jest dobra wiadomość', () => {
  // Cisza znaczy "nie wiemy", nie "wszystko gra". Bez tego rozróżnienia
  // wskaźnik kłamałby przez pierwsze sekundy po dołączeniu widza.
  expect(qualityFromReport(null, 0)).toBe('unknown')
})

test('raport w progu jest w porządku, powyżej progu już nie', () => {
  const okno = 10_000
  const naProgu = okno * FROZEN_FRACTION_POOR
  expect(qualityFromReport({ frozenMs: naProgu, windowMs: okno }, 0)).toBe('ok')
  expect(qualityFromReport({ frozenMs: naProgu + 1, windowMs: okno }, 0)).toBe('poor')
})

test('obraz stojący prawie cały czas to zdecydowanie słabo', () => {
  expect(qualityFromReport({ frozenMs: 9_000, windowMs: 10_000 }, 0)).toBe('poor')
})

test('brak zamrożeń to dobrze', () => {
  expect(qualityFromReport({ frozenMs: 0, windowMs: 10_000 }, 0)).toBe('ok')
})

test('stary raport przestaje cokolwiek znaczyć', () => {
  const dobry = { frozenMs: 0, windowMs: 10_000 }
  expect(qualityFromReport(dobry, QUALITY_STALE_AFTER_MS - 1)).toBe('ok')
  expect(qualityFromReport(dobry, QUALITY_STALE_AFTER_MS)).toBe('unknown')
})

test('okno zerowej długości nie dzieli przez zero', () => {
  expect(qualityFromReport({ frozenMs: 0, windowMs: 0 }, 0)).toBe('unknown')
})

test('jeden widz z problemem to jego problem, nie nasz', () => {
  // Przy jednym widzu nie da się odróżnić "moje łącze" od "jego komputer",
  // więc pasek ma milczeć, a informacja zostaje przy nazwisku.
  expect(allViewersStruggling(['poor'])).toBe(false)
})

test('dwóch widzów z problemem to już wspólny mianownik', () => {
  expect(allViewersStruggling(['poor', 'poor'])).toBe(true)
})

test('jeden słabo i jeden dobrze to nie jest wina nadawcy', () => {
  expect(allViewersStruggling(['poor', 'ok'])).toBe(false)
})

test('nie wiemy, więc nie krzyczymy', () => {
  expect(allViewersStruggling(['unknown', 'unknown'])).toBe(false)
  expect(allViewersStruggling(['poor', 'unknown'])).toBe(false)
})

test('brak widzów to brak problemu', () => {
  const pusto: ViewerQuality[] = []
  expect(allViewersStruggling(pusto)).toBe(false)
})
```

- [ ] **Step 2: Uruchom test i potwierdź, że nie przechodzi**

```bash
cd companion-app && npx vitest run test/viewer-quality.test.ts
```

Oczekiwane: FAIL — `Failed to resolve import "../src/shared/viewerQuality"`.

- [ ] **Step 3: Napisz implementację**

Utwórz `companion-app/src/shared/viewerQuality.ts`:

```ts
/**
 * Jak widzowi dochodzi nasz obraz.
 *
 * Mierzymy OBRAZ, nie łącze. Własne FPS i bitrate mówią "czy koduję", a strata
 * pakietów mówi o łączu — tymczasem obraz potrafi zacinać się od słabego
 * procesora widza przy zerowej stracie, a część strat WebRTC nadrabia
 * retransmisją i są niewidoczne. Jedyne miejsce, w którym istnieje odpowiedź
 * na pytanie "czy się zacina", to odbiornik.
 */
export type ViewerQuality = 'ok' | 'poor' | 'unknown'

/** Ile obraz stał zamrożony w oknie o danej długości. */
export interface FreezeReport {
  frozenMs: number
  windowMs: number
}

/** Co ile widz wysyła raport. */
export const QUALITY_REPORT_INTERVAL_MS = 5_000

/**
 * Po tylu milisekundach bez raportu wracamy do "nie wiadomo". Trzy przegapione
 * raporty — wcześniej byłoby to czułe na pojedynczy zgubiony pakiet.
 */
export const QUALITY_STALE_AFTER_MS = 15_000

/**
 * Powyżej tego ułamka okna wskaźnik robi się "słabo". 5% to pół sekundy na
 * dziesięć — próg dobrany tak, żeby przekładał się na odczucie ("co dwudziesta
 * sekunda stoi"), a nie zapalał się przy pojedynczym mrugnięciu.
 */
export const FROZEN_FRACTION_POOR = 0.05

export function qualityFromReport(
  report: FreezeReport | null,
  ageMs: number
): ViewerQuality {
  if (report === null) return 'unknown'
  if (ageMs >= QUALITY_STALE_AFTER_MS) return 'unknown'
  // Okno zerowe albo ujemne = raport bez sensu; lepiej przyznać się do
  // niewiedzy niż dzielić przez zero.
  if (report.windowMs <= 0) return 'unknown'
  return report.frozenMs / report.windowMs > FROZEN_FRACTION_POOR ? 'poor' : 'ok'
}

/**
 * Czy problem jest po NASZEJ stronie.
 *
 * Wymaga co najmniej dwóch widzów: przy jednym nie da się odróżnić "moje
 * łącze" od "jego komputer", więc pasek milczy, a informacja zostaje przy
 * nazwisku. Przy dwóch i więcej wspólny mianownik jesteśmy my.
 *
 * "Nie wiadomo" nie liczy się jako problem — nie krzyczymy o czymś, czego
 * nie zmierzyliśmy.
 */
export function allViewersStruggling(qualities: ViewerQuality[]): boolean {
  return qualities.length >= 2 && qualities.every((quality) => quality === 'poor')
}
```

- [ ] **Step 4: Uruchom testy i potwierdź, że przechodzą**

```bash
cd companion-app && npm test
```

Oczekiwane: PASS, w tym 11 nowych przypadków.

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/shared/viewerQuality.ts companion-app/test/viewer-quality.test.ts
git commit -m "feat(jakosc): czysta logika jakosci odbioru u widzow"
```

---

### Task 2: Lista widzów zamiast ich liczby

Wskaźnik trzeba postawić **przy konkretnej osobie**, a licznik tego nie umożliwia. Zamieniamy funkcję zwracającą liczbę na zwracającą listę; liczba wylicza się z długości.

**Files:**
- Modify: `companion-app/src/renderer/webrtc/session.ts` — `countViewers` (linie ~41-57), `emitViewerCount` (~463-467), typ `LobbyCallbacks`
- Modify: `companion-app/test/session-keys.test.ts`
- Modify: `companion-app/src/renderer/hooks/useLobby.ts` — pole stanu
- Modify: `companion-app/src/renderer/components/LobbyView.tsx:204-206` — licznik w nagłówku

**Interfaces:**
- Consumes: nic z Zadania 1.
- Produces:
  - `export function viewerPeerIds(peerIds: Iterable<string>, hasConnection: (key: string) => boolean): string[]`
  - `LobbyCallbacks.onViewersChange: (peerIds: string[]) => void` (zastępuje `onViewerCountChange`)
  - `LobbyState.viewerPeerIds: string[]` (zastępuje `viewers: number`)

- [ ] **Step 1: Przepisz testy na listę**

W `companion-app/test/session-keys.test.ts` zamień import i przypadki dotyczące `countViewers`:

```ts
import { connectionKey, viewerPeerIds } from '../src/renderer/webrtc/session'
```

```ts
test('widz z ekranem i kamerą liczy się raz', () => {
  // Jedna osoba oglądająca oba nasze strumienie ma dwa połączenia
  // wychodzące, ale to wciąż jedna osoba na liście.
  const connections = new Set([
    connectionKey('widz', 'screen'),
    connectionKey('widz', 'camera')
  ])
  expect(viewerPeerIds(['widz'], (key) => connections.has(key))).toEqual(['widz'])
})

test('osoba bez połączenia wychodzącego nie jest widzem', () => {
  const connections = new Set([connectionKey('a', 'screen')])
  expect(viewerPeerIds(['a', 'b'], (key) => connections.has(key))).toEqual(['a'])
})

test('kolejność wynika z kolejności uczestników', () => {
  const connections = new Set([
    connectionKey('a', 'screen'),
    connectionKey('b', 'camera')
  ])
  expect(viewerPeerIds(['a', 'b'], (key) => connections.has(key))).toEqual(['a', 'b'])
})
```

Usuń stare przypadki wołające `countViewers`.

- [ ] **Step 2: Uruchom i potwierdź, że nie przechodzą**

```bash
cd companion-app && npx vitest run test/session-keys.test.ts
```

Oczekiwane: FAIL — `viewerPeerIds` nie jest eksportowane.

- [ ] **Step 3: Zamień funkcję w sesji**

W `companion-app/src/renderer/webrtc/session.ts` zamień `countViewers` na:

```ts
/**
 * Zwraca WIDZOW, nie polaczenia. Widz ogladajacy nasz ekran i nasza kamere ma
 * dwa polaczenia wychodzace, wiec sama liczba polaczen pokazywalaby "2 widzow",
 * choc po drugiej stronie siedzi jedna osoba. Pytamy o gotowy klucz zamiast
 * rozbierac go z powrotem na peerId — peerId pochodzi z serwera i nikt nam nie
 * obiecal, ze nie ma w nim dwukropka.
 *
 * Lista, nie liczba: wskaznik jakosci odbioru trzeba postawic przy konkretnej
 * osobie, a z liczby nie da sie odtworzyc, przy ktorej.
 */
export function viewerPeerIds(
  peerIds: Iterable<string>,
  hasConnection: (key: string) => boolean
): string[] {
  const viewers: string[] = []
  for (const peerId of peerIds) {
    if (STREAM_KINDS.some((kind) => hasConnection(connectionKey(peerId, kind)))) {
      viewers.push(peerId)
    }
  }
  return viewers
}
```

W `interface LobbyCallbacks` zamień `onViewerCountChange` na:

```ts
  /**
   * Kto nas aktualnie oglada. Lista, nie liczba — przy kazdej z tych osob
   * stoi wskaznik jakosci odbioru.
   */
  onViewersChange: (peerIds: string[]) => void
```

Zamień metodę `emitViewerCount` na:

```ts
  private emitViewers(): void {
    this.callbacks.onViewersChange(
      viewerPeerIds(this.peers.keys(), (key) => this.outgoing.has(key))
    )
  }
```

Zamień oba wywołania `this.emitViewerCount()` (w `createOutgoing` i `dropOutgoing`) na `this.emitViewers()`.

- [ ] **Step 4: Zaktualizuj stan lobby**

W `companion-app/src/renderer/hooks/useLobby.ts`, w `interface LobbyState`, zamień `viewers: number` na:

```ts
  /** Kto nas aktualnie ogląda. Licznik w nagłówku bierze się z długości. */
  viewerPeerIds: string[]
```

W `INITIAL` zamień `viewers: 0,` na `viewerPeerIds: [],`.

W obiekcie callbacków zamień obsługę:

```ts
          onViewersChange: (peerIds) =>
            setState((current) => ({ ...current, viewerPeerIds: peerIds })),
```

- [ ] **Step 5: Zaktualizuj licznik w nagłówku**

W `companion-app/src/renderer/components/LobbyView.tsx` w wyrażeniu z liczbą widzów zamień trzy odwołania do `lobby.state.viewers` na `lobby.state.viewerPeerIds.length`. Sens tekstu („nikt nie ogląda" / „1 widz" / „N widzów") ma zostać bez zmian.

- [ ] **Step 6: Sprawdź testy i budowę**

```bash
cd companion-app && npm test && npm run build
```

Oczekiwane: PASS oraz budowa bez błędów.

- [ ] **Step 7: Commit**

```bash
git add companion-app/src/renderer/webrtc/session.ts companion-app/test/session-keys.test.ts companion-app/src/renderer/hooks/useLobby.ts companion-app/src/renderer/components/LobbyView.tsx
git commit -m "refactor(jakosc): lista widzow zamiast ich liczby"
```

---

### Task 3: Wysyłka i odbiór raportów jakości

**Files:**
- Modify: `companion-app/src/renderer/webrtc/session.ts` — typ `SignalPayload` (~88-91), `LobbyCallbacks`, `onSignal` (~518), `closeIncoming`, `dispose`, nowe pole i metoda

**Interfaces:**
- Consumes: `FreezeReport` z Zadania 1.
- Produces:
  - `LobbyCallbacks.onViewerQualityChange: (peerId: string, report: FreezeReport) => void`
  - `LobbySession.reportQualityToStreamers(): Promise<void>`

- [ ] **Step 1: Dodaj rodzaj payloadu i callback**

W `companion-app/src/renderer/webrtc/session.ts` dopisz import typu:

```ts
import type { FreezeReport } from '@shared/viewerQuality'
```

Do typu `SignalPayload` dopisz wariant:

```ts
  /**
   * Raport widza o tym, jak mu dochodzi nasz obraz.
   *
   * CELOWO bez pola `stream` — i to jest warunek zgodnosci wstecz, nie
   * przeoczenie. `onSignal` w starszych klientach liczy
   * `connectionKey(from, payload.stream)`; bez tego pola klucz nigdy nie
   * pasuje i wiadomosc jest po cichu ignorowana. Z polem `stream` stary
   * klient probowalby dodac `undefined` jako kandydata ICE.
   */
  | { kind: 'quality'; frozenMs: number; windowMs: number }
```

Do `interface LobbyCallbacks`:

```ts
  /** Raport od widza: ile jego obraz stal zamrozony w ostatnim oknie. */
  onViewerQualityChange: (peerId: string, report: FreezeReport) => void
```

- [ ] **Step 2: Obsłuż raport w onSignal — PRZED gałęzią ICE**

W `onSignal` wstaw obsługę **na samym początku**, przed obliczeniem `kind` i `key`:

```ts
  private async onSignal(from: string, payload: SignalPayload): Promise<void> {
    // Przed czymkolwiek innym: ten payload nie ma pola `stream`, wiec liczenie
    // z niego klucza polaczenia nie ma sensu. Dalsza czesc funkcji traktuje
    // wszystko, co nie jest oferta ani odpowiedzia, jako kandydata ICE.
    if (payload.kind === 'quality') {
      this.callbacks.onViewerQualityChange(from, {
        frozenMs: payload.frozenMs,
        windowMs: payload.windowMs
      })
      return
    }

    const kind = payload.stream
    const key = connectionKey(from, kind)
```

- [ ] **Step 3: Dodaj pole na poprzednie próbki**

Obok pozostałych pól prywatnych `LobbySession`:

```ts
  /**
   * Poprzedni odczyt zamrozen na polaczeniu PRZYCHODZACYM:
   * connectionKey -> { laczny czas zamrozen, kiedy odczytany }.
   *
   * `totalFreezesDuration` narasta od poczatku polaczenia, wiec bez poprzedniej
   * wartosci nie da sie policzyc, ile obraz stal w OSTATNIM oknie.
   */
  private readonly lastFreezeSample = new Map<string, { totalMs: number; at: number }>()
```

- [ ] **Step 4: Napisz wysyłkę raportów**

Metoda publiczna w `LobbySession`:

```ts
  /**
   * Wysyla kazdemu nadajacemu raport o tym, jak nam dochodzi jego obraz.
   * Wolane cyklicznie z warstwy interfejsu — sesja nie ma wlasnych timerow.
   *
   * Osoba nadajaca ekran i kamere naraz dostaje JEDEN raport: bierzemy
   * najgorszy z jej strumieni. Wskaznik i tak stoi przy nazwisku, wiec
   * rozbijanie go na strumienie niczego by nie wniosło.
   */
  async reportQualityToStreamers(): Promise<void> {
    type InboundStat = { type: string; kind?: string; totalFreezesDuration?: number }

    const now = Date.now()
    const najgorszy = new Map<string, FreezeReport>()

    for (const ref of this.streamerRefs.values()) {
      if (ref.peerId === this.myPeerId) continue
      const key = connectionKey(ref.peerId, ref.kind)
      const connection = this.incoming.get(key)
      if (!connection) continue

      let totalMs: number | null = null
      const report = await connection.getStats()
      for (const entry of report.values()) {
        const stat = entry as InboundStat
        if (stat.type !== 'inbound-rtp' || stat.kind !== 'video') continue
        // Statystyka jest w sekundach, my liczymy w milisekundach.
        if (typeof stat.totalFreezesDuration === 'number') {
          totalMs = stat.totalFreezesDuration * 1000
        }
      }
      if (totalMs === null) continue

      const previous = this.lastFreezeSample.get(key)
      this.lastFreezeSample.set(key, { totalMs, at: now })
      // Pierwsza probka nie ma z czym sie porownac. Bez tego pierwszy raport
      // powiedzialby "zamrozone 3 s w oknie 5 s", choc te 3 s uzbieraly sie
      // przez cala dotychczasowa transmisje.
      if (!previous) continue

      const windowMs = now - previous.at
      if (windowMs <= 0) continue
      // Licznik nie powinien maleć, ale ujemny wynik po restarcie polaczenia
      // dalby bezsensowny raport.
      const frozenMs = Math.max(0, totalMs - previous.totalMs)

      const dotychczas = najgorszy.get(ref.peerId)
      if (!dotychczas || frozenMs / windowMs > dotychczas.frozenMs / dotychczas.windowMs) {
        najgorszy.set(ref.peerId, { frozenMs, windowMs })
      }
    }

    for (const [peerId, raport] of najgorszy) {
      this.signaling.signal(peerId, { kind: 'quality', ...raport })
    }
  }
```

- [ ] **Step 5: Posprzątaj próbki**

W `closeIncoming`, obok pozostałego sprzątania:

```ts
    this.lastFreezeSample.delete(key)
```

W `dispose()`, obok pozostałego czyszczenia:

```ts
    this.lastFreezeSample.clear()
```

- [ ] **Step 6: Podłącz callback po stronie lobby**

Nowy callback jest wymagany przez typ, więc bez tego kroku nie skompiluje się miejsce tworzenia `LobbySession`. **Nie wstawiaj atrapy `() => {}`.**

W `companion-app/src/renderer/hooks/useLobby.ts`, w `interface LobbyState`, po `viewerPeerIds`:

```ts
  /** Ostatni raport od każdego widza wraz z czasem odbioru. */
  viewerQuality: Map<string, { report: FreezeReport; receivedAt: number }>
```

Dopisz import typu:

```ts
import type { FreezeReport } from '@shared/viewerQuality'
```

W `INITIAL`:

```ts
  viewerQuality: new Map(),
```

W obiekcie callbacków:

```ts
          onViewerQualityChange: (peerId, report) =>
            setState((current) => {
              // Nowa mapa, nie mutacja: React porownuje referencje.
              const viewerQuality = new Map(current.viewerQuality)
              viewerQuality.set(peerId, { report, receivedAt: Date.now() })
              return { ...current, viewerQuality }
            }),
```

- [ ] **Step 7: Sprawdź typy, budowę i testy**

```bash
cd companion-app && npm run build && npm test
```

Oczekiwane: budowa bez błędów, testy PASS bez zmian w liczbie.

- [ ] **Step 8: Commit**

```bash
git add companion-app/src/renderer/webrtc/session.ts companion-app/src/renderer/hooks/useLobby.ts
git commit -m "feat(jakosc): wysylka i odbior raportow o zamrozeniach obrazu"
```

---

### Task 4: Wystawienie wysyłki z lobby

**Files:**
- Modify: `companion-app/src/renderer/hooks/useLobby.ts` — interfejs `Lobby`, nowy `useCallback`

**Interfaces:**
- Consumes: `LobbySession.reportQualityToStreamers()` z Zadania 3.
- Produces: `Lobby.reportQualityToStreamers: () => Promise<void>`

- [ ] **Step 1: Rozszerz interfejs Lobby**

W `interface Lobby`, po `uplinkLimited`:

```ts
  /** Wysyła nadającym raport o tym, jak nam dochodzi ich obraz. */
  reportQualityToStreamers: () => Promise<void>
```

- [ ] **Step 2: Dodaj implementację**

Obok pozostałych `useCallback` w tym hooku:

```ts
  const reportQualityToStreamers = useCallback(async (): Promise<void> => {
    // Brak sesji = nikogo nie oglądamy, więc nie ma o czym raportować.
    await sessionRef.current?.reportQualityToStreamers()
  }, [])
```

i dodaj `reportQualityToStreamers` do obiektu zwracanego przez hook.

- [ ] **Step 3: Sprawdź budowę i testy**

```bash
cd companion-app && npm run build && npm test
```

Oczekiwane: brak błędów, testy PASS.

- [ ] **Step 4: Commit**

```bash
git add companion-app/src/renderer/hooks/useLobby.ts
git commit -m "feat(jakosc): wystaw wysylke raportow w interfejsie lobby"
```

---

### Task 5: Hook, kropka przy nazwisku, style

**Files:**
- Create: `companion-app/src/renderer/hooks/useViewerQuality.ts`
- Modify: `companion-app/src/renderer/components/PeerPanel.tsx`
- Modify: `companion-app/src/renderer/styles.css`
- Modify: `companion-app/src/renderer/components/LobbyView.tsx`

**Interfaces:**
- Consumes: wszystko z Zadań 1-4.
- Produces: `function useViewerQuality(lobby: Lobby): Map<string, ViewerQuality>`

- [ ] **Step 1: Napisz hook**

Utwórz `companion-app/src/renderer/hooks/useViewerQuality.ts`:

```ts
import { useEffect, useState } from 'react'
import {
  QUALITY_REPORT_INTERVAL_MS,
  qualityFromReport,
  type ViewerQuality
} from '@shared/viewerQuality'
import type { Lobby } from './useLobby'

/** Jak często przeliczamy wiek raportów, żeby „brak danych" pojawiał się płynnie. */
const AGE_TICK_MS = 1_000

/**
 * Dwa timery, bo mają różne zadania: wysyłka raportów jest odczytem z
 * `getStats()` i wystarcza co 5 s, a starzenie trzeba przeliczać częściej,
 * żeby przejście w „brak danych" nie następowało skokiem co pięć sekund.
 */
export function useViewerQuality(lobby: Lobby): Map<string, ViewerQuality> {
  const [quality, setQuality] = useState<Map<string, ViewerQuality>>(new Map())
  const { state, reportQualityToStreamers } = lobby

  useEffect(() => {
    function report(): void {
      // Sesja moze zostac zniszczona pod trwajacym odczytem (rekonekt po
      // zmianie klucza API) — `getStats()` na zamknietym polaczeniu rzuca.
      void reportQualityToStreamers().catch((err: unknown) =>
        console.debug('[jakosc] nieudana wysylka raportu:', err)
      )
    }

    report()
    const id = setInterval(report, QUALITY_REPORT_INTERVAL_MS)
    return () => clearInterval(id)
  }, [reportQualityToStreamers])

  useEffect(() => {
    function recompute(): void {
      const now = Date.now()
      const next = new Map<string, ViewerQuality>()
      for (const peerId of state.viewerPeerIds) {
        const entry = state.viewerQuality.get(peerId)
        next.set(
          peerId,
          qualityFromReport(entry?.report ?? null, entry ? now - entry.receivedAt : 0)
        )
      }
      setQuality(next)
    }

    recompute()
    const id = setInterval(recompute, AGE_TICK_MS)
    return () => clearInterval(id)
  }, [state.viewerPeerIds, state.viewerQuality])

  return quality
}
```

- [ ] **Step 2: Dodaj kropkę w panelu uczestników**

W `companion-app/src/renderer/components/PeerPanel.tsx` dopisz import:

```tsx
import type { ViewerQuality } from '@shared/viewerQuality'
```

Do `interface PeerPanelProps`:

```tsx
  /**
   * Jak dochodzi nasz obraz do osób, które nas oglądają. Klucz to peerId;
   * osoby spoza tej mapy nie oglądają nas i nie dostają wskaźnika.
   */
  viewerQuality: Map<string, ViewerQuality>
```

Dodaj `viewerQuality` do listy parametrów funkcji `PeerPanel`.

Nad komponentem dopisz pomocniczy opis:

```tsx
const OPIS_JAKOSCI: Record<ViewerQuality, string> = {
  ok: 'Obraz dochodzi bez zacięć',
  poor: 'Obraz się u tej osoby zacina',
  unknown: 'Jeszcze nie wiadomo, jak dochodzi obraz'
}
```

W ciele `.map((peer) => { … })`, obok istniejących `const kinds = …`, wylicz stan raz:

```tsx
          const jakosc = viewerQuality.get(peer.peerId)
```

Potem w `<li>`, zaraz po `<span className="peers__name">…</span>`, wstaw:

```tsx
              {jakosc && (
                <span
                  className={`peers__quality peers__quality--${jakosc}`}
                  title={OPIS_JAKOSCI[jakosc]}
                  aria-label={OPIS_JAKOSCI[jakosc]}
                />
              )}
```

Jedno pobranie z mapy zamiast trzech i bez rzutowania typu — `jakosc` jest już
zawężone do `ViewerQuality` przez sprawdzenie prawdziwości.

- [ ] **Step 3: Dodaj style kropki**

W `companion-app/src/renderer/styles.css`, po regule `.peers__you`:

```css
/* Kropka jakości odbioru. Tylko przy osobach, które nas oglądają — brak kropki
   znaczy "nie ogląda", a nie "brak danych"; od tego drugiego jest kolor. */
.peers__quality {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-left: auto;
}

.peers__quality--ok {
  background: #57a773;
}

.peers__quality--poor {
  background: #f0c674;
}

/* Pusty środek: "nie wiemy" ma wyglądać inaczej niż każda odpowiedź. */
.peers__quality--unknown {
  border: 1px solid var(--border);
}
```

- [ ] **Step 4: Osadź w LobbyView**

W `companion-app/src/renderer/components/LobbyView.tsx` dopisz import:

```tsx
import { useViewerQuality } from '../hooks/useViewerQuality'
```

W ciele komponentu, po `const connectionProblem = useConnectionHealth(lobby)`:

```tsx
  const viewerQuality = useViewerQuality(lobby)
```

Do `<PeerPanel …>` dopisz props:

```tsx
          viewerQuality={viewerQuality}
```

- [ ] **Step 5: Sprawdź budowę i testy**

```bash
cd companion-app && npm run build && npm test
```

Oczekiwane: brak błędów, testy PASS.

- [ ] **Step 6: Commit**

```bash
git add companion-app/src/renderer/hooks/useViewerQuality.ts companion-app/src/renderer/components/PeerPanel.tsx companion-app/src/renderer/styles.css companion-app/src/renderer/components/LobbyView.tsx
git commit -m "feat(jakosc): kropka jakosci odbioru przy nazwisku widza"
```

---

### Task 6: Pasek odzywa się, gdy zacina się wszystkim

**Files:**
- Modify: `companion-app/src/shared/connectionHealth.ts`
- Modify: `companion-app/test/connection-health.test.ts`
- Modify: `companion-app/src/renderer/hooks/useConnectionHealth.ts`
- Modify: `companion-app/src/renderer/components/LobbyView.tsx`

**Interfaces:**
- Consumes: `allViewersStruggling` z Zadania 1, `useViewerQuality` z Zadania 5.
- Produces: `ConnectionProblem` zyskuje wariant `{ kind: 'viewers-struggling' }`; `useConnectionHealth(lobby, viewersStruggling: boolean)`

- [ ] **Step 1: Napisz testy priorytetu**

Dopisz na końcu `companion-app/test/connection-health.test.ts`:

```ts
test('zacinanie u wszystkich widzów trafia na pasek', () => {
  const problem = pickProblem({ ...NIC, viewersStruggling: true })
  expect(problem).toEqual({ kind: 'viewers-struggling' })
  expect(problemText(problem!)).toMatch(/rozdzielczo|FPS/i)
})

test('zatkane łącze wygrywa z zacinaniem u widzów', () => {
  // Obie sytuacje mają tę samą radę, ale zatkane łącze nazywa przyczynę
  // dokładniej — po co mówić o skutku, gdy znamy powód.
  const problem = pickProblem({ ...NIC, uplinkSlow: true, viewersStruggling: true })
  expect(problem?.kind).toBe('slow-uplink')
})

test('nieosiągalny peer wygrywa z zacinaniem u widzów', () => {
  const problem = pickProblem({
    ...NIC,
    unreachableNames: ['Michał'],
    viewersStruggling: true
  })
  expect(problem?.kind).toBe('peer-unreachable')
})
```

Uzupełnij też stałą `NIC` na górze pliku o nowe pole:

```ts
const NIC = {
  connectingForMs: null,
  unreachableNames: [],
  uplinkSlow: false,
  viewersStruggling: false
}
```

- [ ] **Step 2: Uruchom i potwierdź, że nie przechodzą**

```bash
cd companion-app && npx vitest run test/connection-health.test.ts
```

Oczekiwane: FAIL — `pickProblem` nie zna pola `viewersStruggling`, a `ConnectionProblem` nie ma tego wariantu.

- [ ] **Step 3: Rozszerz czysty moduł**

W `companion-app/src/shared/connectionHealth.ts` do typu `ConnectionProblem` dopisz wariant:

```ts
  | { kind: 'viewers-struggling' }
```

W `pickProblem` rozszerz sygnaturę wejścia o `viewersStruggling: boolean` i dopisz gałąź **po** `uplinkSlow`:

```ts
  if (input.uplinkSlow) return { kind: 'slow-uplink' }
  // Niżej niż zatkane łącze: obie sytuacje mają tę samą radę, ale tamta
  // nazywa przyczynę dokładniej.
  if (input.viewersStruggling) return { kind: 'viewers-struggling' }
  return null
```

W `problemText` dopisz gałąź:

```ts
    case 'viewers-struggling':
      return 'Obraz zacina się u wszystkich widzów — zmniejsz rozdzielczość albo FPS.'
```

- [ ] **Step 4: Podaj nowe wejście z hooka**

W `companion-app/src/renderer/hooks/useConnectionHealth.ts` zmień sygnaturę:

```ts
export function useConnectionHealth(
  lobby: Lobby,
  viewersStruggling: boolean
): ConnectionProblem | null {
```

W wywołaniu `pickProblem` dopisz pole `viewersStruggling`, a do tablicy zależności efektu przeliczającego problem dopisz `viewersStruggling`.

- [ ] **Step 5: Policz to w LobbyView**

W `companion-app/src/renderer/components/LobbyView.tsx` dopisz import:

```tsx
import { allViewersStruggling } from '@shared/viewerQuality'
```

Zamień kolejność wywołań tak, żeby jakość była policzona przed diagnostyką:

```tsx
  const viewerQuality = useViewerQuality(lobby)
  const connectionProblem = useConnectionHealth(
    lobby,
    allViewersStruggling([...viewerQuality.values()])
  )
```

- [ ] **Step 6: Sprawdź testy i budowę**

```bash
cd companion-app && npm test && npm run build
```

Oczekiwane: PASS oraz budowa bez błędów.

- [ ] **Step 7: Commit**

```bash
git add companion-app/src/shared/connectionHealth.ts companion-app/test/connection-health.test.ts companion-app/src/renderer/hooks/useConnectionHealth.ts companion-app/src/renderer/components/LobbyView.tsx
git commit -m "feat(jakosc): pasek mowi, gdy obraz zacina sie u wszystkich"
```

---

### Task 7: Pomiar — czy raport realnie dolatuje

Bez tego kroku próg 5% jest zgadnięty, a cały mechanizm — niesprawdzony poza testami czystej logiki. Spec obiecuje ten pomiar wprost.

**Files:**
- Create: `companion-app/e2e/jakosc-odbioru.mjs`
- Modify: `companion-app/package.json` (skrypt `e2e:jakosc`)

**Interfaces:**
- Consumes: zbudowana aplikacja (`npm run build`) i działający serwer sygnalizacyjny.
- Produces: `npm run e2e:jakosc`.

- [ ] **Step 1: Przeczytaj istniejący harness**

Przeczytaj `companion-app/e2e/obciazenie.mjs` **w całości**, zanim cokolwiek napiszesz. Odtwarza dokładnie ten układ, którego potrzebujesz: dwie instancje aplikacji (A nadaje, B ogląda) w jednym kanale, podpięcie przez CDP, hak na `RTCPeerConnection`, odczyt `getStats()`. Skopiuj z niego sposób uruchamiania i podpinania — nie wymyślaj własnego.

Zwróć uwagę na komentarz o dławieniu renderera w zasłoniętym oknie: bez flag `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` i `--disable-background-timer-throttling` pomiar mierzy dławienie, nie rzeczywistość.

- [ ] **Step 2: Napisz skrypt pomiarowy**

Utwórz `companion-app/e2e/jakosc-odbioru.mjs`:

```js
// Czy raport o zamrozeniach realnie dolatuje od widza do nadawcy?
//
// Mierzymy z dwoch stron naraz, bo kazda odpowiada na inne pytanie:
//   - u WIDZA (B): surowe totalFreezesDuration z inbound-rtp — czy liczby sa
//     w ogole sensowne i po ktorej stronie progu 5% wypadaja;
//   - u NADAWCY (A): kropki w panelu uczestnikow — czy caly lancuch dziala,
//     od odczytu przez sygnalizacje po wyrenderowanie.
//
// Czytamy DOM zamiast stanu Reacta celowo: kropka w interfejsie jest tym, co
// widzi uzytkownik, a stan mozna miec poprawny i zapomniec go pokazac.
//
// Wymaga dzialajacego serwera sygnalizacyjnego:
//   cd signaling-server && npm start
//
// Uruchomienie: npm run build && npm run e2e:jakosc
import { attach, launchApp } from './cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Widz wysyla co 5 s, a pierwsza probka z zalozenia nie daje raportu, wiec
// dwadziescia pare sekund to okolo czterech raportow.
const CZEKAJ_MS = Number(process.env.CZEKAJ_MS ?? 25_000)
const CHANNEL = process.env.KANAL ?? `jakosc-e2e-${Date.now()}`
const PORT_A = 9371
const PORT_B = 9372

function instanceArgs() {
  return [
    '--ts3-server=ts.test.pl:9987',
    `--channel=${CHANNEL}`,
    '--signaling=ws://127.0.0.1:8080',
    '--use-fake-device-for-media-stream',
    // Bez tych flag Chromium dlawi renderer zaslonietego okna i mierzymy
    // dlawienie zamiast rzeczywistosci — patrz uwaga w obciazenie.mjs.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling'
  ]
}

/** Hak na RTCPeerConnection — u WIDZA, bo to jego getStats() nas interesuje. */
const PC_HOOK = `
  (() => {
    const Original = window.RTCPeerConnection
    window.__pcs = []
    window.RTCPeerConnection = function (...args) {
      const pc = new Original(...args)
      window.__pcs.push(pc)
      return pc
    }
    window.RTCPeerConnection.prototype = Original.prototype
  })()
`

const procesy = []
function uruchom(port) {
  const proc = launchApp(port, instanceArgs())
  procesy.push(proc)
  return proc
}

let kodWyjscia = 0

try {
  uruchom(PORT_A)
  uruchom(PORT_B)

  const a = await attach(PORT_A)
  const b = await attach(PORT_B)

  await b.call('Page.enable')
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: PC_HOOK })
  await b.call('Page.reload')
  await sleep(3_000)

  console.log('Obie instancje w kanale. A zaczyna udostepniac ekran...')
  await a.evaluate(
    `[...document.querySelectorAll('button')].find(b=>/Udostępnij ekran/.test(b.textContent)).click()`
  )
  await sleep(1_000)
  await a.evaluate(
    `[...document.querySelectorAll('.source-card')].find(c=>/Ekran/.test(c.textContent)).click()`
  )
  await sleep(1_000)
  await a.evaluate(`
    const b = [...document.querySelectorAll('button')].find(x => /Udostępnij$|Potwierdź|Zacznij/.test(x.textContent))
    if (b) b.click()
    'ok'
  `)

  console.log(`Czekam ${CZEKAJ_MS / 1000} s na raporty (widz wysyla co 5 s)...`)
  await sleep(CZEKAJ_MS)

  // --- strona widza: surowe liczby ---
  const surowe = await b.evaluate(`(async () => {
    const wyniki = []
    for (const pc of window.__pcs ?? []) {
      const stats = await pc.getStats()
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          wyniki.push({
            totalFreezesDuration: s.totalFreezesDuration ?? null,
            freezeCount: s.freezeCount ?? null,
            framesDecoded: s.framesDecoded ?? null
          })
        }
      })
    }
    return wyniki
  })()`)

  // --- strona nadawcy: co widac w interfejsie ---
  const kropki = await a.evaluate(`
    [...document.querySelectorAll('.peers__quality')].map((el) => ({
      klasa: el.className,
      opis: el.getAttribute('title')
    }))
  `)

  console.log('\\n=== U WIDZA (surowe inbound-rtp) ===')
  if (surowe.length === 0) {
    console.log('  brak strumieni przychodzacych — widz niczego nie odbiera')
  }
  for (const s of surowe) {
    const zamrozoneMs = (s.totalFreezesDuration ?? 0) * 1000
    const udzial = zamrozoneMs / CZEKAJ_MS
    console.log(
      `  zamrozone lacznie ${zamrozoneMs.toFixed(0)} ms z ${CZEKAJ_MS} ms ` +
        `(${(udzial * 100).toFixed(2)}%) | zaciec: ${s.freezeCount} | klatek: ${s.framesDecoded}`
    )
    console.log(`  -> prog 5%: ${udzial > 0.05 ? 'PRZEKROCZONY (slabo)' : 'niePrzekroczony (dobrze)'}`)
  }

  console.log('\\n=== U NADAWCY (kropki w panelu) ===')
  if (kropki.length === 0) {
    console.error('  BRAK KROPEK — lancuch nie dziala albo nikt nie oglada')
    kodWyjscia = 1
  }
  for (const k of kropki) {
    console.log(`  ${k.klasa}  "${k.opis}"`)
  }

  const samoNieWiadomo =
    kropki.length > 0 && kropki.every((k) => k.klasa.includes('--unknown'))
  if (samoNieWiadomo) {
    console.error(
      '\\nBLAD: po ' + CZEKAJ_MS / 1000 + ' s wszystkie kropki nadal pokazuja "brak danych".'
    )
    console.error('Raporty nie dolatuja — wroc do diagnozy zamiast dopisywac kod.')
    kodWyjscia = 1
  }

  if (kodWyjscia === 0) {
    console.log('\\nOK: raporty dolatuja, kropki maja stan inny niz "brak danych".')
  }
} catch (err) {
  console.error('\\nBLAD pomiaru:', err instanceof Error ? err.message : String(err))
  kodWyjscia = 1
} finally {
  for (const proc of procesy) proc.kill()
}

process.exit(kodWyjscia)
```

Skrypt **mierzy i raportuje**, nie orzeka o progu. Wypisuje, po której stronie 5% wypadł pomiar; ocena, czy ta wartość odpowiada temu, co widać okiem, należy do właściciela projektu.

- [ ] **Step 3: Dodaj skrypt npm**

W `companion-app/package.json`, w `scripts`, po `"e2e:obciazenie"`:

```json
    "e2e:jakosc": "node e2e/jakosc-odbioru.mjs",
```

- [ ] **Step 4: Uruchom pomiar**

```bash
cd companion-app && npm run build && npm run e2e:jakosc
```

Oczekiwane: raporty dolatują, `windowMs` jest bliskie 5000, `frozenMs` przy zdrowym łączu lokalnym bliskie zeru.

**Jeśli żaden raport nie dolatuje** — zatrzymaj się i zgłoś to. To znaczy, że któreś ogniwo nie działa, i trzeba wrócić do diagnozy zamiast dopisywać kod.

- [ ] **Step 5: Commit**

```bash
git add companion-app/e2e/jakosc-odbioru.mjs companion-app/package.json
git commit -m "test(jakosc): pomiar dolotu raportow o zamrozeniach"
```

---

### Task 8: Wersja 0.3.1 i dokumentacja

**Files:**
- Modify: `companion-app/package.json` (pole `version`)
- Modify: `companion-app/package-lock.json` (dwie linie z wersją)
- Modify: `TODO.md`

- [ ] **Step 1: Podbij wersję**

W `companion-app/package.json` zmień `"version": "0.3.0"` na `"version": "0.3.1"`.

**Podbij też `package-lock.json`** — obie linie z `"version": "0.3.0"` (pole `.version` i `packages[""].version`). Ręcznie, nie przez `npm install`. Pominięcie tego sprawia, że `npm run release` zsynchronizuje lock w trakcie budowania wydania i zabrudzi drzewo robocze.

- [ ] **Step 2: Opisz temat w TODO.md**

W `TODO.md` dopisz nową sekcję za sekcją o zadaniach 3.2–3.4:

```markdown
### Widać, jak im idzie — jakość odbioru u widzów (0.3.1, 2026-08-10)

Przy każdej osobie, która nas ogląda, stoi kropka: obraz dochodzi bez zacięć,
zacina się, albo jeszcze nie wiadomo. Spec:
`docs/superpowers/specs/2026-08-10-jakosc-odbioru-u-widzow-design.md`.

**Rozstrzygnięcie, od którego wszystko zależy: mierzymy OBRAZ, nie łącze.**
Własne FPS i bitrate mówią „czy koduję", strata pakietów mówi o łączu — a obraz
potrafi zacinać się od słabego procesora widza przy zerowej stracie pakietów,
albo nie zacinać się mimo strat, bo WebRTC nadrobił je retransmisją. Jedyne
miejsce, w którym istnieje odpowiedź na pytanie „czy się zacina", to odbiornik.
Dlatego widz sam raportuje `totalFreezesDuration` ze swojego `inbound-rtp`.

**Zgodność wstecz wyszła za darmo.** Wiadomość `signal` niesie nieprzezroczysty
payload, więc raport jedzie tą samą drogą co SDP i kandydaci ICE — zero zmian
w serwerze i w protokole. Payload celowo **nie zawiera pola `stream`**:
starsze klienty routują nieznany rodzaj payloadu przez
`connectionKey(from, payload.stream)`, więc bez tego pola klucz nigdy nie pasuje
i wiadomość jest po cichu ignorowana. Z tym polem stary klient próbowałby dodać
`undefined` jako kandydata ICE.

**Pasek odzywa się przy jednym warunku:** wszyscy widzowie mają „słabo" i jest
ich co najmniej dwóch. Przy jednym widzu nie da się odróżnić „moje łącze" od
„jego komputer", więc informacja zostaje przy nazwisku.

**Czego nie zrobiono:**

- **`framesDropped` i `jitter`** — jedna miara wystarczy; dwie wymagają dwóch
  progów i dwóch uzasadnień.
- **Historii jakości w czasie** — wskaźnik odpowiada na pytanie „jak jest teraz".
- **Automatycznego obniżania jakości** przy zacinaniu. Najpierw informacja,
  potem ewentualnie decyzja za użytkownika.
- **Sprawdzenia przy realnie słabym łączu.** Pomiar (`npm run e2e:jakosc`)
  potwierdza, że raporty dolatują i niosą sensowne liczby na łączu lokalnym.
  Czy próg 5% odpowiada temu, co widać okiem przy prawdziwym zatkaniu — do
  potwierdzenia przy pierwszej sesji we trzech.
```

- [ ] **Step 3: Sprawdź całość**

```bash
cd companion-app && npm test && npm run build
```

Oczekiwane: testy PASS, budowa bez błędów.

- [ ] **Step 4: Commit**

```bash
git add companion-app/package.json companion-app/package-lock.json TODO.md
git commit -m "docs: wersja 0.3.1 i domkniecie tematu jakosci odbioru"
```

---

## Po planie — co zostaje do zrobienia ręcznie

1. **Wydanie 0.3.1** (`npm run release` + ręczna publikacja szkicu).
2. **Obejrzenie kropek na żywo** — czy „brak danych" znika po pierwszych 5 s, czy przy zdrowym łączu wszyscy są zieloni.
3. **Sprawdzenie progu przy realnym obciążeniu** — np. przy 1440p60 do trzech osób, czyli tam, gdzie łącze domowe faktycznie się dusi.
