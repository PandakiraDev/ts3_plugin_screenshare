# Panel diagnostyczny, wskaźniki zużycia i odcisk palca lobby — plan wdrożenia

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplikacja prowadzi zapis szeregu czasowego (klatki, bitrate, porzucone klatki, CPU, pamięć, GPU), panel pozwala go przewinąć w tył, a odcisk palca lobby pokazuje, z czego wyliczono identyfikator pokoju.

**Architecture:** Właścicielem zapisu jest proces główny — renderer co sekundę wysyła próbkę ze statystyk WebRTC, proces główny dokłada wiersz systemowy i scala to jednym zegarem. Rejestrator celowo nie mieszka w rendererze, bo renderer jest podejrzanym. Cała logika, którą da się sprawdzić, siedzi w bezimportowym `src/shared/diagnostics.ts`; procesy i zegary są cienką warstwą nad nią.

**Tech Stack:** TypeScript, Electron 33 (Chromium 130), React 18 (w `StrictMode`), vitest w gołym Node bez jsdom, `nvidia-smi` jako zewnętrzne źródło danych o GPU.

**Spec:** `docs/superpowers/specs/2026-10-13-panel-diagnostyczny-design.md`

## Global Constraints

- **Identyfikatory w kodzie po ANGIELSKU** — zmienne, funkcje, typy, pola, stałe, klasy CSS, także w testach i skryptach `.mjs`.
- **Komentarze, nazwy testów i teksty dla użytkownika po POLSKU, z pełnymi diakrytykami** (`ą ć ę ł ń ó ś ź ż`). Nie „polaczenie" tylko „połączenie".
- **Temat commita bez polskich znaków** — konwencja tego repozytorium; cała historia jest ASCII.
- **TDD**: najpierw test, potem uruchomienie go w stanie RED jako osobny, obowiązkowy krok, dopiero potem implementacja.
- **Vitest chodzi bez jsdom** — nie ma `document`, `window` ani renderowania komponentów. Co ma być sprawdzone, musi mieszkać w `src/shared/*`. Nic w `test/` nie importuje `electron`.
- Katalog `test/` jest objęty `include` w `tsconfig.json`, więc błąd typów w teście **wywala `npm run build`**.
- Testy i budowanie uruchamiamy z katalogu `companion-app`: `npm test`, `npm run build`.
- **Brak odczytu GPU to `null`, nigdy zero.** Zero znaczy „karta nic nie robi" i jest kłamstwem.
- **Awaria zapisu diagnostyki nie może przewrócić aplikacji** — każde wywołanie systemu plików w `try/catch`.
- Przed zmianą pakiet ma **139 przechodzących testów**.

## Review Focus

Pięć rzeczy, których spec wymaga pośrednio, a które najpewniej ugryzą użytkownika. Każda ma przypisany test w zadaniu, które jest właścicielem kodu.

1. **`nvidia-smi` nie istnieje albo uruchomienie rzuca wyjątkiem** (brak w `PATH`, karta AMD, sterownik w aktualizacji). Musi dać `gpu: null` i **nie zatrzymać zegara** — jeden wyjątek nie może zabić całego zapisu. → Task 3, `readGpu` z wstrzykiwanym uruchamiaczem.
2. **Strumień pojawia się albo znika między próbkami** (ktoś zaczął lub skończył nadawać). `ratesBetween` dostaje wtedy `next` bez `previous`. Musi dać „nie wiem", a nie `NaN` ani tempo liczone od zera. → Task 4.
3. **Licznik WebRTC cofa się** przy przełączeniu kodeka. Panel nie może pokazać minus czterdziestu klatek na sekundę. → Task 4.
4. **Zegar systemowy cofa się w trakcie sesji** (synchronizacja czasu). Bufor kołowy nie może wtedy wyrzucić wszystkiego ani rosnąć bez końca. → Task 5.
5. **Sufit rozmiaru pliku zostaje przekroczony** przy wielogodzinnej sesji. Dopisywanie musi ustać z jedną adnotacją, bez wyjątku i bez pustego pliku. → Task 5, `shouldAppendLine`.

---

## Struktura plików

| Plik | Odpowiedzialność |
|---|---|
| `companion-app/src/shared/diagnostics.ts` | **Nowy.** Typy, parser `nvidia-smi`, odczyt GPU z wstrzykiwanym uruchamiaczem, przeliczanie tempa, bufor kołowy, decyzja o sufcie pliku, format paska, skrót odcisku |
| `companion-app/src/shared/cli.ts` | Flaga `--diagnostics`, obsługa flag logicznych, przeprowadzenie adresu i kanału do `LaunchOptions` |
| `companion-app/src/shared/ipc.ts` | Trzy nowe kanały |
| `companion-app/src/main/metrics.ts` | **Nowy.** `app.getAppMetrics()` i uruchamianie `nvidia-smi` |
| `companion-app/src/main/diagnosticsRecorder.ts` | **Nowy.** Zegar 1 s, scalanie, bufor, zapis do pliku, obsługa IPC |
| `companion-app/src/preload/index.ts` | Trzy nowe metody mostu |
| `companion-app/src/renderer/hooks/useDiagnosticsReporter.ts` | **Nowy.** Odczyt `getStats()` i wysyłka w górę |
| `companion-app/src/renderer/components/Diagnostics.tsx` | **Nowy.** Pasek w rogu i panel z suwakiem czasu |
| `companion-app/src/renderer/main.tsx` | Montuje `<Diagnostics />` jako rodzeństwo `<App />` |
| `companion-app/src/renderer/components/LobbyView.tsx` | Montuje hook zbierający; przekazuje odcisk palca |
| `companion-app/src/renderer/components/PeerPanel.tsx` | Odcisk palca w nagłówku |
| `companion-app/src/renderer/styles.css` | Styl paska i panelu |
| `companion-app/test/diagnostics.test.ts` | **Nowy.** |
| `companion-app/test/cli.test.ts` | Rozszerzony (jeśli nie istnieje — nowy) |
| `companion-app/e2e/diagnostyka.mjs` | **Nowy.** Sprawdzian z prawdziwym oknem |

---

### Task 1: Flaga `--diagnostics` i przeprowadzenie wejść pokoju

Dziś `cli.ts` mieli adres serwera TS3 i numer kanału w `deriveRoomId` i **wyrzuca je** — zostaje sam skrót. Odcisk palca potrzebuje obu, żeby pokazać, z czego skrót powstał.

