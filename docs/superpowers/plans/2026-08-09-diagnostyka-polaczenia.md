# Uczciwa informacja o kłopotach z połączeniem — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jeden pasek pod nagłówkiem mówi wprost, co jest nie tak z połączeniem — zatkane łącze, budzący się serwer albo osoba, z którą połączenie nie wstało — i gaśnie sam, gdy przyczyna ustaje.

**Architecture:** Cała logika decyzyjna (priorytet, teksty, rozbieg i debounce) siedzi w czystym module `src/shared/connectionHealth.ts` bez zależności, testowalnym w vitest. Timery i odpytywanie `getStats()` są w hooku renderera. `LobbySession` dostaje zbiór nieosiągalnych peerów zamiast jednorazowego `onError` oraz metodę czytającą ograniczenie łącza na żądanie.

**Tech Stack:** Electron 33, React 18, TypeScript, vitest, WebRTC `getStats()`.

**Spec:** `docs/superpowers/specs/2026-08-09-diagnostyka-polaczenia-design.md`

## Global Constraints

- **Identyfikatory w kodzie po angielsku; komentarze i komunikaty dla użytkownika po polsku.** Pliki `.ts`/`.tsx` używają polskich znaków diakrytycznych.
- **Testy w `companion-app/test/*.test.ts` NIE mogą importować `electron`.** Vitest chodzi w gołym Node bez konfiguracji; importy są względne (`../src/...`) — wzorzec: `test/cli.test.ts`.
- **`src/shared/connectionHealth.ts` ma mieć zero zależności** — to granica architektoniczna: w rendererze zostają wyłącznie timery i odpytywanie.
- **Brak jsdom** — nie da się renderować komponentów Reacta w testach. Komponenty i hooki weryfikuje `npm run build` (obejmuje `tsc --noEmit`).
- Zero zmian w: `signaling-server/`, `plugin/src/plugin.c`, `build/installer.nsh`, protokole sygnalizacji, `src/main/`, `src/preload/`.
- `tsconfig.json` ma `noUnusedLocals` i `noUnusedParameters` — niewykorzystany import to błąd kompilacji.
- Komunikaty commitów po polsku, konwencja `typ: opis`.
- Platforma docelowa: wyłącznie Windows.
- Wszystkie polecenia z katalogu `companion-app/`.

## Odstępstwo od specu — przeczytaj przed Zadaniem 1

Spec podaje rozbieg **30 s**. Plan ustawia **45 s**, i to jest świadoma zmiana.

Powód: pomiar z `TODO.md § 1` mówi, że przy kamerze 1080p60 `qualityLimitationReason` wróciło do `none` dopiero **koło 41 s**. Przy rozbiegu 30 s i debouncie 10 s najwcześniejszy możliwy komunikat wypada w 40 s — czyli tuż przed końcem tego, co pomiar pokazał jako normalne dochodzenie do równowagi. Pasek mignąłby na sekundę przy każdym starcie kamery 1080p60.

45 s rozbiegu + 10 s debounce'u daje najwcześniejszy komunikat w 55 s, z zapasem ponad zmierzone 41 s. Reakcja na zatkanie w środku sesji jest niezmieniona — tam liczy się wyłącznie debounce.

## File Structure

| Plik | Odpowiedzialność | Zadanie |
|---|---|---|
| `src/shared/connectionHealth.ts` | **Nowy.** Typ problemu, wybór po priorytecie, teksty, maszyna rozbiegu i debounce'u. Zero zależności. | 1 |
| `test/connection-health.test.ts` | **Nowy.** Testy powyższego. | 1 |
| `src/renderer/signaling/SignalingClient.ts` | Modyfikacja: limit czasu w `connect`. | 2 |
| `test/signaling-client.test.ts` | Modyfikacja: przypadek limitu czasu. | 2 |
| `src/renderer/webrtc/session.ts` | Modyfikacja: zbiór nieosiągalnych peerów, `uplinkLimited()`. | 3 |
| `src/renderer/hooks/useLobby.ts` | Modyfikacja: `unreachablePeerIds`, `connectingSince`, `uplinkLimited`. | 4 |
| `src/renderer/hooks/useConnectionHealth.ts` | **Nowy.** Dwa timery: 3 s na próbkowanie łącza, 1 s na licznik. | 5 |
| `src/renderer/components/ConnectionNotice.tsx` | **Nowy.** Pasek. | 5 |
| `src/renderer/styles.css` | Modyfikacja: `.app__connection`. | 5 |
| `src/renderer/components/LobbyView.tsx` | Modyfikacja: osadzenie paska. | 5 |
| `companion-app/package.json`, `README.md`, `TODO.md` | Modyfikacja: wersja 0.3.0 i domknięcie § 3.2–3.4. | 6 |

---

### Task 1: Czysta logika wyboru problemu

**Files:**
- Create: `companion-app/src/shared/connectionHealth.ts`
- Test: `companion-app/test/connection-health.test.ts`

**Interfaces:**
- Consumes: nic.
- Produces:
  - `type ConnectionProblem = { kind: 'server-waking'; secondsWaiting: number } | { kind: 'peer-unreachable'; names: string[] } | { kind: 'slow-uplink' }`
  - `const SERVER_WAKING_AFTER_MS: number`, `UPLINK_WARMUP_MS`, `UPLINK_DEBOUNCE_MS`
  - `function pickProblem(input: { connectingForMs: number | null; unreachableNames: string[]; uplinkSlow: boolean }): ConnectionProblem | null`
  - `function problemText(problem: ConnectionProblem): string`
  - `interface UplinkWatch { sharingSince: number | null; limitedSince: number | null }`
  - `const NO_UPLINK_WATCH: UplinkWatch`
  - `function advanceUplinkWatch(watch: UplinkWatch, sample: { sharing: boolean; limited: boolean; now: number }): UplinkWatch`
  - `function isUplinkSlow(watch: UplinkWatch, now: number): boolean`

- [ ] **Step 1: Napisz test, który ma nie przejść**

Utwórz `companion-app/test/connection-health.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  NO_UPLINK_WATCH,
  UPLINK_DEBOUNCE_MS,
  UPLINK_WARMUP_MS,
  advanceUplinkWatch,
  isUplinkSlow,
  pickProblem,
  problemText
} from '../src/shared/connectionHealth'

const NIC = { connectingForMs: null, unreachableNames: [], uplinkSlow: false }

test('brak problemów daje null', () => {
  expect(pickProblem(NIC)).toBeNull()
})

test('krótkie łączenie jeszcze nie jest problemem', () => {
  // Zwykłe połączenie wstaje w ułamku sekundy — dopiero czekanie dłuższe niż
  // kilka sekund znaczy, że serwer się budzi.
  expect(pickProblem({ ...NIC, connectingForMs: 1_000 })).toBeNull()
})

test('długie łączenie zgłasza budzenie serwera z licznikiem', () => {
  const problem = pickProblem({ ...NIC, connectingForMs: 23_400 })
  expect(problem).toEqual({ kind: 'server-waking', secondsWaiting: 23 })
  expect(problemText(problem!)).toContain('0:23')
})

test('budzenie serwera wygrywa z pozostałymi problemami', () => {
  // Priorytet odzwierciedla zagnieżdżenie: bez serwera informacja o łączu
  // jest bez znaczenia.
  const problem = pickProblem({
    connectingForMs: 10_000,
    unreachableNames: ['Michał'],
    uplinkSlow: true
  })
  expect(problem?.kind).toBe('server-waking')
})

test('nieosiągalny peer wygrywa z zatkanym łączem', () => {
  const problem = pickProblem({
    connectingForMs: null,
    unreachableNames: ['Michał'],
    uplinkSlow: true
  })
  expect(problem?.kind).toBe('peer-unreachable')
})

test('jedna osoba jest wymieniona z nazwy', () => {
  expect(problemText({ kind: 'peer-unreachable', names: ['Michał'] })).toContain('Michał')
})

test('kilka osób zwija się w liczbę zamiast listy nazwisk', () => {
  const text = problemText({ kind: 'peer-unreachable', names: ['Michał', 'Ala', 'Bartek'] })
  expect(text).toContain('3 osobami')
  expect(text).not.toContain('Michał')
})

test('zatkane łącze ma radę, co zrobić', () => {
  const text = problemText({ kind: 'slow-uplink' })
  expect(text).toMatch(/rozdzielczo|FPS/i)
})

test('ograniczenie w czasie rozbiegu NIE jest zgłaszane', () => {
  // To jest ten fałszywy alarm z pomiaru w TODO § 1: przy kamerze 1080p60
  // qualityLimitationReason było 'bandwidth' przez pierwsze ~40 s, bez
  // żadnego związku z łączem.
  let watch = NO_UPLINK_WATCH
  for (let t = 0; t < UPLINK_WARMUP_MS; t += 3_000) {
    watch = advanceUplinkWatch(watch, { sharing: true, limited: true, now: t })
    expect(isUplinkSlow(watch, t)).toBe(false)
  }
})

test('po rozbiegu sam debounce jeszcze nie wystarcza', () => {
  let watch = NO_UPLINK_WATCH
  watch = advanceUplinkWatch(watch, { sharing: true, limited: false, now: 0 })
  const po = UPLINK_WARMUP_MS + 1_000
  watch = advanceUplinkWatch(watch, { sharing: true, limited: true, now: po })
  expect(isUplinkSlow(watch, po + UPLINK_DEBOUNCE_MS - 1)).toBe(false)
  expect(isUplinkSlow(watch, po + UPLINK_DEBOUNCE_MS)).toBe(true)
})

test('ustanie ograniczenia zeruje licznik', () => {
  let watch = NO_UPLINK_WATCH
  watch = advanceUplinkWatch(watch, { sharing: true, limited: false, now: 0 })
  const po = UPLINK_WARMUP_MS + 1_000
  watch = advanceUplinkWatch(watch, { sharing: true, limited: true, now: po })
  watch = advanceUplinkWatch(watch, { sharing: true, limited: false, now: po + 3_000 })
  expect(isUplinkSlow(watch, po + 60_000)).toBe(false)
})

test('zatrzymanie strumienia daje następnemu świeży rozbieg', () => {
  // Bez tego drugie udostępnianie w tej samej sesji dostałoby komunikat od razu.
  let watch = NO_UPLINK_WATCH
  watch = advanceUplinkWatch(watch, { sharing: true, limited: false, now: 0 })
  watch = advanceUplinkWatch(watch, { sharing: false, limited: false, now: 100_000 })
  expect(watch).toEqual(NO_UPLINK_WATCH)

  watch = advanceUplinkWatch(watch, { sharing: true, limited: true, now: 200_000 })
  expect(isUplinkSlow(watch, 200_000 + UPLINK_DEBOUNCE_MS + 1)).toBe(false)
})
```