Druga rzecz, którą trzeba naprawić świadomie: **`readFlags` po cichu gubi flagi bez wartości.** Gdy po `--klucz` nie ma wartości albo następny argument sam jest flagą, `flags.set` nie jest wywoływane wcale. Czyli `--diagnostics` nigdy nie trafiłoby do mapy, a flaga milcząco by nie działała. Komentarz w kodzie mówi, że to było zamierzone („flaga bez wartości, np. `--inspect`"), więc zmieniamy to z otwartymi oczami.

**Files:**
- Modify: `companion-app/src/shared/cli.ts`
- Create: `companion-app/test/cli.test.ts` (jeśli plik już istnieje — dopisz na końcu i rozszerz import)

**Interfaces:**
- Consumes: `deriveRoomId(ts3ServerAddress, channelId)` z `./room.js`
- Produces: `LaunchOptions` z polami `ts3ServerAddress: string | null`, `channelId: string | null`, `diagnostics: boolean`

- [ ] **Step 1: Napisz testy**

Jeśli `companion-app/test/cli.test.ts` istnieje, dopisz poniższe na końcu i uzupełnij import. Jeśli nie istnieje, utwórz go z tą treścią:

```ts
import { expect, test } from 'vitest'
import { parseLaunchArgs } from '../src/shared/cli'
import { deriveRoomId } from '../src/shared/room'

test('tryb samodzielny nie ma wejść pokoju ani diagnostyki', () => {
  const result = parseLaunchArgs([])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.mode).toBe('standalone')
  expect(result.options.ts3ServerAddress).toBeNull()
  expect(result.options.channelId).toBeNull()
  expect(result.options.diagnostics).toBe(false)
})

test('wejścia pokoju przeżywają drogę do opcji', () => {
  // Bez tego odcisk palca lobby pokazywałby wartości, z których skrótu
  // NIE wyliczono — czyli diagnostykę gorszą niż jej brak.
  const result = parseLaunchArgs(['--ts3-server=ts.serwer.pl:9987', '--channel=42'])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.ts3ServerAddress).toBe('ts.serwer.pl:9987')
  expect(result.options.channelId).toBe('42')
})

test('identyfikator pokoju nadal zgadza się ze skrótem z tych samych wejść', () => {
  const result = parseLaunchArgs(['--ts3-server=ts.serwer.pl:9987', '--channel=42'])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.roomId).toBe(deriveRoomId('ts.serwer.pl:9987', '42'))
})

test('flaga diagnostyki działa jako ostatni argument', () => {
  // Pułapka: readFlags gubił flagi bez wartości, więc samo `--diagnostics`
  // na końcu wiersza nigdy nie trafiało do mapy.
  const result = parseLaunchArgs(['--ts3-server=a:1', '--channel=2', '--diagnostics'])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.diagnostics).toBe(true)
})

test('flaga diagnostyki działa przed inną flagą', () => {
  const result = parseLaunchArgs(['--diagnostics', '--ts3-server=a:1', '--channel=2'])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.diagnostics).toBe(true)
})

test('flaga diagnostyki działa też w trybie samodzielnym', () => {
  const result = parseLaunchArgs(['--diagnostics'])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.mode).toBe('standalone')
  expect(result.options.diagnostics).toBe(true)
})

test('obsługa flag logicznych nie psuje flag z wartością', () => {
  const result = parseLaunchArgs(['--ts3-server', 'a:1', '--channel', '2', '--nick', 'Marek'])
  if (!result.ok) throw new Error('spodziewano się powodzenia')
  expect(result.options.ts3ServerAddress).toBe('a:1')
  expect(result.options.channelId).toBe('2')
  expect(result.options.displayName).toBe('Marek')
})
```

- [ ] **Step 2: Uruchom testy, żeby zobaczyć, że nie przechodzą**

Run: `cd companion-app && npx vitest run test/cli.test.ts`
Expected: FAIL — `ts3ServerAddress` nie istnieje w typie / `undefined`, oraz `diagnostics` jest `undefined`

- [ ] **Step 3: Rozszerz `LaunchOptions`**

W `companion-app/src/shared/cli.ts`, w `interface LaunchOptions`, dopisz po polu `roomId`:

```ts
  /**
   * Wejścia, z których wyliczono `roomId`. Oba `null` w trybie standalone.
   * Trzymamy je w postaci SUROWEJ, a nie znormalizowanej przez `deriveRoomId`:
   * to właśnie surowa postać różni się między maszynami (raz nazwa domeny,
   * raz adres IP tego samego serwera) i o niej trzeba rozmawiać przez telefon.
   */
  ts3ServerAddress: string | null
  channelId: string | null
  /** Flaga `--diagnostics`: zapis diagnostyczny, panel i wskaźniki zużycia. */
  diagnostics: boolean
```

- [ ] **Step 4: Napraw gubienie flag logicznych**

W `companion-app/src/shared/cli.ts`, w funkcji `readFlags`, zamień końcówkę pętli:

```ts
    // Postać `--klucz wartość`: wartością jest następny argument, o ile
    // sam nie jest kolejną flagą.
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next)
      i++
      continue
    }
    /*
     * Flaga bez wartości (`--diagnostics`, `--inspect`). Wcześniej była tu
     * cisza: `flags.set` nie wykonywało się wcale, więc flaga logiczna
     * milcząco nie działała. Pusty łańcuch pozwala sprawdzić jej OBECNOŚĆ
     * przez `flags.has`, a flagom Electrona nie szkodzi, bo czytamy tylko
     * znane nam klucze.
     */
    flags.set(arg.slice(2), '')
```

- [ ] **Step 5: Przekaż nowe pola w obu gałęziach**

W `parseLaunchArgs` dopisz nad gałęzią standalone:

```ts
  const diagnostics = flags.has('diagnostics')
```

Gałąź standalone:

```ts
    return {
      ok: true,
      options: {
        mode: 'standalone',
        roomId: null,
        ts3ServerAddress: null,
        channelId: null,
        diagnostics,
        signalingUrl,
        displayName
      }
    }
```

Gałąź lobby:

```ts
      options: {
        mode: 'lobby',
        roomId: deriveRoomId(ts3Server, channel),
        ts3ServerAddress: ts3Server,
        channelId: channel,
        diagnostics,
        signalingUrl,
        displayName
      }
```

- [ ] **Step 6: Uruchom testy i budowanie**

Run: `cd companion-app && npm test && npm run build`
Expected: PASS — 146 testów (139 dotychczasowych plus 7 nowych), budowanie bez błędów `tsc`

Jeśli `tsc` zgłosi brakujące pola w innych miejscach tworzących `LaunchOptions` (np. w testach e2e albo w `App.tsx`), uzupełnij je — to kompilator wskazuje wszystkie miejsca, które trzeba ruszyć.

- [ ] **Step 7: Commit**

```bash
git add companion-app/src/shared/cli.ts companion-app/test/cli.test.ts
git commit -m "feat(diagnostyka): flaga --diagnostics i wejscia pokoju w opcjach"
```

---

### Task 2: Typy diagnostyki i parser `nvidia-smi`

**Files:**
- Create: `companion-app/src/shared/diagnostics.ts`
- Create: `companion-app/test/diagnostics.test.ts`

**Interfaces:**
- Consumes: `StreamKind` z `./types` (import typu)
- Produces: `GpuReading`, `SystemStats`, `StreamStats`, `DiagnosticsSample`, `StreamRates`, stałe (w tym `BUFFER_MAX_SAMPLES`), `parseNvidiaSmi(stdout: string, at: number): GpuReading | null`

- [ ] **Step 1: Napisz testy parsera**

`companion-app/test/diagnostics.test.ts`:

```ts
import { expect, test } from 'vitest'
import { parseNvidiaSmi } from '../src/shared/diagnostics'

test('poprawny odczyt jednej karty', () => {
  const reading = parseNvidiaSmi('99, 10034, 12282', 1000)
  expect(reading).toEqual({
    utilizationPercent: 99,
    memoryUsedMb: 10034,
    memoryTotalMb: 12282,
    at: 1000
  })
})

test('nadmiarowe spacje i koniec linii nie przeszkadzają', () => {
  expect(parseNvidiaSmi('  23 ,  512 , 8192  \n', 5)?.utilizationPercent).toBe(23)
})

test('dwie karty: bierzemy pierwszą linię', () => {
  // nvidia-smi wypisuje jedną linię na kartę i tylko karty NVIDIA.
  const reading = parseNvidiaSmi('99, 10034, 12282\n5, 100, 8192', 1)
  expect(reading?.utilizationPercent).toBe(99)
  expect(reading?.memoryTotalMb).toBe(12282)
})

test('wartość [N/A] daje brak odczytu, a nie zero', () => {
  // Zero znaczyloby "karta nic nie robi" — to klamstwo. Czesc kart zwraca
  // [N/A] dla zuzycia i wtedy po prostu NIE WIEMY.
  expect(parseNvidiaSmi('[N/A], 10034, 12282', 1)).toBeNull()
  expect(parseNvidiaSmi('99, [N/A], 12282', 1)).toBeNull()
})

test('puste wyjście daje brak odczytu', () => {
  expect(parseNvidiaSmi('', 1)).toBeNull()
  expect(parseNvidiaSmi('   \n  ', 1)).toBeNull()
})

test('śmieci dają brak odczytu', () => {
  expect(parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate', 1)).toBeNull()
  expect(parseNvidiaSmi('99, 10034', 1)).toBeNull()
})

test('brak odczytu nigdy nie udaje bezczynnej karty', () => {
  // Test pilnuje reguly jako takiej, osobno od pojedynczych przypadkow:
  // ZADNE zle wejscie nie moze dac liczby zero zamiast null.
  for (const bad of ['', '   ', '[N/A], [N/A], [N/A]', 'blad', '1, 2']) {
    const reading = parseNvidiaSmi(bad, 1)
    expect(reading, `wejście ${JSON.stringify(bad)}`).toBeNull()
  }
})
```

- [ ] **Step 2: Uruchom testy, żeby zobaczyć, że nie przechodzą**

Run: `cd companion-app && npx vitest run test/diagnostics.test.ts`
Expected: FAIL — `Failed to resolve import "../src/shared/diagnostics"`

- [ ] **Step 3: Napisz typy i parser**

`companion-app/src/shared/diagnostics.ts`:

```ts
import type { StreamKind } from './types'

export interface GpuReading {
  utilizationPercent: number
  memoryUsedMb: number
  memoryTotalMb: number
  /**
   * Własny znacznik czasu: odczyt GPU NIE jest jednoczesny z resztą próbki.
   * Pochodzi z osobnego procesu, który wraca po ~47 ms, a zegar na niego nie
   * czeka — blokada procesu głównego co sekundę dawałaby zacinanie interfejsu,
   * czyli dokładnie to, czego w tej aplikacji szukamy.
   */
  at: number
}

export interface SystemStats {
  cpuPercent: number
  memoryMb: number
  /** `null` znaczy „nie wiemy", nigdy „karta nic nie robi". */
  gpu: GpuReading | null
}

export interface StreamStats {
  peerId: string
  kind: StreamKind
  direction: 'inbound' | 'outbound'
  /** Pola nieobecne dla danego kierunku są `null`, a nie zerem. */
  framesReceived: number | null
  framesDecoded: number | null
  framesPresented: number | null
  framesDropped: number | null
  framesEncoded: number | null
  framesSent: number | null
  bytes: number
  qualityLimitationReason: string | null
}

export interface DiagnosticsSample {
  at: number
  system: SystemStats
  streams: StreamStats[]
}

export interface StreamRates {
  receivedPerS: number | null
  decodedPerS: number | null
  presentedPerS: number | null
  droppedPerS: number | null
  encodedPerS: number | null
  sentPerS: number | null
  kilobitsPerS: number | null
}

export const SAMPLE_INTERVAL_MS = 1_000
export const BUFFER_MAX_AGE_MS = 10 * 60 * 1_000
/** Sufit liczby wpisow: dziesiec minut przy 1 Hz, plus zapas na cofniety zegar. */
export const BUFFER_MAX_SAMPLES = 600
export const LOG_SIZE_CEILING_BYTES = 8 * 1024 * 1024
export const ROOM_FINGERPRINT_LENGTH = 8

/**
 * Parsuje wyjście `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total
 * --format=csv,noheader,nounits`, czyli trzy liczby po przecinkach.
 *
 * Bierzemy PIERWSZĄ linię: narzędzie wypisuje jedną na kartę i wyłącznie karty
 * NVIDIA, więc pozostałe adaptery w systemie tu nie występują.
 *
 * Każde wejście, którego nie da się odczytać w całości, daje `null`. To jest
 * reguła, nie ostrożność: `[N/A]` zamienione na zero mówiłoby, że karta jest
 * bezczynna, a my po prostu nie wiemy.
 */
export function parseNvidiaSmi(stdout: string, at: number): GpuReading | null {
  const firstLine = stdout.split('\n')[0]?.trim()
  if (!firstLine) return null

  const parts = firstLine.split(',').map((part) => part.trim())
  if (parts.length !== 3) return null

  const numbers = parts.map((part) => (/^\d+(\.\d+)?$/.test(part) ? Number(part) : null))
  if (numbers.some((value) => value === null)) return null

  const [utilizationPercent, memoryUsedMb, memoryTotalMb] = numbers as number[]
  return { utilizationPercent, memoryUsedMb, memoryTotalMb, at }
}
```

- [ ] **Step 4: Uruchom testy**

Run: `cd companion-app && npx vitest run test/diagnostics.test.ts`
Expected: PASS — 7 testów

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/shared/diagnostics.ts companion-app/test/diagnostics.test.ts
git commit -m "feat(diagnostyka): typy probki i parser wyjscia nvidia-smi"
```

---

### Task 3: Odczyt GPU odporny na brak `nvidia-smi`

Oddzielne zadanie, bo to **ścieżka awarii, którą trzeba przetestować**, a nie da się jej przetestować, jeśli uruchamianie procesu siedzi na sztywno w środku. Uruchamiacz wstrzykujemy.

**Files:**
- Modify: `companion-app/src/shared/diagnostics.ts`
- Modify: `companion-app/test/diagnostics.test.ts`

**Interfaces:**
- Consumes: `parseNvidiaSmi`, `GpuReading` z Task 2
- Produces: `readGpu(run: () => Promise<string>, at: number): Promise<GpuReading | null>`

- [ ] **Step 1: Dopisz testy ścieżki awarii**

Dopisz na końcu `companion-app/test/diagnostics.test.ts` i rozszerz import o `readGpu`:

```ts
test('odczyt GPU zwraca wartości, gdy uruchamiacz je poda', async () => {
  const reading = await readGpu(async () => '99, 10034, 12282', 7)
  expect(reading?.utilizationPercent).toBe(99)
  expect(reading?.at).toBe(7)
})

test('wyjątek uruchamiacza daje brak odczytu, a nie wyjątek w górę', async () => {
  // Tak wyglada brak nvidia-smi w PATH (ENOENT), karta AMD albo sterownik
  // w trakcie aktualizacji. Jeden wyjatek nie moze zatrzymac calego zapisu.
  const reading = await readGpu(async () => {
    throw new Error('spawn nvidia-smi ENOENT')
  }, 7)
  expect(reading).toBeNull()
})

test('odrzucona obietnica bez obiektu błędu też daje brak odczytu', async () => {
  const reading = await readGpu(() => Promise.reject('cokolwiek'), 7)
  expect(reading).toBeNull()
})

test('nieczytelne wyjście uruchamiacza daje brak odczytu', async () => {
  expect(await readGpu(async () => 'NVIDIA-SMI has failed', 7)).toBeNull()
})
```

- [ ] **Step 2: Uruchom testy, żeby zobaczyć, że nie przechodzą**

Run: `cd companion-app && npx vitest run test/diagnostics.test.ts`
Expected: FAIL — `readGpu is not a function`

- [ ] **Step 3: Dopisz `readGpu`**

Dopisz na końcu `companion-app/src/shared/diagnostics.ts`:

```ts
/**
 * Odczyt GPU z wstrzykiwanym uruchamiaczem.
 *
 * Uruchamianie procesu nie siedzi tutaj celowo: gdyby siedziało, nie dałoby
 * się przetestować ścieżki, która w praktyce zdarza się najczęściej — braku
 * `nvidia-smi` (karta AMD, narzędzie nie w `PATH`, sterownik w aktualizacji).
 * Proces główny wstrzykuje funkcję, która naprawdę uruchamia narzędzie.
 *
 * Łapiemy WSZYSTKO, bo odrzucona obietnica może nieść cokolwiek, nie tylko
 * `Error`. Diagnostyka jest dodatkiem: jej awaria nie może zatrzymać zapisu.
 */
export async function readGpu(
  run: () => Promise<string>,
  at: number
): Promise<GpuReading | null> {
  try {
    return parseNvidiaSmi(await run(), at)
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Uruchom testy**

Run: `cd companion-app && npx vitest run test/diagnostics.test.ts`
Expected: PASS — 11 testów

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/shared/diagnostics.ts companion-app/test/diagnostics.test.ts
git commit -m "feat(diagnostyka): odczyt GPU odporny na brak nvidia-smi"
```

---

### Task 4: Przeliczanie liczników na tempo

**Files:**
- Modify: `companion-app/src/shared/diagnostics.ts`
- Modify: `companion-app/test/diagnostics.test.ts`

**Interfaces:**
- Consumes: `StreamStats`, `StreamRates` z Task 2
- Produces: `ratesBetween(previous: StreamStats | undefined, next: StreamStats, elapsedMs: number): StreamRates | null`

- [ ] **Step 1: Dopisz testy**

Dopisz na końcu `companion-app/test/diagnostics.test.ts`, rozszerz import o `ratesBetween` i typ `StreamStats`:

```ts
function inbound(overrides: Partial<StreamStats> = {}): StreamStats {
  return {
    peerId: 'p1',
    kind: 'screen',
    direction: 'inbound',
    framesReceived: 0,
    framesDecoded: 0,
    framesPresented: 0,
    framesDropped: 0,
    framesEncoded: null,
    framesSent: null,
    bytes: 0,
    qualityLimitationReason: null,
    ...overrides
  }
}

test('zwykły przyrost daje tempo na sekundę', () => {
  const rates = ratesBetween(
    inbound({ framesReceived: 100, bytes: 1_000 }),
    inbound({ framesReceived: 160, bytes: 126_000 }),
    1_000
  )
  expect(rates?.receivedPerS).toBe(60)
  // 125 000 bajtow = 1 000 000 bitow = 1 000 kilobitow na sekunde
  expect(rates?.kilobitsPerS).toBe(1_000)
})

test('zerowy i ujemny odstęp czasu unieważnia cały odczyt', () => {
  expect(ratesBetween(inbound(), inbound({ framesReceived: 10 }), 0)).toBeNull()
  expect(ratesBetween(inbound(), inbound({ framesReceived: 10 }), -5)).toBeNull()
})

test('brak poprzedniej próbki unieważnia cały odczyt', () => {
  // Tak wyglada strumien, ktory wlasnie sie pojawil: nie ma od czego liczyc
  // przyrostu, a liczenie od zera pokazaloby falszywy skok.
  expect(ratesBetween(undefined, inbound({ framesReceived: 500 }), 1_000)).toBeNull()
})

test('cofnięty licznik zeruje SWOJE pole, nie cały odczyt', () => {
  // WebRTC zeruje liczniki przy przelaczeniu kodeka. Bez tej reguly panel
  // pokazalby minus czterdziesci klatek na sekunde.
  const rates = ratesBetween(
    inbound({ framesReceived: 100, framesDecoded: 100 }),
    inbound({ framesReceived: 5, framesDecoded: 160 }),
    1_000
  )
  expect(rates?.receivedPerS).toBeNull()
  expect(rates?.decodedPerS).toBe(60)
})

test('pole brakujące po którejkolwiek stronie daje null, nie NaN', () => {
  const rates = ratesBetween(
    inbound({ framesPresented: null }),
    inbound({ framesPresented: 60 }),
    1_000
  )
  expect(rates?.presentedPerS).toBeNull()
  expect(Number.isNaN(rates?.presentedPerS as unknown as number)).toBe(false)
})

test('pola drugiego kierunku zostają null, gdy strumień ich nie ma', () => {
  const rates = ratesBetween(inbound(), inbound({ framesReceived: 30 }), 1_000)
  expect(rates?.encodedPerS).toBeNull()
  expect(rates?.sentPerS).toBeNull()
})
```

- [ ] **Step 2: Uruchom testy, żeby zobaczyć, że nie przechodzą**

Run: `cd companion-app && npx vitest run test/diagnostics.test.ts`
Expected: FAIL — `ratesBetween is not a function`

- [ ] **Step 3: Dopisz implementację**

Dopisz na końcu `companion-app/src/shared/diagnostics.ts`:

```ts
/**
 * Przyrost jednego licznika na sekundę.
 *
 * `null` oznacza „nie wiem" i wychodzi w trzech przypadkach: licznika brakuje
 * po którejkolwiek stronie, albo poszedł w tył. Cofnięcie jest realne —
 * WebRTC zeruje liczniki przy przełączeniu kodeka — a bez tej reguły panel
 * pokazywałby ujemne tempo, czyli bzdurę wyglądającą na pomiar.
 */
function deltaPerSecond(
  previous: number | null,
  next: number | null,
  elapsedMs: number
): number | null {
  if (previous === null || next === null) return null
  if (next < previous) return null
  return ((next - previous) * 1000) / elapsedMs
}

/**
 * Tempo wszystkich liczników strumienia między dwiema próbkami.
 *
 * Zwraca `null` jako CAŁOŚĆ tylko wtedy, gdy nie ma czego liczyć: brak
 * poprzedniej próbki (strumień właśnie się pojawił) albo niedodatni odstęp
 * czasu. Pojedyncze pola mogą być `null` niezależnie od siebie — patrz
 * `deltaPerSecond`.
 */
export function ratesBetween(
  previous: StreamStats | undefined,
  next: StreamStats,
  elapsedMs: number
): StreamRates | null {
  if (previous === undefined) return null
  if (elapsedMs <= 0) return null

  const bytesPerSecond = deltaPerSecond(previous.bytes, next.bytes, elapsedMs)
  return {
    receivedPerS: deltaPerSecond(previous.framesReceived, next.framesReceived, elapsedMs),
    decodedPerS: deltaPerSecond(previous.framesDecoded, next.framesDecoded, elapsedMs),
    presentedPerS: deltaPerSecond(previous.framesPresented, next.framesPresented, elapsedMs),
    droppedPerS: deltaPerSecond(previous.framesDropped, next.framesDropped, elapsedMs),
    encodedPerS: deltaPerSecond(previous.framesEncoded, next.framesEncoded, elapsedMs),
    sentPerS: deltaPerSecond(previous.framesSent, next.framesSent, elapsedMs),
    kilobitsPerS: bytesPerSecond === null ? null : (bytesPerSecond * 8) / 1000
  }
}
```

- [ ] **Step 4: Uruchom testy**

Run: `cd companion-app && npx vitest run test/diagnostics.test.ts`
Expected: PASS — 17 testów

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/shared/diagnostics.ts companion-app/test/diagnostics.test.ts
git commit -m "feat(diagnostyka): przeliczanie licznikow na tempo"
```

---

### Task 5: Bufor kołowy, sufit pliku i formatowanie

**Files:**
- Modify: `companion-app/src/shared/diagnostics.ts`
- Modify: `companion-app/test/diagnostics.test.ts`

**Interfaces:**
- Consumes: `DiagnosticsSample`, `SystemStats`, stałe z Task 2
- Produces: `appendSample(buffer, sample, maxAgeMs, maxCount): DiagnosticsSample[]`, `shouldAppendLine(currentBytes, lineBytes, ceilingBytes): boolean`, `formatResourceBadge(system): string`, `shortRoomFingerprint(roomId): string`

- [ ] **Step 1: Dopisz testy**

Dopisz na końcu `companion-app/test/diagnostics.test.ts`, rozszerz import o `appendSample`, `shouldAppendLine`, `formatResourceBadge`, `shortRoomFingerprint` i typ `DiagnosticsSample`:

```ts
function sample(at: number): DiagnosticsSample {
  return { at, system: { cpuPercent: 1, memoryMb: 2, gpu: null }, streams: [] }
}

test('bufor zachowuje kolejność i to, co się mieści', () => {
  let buffer = appendSample([], sample(1_000), 10_000, 600)
  buffer = appendSample(buffer, sample(2_000), 10_000, 600)
  buffer = appendSample(buffer, sample(3_000), 10_000, 600)
  expect(buffer.map((entry) => entry.at)).toEqual([1_000, 2_000, 3_000])
})

test('bufor przycina próbki starsze niż podany wiek', () => {
  let buffer = appendSample([], sample(1_000), 5_000, 600)
  buffer = appendSample(buffer, sample(3_000), 5_000, 600)
  buffer = appendSample(buffer, sample(7_000), 5_000, 600)
  // Granica liczona wzgledem najnowszej probki: 7000 - 5000 = 2000,
  // wiec probka z 1000 wypada, a ta z 3000 zostaje.
  expect(buffer.map((entry) => entry.at)).toEqual([3_000, 7_000])
})

test('próbka dokładnie na granicy wieku zostaje', () => {
  let buffer = appendSample([], sample(2_000), 5_000, 600)
  buffer = appendSample(buffer, sample(7_000), 5_000, 600)
  expect(buffer.map((entry) => entry.at)).toEqual([2_000, 7_000])
})

test('cofnięty zegar systemowy nie wyrzuca ani historii, ani nowej próbki', () => {
  // Synchronizacja czasu w trakcie sesji potrafi cofnac zegar. Sa tu dwie
  // pulapki, kazda gorsza od drugiej:
  //   - gdyby granica liczyla sie od probki PRZYCHODZACEJ, jedna cofnieta
  //     wartosc wyczyscilaby cala dotychczasowa historie;
  //   - gdyby nowa probka podlegala filtrowi wieku, to po cofnieciu zegara
  //     ODRZUCANA bylaby kazda kolejna probka i zapis cicho by umarl.
  // Dlatego nowa probka zostaje ZAWSZE, a ograniczenie rozmiaru bierze na
  // siebie sufit liczby wpisow (osobny test ponizej).
  let buffer = appendSample([], sample(100_000), 5_000, 600)
  buffer = appendSample(buffer, sample(101_000), 5_000, 600)
  buffer = appendSample(buffer, sample(1_000), 5_000, 600)
  expect(buffer.length).toBe(3)
  expect(buffer.map((entry) => entry.at)).toContain(100_000)
})

test('sufit liczby wpisów ogranicza bufor niezależnie od zegara', () => {
  // To jest zabezpieczenie na wypadek, gdy filtr wieku nie wystarczy — na
  // przyklad po cofnieciu zegara, gdy w buforze siedza dwie epoki naraz.
  let buffer = []
  for (let at = 1; at <= 10; at++) buffer = appendSample(buffer, sample(at), 10_000_000, 4)
  expect(buffer.length).toBe(4)
  expect(buffer.map((entry) => entry.at)).toEqual([7, 8, 9, 10])
})

test('sufit pliku wstrzymuje dopisywanie, gdy linia by go przekroczyła', () => {
  expect(shouldAppendLine(0, 100, 1_000)).toBe(true)
  expect(shouldAppendLine(900, 100, 1_000)).toBe(true)
  expect(shouldAppendLine(901, 100, 1_000)).toBe(false)
  expect(shouldAppendLine(5_000, 1, 1_000)).toBe(false)
})

test('pasek zużycia pokazuje brak odczytu GPU kreską, nie zerem', () => {
  const text = formatResourceBadge({ cpuPercent: 23, memoryMb: 412, gpu: null })
  expect(text).toBe('CPU 23% · RAM 412 MB · GPU —')
})

test('pasek zużycia podaje pamięć karty w gigabajtach z przecinkiem', () => {
  const text = formatResourceBadge({
    cpuPercent: 23,
    memoryMb: 412,
    gpu: { utilizationPercent: 99, memoryUsedMb: 10_034, memoryTotalMb: 12_282, at: 1 }
  })
  expect(text).toBe('CPU 23% · RAM 412 MB · GPU 99% · VRAM 9,8/12,0 GB')
})

test('odcisk palca lobby to osiem pierwszych znaków skrótu', () => {
  expect(shortRoomFingerprint('3f9a2c1b4d5e6f70' + 'a'.repeat(48))).toBe('3f9a2c1b')
})

test('odcisk palca krótszego wejścia nie wywraca funkcji', () => {
  expect(shortRoomFingerprint('abc')).toBe('abc')
  expect(shortRoomFingerprint('')).toBe('')
})
```

- [ ] **Step 2: Uruchom testy, żeby zobaczyć, że nie przechodzą**

Run: `cd companion-app && npx vitest run test/diagnostics.test.ts`
Expected: FAIL — `appendSample is not a function`

- [ ] **Step 3: Dopisz implementację**

Dopisz na końcu `companion-app/src/shared/diagnostics.ts`:

```ts
/**
 * Dokłada próbkę i przycina bufor — po wieku, a na końcu po liczbie wpisów.
 *
 * Oba ograniczenia są parametrami, nie stałymi w środku: inaczej test bufora
 * musiałby czekać dziesięć minut i wstawiać sześćset próbek.
 *
 * Dwie reguły, obie wymuszone przez cofnięcie zegara systemowego
 * (synchronizacja czasu zdarza się w środku sesji):
 *
 * 1. **Granicę wieku liczymy od największego znacznika czasu**, a nie od
 *    znacznika próbki właśnie dokładanej. Inaczej jedna cofnięta wartość
 *    wyrzuciłaby całą historię, czyli zabrałaby dane dokładnie wtedy, gdy
 *    dzieje się coś nietypowego.
 * 2. **Nowa próbka nie podlega filtrowi wieku i zostaje zawsze.** Inaczej po
 *    cofnięciu zegara każda kolejna próbka byłaby starsza od okna liczonego
 *    względem starej epoki — i zapis cicho by umarł.
 *
 * Skutkiem drugiej reguły bufor może przez chwilę trzymać dwie epoki czasu.
 * Dlatego ograniczenie rozmiaru bierze na siebie `maxCount`: filtr wieku nie
 * jest w tym przypadku żadną gwarancją, a bufor musi być skończony.
 */
export function appendSample(
  buffer: readonly DiagnosticsSample[],
  sample: DiagnosticsSample,
  maxAgeMs: number,
  maxCount: number
): DiagnosticsSample[] {
  const newest = buffer.reduce((largest, entry) => Math.max(largest, entry.at), sample.at)
  const kept = buffer.filter((entry) => newest - entry.at <= maxAgeMs)
  const next = [...kept, sample]
  return next.length > maxCount ? next.slice(next.length - maxCount) : next
}

/** Czy linia zmieści się pod sufitem rozmiaru pliku. */
export function shouldAppendLine(
  currentBytes: number,
  lineBytes: number,
  ceilingBytes: number
): boolean {
  return currentBytes + lineBytes <= ceilingBytes
}

/** Pamięć karty w gigabajtach, z przecinkiem — interfejs jest polski. */
function formatGigabytes(megabytes: number): string {
  return (megabytes / 1024).toFixed(1).replace('.', ',')
}

/**
 * Tekst paska w rogu okna. Brak odczytu GPU pokazujemy kreską, bo zero
 * znaczyłoby „karta nic nie robi", a my po prostu nie wiemy.
 */
export function formatResourceBadge(system: SystemStats): string {
  const parts = [
    `CPU ${Math.round(system.cpuPercent)}%`,
    `RAM ${Math.round(system.memoryMb)} MB`
  ]
  if (system.gpu === null) {
    parts.push('GPU —')
  } else {
    parts.push(`GPU ${Math.round(system.gpu.utilizationPercent)}%`)
    parts.push(
      `VRAM ${formatGigabytes(system.gpu.memoryUsedMb)}/${formatGigabytes(system.gpu.memoryTotalMb)} GB`
    )
  }
  return parts.join(' · ')
}

/**
 * Skrót identyfikatora pokoju do porównania przez telefon. Osiem znaków
 * z szesnastkowego skrótu to 32 bity — na dwie osoby w jednym kanale
 * z zapasem, a da się to przeczytać na głos bez pomyłki.
 */
export function shortRoomFingerprint(roomId: string): string {
  return roomId.slice(0, ROOM_FINGERPRINT_LENGTH)
}
```

- [ ] **Step 4: Uruchom testy i budowanie**

Run: `cd companion-app && npm test && npm run build`
Expected: PASS — 173 testy (146 po Task 1 plus 27 w `diagnostics.test.ts`), budowanie bez błędów

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/shared/diagnostics.ts companion-app/test/diagnostics.test.ts
git commit -m "feat(diagnostyka): bufor kolowy, sufit pliku i formatowanie"
```

---

### Task 6: Zbieranie metryk systemowych w procesie głównym

**Files:**
- Create: `companion-app/src/main/metrics.ts`

**Interfaces:**
- Consumes: `readGpu`, `GpuReading`, `SystemStats` z Task 2-3
- Produces: `readSystemStats(): SystemStats`, `startGpuPolling(intervalMs: number): () => void`, `latestGpu(): GpuReading | null`

To zadanie **nie ma testów jednostkowych**: importuje `electron`, a nic w `test/` nie może tego robić. Cała arytmetyka i obsługa awarii zostały przetestowane w Task 2-3. Sprawdzianem jest `npm run build`.

- [ ] **Step 1: Napisz moduł**

`companion-app/src/main/metrics.ts`:

```ts
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { readGpu, type GpuReading, type SystemStats } from '@shared/diagnostics'

/*
 * Odczyt GPU trzymamy osobno od zegara próbek. `nvidia-smi` to uruchomienie
 * procesu i mierzy ~47 ms (średnia z dziesięciu, min 43, max 54), czyli 4,7%
 * sekundy. Czekanie na niego w tyknięciu zablokowałoby proces główny i dałoby
 * zacinanie interfejsu — dokładnie to, czego w tej aplikacji szukamy.
 *
 * Zamiast tego odpytujemy w tle, a tyknięcie bierze ostatni znany odczyt
 * razem z JEGO znacznikiem czasu.
 */
let lastGpu: GpuReading | null = null

const NVIDIA_SMI_ARGS = [
  '--query-gpu=utilization.gpu,memory.used,memory.total',
  '--format=csv,noheader,nounits'
]

function runNvidiaSmi(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('nvidia-smi', NVIDIA_SMI_ARGS, { timeout: 3_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/** Zwraca funkcję zatrzymującą odpytywanie. */
export function startGpuPolling(intervalMs: number): () => void {
  const tick = (): void => {
    void readGpu(runNvidiaSmi, Date.now()).then((reading) => {
      lastGpu = reading
    })
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  return () => clearInterval(timer)
}

export function latestGpu(): GpuReading | null {
  return lastGpu
}

/**
 * Zużycie procesora i pamięci całej aplikacji — suma po wszystkich procesach
 * Electrona. Rozbicie na procesy świadomie pomijamy: suma odpowiada na pytanie
 * „czy aplikacja zjada maszynę", a to jest pytanie, które zadajemy.
 *
 * `getAppMetrics()` jest synchroniczne i tanie, więc wywołujemy je w tyknięciu.
 */
export function readSystemStats(): SystemStats {
  let cpuPercent = 0
  let memoryKb = 0
  for (const entry of app.getAppMetrics()) {
    cpuPercent += entry.cpu?.percentCPUUsage ?? 0
    memoryKb += entry.memory?.workingSetSize ?? 0
  }
  return { cpuPercent, memoryMb: memoryKb / 1024, gpu: latestGpu() }
}
```

- [ ] **Step 2: Sprawdź budowanie**

Run: `cd companion-app && npm run build`
Expected: PASS — bez błędów `tsc`

- [ ] **Step 3: Sprawdź, że testy nadal przechodzą**

Run: `cd companion-app && npm test`
Expected: PASS — 173 testy

- [ ] **Step 4: Commit**

```bash
git add companion-app/src/main/metrics.ts
git commit -m "feat(diagnostyka): zbieranie CPU, pamieci i GPU w procesie glownym"
```

---

### Task 7: Rejestrator, kanały IPC i most w preload

**Files:**
- Create: `companion-app/src/main/diagnosticsRecorder.ts`
- Modify: `companion-app/src/shared/ipc.ts`
- Modify: `companion-app/src/preload/index.ts`
- Modify: `companion-app/src/main/index.ts`

**Interfaces:**
- Consumes: `readSystemStats`, `startGpuPolling` z Task 6; `appendSample`, `shouldAppendLine`, `SAMPLE_INTERVAL_MS`, `BUFFER_MAX_AGE_MS`, `BUFFER_MAX_SAMPLES`, `LOG_SIZE_CEILING_BYTES`, `DiagnosticsSample`, `StreamStats` z Task 2-5
- Produces: `registerDiagnostics(enabled: boolean): void`; most `window.companion.pushDiagnostics`, `window.companion.getLatestDiagnostics`, `window.companion.readDiagnostics`

- [ ] **Step 1: Dopisz kanały IPC**

Dopisz na końcu `companion-app/src/shared/ipc.ts`:

```ts
/*
 * Diagnostyka. Trzy kanały, nie cztery: o samą flagę renderer nie pyta
 * osobno, bo przychodzi ona polem `diagnostics` w `LaunchOptions`, czyli
 * istniejącym `IPC_GET_LAUNCH`.
 *
 * `LATEST` i `READ` są rozdzielone celowo: pasek w rogu potrzebuje jednej
 * najnowszej próbki co sekundę, a panel całego bufora tylko wtedy, gdy jest
 * otwarty. Przesyłanie sześciuset wpisów co sekundę dla czterech liczb
 * w rogu byłoby marnotrawstwem.
 */
export const IPC_DIAGNOSTICS_PUSH = 'diagnostics:push'
export const IPC_DIAGNOSTICS_LATEST = 'diagnostics:latest'
export const IPC_DIAGNOSTICS_READ = 'diagnostics:read'
```

- [ ] **Step 2: Napisz rejestrator**

`companion-app/src/main/diagnosticsRecorder.ts`:

```ts
import { app, ipcMain } from 'electron'
import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUFFER_MAX_AGE_MS,
  BUFFER_MAX_SAMPLES,
  LOG_SIZE_CEILING_BYTES,
  SAMPLE_INTERVAL_MS,
  appendSample,
  shouldAppendLine,
  type DiagnosticsSample,
  type StreamStats
} from '@shared/diagnostics'
import { IPC_DIAGNOSTICS_LATEST, IPC_DIAGNOSTICS_PUSH, IPC_DIAGNOSTICS_READ } from '@shared/ipc'
import { readSystemStats, startGpuPolling } from './metrics'

let buffer: DiagnosticsSample[] = []
/** Ostatnie statystyki strumieni przysłane przez renderer. */
let pendingStreams: StreamStats[] = []
let logPath: string | null = null
let logBytes = 0
let ceilingReported = false

/**
 * Zapis na dysk. Każde wywołanie systemu plików w `try/catch`, bo diagnostyka
 * jest dodatkiem: pełny dysk, brak uprawnień ani nic innego nie może przewrócić
 * aplikacji. Ten sam układ co `updateLogger.ts` z 0.2.0.
 */
function appendLine(sample: DiagnosticsSample): void {
  if (logPath === null) return
  const line = JSON.stringify(sample) + '\n'
  const lineBytes = Buffer.byteLength(line, 'utf8')

  if (!shouldAppendLine(logBytes, lineBytes, LOG_SIZE_CEILING_BYTES)) {
    if (ceilingReported) return
    ceilingReported = true
    try {
      appendFileSync(logPath, JSON.stringify({ note: 'sufit rozmiaru osiagniety' }) + '\n', 'utf8')
    } catch {
      /* nic wiecej nie zrobimy */
    }
    return
  }

  try {
    appendFileSync(logPath, line, 'utf8')
    logBytes += lineBytes
  } catch {
    /* zapis padl — bufor w pamieci dziala dalej */
  }
}

function openLog(): void {
  try {
    const directory = join(app.getPath('userData'), 'diagnostics')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl`)
    let existing = 0
    try {
      existing = statSync(path).size
    } catch {
      /* plik jeszcze nie istnieje */
    }
    logPath = path
    logBytes = existing
  } catch {
    // Bez pliku zostaje bufor w pamieci — panel dziala, zapis nie przezyje
    // restartu. Lepsze niz brak diagnostyki.
    logPath = null
  }
}

/**
 * Włącza zapis diagnostyczny. Przy `enabled === false` nie rejestruje NICZEGO:
 * ani zegara, ani obsługi IPC, ani pliku. Normalny użytkownik nie płaci za
 * diagnostykę ani jednym cyklem.
 */
export function registerDiagnostics(enabled: boolean): void {
  if (!enabled) return

  openLog()
  const stopGpu = startGpuPolling(SAMPLE_INTERVAL_MS)

  /*
   * Renderer przysyła statystyki strumieni, a proces główny dokłada wiersz
   * systemowy i scala jednym zegarem. Rejestrator celowo nie mieszka
   * w rendererze: podejrzanym jest głodzony renderer, a dziennik prowadzony
   * przez podejrzanego przestaje być dziennikiem dokładnie wtedy, gdy staje
   * się potrzebny.
   */
  ipcMain.handle(IPC_DIAGNOSTICS_PUSH, (_event, streams: StreamStats[]) => {
    pendingStreams = Array.isArray(streams) ? streams : []
  })
  ipcMain.handle(IPC_DIAGNOSTICS_LATEST, () => buffer[buffer.length - 1] ?? null)
  ipcMain.handle(IPC_DIAGNOSTICS_READ, () => buffer)

  const timer = setInterval(() => {
    const sample: DiagnosticsSample = {
      at: Date.now(),
      system: readSystemStats(),
      streams: pendingStreams
    }
    buffer = appendSample(buffer, sample, BUFFER_MAX_AGE_MS, BUFFER_MAX_SAMPLES)
    appendLine(sample)
  }, SAMPLE_INTERVAL_MS)

  app.on('will-quit', () => {
    clearInterval(timer)
    stopGpu()
  })
}
```

- [ ] **Step 3: Podepnij rejestrator w procesie głównym**

W `companion-app/src/main/index.ts` dopisz do importów:

```ts
import { registerDiagnostics } from './diagnosticsRecorder'
```

i wywołaj go tam, gdzie rejestrowane są pozostałe usługi procesu głównego (obok `registerUpdates` / `registerAppAudio`), przekazując flagę z już sparsowanych argumentów:

```ts
registerDiagnostics(launch.ok && launch.options.diagnostics)
```

- [ ] **Step 4: Dopisz most w preload**

W `companion-app/src/preload/index.ts` rozszerz import z `@shared/ipc` o trzy nowe stałe, dopisz import typów:

```ts
import type { DiagnosticsSample, StreamStats } from '@shared/diagnostics'
```

i dołóż do obiektu `api`:

```ts
  /** Statystyki strumieni w górę; proces główny dokłada wiersz systemowy. */
  pushDiagnostics: (streams: StreamStats[]): Promise<void> =>
    ipcRenderer.invoke(IPC_DIAGNOSTICS_PUSH, streams),
  getLatestDiagnostics: (): Promise<DiagnosticsSample | null> =>
    ipcRenderer.invoke(IPC_DIAGNOSTICS_LATEST),
  readDiagnostics: (): Promise<DiagnosticsSample[]> => ipcRenderer.invoke(IPC_DIAGNOSTICS_READ),
```

- [ ] **Step 5: Sprawdź budowanie i testy**

Run: `cd companion-app && npm run build && npm test`
Expected: PASS — bez błędów `tsc`, 173 testy

- [ ] **Step 6: Commit**

```bash
git add companion-app/src/main/diagnosticsRecorder.ts companion-app/src/shared/ipc.ts \
        companion-app/src/preload/index.ts companion-app/src/main/index.ts
git commit -m "feat(diagnostyka): rejestrator w procesie glownym, kanaly IPC i most"
```

---

### Task 8: Zbieranie statystyk WebRTC w rendererze

**Files:**
- Create: `companion-app/src/renderer/hooks/useDiagnosticsReporter.ts`
- Modify: `companion-app/src/renderer/components/LobbyView.tsx`

**Interfaces:**
- Consumes: `StreamStats` z Task 2; `window.companion.pushDiagnostics` z Task 7; `Lobby` z `../hooks/useLobby`
- Produces: `useDiagnosticsReporter(lobby: Lobby, enabled: boolean): void`

- [ ] **Step 1: Napisz hook**

`companion-app/src/renderer/hooks/useDiagnosticsReporter.ts`:

```ts
import { useEffect } from 'react'
import { SAMPLE_INTERVAL_MS, type StreamStats } from '@shared/diagnostics'
import type { Lobby } from './useLobby'

/**
 * Co sekundę odczytuje `getStats()` ze wszystkich połączeń i wysyła wynik do
 * procesu głównego, który jest właścicielem zapisu.
 *
 * Hook siedzi w rendererze, bo tylko tutaj istnieje sesja WebRTC — ale NIE
 * prowadzi dziennika. Dziennik prowadzi proces główny, bo renderer jest tym,
 * co diagnozujemy: gdyby on zapisywał, przestawałby zapisywać dokładnie
 * w chwili, która nas interesuje.
 *
 * Przy `enabled === false` nie montuje zegara wcale.
 */
export function useDiagnosticsReporter(lobby: Lobby, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return

    let cancelled = false

    const collect = async (): Promise<void> => {
      const streams: StreamStats[] = []
      for (const { peerId, kind, direction, connection } of lobby.diagnosticConnections()) {
        let report: RTCStatsReport
        try {
          report = await connection.getStats()
        } catch {
          // Polaczenie moglo sie zamknac miedzy pobraniem listy a odczytem.
          continue
        }
        const entry: StreamStats = {
          peerId,
          kind,
          direction,
          framesReceived: null,
          framesDecoded: null,
          framesPresented: null,
          framesDropped: null,
          framesEncoded: null,
          framesSent: null,
          bytes: 0,
          qualityLimitationReason: null
        }
        report.forEach((stat) => {
          if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
            entry.framesReceived = stat.framesReceived ?? null
            entry.framesDecoded = stat.framesDecoded ?? null
            entry.bytes = stat.bytesReceived ?? 0
          }
          if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
            entry.framesEncoded = stat.framesEncoded ?? null
            entry.framesSent = stat.framesSent ?? null
            entry.bytes = stat.bytesSent ?? 0
            entry.qualityLimitationReason =
              stat.qualityLimitationReason && stat.qualityLimitationReason !== 'none'
                ? stat.qualityLimitationReason
                : null
          }
        })
        streams.push(entry)
      }

      /*
       * Klatki WYSTAWIONE na ekran nie ma ich w getStats() — to wlasnosc
       * elementu <video>, a nie polaczenia. Czytamy je z DOM-u i dopisujemy
       * do strumieni przychodzacych. Bez nich nie da sie odroznic "karta nie
       * nadaza" od "strumien nie dochodzi", czyli najwazniejszego rozroznienia
       * w calej tej diagnostyce.
       */
      for (const element of document.querySelectorAll('video.tile__video')) {
        const video = element as HTMLVideoElement
        const peerId = video.dataset.peerId
        if (!peerId || typeof video.getVideoPlaybackQuality !== 'function') continue
        const quality = video.getVideoPlaybackQuality()
        const target = streams.find(
          (stream) => stream.peerId === peerId && stream.direction === 'inbound'
        )
        if (target) {
          target.framesPresented = quality.totalVideoFrames
          target.framesDropped = quality.droppedVideoFrames
        }
      }

      if (!cancelled) await window.companion.pushDiagnostics(streams)
    }

    void collect()
    const timer = setInterval(() => void collect(), SAMPLE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [lobby, enabled])
}
```

- [ ] **Step 2: Wystaw listę połączeń z sesji**

Połączenia są trzymane w **dwóch osobnych mapach** (`outgoing` i `incoming`),
kluczowanych przez `connectionKey(peerId, kind)`, czyli `peerId:rodzaj`.
Kierunku nie trzeba więc zgadywać — wynika z tego, z której mapy element
pochodzi.

W `companion-app/src/renderer/webrtc/session.ts` dopisz typ obok pozostałych
eksportowanych typów:

```ts
export interface DiagnosticConnection {
  peerId: string
  kind: StreamKind
  direction: 'inbound' | 'outbound'
  connection: RTCPeerConnection
}
```

i metodę w klasie `LobbySession`:

```ts
  /**
   * Płaska lista połączeń do odczytu statystyk, z opisem czego dotyczą.
   *
   * Czyta tylko to, co już jest — żadnego nowego stanu ani zegara, zgodnie
   * z układem tej klasy: statystyki czytamy na żądanie.
   *
   * Klucz ma postać `peerId:rodzaj`, a `peerId` jest UUID-em bez dwukropka,
   * więc dzielimy na OSTATNIM dwukropku. Kierunku nie zgadujemy po zawartości
   * połączenia — wiemy go z tego, z której mapy element pochodzi.
   */
  diagnosticConnections(): DiagnosticConnection[] {
    const result: DiagnosticConnection[] = []
    const collect = (
      source: Map<string, RTCPeerConnection>,
      direction: 'inbound' | 'outbound'
    ): void => {
      for (const [key, connection] of source) {
        const separator = key.lastIndexOf(':')
        if (separator <= 0) continue
        result.push({
          peerId: key.slice(0, separator),
          kind: key.slice(separator + 1) as StreamKind,
          direction,
          connection
        })
      }
    }
    collect(this.outgoing, 'outbound')
    collect(this.incoming, 'inbound')
    return result
  }
```

W `companion-app/src/renderer/hooks/useLobby.ts` dopisz pole do **interfejsu
`Lobby`** — bez tego `tsc` nie zobaczy nowej metody u konsumenta:

```ts
  /**
   * Połączenia do odczytu statystyk. Metoda, nie stan: statystyki czytamy na
   * żądanie raz na sekundę, a trzymanie ich w stanie Reacta kazałoby
   * przerysowywać interfejs przy każdej próbce.
   */
  diagnosticConnections: () => DiagnosticConnection[]
```

uzupełnij import o `type DiagnosticConnection` z `../webrtc/session`, a do
zwracanego obiektu dołóż:

```ts
    diagnosticConnections: () => sessionRef.current?.diagnosticConnections() ?? [],
```

- [ ] **Step 3: Zamontuj hook w LobbyView**

W `companion-app/src/renderer/components/LobbyView.tsx` dopisz import:

```ts
import { useDiagnosticsReporter } from '../hooks/useDiagnosticsReporter'
```

i wywołaj go obok pozostałych hooków, **przed wszystkimi instrukcjami `return`**:

```ts
  /*
   * UWAGA: musi stać tutaj, przed instrukcjami `return` niżej. LobbyView
   * wychodzi wcześniej przy `bad-key` i przy otwartym oknie wyboru źródła,
   * a hook wywołany po takim wyjściu łamie zasady Reacta i wywala aplikację
   * przy pierwszym otwarciu pickera. Ta sama pułapka wystąpiła w 0.3.2.
   */
  useDiagnosticsReporter(lobby, options.diagnostics)
```

- [ ] **Step 4: Dopisz `data-peer-id` do kafelka**

Hook dopasowuje element `<video>` do strumienia po identyfikatorze osoby, a dziś nie ma tego w DOM-ie. W `companion-app/src/renderer/components/StreamTile.tsx` dołóż props `peerId: string` i atrybut na elemencie wideo:

```tsx
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className="tile__video"
          data-peer-id={peerId}
        />
```

W `companion-app/src/renderer/components/LobbyView.tsx` przekaż go w miejscu renderowania kafelków: `peerId={row.item.peerId}`.

- [ ] **Step 5: Sprawdź budowanie i testy**

Run: `cd companion-app && npm run build && npm test`
Expected: PASS — bez błędów `tsc`, 173 testy

- [ ] **Step 6: Commit**

```bash
git add companion-app/src/renderer/hooks/useDiagnosticsReporter.ts \
        companion-app/src/renderer/hooks/useLobby.ts \
        companion-app/src/renderer/webrtc/session.ts \
        companion-app/src/renderer/components/LobbyView.tsx \
        companion-app/src/renderer/components/StreamTile.tsx
git commit -m "feat(diagnostyka): zbieranie statystyk WebRTC i klatek wystawionych"
```

---

### Task 9: Pasek zużycia i panel z suwakiem czasu

**Files:**
- Create: `companion-app/src/renderer/components/Diagnostics.tsx`
- Modify: `companion-app/src/renderer/main.tsx`
- Modify: `companion-app/src/renderer/styles.css`

**Interfaces:**
- Consumes: `formatResourceBadge`, `ratesBetween`, `DiagnosticsSample` z Task 2-5; `window.companion.getLatestDiagnostics`, `readDiagnostics`, `getLaunch` z Task 7
- Produces: komponent `Diagnostics`

- [ ] **Step 1: Napisz komponent**

`companion-app/src/renderer/components/Diagnostics.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'
import {
  SAMPLE_INTERVAL_MS,
  formatResourceBadge,
  ratesBetween,
  type DiagnosticsSample
} from '@shared/diagnostics'

function formatRate(value: number | null): string {
  return value === null ? '—' : value.toFixed(1)
}

/**
 * Pasek zużycia i panel diagnostyczny. Wisi w `main.tsx` jako rodzeństwo
 * `<App />`, a nie w jego środku: `App` ma własne wczesne wyjścia
 * („Uruchamianie…", błąd argumentów) i wskaźniki znikałyby w nich. Dane bierze
 * z procesu głównego, więc nie potrzebuje sesji WebRTC.
 */
export function Diagnostics(): JSX.Element | null {
  const [enabled, setEnabled] = useState(false)
  const [latest, setLatest] = useState<DiagnosticsSample | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [history, setHistory] = useState<DiagnosticsSample[]>([])
  const [cursor, setCursor] = useState(0)

  useEffect(() => {
    void window.companion.getLaunch().then((launch) => {
      if (launch.ok) setEnabled(launch.options.diagnostics)
    })
  }, [])

  // Pasek w rogu potrzebuje jednej najnowszej probki, nie calego bufora.
  useEffect(() => {
    if (!enabled) return
    const tick = (): void => {
      void window.companion.getLatestDiagnostics().then(setLatest)
    }
    tick()
    const timer = setInterval(tick, SAMPLE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [enabled])

  const openPanel = useCallback(() => {
    void window.companion.readDiagnostics().then((samples) => {
      setHistory(samples)
      // Suwak staje na koncu: najpierw pokazujemy teraznieszosc, a przewijanie
      // w tyl jest czynnoscia swiadoma.
      setCursor(Math.max(0, samples.length - 1))
      setPanelOpen(true)
    })
  }, [])

  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== 'd') return
      event.preventDefault()
      if (panelOpen) setPanelOpen(false)
      else openPanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, panelOpen, openPanel])

  if (!enabled) return null

  const shown = history[cursor] ?? null
  const previous = cursor > 0 ? history[cursor - 1] : undefined

  return (
    <>
      {latest && <div className="resource-badge">{formatResourceBadge(latest.system)}</div>}

      {panelOpen && (
        <div className="diag" role="dialog" aria-label="Panel diagnostyczny">
          <header className="diag__header">
            <strong>Diagnostyka</strong>
            <span className="diag__hint">Ctrl+Shift+D zamyka</span>
          </header>

          {history.length === 0 ? (
            <p className="diag__empty">Bufor jest pusty — zapis dopiero się rozkręca.</p>
          ) : (
            <>
              <div className="diag__time">
                <input
                  type="range"
                  min={0}
                  max={history.length - 1}
                  value={cursor}
                  onChange={(event) => setCursor(Number(event.target.value))}
                  aria-label="Chwila w czasie"
                />
                <span className="diag__stamp">
                  {shown ? new Date(shown.at).toLocaleTimeString('pl-PL') : '—'}
                  {' · '}
                  {cursor + 1}/{history.length}
                </span>
              </div>

              <p className="diag__system">{shown ? formatResourceBadge(shown.system) : '—'}</p>

              <table className="diag__table">
                <thead>
                  <tr>
                    <th>osoba</th>
                    <th>rodzaj</th>
                    <th>kierunek</th>
                    <th>odebrane</th>
                    <th>zdekodowane</th>
                    <th>wystawione</th>
                    <th>porzucone</th>
                    <th>kb/s</th>
                    <th>ograniczenie</th>
                  </tr>
                </thead>
                <tbody>
                  {(shown?.streams ?? []).map((stream) => {
                    const before = previous?.streams.find(
                      (candidate) =>
                        candidate.peerId === stream.peerId &&
                        candidate.kind === stream.kind &&
                        candidate.direction === stream.direction
                    )
                    const elapsed = shown && previous ? shown.at - previous.at : 0
                    const rates = ratesBetween(before, stream, elapsed)
                    const dropped = rates?.droppedPerS ?? null
                    return (
                      <tr key={`${stream.direction}:${stream.peerId}:${stream.kind}`}>
                        <td>{stream.peerId.slice(0, 8)}</td>
                        <td>{stream.kind === 'screen' ? 'ekran' : 'kamera'}</td>
                        <td>{stream.direction === 'inbound' ? 'odbiór' : 'nadawanie'}</td>
                        <td>{formatRate(rates?.receivedPerS ?? null)}</td>
                        <td>{formatRate(rates?.decodedPerS ?? null)}</td>
                        <td>{formatRate(rates?.presentedPerS ?? null)}</td>
                        <td className={dropped !== null && dropped > 0 ? 'diag__dropped' : ''}>
                          {formatRate(dropped)}
                        </td>
                        <td>{formatRate(rates?.kilobitsPerS ?? null)}</td>
                        <td>{stream.qualityLimitationReason ?? '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 2: Zamontuj jako rodzeństwo `App`**

Zastąp zawartość `companion-app/src/renderer/main.tsx`:

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { Diagnostics } from './components/Diagnostics'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
    {/*
      Rodzeństwo, nie dziecko: `App` ma własne wczesne wyjścia, a wskaźniki
      zużycia mają być widoczne także wtedy, gdy pokazuje „Uruchamianie…"
      albo błąd argumentów wywołania.
    */}
    <Diagnostics />
  </React.StrictMode>
)
```

- [ ] **Step 3: Dopisz styl**

Dopisz na końcu `companion-app/src/renderer/styles.css`:

```css
/* ---------- diagnostyka (tylko przy fladze --diagnostics) ---------- */

/* Pasek zużycia: prawy dolny róg, nad całą zawartością, nieklikany — nie może
   przechwytywać kliknięć w kafelki pod nim. */
.resource-badge {
  position: fixed;
  right: 10px;
  bottom: 8px;
  z-index: 40;
  padding: 3px 8px;
  border-radius: 4px;
  background: rgba(30, 31, 34, 0.82);
  color: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.diag {
  position: fixed;
  inset: 24px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: rgba(30, 31, 34, 0.97);
  overflow: auto;
}

.diag__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.diag__hint,
.diag__stamp,
.diag__empty {
  color: var(--text-muted);
  font-size: 12px;
}

.diag__time {
  display: flex;
  align-items: center;
  gap: 10px;
}

.diag__time input {
  flex: 1;
}

.diag__system {
  margin: 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.diag__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.diag__table th,
.diag__table td {
  padding: 4px 6px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.diag__table th {
  color: var(--text-muted);
  font-weight: 600;
}

/* Porzucone klatki wyróżnione, bo to jedyna z tych liczb, która odpowiada
   słowu „laguje". */
.diag__dropped {
  color: #f0c674;
  font-weight: 600;
}
```

- [ ] **Step 4: Sprawdź budowanie i testy**

Run: `cd companion-app && npm run build && npm test`
Expected: PASS — bez błędów `tsc`, 173 testy

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/renderer/components/Diagnostics.tsx \
        companion-app/src/renderer/main.tsx companion-app/src/renderer/styles.css
git commit -m "feat(diagnostyka): pasek zuzycia i panel z suwakiem czasu"
```

---

### Task 10: Odcisk palca lobby

Jedyna część tego wydania **poza flagą**: zgłoszenie 1 wymaga porównania dwóch wartości z dwóch maszyn, a odcisk widoczny u jednej osoby nie rozstrzygnie niczego.

**Files:**
- Modify: `companion-app/src/renderer/components/PeerPanel.tsx`
- Modify: `companion-app/src/renderer/components/LobbyView.tsx`
- Modify: `companion-app/src/renderer/styles.css`

**Interfaces:**
- Consumes: `shortRoomFingerprint` z Task 5; `LaunchOptions.ts3ServerAddress`, `channelId`, `roomId` z Task 1
- Produces: nic dla dalszych zadań

- [ ] **Step 1: Dołóż props i nagłówek w PeerPanel**

W `companion-app/src/renderer/components/PeerPanel.tsx` dopisz do `PeerPanelProps`:

```ts
  /**
   * Odcisk palca pokoju i opis, z czego go wyliczono. `null` w trybie
   * standalone, gdzie żadnego pokoju nie ma.
   */
  roomFingerprint: { short: string; derivedFrom: string } | null
```

i w nagłówku, obok tytułu:

```tsx
      <header className="peers__header">
        <h2 className="peers__title">Uczestnicy</h2>
        {roomFingerprint && (
          <span className="peers__room" title={roomFingerprint.derivedFrom}>
            lobby {roomFingerprint.short}
          </span>
        )}
        <button
```

Pamiętaj o dopisaniu `roomFingerprint` do listy rozpakowanych propsów w sygnaturze funkcji.

- [ ] **Step 2: Policz odcisk w LobbyView**

W `companion-app/src/renderer/components/LobbyView.tsx` dopisz import:

```ts
import { shortRoomFingerprint } from '@shared/diagnostics'
```

i wylicz wartość obok pozostałych wyliczeń, przed instrukcjami `return`:

```ts
  /*
   * Pokazujemy skrót ORAZ wejścia, z których powstał. Sam skrót powie tylko
   * „różnimy się"; dopiero wejścia powiedzą dlaczego. Najbardziej prawdopodobny
   * przypadek: jedna osoba ma w adresie nazwę domeny, druga adres IP tego
   * samego serwera — `deriveRoomId` normalizuje wielkość liter i spacje, ale
   * `ts.serwer.pl:9987` i `11.22.33.44:9987` to dwa różne pokoje.
   */
  const roomFingerprint =
    options.roomId && options.ts3ServerAddress && options.channelId
      ? {
          short: shortRoomFingerprint(options.roomId),
          derivedFrom: `Pokój wyliczony z: ${options.ts3ServerAddress} · kanał ${options.channelId}`
        }
      : null
```

i przekaż do panelu: `roomFingerprint={roomFingerprint}`.

- [ ] **Step 3: Dopisz styl**

Dopisz w `companion-app/src/renderer/styles.css`, przy pozostałych regułach `.peers__*`:

```css
/* Odcisk palca pokoju. Małym drukiem i wyciszony: to narzędzie diagnostyczne,
   a nie informacja, na którą trzeba patrzeć przy każdym spojrzeniu na panel. */
.peers__room {
  margin-left: auto;
  margin-right: 8px;
  color: var(--text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  cursor: help;
}
```

- [ ] **Step 4: Sprawdź budowanie i testy**

Run: `cd companion-app && npm run build && npm test`
Expected: PASS — bez błędów `tsc`, 173 testy

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/renderer/components/PeerPanel.tsx \
        companion-app/src/renderer/components/LobbyView.tsx \
        companion-app/src/renderer/styles.css
git commit -m "feat(diagnostyka): odcisk palca lobby w naglowku panelu"
```

---

### Task 11: Sprawdzian z prawdziwym oknem

**Files:**
- Create: `companion-app/e2e/diagnostyka.mjs`
- Modify: `companion-app/e2e/cdp.mjs`
- Modify: `companion-app/package.json`

**Interfaces:**
- Consumes: flaga `--diagnostics`, klasa `.resource-badge`, klasa `.peers__room`, plik `userData/diagnostics/YYYY-MM-DD.jsonl`
- Produces: skrypt `e2e:diagnostyka`

Wymaga działającego serwera sygnalizacyjnego. **Bez zrzutów ekranu** — czytamy DOM i plik.

- [ ] **Step 1: Napisz skrypt**

`companion-app/e2e/diagnostyka.mjs`:

```js
// Czy zapis diagnostyczny powstaje, a odcisk palca lobby zgadza sie miedzy
// instancjami?
//
// Trzy rzeczy do potwierdzenia, kazda osobno:
//   1. przy fladze --diagnostics powstaje plik .jsonl z sensownymi polami;
//   2. pasek zuzycia jest w DOM-ie;
//   3. dwie instancje w TYM SAMYM kanale pokazuja IDENTYCZNY odcisk palca,
//      a w dwoch roznych kanalach — rozny.
//
// Punkt 3 jest sednem: odcisk ma rozstrzygac zgloszenie "nie widzimy sie
// w lobby", wiec jego zgodnosc musi byc pilnowana testem, a nie zaufaniem.
//
// Czekanie warunkowe, nie sztywne: lista zrodel pulpitu generuje miniatury
// wszystkich ekranow i okien, a sztywny sleep raz na kilka przebiegow dawal
// "BRAK KARTY" w innych skryptach.
//
// Wymaga dzialajacego serwera sygnalizacyjnego:
//   cd signaling-server && npm start
//
// Uruchomienie: npm run build && npm run e2e:diagnostyka
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attach, launchApp } from './cdp.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const CHANNEL_A = process.env.CHANNEL ?? `diag-e2e-${Date.now()}`
const CHANNEL_B = `${CHANNEL_A}-inny`
const PORT_A = 9421
const PORT_B = 9422
const PORT_C = 9423

function instanceArgs(channel, extra = []) {
  return [
    '--ts3-server=ts.test.pl:9987',
    `--channel=${channel}`,
    '--signaling=ws://127.0.0.1:8080',
    '--use-fake-device-for-media-stream',
    ...extra
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
  throw new Error(`${label}: nie doczekalem sie polaczenia z serwerem sygnalizacyjnym`)
}

const FINGERPRINT = `(() => {
  const el = document.querySelector('.peers__room')
  return el ? JSON.stringify({ text: el.textContent.trim(), title: el.getAttribute('title') }) : null
})()`

const BADGE = `(() => {
  const el = document.querySelector('.resource-badge')
  return el ? el.textContent.trim() : null
})()`

const processes = []
let exitCode = 0
const attached = []

/** Wlasny katalog danych instancji A, zeby wiedziec, gdzie szukac zapisu. */
const dataDirA = mkdtempSync(join(tmpdir(), 'ts3-diag-e2e-'))

try {
  // A i B w tym samym kanale; A z flaga diagnostyki, B bez niej.
  processes.push(launchApp(PORT_A, instanceArgs(CHANNEL_A, ['--diagnostics']), dataDirA))
  processes.push(launchApp(PORT_B, instanceArgs(CHANNEL_A)))
  processes.push(launchApp(PORT_C, instanceArgs(CHANNEL_B)))

  const A = await attach(PORT_A)
  const B = await attach(PORT_B)
  const C = await attach(PORT_C)
  attached.push(A, B, C)

  await waitReady(A, 'A (z diagnostyka)')
  await waitReady(B, 'B (ten sam kanal)')
  await waitReady(C, 'C (inny kanal)')

  console.log('Trzy instancje gotowe. Czekam na probki...')
  await sleep(6_000)

  // --- 1. plik zapisu ---
  // Katalog userData NIE jest tu domyslnym APPDATA: harness podaje aplikacji
  // wlasny --user-data-dir, zeby przebiegi sie nie mieszaly. Tworzymy go sami
  // i przekazujemy do launchApp, a potem czytamy z niego wprost.
  const base = join(dataDirA, 'diagnostics')
  let lines = []
  if (existsSync(base)) {
    for (const name of readdirSync(base)) {
      if (!name.endsWith('.jsonl')) continue
      lines = readFileSync(join(base, name), 'utf8').trim().split('\n').filter(Boolean)
    }
  }
  console.log(`\n=== ZAPIS === linii: ${lines.length}`)
  if (lines.length === 0) {
    console.error('BLAD: plik zapisu nie powstal albo jest pusty')
    exitCode = 1
  } else {
    const last = JSON.parse(lines[lines.length - 1])
    console.log('  ostatnia probka:', JSON.stringify(last.system))
    for (const field of ['at', 'system', 'streams']) {
      if (!(field in last)) {
        console.error(`BLAD: w probce brakuje pola ${field}`)
        exitCode = 1
      }
    }
    if (typeof last.system?.cpuPercent !== 'number') {
      console.error('BLAD: cpuPercent nie jest liczba')
      exitCode = 1
    }
  }

  // --- 2. pasek zuzycia ---
  const badgeA = await A.evaluate(BADGE)
  const badgeB = await B.evaluate(BADGE)
  console.log(`\n=== PASEK === z flaga: ${badgeA} | bez flagi: ${badgeB}`)
  if (!badgeA) {
    console.error('BLAD: brak paska zuzycia w instancji z flaga')
    exitCode = 1
  }
  if (badgeB !== null) {
    console.error('BLAD: pasek pokazal sie BEZ flagi — diagnostyka nie jest bramkowana')
    exitCode = 1
  }

  // --- 3. odcisk palca ---
  const fpA = JSON.parse((await A.evaluate(FINGERPRINT)) ?? 'null')
  const fpB = JSON.parse((await B.evaluate(FINGERPRINT)) ?? 'null')
  const fpC = JSON.parse((await C.evaluate(FINGERPRINT)) ?? 'null')
  console.log('\n=== ODCISK PALCA ===')
  console.log('  A:', JSON.stringify(fpA))
  console.log('  B:', JSON.stringify(fpB))
  console.log('  C:', JSON.stringify(fpC))

  if (!fpA || !fpB || !fpC) {
    console.error('BLAD: odcisk palca nie jest widoczny we wszystkich instancjach')
    console.error('      (ma dzialac BEZ flagi — to jego caly sens)')
    exitCode = 1
  } else {
    if (fpA.text !== fpB.text) {
      console.error(`BLAD: ten sam kanal dal rozne odciski: ${fpA.text} vs ${fpB.text}`)
      exitCode = 1
    }
    if (fpA.text === fpC.text) {
      console.error('BLAD: rozne kanaly daly ten sam odcisk')
      exitCode = 1
    }
    if (!fpA.title || !fpA.title.includes('ts.test.pl:9987')) {
      console.error('BLAD: podpowiedz nie zawiera adresu serwera, z ktorego wyliczono pokoj')
      exitCode = 1
    }
  }

  if (exitCode === 0) console.log('\nOK: zapis powstaje, pasek jest bramkowany, odcisk sie zgadza.')
} catch (err) {
  console.error('\nBLAD sprawdzianu:', err instanceof Error ? err.message : String(err))
  exitCode = 1
} finally {
  for (const cdp of attached) cdp.close()
  for (const proc of processes) proc.kill()
  await sleep(500)
}

process.exit(exitCode)
```

- [ ] **Step 2: Pozwól harnessowi wskazać katalog danych**

`launchApp` w `companion-app/e2e/cdp.mjs` tworzy dziś katalog danych sam i nie
oddaje go wywołującemu, więc sprawdzian nie wiedziałby, gdzie szukać zapisu.
Dołóż **opcjonalny** trzeci parametr, zachowując dotychczasowe zachowanie
pozostałych skryptów:

```js
export function launchApp(port, extraArgs = [], userDataDir) {
  const exe = process.env.APP_EXE
  // Bez podanego katalogu zachowujemy sie jak dotad: swiezy katalog tymczasowy
  // na kazdy przebieg. Podanie go jest potrzebne tylko tam, gdzie sprawdzian
  // musi potem zajrzec do plikow zapisanych przez aplikacje.
  const dataDir = userDataDir ?? mkdtempSync(join(tmpdir(), 'ts3-e2e-'))
  return spawn(
    exe ?? electronPath,
    [
      ...(exe ? [] : ['.']),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dataDir}`,
      ...extraArgs
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  )
}
```

- [ ] **Step 3: Dopisz skrypt npm**

W `companion-app/package.json`, w `scripts`, obok `"e2e:sesja"`:

```json
    "e2e:diagnostyka": "node e2e/diagnostyka.mjs",
```

- [ ] **Step 4: Uruchom sprawdzian**

W jednym terminalu: `cd signaling-server && npm start`

W drugim:

```bash
cd companion-app && npm run build && npm run e2e:diagnostyka
```

Expected: `OK: zapis powstaje, pasek jest bramkowany, odcisk sie zgadza.` i kod wyjścia 0.

Jeśli sprawdzian zgłosi błąd — **to jest prawdziwa usterka do zdiagnozowania, a nie powód do rozluźnienia sprawdzianu.** Nie zmiękczaj asercji ani nie wydłużaj czekania bez uzasadnienia.

Posprzątaj po sobie: zatrzymaj serwer sygnalizacyjny i upewnij się, że nie zostały wiszące procesy Electrona.

- [ ] **Step 5: Commit**

```bash
git add companion-app/e2e/diagnostyka.mjs companion-app/e2e/cdp.mjs \
        companion-app/package.json
git commit -m "test(diagnostyka): sprawdzian zapisu, bramkowania flaga i odcisku palca"
```

---

### Task 12: Wersja 0.3.3 i dokumentacja

**Files:**
- Modify: `companion-app/package.json`
- Modify: `TODO.md`

- [ ] **Step 1: Podnieś wersję**

W `companion-app/package.json` zmień `"version": "0.3.2"` na `"version": "0.3.3"`.

- [ ] **Step 2: Dopisz podsumowanie do TODO.md**

W `TODO.md`, w sekcji `## 5`, pod wpisem o kawałku A, dopisz:

```markdown
### B — panel diagnostyczny i wskaźniki zużycia (0.3.3, ZROBIONE)

Zapis szeregu czasowego co sekundę, panel-podgląd z suwakiem czasu, pasek
zużycia w rogu i odcisk palca lobby. Spec:
`docs/superpowers/specs/2026-10-13-panel-diagnostyczny-design.md`.

**Rzecz, która rządziła całym projektem:** objaw zdarza się wtedy, gdy nikt
nie patrzy na aplikację. Dlatego zapis jest źródłem prawdy, a panel tylko
jego podglądem — panel pokazujący wyłącznie teraźniejszość odpowiadałby na
„czy laga teraz", a pytanie brzmi „dlaczego lagało".

**Rejestrator mieszka w procesie głównym, nie w rendererze**, bo renderer
jest podejrzanym: dziennik prowadzony przez podejrzanego przestaje być
dziennikiem dokładnie wtedy, gdy staje się potrzebny.

**Odcisk palca lobby jest jedyną częścią POZA flagą.** Zgłoszenie 1 wymaga
porównania dwóch wartości z dwóch maszyn; odcisk widoczny u jednej osoby nie
rozstrzygnąłby niczego. Podpowiedź pokazuje adres serwera i numer kanału,
bo to one się różnią, nie skrót.

**Pułapka znaleziona przy okazji:** `readFlags` w `cli.ts` po cichu gubił
flagi bez wartości — samo `--diagnostics` nigdy nie trafiało do mapy. Było
to zamierzone dla flag Electrona, więc obsługa flag logicznych doszła
świadomie, z testem na oba ustawienia w wierszu poleceń.

**Odczyt GPU z wstrzykiwanym uruchamiaczem** (`readGpu`), żeby dała się
przetestować ścieżka, która w praktyce zdarza się najczęściej: brak
`nvidia-smi`. Brak odczytu to zawsze `null`, nigdy zero — zero znaczyłoby
„karta nic nie robi".

**Następny krok:** wrócić do kawałka A z zapisem z prawdziwej sesji ze
zdalnym nadawcą i odpowiedzieć, które ogniwo łańcucha siada.
```

- [ ] **Step 3: Sprawdź całość**

Run: `cd companion-app && npm test && npm run build`
Expected: PASS — 173 testy, budowanie bez błędów

- [ ] **Step 4: Commit**

```bash
git add companion-app/package.json TODO.md
git commit -m "docs: wersja 0.3.3 i domkniecie kawalka B"
```

---

## Kolejność i zależności

Zadania 1-5 są czystą logiką i można je robić po kolei bez dotykania interfejsu.
Task 6 zależy od 2-3, Task 7 od 2-6, Task 8 od 7, Task 9 od 7, Task 10 od 1 i 5.
Task 11 wymaga 9 i 10 (czyta ich klasy CSS). Task 12 na końcu.

Po Task 7 zapis już działa i da się go obejrzeć w pliku — dobry moment na
pierwsze sprawdzenie, czy liczby mają sens, zanim powstanie interfejs.