- [ ] **Step 2: Uruchom test i potwierdź, że nie przechodzi**

```bash
cd companion-app && npx vitest run test/connection-health.test.ts
```

Oczekiwane: FAIL — `Failed to resolve import "../src/shared/connectionHealth"`.

- [ ] **Step 3: Napisz implementację**

Utwórz `companion-app/src/shared/connectionHealth.ts`:

```ts
/**
 * Co jest nie tak z połączeniem — wyliczane z bieżących warunków, nigdy
 * z zapamiętanych zdarzeń.
 *
 * Dlaczego stan, a nie zdarzenia: z jednorazowego „połączenie nie wstało" nie
 * da się dowiedzieć, że problem MINĄŁ. Pasek zbudowany na zdarzeniach wisiałby
 * po ustaniu przyczyny i wymagałby przycisku zamykania. Ten model gaśnie sam.
 */
export type ConnectionProblem =
  | { kind: 'server-waking'; secondsWaiting: number }
  | { kind: 'peer-unreachable'; names: string[] }
  | { kind: 'slow-uplink' }

/** Zwykłe połączenie wstaje od razu; dłuższe czekanie to budzący się Render. */
export const SERVER_WAKING_AFTER_MS = 5_000

/**
 * Ile pierwszych sekund strumienia ignorujemy przy ocenie łącza.
 *
 * Pomiar z TODO § 1: przy kamerze 1080p60 `qualityLimitationReason` było
 * `bandwidth` do ~41 s, po czym samo spadło do `none` — sterowanie przepływem
 * dochodziło do równowagi, łącze nie miało z tym nic wspólnego. 45 s daje zapas
 * ponad tę wartość.
 */
export const UPLINK_WARMUP_MS = 45_000

/** Jak długo ograniczenie musi się utrzymać PO rozbiegu, zanim coś powiemy. */
export const UPLINK_DEBOUNCE_MS = 10_000

/**
 * Jeden problem naraz, po priorytecie. Kolejność odzwierciedla zagnieżdżenie:
 * bez serwera informacja o łączu jest bez znaczenia.
 */
export function pickProblem(input: {
  connectingForMs: number | null
  unreachableNames: string[]
  uplinkSlow: boolean
}): ConnectionProblem | null {
  if (input.connectingForMs !== null && input.connectingForMs >= SERVER_WAKING_AFTER_MS) {
    return {
      kind: 'server-waking',
      secondsWaiting: Math.floor(input.connectingForMs / 1000)
    }
  }
  if (input.unreachableNames.length > 0) {
    return { kind: 'peer-unreachable', names: input.unreachableNames }
  }
  if (input.uplinkSlow) return { kind: 'slow-uplink' }
  return null
}

function formatWait(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export function problemText(problem: ConnectionProblem): string {
  switch (problem.kind) {
    case 'server-waking':
      return (
        'Serwer się budzi — pierwsze połączenie wieczorem trwa kilkadziesiąt ' +
        `sekund. Czekam… (${formatWait(problem.secondsWaiting)})`
      )
    case 'peer-unreachable':
      // Przy kilku osobach wymieniamy liczbę, nie listę: pasek ma jedną linijkę,
      // a lista nazwisk rozepchnęłaby go na pół okna.
      return problem.names.length === 1
        ? `Nie udało się połączyć z ${problem.names[0]} — obraz od tej osoby nie ` +
            'dojdzie. Zwykle winny jest restrykcyjny NAT albo firewall.'
        : `Nie udało się połączyć z ${problem.names.length} osobami — obraz od ` +
            'nich nie dojdzie. Zwykle winny jest restrykcyjny NAT albo firewall.'
    case 'slow-uplink':
      return 'Twoje łącze nie nadąża — zmniejsz rozdzielczość albo FPS w ustawieniach.'
  }
}

/** Stan obserwacji łącza. Trzyma go hook, przesuwa `advanceUplinkWatch`. */
export interface UplinkWatch {
  /** Kiedy zaczęliśmy nadawać; null = nie nadajemy. */
  sharingSince: number | null
  /** Od kiedy trwa ograniczenie liczone PO rozbiegu; null = nie trwa. */
  limitedSince: number | null
}

export const NO_UPLINK_WATCH: UplinkWatch = { sharingSince: null, limitedSince: null }

/**
 * Uwaga na kolejność: w czasie rozbiegu `limitedSince` w ogóle się NIE zaczyna
 * liczyć. Gdyby zaczynało, licznik debounce'u zdążyłby dobiec do końca razem
 * z rozbiegiem i komunikat wyskoczyłby dokładnie w momencie, w którym
 * ograniczenie samo znika.
 */
export function advanceUplinkWatch(
  watch: UplinkWatch,
  sample: { sharing: boolean; limited: boolean; now: number }
): UplinkWatch {
  if (!sample.sharing) return NO_UPLINK_WATCH

  const sharingSince = watch.sharingSince ?? sample.now
  const inWarmup = sample.now - sharingSince < UPLINK_WARMUP_MS
  if (inWarmup || !sample.limited) return { sharingSince, limitedSince: null }

  return { sharingSince, limitedSince: watch.limitedSince ?? sample.now }
}

export function isUplinkSlow(watch: UplinkWatch, now: number): boolean {
  if (watch.limitedSince === null) return false
  return now - watch.limitedSince >= UPLINK_DEBOUNCE_MS
}
```

- [ ] **Step 4: Uruchom testy i potwierdź, że przechodzą**

```bash
cd companion-app && npm test
```

Oczekiwane: PASS, w tym 12 nowych przypadków.

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/shared/connectionHealth.ts companion-app/test/connection-health.test.ts
git commit -m "feat(diagnostyka): czysta logika wyboru problemu z polaczeniem"
```

---

### Task 2: Limit czasu w SignalingClient

**Files:**
- Modify: `companion-app/src/renderer/signaling/SignalingClient.ts:72-84`
- Test: `companion-app/test/signaling-client.test.ts` (dopisanie przypadku)

**Interfaces:**
- Consumes: nic z Zadania 1.
- Produces: `static connect(url: string, timeoutMs?: number): Promise<SignalingClient>` — domyślnie `90_000`.

- [ ] **Step 1: Napisz test, który ma nie przejść**

Na końcu `companion-app/test/signaling-client.test.ts` dopisz import i przypadek.

Do istniejących importów na górze pliku dodaj:

```ts
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
```

Na końcu pliku:

```ts
test('connect przerywa po limicie czasu zamiast wisieć', async () => {
  // Goły serwer TCP: przyjmuje połączenie i milczy. WebSocket nigdy nie dostanie
  // odpowiedzi na uzgodnienie protokołu, więc bez limitu czasu `connect` wisiałby
  // w nieskończoność — dokładnie to robi uśpiony Render, dopóki się nie obudzi.
  const silent = createServer(() => {
    /* celowo nic: przyjmujemy połączenie i nie odpowiadamy */
  })
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
  const { port } = silent.address() as AddressInfo

  try {
    await expect(
      SignalingClient.connect(`ws://127.0.0.1:${port}`, 200)
    ).rejects.toThrow(/nie odpowiada/i)
  } finally {
    await new Promise<void>((resolve) => silent.close(() => resolve()))
  }
})
```

- [ ] **Step 2: Uruchom test i potwierdź, że nie przechodzi**

```bash
cd companion-app && npx vitest run test/signaling-client.test.ts -t "limicie czasu"
```

Oczekiwane: FAIL przez przekroczenie czasu testu — `connect` nie odrzuca obietnicy, bo dziś nie ma żadnego limitu. To jest właśnie defekt, który naprawiamy.

- [ ] **Step 3: Napisz implementację**

W `companion-app/src/renderer/signaling/SignalingClient.ts` zamień metodę `connect`:

```ts
  /**
   * `timeoutMs` jest parametrem, a nie stałą, wyłącznie po to, żeby test limitu
   * nie musiał trwać półtorej minuty. Wartość domyślna z zapasem pokrywa zimny
   * start uśpionego Rendera (~kilkadziesiąt sekund).
   */
  static connect(url: string, timeoutMs = 90_000): Promise<SignalingClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)

      // Bez tego uśpiony serwer, który przyjmuje połączenie TCP i milczy,
      // zostawia aplikację w „Łączenie z kanałem…" w nieskończoność —
      // zdarzenie 'error' nigdy nie przychodzi.
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error(`Serwer ${url} nie odpowiada — spróbuj ponownie za chwilę.`))
      }, timeoutMs)

      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve(new SignalingClient(socket))
        },
        { once: true }
      )
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error(`Nie udało się połączyć z ${url}`))
        },
        { once: true }
      )
    })
  }
```

- [ ] **Step 4: Uruchom testy i potwierdź, że przechodzą**

```bash
cd companion-app && npm test
```

Oczekiwane: PASS — nowy przypadek plus wszystkie dotychczasowe testy klienta sygnalizacji, które łączą się z prawdziwym serwerem.

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/renderer/signaling/SignalingClient.ts companion-app/test/signaling-client.test.ts
git commit -m "fix(sygnalizacja): limit czasu w connect zamiast wiecznego czekania"
```

---

### Task 3: Zbiór nieosiągalnych peerów i odczyt ograniczenia łącza

**Files:**
- Modify: `companion-app/src/renderer/webrtc/session.ts` — `LobbyCallbacks` (linia ~132), obsługa `failed` (linie ~386 i ~451), nowe pole i dwie metody

**Interfaces:**
- Consumes: nic z wcześniejszych zadań.
- Produces:
  - `LobbyCallbacks.onUnreachableChange: (peerIds: string[]) => void`
  - `LobbySession.uplinkLimited(): Promise<boolean>`

- [ ] **Step 1: Dodaj callback do interfejsu**

W `companion-app/src/renderer/webrtc/session.ts`, w `interface LobbyCallbacks`, obok `onError`:

```ts
  /**
   * Osoby, z którymi połączenie jest w stanie `failed`. ZBIÓR, nie zdarzenie:
   * z jednorazowego zgłoszenia nie dałoby się dowiedzieć, że problem minął,
   * więc komunikat wisiałby w interfejsie po ustaniu przyczyny.
   */
  onUnreachableChange: (peerIds: string[]) => void
```

- [ ] **Step 2: Dodaj pole i pomocniczą metodę**

Obok pozostałych pól prywatnych klasy `LobbySession` (przy `private readonly incoming`, linia ~163):

```ts
  /**
   * Połączenia w stanie `failed`: identyfikator połączenia -> peerId właściciela.
   *
   * Mapa per POŁĄCZENIE, nie zbiór per osoba, i to jest tu istotne: jedna osoba
   * ma nawet cztery połączenia naraz (wychodzące i przychodzące × ekran
   * i kamera). Przy zbiorze kluczowanym po peerId normalne zamknięcie jednego
   * z nich skasowałoby wpis o awarii drugiego i komunikat zgasłby mimo trwającego
   * problemu.
   */
  private readonly failedConnections = new Map<string, string>()
```

Obok pozostałych metod prywatnych:

```ts
  /**
   * `failed` dodaje, każdy inny stan usuwa. Dzięki temu odbudowane połączenie
   * gasi komunikat samo, bez żadnej dodatkowej ścieżki.
   *
   * `connectionId` musi być unikalny w obrębie osoby — stąd prefiks kierunku.
   */
  private markReachability(connectionId: string, peerId: string, failed: boolean): void {
    if (failed === this.failedConnections.has(connectionId)) return
    if (failed) this.failedConnections.set(connectionId, peerId)
    else this.failedConnections.delete(connectionId)
    this.callbacks.onUnreachableChange([...new Set(this.failedConnections.values())])
  }
```

- [ ] **Step 3: Podepnij to zamiast jednorazowego onError**

Zamień obsługę stanu w połączeniu **wychodzącym** (dziś `this.callbacks.onError(\`Połączenie z widzem ${peerId.slice(0, 8)} nie wstało\`)`, linia ~386-389):

```ts
    connection.addEventListener('connectionstatechange', () => {
      this.markReachability(
        `out:${connectionKey(peerId, kind)}`,
        peerId,
        connection.connectionState === 'failed'
      )
    })
```

Zamień obsługę w połączeniu **przychodzącym** (dziś `this.callbacks.onError('Nie udało się zestawić połączenia z nadającym')`, linia ~451-454):

```ts
    connection.addEventListener('connectionstatechange', () => {
      this.markReachability(
        `in:${connectionKey(streamerId, kind)}`,
        streamerId,
        connection.connectionState === 'failed'
      )
    })
```

- [ ] **Step 4: Sprzątaj przy odejściu osoby i przy zamykaniu lobby**

W obsłudze `peer-left` (linia ~208), zaraz po `this.peers.delete(peerId)`:

```ts
      // Problem osoby, której już nie ma, przestał istnieć razem z nią.
      for (const [id, owner] of this.failedConnections) {
        if (owner === peerId) this.markReachability(id, owner, false)
      }
```

W `dispose()` (linia ~514) wyczyść mapę, żeby zamknięcie lobby nie zostawiło komunikatu:

```ts
    this.failedConnections.clear()
```

**Czego celowo NIE trzeba dopisywać:** `closeIncoming` i `dropOutgoing` wołają `connection.close()`, po którym `connectionState` przechodzi w `'closed'` i nasłuch z kroku 3 sam czyści wpis. Dokładanie tam jawnego czyszczenia byłoby duplikacją, która potrafi się rozjechać z rzeczywistością.

- [ ] **Step 5: Dodaj odczyt ograniczenia łącza**

Metoda publiczna w `LobbySession`:

```ts
  /**
   * Czy KTÓRYKOLWIEK z naszych nadajników jest duszony przez pasmo.
   *
   * Ekran i kamera to osobne połączenia z osobnymi limitami, ale rada dla
   * użytkownika jest ta sama, więc nie rozróżniamy ich w wyniku.
   *
   * Własny typ zamiast `RTCOutboundRtpStreamStats`: pole
   * `qualityLimitationReason` bywa nieobecne w typach DOM zależnie od wersji
   * TypeScriptu, a to jedyne pole, którego tu potrzebujemy.
   */
  async uplinkLimited(): Promise<boolean> {
    type OutboundStat = { type: string; kind?: string; qualityLimitationReason?: string }

    for (const connection of this.outgoing.values()) {
      const report = await connection.getStats()
      for (const entry of report.values()) {
        const stat = entry as OutboundStat
        if (stat.type !== 'outbound-rtp' || stat.kind !== 'video') continue
        if (stat.qualityLimitationReason === 'bandwidth') return true
      }
    }
    return false
  }
```

- [ ] **Step 6: Sprawdź typy i budowę**

```bash
cd companion-app && npm run build
```

Oczekiwane: brak błędów. Jeśli `tsc` zgłosi, że `onUnreachableChange` brakuje w miejscu tworzenia `LobbySession` — to jest oczekiwane i naprawi to Zadanie 4; na czas tego zadania dodaj tymczasowo `onUnreachableChange: () => {}` w `useLobby.ts`, żeby budowa przeszła, i zaznacz to w raporcie.

- [ ] **Step 7: Sprawdź, że testy dalej przechodzą**

```bash
cd companion-app && npm test
```

Oczekiwane: PASS bez zmian w liczbie testów. `session.ts` nie ma testów jednostkowych — WebRTC nie istnieje w Node — więc weryfikacją jest budowa i przegląd kodu.

- [ ] **Step 8: Commit**

```bash
git add companion-app/src/renderer/webrtc/session.ts companion-app/src/renderer/hooks/useLobby.ts
git commit -m "feat(diagnostyka): zbior nieosiagalnych peerow i odczyt ograniczenia lacza"
```

---

### Task 4: Nowe pola stanu w useLobby

**Files:**
- Modify: `companion-app/src/renderer/hooks/useLobby.ts` — `LobbyState` (linie ~94-108), `INITIAL` (~110-119), efekt łączenia (~142-230), interfejs `Lobby` (~121-129)

**Interfaces:**
- Consumes: `onUnreachableChange`, `uplinkLimited()` z Zadania 3.
- Produces:
  - `LobbyState.unreachablePeerIds: string[]`
  - `LobbyState.connectingSince: number | null`
  - `Lobby.uplinkLimited: () => Promise<boolean>`

- [ ] **Step 1: Rozszerz typ stanu**

W `interface LobbyState`, po polu `error`:

```ts
  /** peerId osób, z którymi połączenie padło. Puste = wszystko w porządku. */
  unreachablePeerIds: string[]
  /**
   * Kiedy ruszyła bieżąca próba połączenia; null gdy nie łączymy.
   * Po tym liczy się, jak długo czekamy na budzący się serwer.
   */
  connectingSince: number | null
```

W `INITIAL` dopisz:

```ts
  unreachablePeerIds: [],
  connectingSince: null
```

`connectingSince` jest `null`, a nie `Date.now()`, celowo: `INITIAL` to stała modułu, policzona raz przy imporcie, więc data startu musi pochodzić z efektu, inaczej po ponownym połączeniu licznik byłby liczony od uruchomienia aplikacji.

- [ ] **Step 2: Rozszerz interfejs Lobby**

W `interface Lobby`, po `applyQuality`:

```ts
  /** Czy któryś z naszych nadajników jest duszony przez pasmo — odczyt na żądanie. */
  uplinkLimited: () => Promise<boolean>
```

- [ ] **Step 3: Ustaw znacznik startu i podepnij callback**

Na początku ciała efektu, zaraz po `if (!options.roomId) return`:

```ts
    setState((current) => ({
      ...current,
      connection: 'connecting',
      connectingSince: Date.now(),
      error: null
    }))
```

Do obiektu callbacków przekazywanego do `new LobbySession(...)`, obok `onError`:

```ts
          onUnreachableChange: (peerIds) =>
            setState((current) => ({ ...current, unreachablePeerIds: peerIds })),
```

W miejscu, gdzie po udanym `join` ustawiamy `connection: 'ready'`, dopisz `connectingSince: null`:

```ts
        setState((current) => ({
          ...current,
          connection: 'ready',
          connectingSince: null,
          error: null,
          me: { peerId: joined.peerId, displayName: joined.displayName }
        }))
```

W bloku `catch`, obok ustawienia `connection`, też zeruj znacznik:

```ts
        setState((current) => ({
          ...current,
          connection: /klucz/i.test(errorMessage) ? 'bad-key' : 'error',
          connectingSince: null,
          error: errorMessage
        }))
```

- [ ] **Step 4: Wystaw odczyt ograniczenia**

Obok pozostałych `useCallback` w tym hooku:

```ts
  const uplinkLimited = useCallback(async (): Promise<boolean> => {
    // Brak sesji = nie nadajemy, więc nie ma czego dusić.
    return sessionRef.current?.uplinkLimited() ?? false
  }, [])
```

i dodaj `uplinkLimited` do obiektu zwracanego przez hook.

- [ ] **Step 5: Sprawdź typy i budowę**

```bash
cd companion-app && npm run build
```

Oczekiwane: brak błędów. Jeśli w Zadaniu 3 dodano tymczasowe `onUnreachableChange: () => {}`, tutaj musi zniknąć na rzecz prawdziwej obsługi.

- [ ] **Step 6: Sprawdź testy**

```bash
cd companion-app && npm test
```

Oczekiwane: PASS.

- [ ] **Step 7: Commit**

```bash
git add companion-app/src/renderer/hooks/useLobby.ts
git commit -m "feat(diagnostyka): stan nieosiagalnych peerow i znacznik startu laczenia"
```

---

### Task 5: Hook, pasek i osadzenie w interfejsie

**Files:**
- Create: `companion-app/src/renderer/hooks/useConnectionHealth.ts`
- Create: `companion-app/src/renderer/components/ConnectionNotice.tsx`
- Modify: `companion-app/src/renderer/styles.css`
- Modify: `companion-app/src/renderer/components/LobbyView.tsx`

**Interfaces:**
- Consumes: wszystko z Zadań 1 i 4.
- Produces:
  - `function useConnectionHealth(lobby: Lobby): ConnectionProblem | null`
  - `function ConnectionNotice({ problem }: { problem: ConnectionProblem | null }): JSX.Element | null`

- [ ] **Step 1: Napisz hook**

Utwórz `companion-app/src/renderer/hooks/useConnectionHealth.ts`:

```ts
import { useEffect, useRef, useState } from 'react'
import {
  NO_UPLINK_WATCH,
  advanceUplinkWatch,
  isUplinkSlow,
  pickProblem,
  type ConnectionProblem,
  type UplinkWatch
} from '@shared/connectionHealth'
import type { Lobby } from './useLobby'

/** Jak często pytamy getStats. Rzadziej niż licznik — to droższy odczyt. */
const UPLINK_POLL_MS = 3_000
/** Jak często przeliczamy problem. Co sekundę, żeby licznik czekania szedł płynnie. */
const PROBLEM_TICK_MS = 1_000

/**
 * Dwa timery, bo mają różne zadania: próbkowanie łącza jest kosztowne i nie musi
 * być częste, a licznik „Czekam… (0:23)" musi tykać co sekundę. Jeden wspólny
 * interwał zmusiłby do wyboru: albo drogie odczyty co sekundę, albo licznik
 * skaczący co trzy.
 */
export function useConnectionHealth(lobby: Lobby): ConnectionProblem | null {
  const [problem, setProblem] = useState<ConnectionProblem | null>(null)
  const [uplinkSlow, setUplinkSlow] = useState(false)
  const watchRef = useRef<UplinkWatch>(NO_UPLINK_WATCH)

  const { state, uplinkLimited } = lobby
  const sharing = state.myStreamKinds.length > 0

  useEffect(() => {
    let cancelled = false

    async function sample(): Promise<void> {
      const limited = sharing ? await uplinkLimited() : false
      if (cancelled) return
      const now = Date.now()
      watchRef.current = advanceUplinkWatch(watchRef.current, { sharing, limited, now })
      setUplinkSlow(isUplinkSlow(watchRef.current, now))
    }

    void sample()
    const id = setInterval(() => void sample(), UPLINK_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [sharing, uplinkLimited])

  useEffect(() => {
    function recompute(): void {
      const now = Date.now()
      // Osoba, której nie ma już na liście uczestników, po prostu wypada —
      // jej problem przestał istnieć razem z nią.
      const names = state.unreachablePeerIds
        .map((id) => state.peers.find((peer) => peer.peerId === id)?.displayName)
        .filter((name): name is string => Boolean(name))

      setProblem(
        pickProblem({
          connectingForMs:
            state.connection === 'connecting' && state.connectingSince !== null
              ? now - state.connectingSince
              : null,
          unreachableNames: names,
          uplinkSlow
        })
      )
    }

    recompute()
    const id = setInterval(recompute, PROBLEM_TICK_MS)
    return () => clearInterval(id)
  }, [
    state.connection,
    state.connectingSince,
    state.unreachablePeerIds,
    state.peers,
    uplinkSlow
  ])

  return problem
}
```

- [ ] **Step 2: Napisz komponent**

Utwórz `companion-app/src/renderer/components/ConnectionNotice.tsx`:

```tsx
import { problemText, type ConnectionProblem } from '@shared/connectionHealth'

/**
 * Jeden pasek na wszystkie kłopoty z połączeniem. Gaśnie sam, gdy przyczyna
 * ustaje — dlatego nie ma tu przycisku zamykania.
 */
export function ConnectionNotice({
  problem
}: {
  problem: ConnectionProblem | null
}): JSX.Element | null {
  if (!problem) return null
  return (
    <div className="app__connection" role="status">
      {problemText(problem)}
    </div>
  )
}
```

- [ ] **Step 3: Dodaj styl**

W `companion-app/src/renderer/styles.css`, zaraz po regule `.app__update`:

```css
/* Pasek kłopotów z połączeniem: ostrzeżenie, nie błąd — coś nie działa dobrze,
   ale aplikacja pracuje dalej. Stąd bursztyn zamiast czerwieni z .notice--error. */
.app__connection {
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
  background: rgba(240, 178, 50, 0.12);
  color: #f0c674;
  font-size: 13px;
  flex-shrink: 0;
}
```

- [ ] **Step 4: Osadź w LobbyView**

W `companion-app/src/renderer/components/LobbyView.tsx` dopisz importy:

```tsx
import { useConnectionHealth } from '../hooks/useConnectionHealth'
import { ConnectionNotice } from './ConnectionNotice'
```

W ciele komponentu, po `const lobby = useLobby(options, apiKeyVersion)`:

```tsx
  const connectionProblem = useConnectionHealth(lobby)
```

Bezpośrednio pod `<UpdateNotice update={update} />`:

```tsx
      <ConnectionNotice problem={connectionProblem} />
```

- [ ] **Step 5: Sprawdź typy i budowę**

```bash
cd companion-app && npm run build
```

Oczekiwane: brak błędów.

- [ ] **Step 6: Sprawdź testy**

```bash
cd companion-app && npm test
```

Oczekiwane: PASS.

- [ ] **Step 7: Commit**

```bash
git add companion-app/src/renderer/hooks/useConnectionHealth.ts companion-app/src/renderer/components/ConnectionNotice.tsx companion-app/src/renderer/styles.css companion-app/src/renderer/components/LobbyView.tsx
git commit -m "feat(diagnostyka): pasek z jednym problemem polaczenia naraz"
```

---

### Task 6: Wersja 0.3.0 i domknięcie zadań w TODO

**Files:**
- Modify: `companion-app/package.json` (pole `version`)
- Modify: `TODO.md` — sekcje § 3.2, § 3.3, § 3.4

**Interfaces:**
- Consumes: wszystko powyżej.
- Produces: repo gotowe do wydania 0.3.0.

- [ ] **Step 1: Podbij wersję**

W `companion-app/package.json` zmień `"version": "0.2.0"` na `"version": "0.3.0"`.

**Podbij też `package-lock.json`** — obie linie z `"version": "0.2.0"` (pole `.version` i `packages[""].version`). Inaczej `npm run release` zsynchronizuje lock w trakcie budowania wydania i zabrudzi drzewo robocze.

- [ ] **Step 2: Zamknij trzy zadania w TODO.md**

Zastąp sekcje `### 3.2`, `### 3.3` i `### 3.4` jedną, opisującą wynik:

```markdown
### 3.2 / 3.3 / 3.4 Uczciwa informacja o kłopotach z połączeniem — ZROBIONE (2026-08-09)

Trzy zadania okazały się jednym problemem: **komunikaty o kłopotach z
połączeniem nie miały gdzie się pokazać**. Spec:
`docs/superpowers/specs/2026-08-09-diagnostyka-polaczenia-design.md`.

Jeden pasek pod nagłówkiem pokazuje najważniejszy aktywny problem i gaśnie sam,
gdy przyczyna ustaje. Priorytet: budzenie serwera → nieosiągalna osoba →
zatkane łącze.

**Co się okazało przy sprawdzaniu stanu zastanego:**

- **3.4 było już w połowie zrobione, ale niewidoczne.** `session.ts` wykrywał
  `connectionState === 'failed'` i wołał `onError`, ale `LobbyView` renderował
  `state.error` wyłącznie przy `connection === 'error'` — przy awarii
  pojedynczego połączenia komunikat powstawał i przepadał.
- **3.3 wypadło lepiej, niż zakładaliśmy.** Nagłówek pokazywał „Łączenie
  z kanałem…", więc to nie był niemy spinner. Ale `SignalingClient.connect` nie
  miał limitu czasu — przy serwerze, który nigdy nie odpowie, aplikacja czekała
  bez końca. Doszedł limit 90 s.
- **Rozbieg przed oceną łącza to 45 s, nie 30 s.** Pomiar z § 1 pokazał, że
  `qualityLimitationReason` wraca do `none` dopiero koło 41 s od startu
  strumienia. Przy 30 s rozbiegu i 10 s debounce'u pasek mignąłby przy każdym
  starcie kamery 1080p60.

**Czego nie zrobiono:**

- **`qualityLimitationReason: 'cpu'`** — inny problem i inna rada.
- **TURN.** Ta zmiana ma dopiero dostarczyć informacji, czy problem realnie
  u kogoś występuje. Do czasu zgłoszeń zostaje sam STUN.
- **Sprawdzenia na realnie zatkanym łączu.** Logika ma testy jednostkowe, ale
  nikt nie widział tego paska przy prawdziwie przeciążonym uploadzie — do
  potwierdzenia przy pierwszej sesji we trzech.
```

Usuń też pozycję **TURN** z sekcji „4. Drobne", bo powtarza się z powyższym.

- [ ] **Step 3: Sprawdź całość**

```bash
cd companion-app && npm test && npm run build
```

Oczekiwane: testy PASS, budowa bez błędów.

- [ ] **Step 4: Commit**

```bash
git add companion-app/package.json companion-app/package-lock.json TODO.md
git commit -m "docs: wersja 0.3.0 i domkniecie zadan 3.2-3.4"
```

---

## Po planie — co zostaje do zrobienia ręcznie

1. **Wydanie 0.3.0** (`npm run release` + ręczna publikacja szkicu). To jest **pierwszy prawdziwy sprawdzian autoaktualizacji** — przy najbliższym uruchomieniu aplikacji z 0.2.0 powinien pojawić się pasek „Pobrano wersję 0.3.0".
2. **Obejrzenie paska diagnostyki na żywo** — najłatwiej wywołać budzenie serwera: nie używać aplikacji przez 15 minut, potem wejść do kanału.
3. **Sprawdzenie, czy ktokolwiek jest nieosiągalny** — jeśli tak, to jest sygnał, że temat TURN wraca.
