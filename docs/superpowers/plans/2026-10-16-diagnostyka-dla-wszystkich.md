# Diagnostyka dla wszystkich — plan wdrożenia (0.3.4, część 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Licznik zużycia CPU/GPU/RAM i dziennik lobby dostępne dla każdego bez flagi, a zapis na dysk za polem wyboru zapamiętywanym między uruchomieniami.

**Architecture:** Jedna flaga `--diagnostics` rozpada się na dwie niezależne sprawy: podgląd (zawsze włączony, obsługa IPC rejestrowana bezwarunkowo) i zapis na dysk (za ustawieniem z `<userData>/settings.json`). Dziennik lobby żyje jako pierścień w procesie głównym, bo renderer jest tym, co diagnozujemy. Każda decyzja, która ma mieć test, mieszka w `src/shared/*`, bo vitest chodzi w gołym Node bez jsdom.

**Tech Stack:** Electron 33 (Chromium 130), React 18 w `StrictMode`, TypeScript, vitest, IPC `ipcMain.handle`/`invoke`, rejestr Windows przez `reg query`.

**Spec:** `docs/superpowers/specs/2026-10-16-diagnostyka-dla-wszystkich-design.md`

## Global Constraints

- Identyfikatory po angielsku; komentarze i teksty dla człowieka po polsku z pełnymi znakami diakrytycznymi; komunikaty commitów w czystym ASCII, zakończone linią `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- vitest chodzi w **gołym Node bez jsdom** — nie ma `document` ani `window`. Komponentów i hooków nie testujemy; decyzja, która ma mieć test, musi być czystą funkcją w `src/shared/*`.
- `test/**/*.ts` jest w `include` w `tsconfig.json`, więc błąd typu w teście wywala `npm run build`.
- `src/shared/diagnostics.ts` ma 783 linie — nowe rzeczy idą do NOWYCH plików w `src/shared/`.
- Stan wyjściowy każdego zadania **odczytaj pomiarem** (`npm test`), nie z tego planu. Liczba rośnie z każdym zadaniem i każdy wpisany tu numer po dniu jest nieprawdą — ta linia mówiła „340 w 18 plikach", gdy faktycznie było 371 w 20.
- **Zadanie, które dodaje kanał IPC, modyfikuje TAKŻE `src/main/index.ts`.** Stałe w `shared/ipc.ts` i funkcja w preloadzie nie wystarczą — bez `ipcMain.handle` kanał jest martwym napisem. Nadziałem się na to dwa razy: raz z `formatGpuCard` (zadanie 2 wyprodukowało tekst, którego nikt nie wołał, co wyszło dopiero z bundla), raz z kanałami dziennika. Sprawdzaj obecność w `out/main/index.js`, a nie tylko w źródle.
- **Funkcja z `src/shared/*`, ktorej nikt nie wola, WYPADA Z BUNDLA przy tree-shakingu — niezaleznie od tego, ile ma testow.** To samo pietro wyzej niz regula o `ipcMain.handle`: wykonawca zadania 6 zmierzyl, ze `formatLogEntry` bylo w bundlu renderera obecne **zero razy** przed jego zadaniem, choc zadanie 4 mialo na nia test — test przypinal wiec decyzje, ktorej nic nie pokazywalo. Sprawdzaj grepem `out/renderer/assets/*.js`, `out/preload/index.js` i `out/main/index.js` OSOBNO, bo kazdy bundel ma inna poprawna odpowiedz: czesc napisow ma byc w jednym i nie ma byc w drugim.
- `vi.useFakeTimers()` jest **dozwolone** (pierwszy raz użyte w zadaniu 4, zegar przywracany w `finally`). Alternatywą byłby test czekający sekundę, czyli wolniejszy i chwiejny.
- **NIE URUCHAMIAJ** aplikacji ani niczego z `companion-app/e2e/` — te skrypty otwierają prawdziwe okna na maszynie właściciela i przechwytują jego pulpit. Dozwolone: `npx tsc --noEmit`, `npm test`, `npm run build`, `node --check`.
- Windows jest jedyną platformą docelową.
- **Wszystkie kroki `Run:` wykonuje się z katalogu `companion-app/`, a ścieżki w `git add` są względne wobec korzenia repozytorium.** Te dwa katalogi są różne i mieszanie ich kosztuje rundę.

## Review Focus

Pięć rzeczy, które specyfikacja zakłada, a które najłatwiej zepsuć. Każda ma swój test w zadaniu, które jest właścicielem kodu:

1. **`settings.json` uszkodzony, niepełny albo z obcymi typami** — ma dać wartości domyślne, a nie wywalić start aplikacji. Test w zadaniu 1.
2. **Maszyna bez karty NVIDIA** — pasek ma powiedzieć, jaką kartę widzi i że zużycia dla niej nie zna; sama kreska to dziś nieodróżnialne od zawieszonego sterownika. Test w zadaniu 2.
3. **`nvidia-smi` obecny, ale zawieszony** — istniejący mechanizm `GPU_STALE_AFTER_MS` ma dalej pokazywać kreskę z godziną ostatniego odczytu. Odbramkowanie nie może go złamać. Test w zadaniu 3.
4. **Długa sesja** — pierścień dziennika nie może rosnąć bez ograniczenia; najstarsze wpisy wypadają. Test w zadaniu 4.
5. **Przestawienie pola wyboru W TRAKCIE sesji** — wpisy i próbki mają być nadal widoczne w oknie (podgląd nie zależy od ustawienia), a zapis na dysk ma się zacząć albo skończyć bez restartu aplikacji. Test w zadaniu 4, na dzienniku.

   **Uczciwie o zasięgu tego testu:** przypięta zostaje połowa dziennikowa, bo `src/main/lobbyLog.ts` jest nowy i bierze zależności parametrami (wzór z `src/main/updateLogger.ts`; takich modułów jest dziś **trzy** — doszły `main/settings.ts` z zadania 1 i `main/lobbyLog.ts` z zadania 4). Połowa dotycząca próbek NIE jest przypięta testem jednostkowym: `src/main/diagnosticsRecorder.ts` importuje `app` i `ipcMain` na poziomie modułu, więc w gołym Node nie da się go wczytać, a to repozytorium nie ma żadnego mockowania Electrona i ta część nie jest dobrym miejscem, żeby je zakładać. Tam niezmiennik pilnuje czytanie kodu (rejestracja kanałów podglądu musi stać POZA jakimkolwiek warunkiem) i sprawdzenie właściciela w żywym oknie. Nie pisz na to testu-atrapy, który tylko wygląda na dowód.

---

### Task 1: Plik ustawień

**Files:**
- Create: `companion-app/src/shared/settings.ts`
- Create: `companion-app/src/main/settings.ts`
- Test: `companion-app/test/settings.test.ts`

**Interfaces:**
- Produces: `interface Settings { recordDiagnostics: boolean }`; `DEFAULT_SETTINGS: Settings`; `parseSettings(raw: string | null): Settings`; `serializeSettings(settings: Settings): string`; oraz z `main/settings.ts`: `readSettings(userDataPath: string): Settings`, `writeSettings(userDataPath: string, settings: Settings): boolean`

> **WYKONANE** (commit `2a33fa6`, 357 testów). `writeSettings` zwraca `boolean` (`true` = plik powstał), a nie `void` jak pisał pierwotny plan. Powód zgłoszony przez wykonawcę i przyjęty: `src/main/updateLogger.ts` sam dokumentuje, że spakowana aplikacja Windows nie ma podpiętej konsoli, więc `console.warn` idzie w próżnię — przy `void` nieudany zapis byłby całkowicie niewidoczny, a pole wyboru z zadania 7 pokazywałoby „włączone" i po cichu wracało do „wyłączone" po restarcie. Zadanie 7 MA z tego wyniku skorzystać.

- [ ] **Step 1: Napisz testy `parseSettings`**

```ts
test('brak pliku daje wartości domyślne', () => {
  expect(parseSettings(null)).toEqual({ recordDiagnostics: false })
})

test('uszkodzony JSON daje wartości domyślne, nie wyjątek', () => {
  expect(parseSettings('{to nie jest json')).toEqual(DEFAULT_SETTINGS)
})

test('obcy typ pola jest odrzucany na rzecz wartości domyślnej', () => {
  // Nie `Boolean('nie')`, bo to dałoby `true` — napis „nie" znaczyłby „tak".
  expect(parseSettings('{"recordDiagnostics":"nie"}')).toEqual(DEFAULT_SETTINGS)
})

test('nieznane klucze są ignorowane, znane zachowane', () => {
  expect(parseSettings('{"recordDiagnostics":true,"czegoNieZnamy":7}')).toEqual({
    recordDiagnostics: true
  })
})

test('zapis i odczyt wracają tym samym', () => {
  expect(parseSettings(serializeSettings({ recordDiagnostics: true }))).toEqual({
    recordDiagnostics: true
  })
})
```

- [ ] **Step 2: Uruchom testy i potwierdź, że padają**

Run: `npx vitest run test/settings.test.ts`
Expected: FAIL — brak modułu `src/shared/settings.ts`.

- [ ] **Step 3: Zaimplementuj `parseSettings` i `serializeSettings` w `src/shared/settings.ts`**

`parseSettings` nigdy nie rzuca: każdy błąd składni i każde pole złego typu schodzi do wartości domyślnej. Pole przyjmujemy tylko wtedy, gdy `typeof === 'boolean'` — rzutowanie przez `Boolean()` zamieniłoby napis „nie" na `true`. Napisz to w komentarzu, bo to jest pułapka, nie oczywistość.

- [ ] **Step 4: Uruchom testy i potwierdź, że przechodzą**

Run: `npx vitest run test/settings.test.ts`
Expected: PASS

- [ ] **Step 5: Zaimplementuj `readSettings`/`writeSettings` w `src/main/settings.ts`**

Ścieżka to `join(userDataPath, 'settings.json')`. `userDataPath` jest **parametrem, nie importem** `app` — tak samo jak w `src/main/updateLogger.ts`, żeby dało się to kiedykolwiek sprawdzić bez Electrona; zajrzyj tam po wzór. `readSettings` zwraca `parseSettings(null)` także wtedy, gdy plik jest nieczytelny z powodu uprawnień. `writeSettings` nie może wywalić aplikacji, gdy zapis się nie uda — zaloguj i jedź dalej.

- [ ] **Step 6: Sprawdź całość i zacommituj**

Run: `npx tsc --noEmit && npm test`
Expected: `tsc` zero, liczba testów większa o nowe.

```bash
git add companion-app/src/shared/settings.ts companion-app/src/main/settings.ts companion-app/test/settings.test.ts
git commit -m "feat(ustawienia): plik settings.json z odpornym parsowaniem"
```

---

### Task 2: Wykrywanie karty graficznej

**Files:**
- Create: `companion-app/src/shared/gpuInfo.ts`
- Modify: `companion-app/src/main/metrics.ts`
- Test: `companion-app/test/gpu-info.test.ts`

**Interfaces:**
- Consumes: `GpuReading`, `SystemStats` z `@shared/diagnostics`
- Produces: `interface GpuCard { name: string; memoryMb: number | null; utilizationAvailable: boolean }`; `parseGpuRegistry(stdout: string): GpuCard | null`; `isNvidia(name: string): boolean`; `formatGpuCard(card: GpuCard | null): string`

- [ ] **Step 1: Napisz testy parsowania i opisu**

Do testu parsowania weź **prawdziwy** kształt wyjścia `reg query`, nie wymyślony: wartości przychodzą wierszami `    NazwaWartości    REG_TYPE    dana`, a `qwMemorySize` jest szesnastkowe. Testy nazwij i napisz tak:

```ts
test('rozpoznaje nazwę karty i pamięć z rejestru', () => {
  // 12282 MB — karta 12 GB. Win32_VideoController.AdapterRAM podaje tu 4095 MB
  // (przepełnienie uint32), dlatego czytamy rejestr.
  const card = parseGpuRegistry(REG_OUTPUT_NVIDIA)
  expect(card?.memoryMb).toBe(12282)
})

test('karta bez wpisu o pamięci daje null, nie zero', () => {
  // Zero znaczyłoby „karta bez pamięci"; null znaczy „nie wiem".
  expect(parseGpuRegistry(REG_OUTPUT_NO_MEMORY)?.memoryMb).toBeNull()
})

test('puste wyjście rejestru daje null', () => {
  expect(parseGpuRegistry('')).toBeNull()
})

test('isNvidia nie zgaduje po samym słowie w nazwie modelu', () => {
  expect(isNvidia('NVIDIA GeForce RTX 4070')).toBe(true)
  expect(isNvidia('AMD Radeon RX 7800 XT')).toBe(false)
  expect(isNvidia('Intel(R) Arc(TM) A770')).toBe(false)
})

test('opis karty bez dostępnego zużycia mówi, czego nie wie', () => {
  // Punkt 2 z Review Focus: sama kreska jest nieodróżnialna od zawieszonego
  // sterownika, więc tekst MUSI nazwać kartę i powiedzieć, że zużycia nie znamy.
  const text = formatGpuCard({
    name: 'AMD Radeon RX 7800 XT',
    memoryMb: 16384,
    utilizationAvailable: false
  })
  expect(text).toContain('AMD Radeon RX 7800 XT')
  expect(text).toMatch(/niedostępne/i)
})

test('brak rozpoznanej karty też jest powiedziany wprost', () => {
  expect(formatGpuCard(null)).toMatch(/nie rozpozna/i)
})
```

- [ ] **Step 2: Uruchom testy i potwierdź, że padają**

Run: `npx vitest run test/gpu-info.test.ts`

- [ ] **Step 3: Zaimplementuj `src/shared/gpuInfo.ts`**

`utilizationAvailable` to `isNvidia(name)` i nic więcej — dla pozostałych kart zużycia nie czytamy, bo licznik systemowy Windows kosztuje 3,9 s przeciw 46,5 ms dla `nvidia-smi` (zmierzone, 84 razy gorzej). Zapisz tę liczbę w komentarzu: bez niej następna osoba spróbuje „dorobić AMD" i odkryje to dopiero po zacięciu interfejsu.

- [ ] **Step 4: Uruchom testy i potwierdź, że przechodzą**

- [ ] **Step 5: Wykryj kartę RAZ, przy starcie, w `src/main/metrics.ts`**

> **WYKONANE** (commit `688d350`, 370 testów). Sprostowanie pomiaru: **„6 ms" było nieprawdą.** Zmierzone na maszynie właściciela — sam klucz klasy bez `/s` to 11,5 ms, ale **nie zawiera żadnych danych o karcie** (te leżą w podkluczach `0000`, `0001`, …); `/s` po całej klasie przekracza 3 s i wpada w `timeout`, czyli oczywista droga z planu dawała `null` na stałe u KAŻDEGO. Działające rozwiązanie to dwa równoległe zapytania `/s /v` o konkretne wartości: **24 ms end-to-end**. Dalej „dziesiątki milisekund", ale cztery razy drożej niż obiecałem.

Dodaj `detectGpuCard(): Promise<GpuCard | null>` czytające
`HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}` przez `execFile('reg', ...)` — tak samo nieblokująco jak dzisiejsze `runNvidiaSmi`, i z takim samym `timeout`. Wynik zapamiętaj w module; karta nie zmienia się w trakcie sesji. `startGpuPolling` ma **nie odpytywać `nvidia-smi` wcale**, gdy wykryta karta nie jest NVIDIĄ: dziś uruchamia proces co 5 s tylko po to, żeby dostać błąd.

- [ ] **Step 6: Sprawdź całość i zacommituj**

Run: `npx tsc --noEmit && npm test && npm run build`

```bash
git add companion-app/src/shared/gpuInfo.ts companion-app/src/main/metrics.ts companion-app/test/gpu-info.test.ts
git commit -m "feat(diagnostyka): wykrywanie karty graficznej, nie tylko NVIDII"
```

---

### Task 3: Licznik dla każdego — rozdzielenie bramki

**Files:**
- Modify: `companion-app/src/main/diagnosticsRecorder.ts`
- Modify: `companion-app/src/main/index.ts:169`
- Modify: `companion-app/src/renderer/components/Diagnostics.tsx`
- Modify: `companion-app/src/renderer/hooks/useDiagnosticsReporter.ts`
- Modify: `companion-app/src/shared/ipc.ts`, `companion-app/src/preload/index.ts`
- Modify: `companion-app/src/shared/diagnostics.ts` (jedno słowo `export`, patrz krok 6)
- Test: `companion-app/test/diagnostics.test.ts` (istniejący, dopisanie)

**Interfaces:**
- Consumes: `readSettings` z zadania 1; `detectedGpuCard(): GpuCard | null` i `formatGpuCard` z zadania 2
- Produces: `registerDiagnostics(options: { recordToDisk: boolean })` — podgląd rejestrowany bezwarunkowo, zapis na dysk za flagą z ustawień; kanał `IPC_GPU_CARD`

> **POPRAWKA PLANU po zadaniu 2.** Zadanie 2 wyprodukowało `formatGpuCard`, ale pierwotny plan **nie przydzielił go nikomu do wywołania** — wykonawca udowodnił to buildem: napisy były wytrzebione z bundla, bo nic ich nie importuje. Bez tego kroku punkt 2 z „Review Focus" (użytkownik AMD ma odróżnić „nie mam karty NVIDIA" od „sterownik się zawiesił") zostałby niedostarczony po cichu, a część 2 zamknęłaby się z martwym kodem. Konsumenta dostaje to zadanie — kroki 5 i 6 niżej.

- [ ] **Step 1: Napisz test punktu 3 z Review Focus**

Mechanizm przestarzałego odczytu GPU jest już zaimplementowany i przetestowany; ten test pilnuje, że odbramkowanie go nie złamie. Dopisz do `test/diagnostics.test.ts`:

```ts
test('zawieszony sterownik pokazuje kreskę z godziną, nie ostatnie procenty', () => {
  // GPU_STALE_AFTER_MS po odczycie pasek nie ma prawa podawać jego liczb jako
  // bieżących. Przed odbramkowaniem pilnowała tego flaga; teraz pasek widzi
  // KAŻDY, więc ten niezmiennik jest ważniejszy, nie mniej ważny.
  const stats: SystemStats = {
    cpuPercent: 10,
    memoryMb: 500,
    gpu: { utilizationPercent: 77, memoryUsedMb: 1, memoryTotalMb: 2, at: 1_000 }
  }
  const text = formatResourceBadge(stats, 1_000 + GPU_STALE_AFTER_MS + 1)
  expect(text).not.toContain('77')
})
```

- [ ] **Step 2: Uruchom i sprawdź, czy pada**

Run: `npx vitest run test/diagnostics.test.ts`
Expected: ten test ma PRZEJŚĆ od razu, bo mechanizm istnieje. To test regresji, nie nowej funkcji — napisz to w komentarzu nad nim, żeby nikt nie szukał brakującej implementacji.

- [ ] **Step 3: Rozdziel bramkę w `diagnosticsRecorder.ts`**

`registerDiagnostics` przyjmuje teraz obiekt. Kanały `IPC_DIAGNOSTICS_PUSH` i `IPC_DIAGNOSTICS_LATEST` rejestrują się **zawsze**; `recordToDisk` decyduje wyłącznie o pisaniu plików. Bufor w pamięci działa niezależnie od zapisu — pasek i tabela strumieni mają z czego żyć.

- [ ] **Step 4: Zdejmij bramkę w rendererze**

W `Diagnostics.tsx` usuń stan `enabled`, odczyt `getLaunch()` i `if (!enabled) return null`. W `useDiagnosticsReporter.ts` usuń parametr `enabled` i jego gałąź. **Usuń też komentarze, które po tej zmianie kłamią:** oba pliki ostrzegają dziś, że wołanie kanału bez flagi kończy się odrzuconą obietnicą („No handler registered") — to przestaje być prawdą, a komentarz, który kłamie, jest w tym projekcie gorszy niż brak komentarza. W miejsce tego ostrzeżenia wpisz, dlaczego obsługa jest teraz bezwarunkowa.

- [ ] **Step 5: Wystaw wykrytą kartę na ekran**

Dodaj kanał `IPC_GPU_CARD` do `src/shared/ipc.ts`, wystaw go w `src/preload/index.ts` obok istniejących, obsłuż w procesie głównym przez `detectedGpuCard()` z zadania 2 (rejestracja **bezwarunkowa**, jak pozostałe kanały podglądu) i wyrenderuj `formatGpuCard(card)` przy pasku zużycia w `Diagnostics.tsx`.

Kartę czytaj **raz**, przy montowaniu — nie zegarem. Nie zmienia się w trakcie sesji, a zadanie 2 wykrywa ją jednorazowo przy starcie.

Tekst o karcie musi wyglądać **inaczej** niż kreska z godziną, którą pokazuje istniejący mechanizm przestarzałego odczytu (`GPU_STALE_AFTER_MS`). Inaczej dołożysz drugą nieodróżnialną kreskę i nie rozwiążesz punktu 2 z „Review Focus", tylko go przepiszesz w nowe miejsce.

- [ ] **Step 6: Zlikwiduj zdublowaną konwencję zapisu liczb**

`formatGigabytes` jest prywatne w `src/shared/diagnostics.ts`, a zadanie 2 musiało powtórzyć te trzy linie w `gpuInfo.ts`, żeby nie wychodzić poza swoją listę plików. Konwencja zapisu wielkości pamięci jest więc teraz w dwóch miejscach i rozjedzie się przy pierwszej zmianie. Dopisz `export` w `diagnostics.ts`, zaimportuj w `gpuInfo.ts`, usuń kopię.

- [ ] **Step 7: Sprawdź całość i zacommituj**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: `tsc` zero; `grep -rn "formatGpuCard" src/` pokazuje co najmniej jedno WYWOŁANIE poza `gpuInfo.ts`, nie tylko wzmianki w komentarzach.

```bash
git add companion-app/src/main/diagnosticsRecorder.ts companion-app/src/main/index.ts companion-app/src/renderer/components/Diagnostics.tsx companion-app/src/renderer/hooks/useDiagnosticsReporter.ts companion-app/src/shared/ipc.ts companion-app/src/preload/index.ts companion-app/src/shared/diagnostics.ts companion-app/src/shared/gpuInfo.ts companion-app/test/diagnostics.test.ts
git commit -m "feat(diagnostyka): licznik zuzycia i karta graficzna widoczne bez flagi"
```

---

### Task 4: Pierścień dziennika lobby

**Files:**
- Create: `companion-app/src/shared/lobbyLog.ts`
- Create: `companion-app/src/main/lobbyLog.ts`
- Modify: `companion-app/src/shared/ipc.ts`
- Modify: `companion-app/src/preload/index.ts`
- Test: `companion-app/test/lobby-log.test.ts`

**Interfaces:**
- Produces: `type LogLevel = 'event' | 'error'`; `interface LogEntry { at: number; level: LogLevel; text: string }`; `LOG_RING_MAX_ENTRIES: number`; `appendLogEntry(ring: readonly LogEntry[], entry: LogEntry): LogEntry[]`; `formatLogEntry(entry: LogEntry): string`; kanały `IPC_LOBBY_LOG_PUSH`, `IPC_LOBBY_LOG_READ`

- [ ] **Step 1: Napisz testy pierścienia**

```ts
test('pierścień nie rośnie powyżej swojego ograniczenia', () => {
  // Punkt 4 z Review Focus: długa sesja nie może zjeść pamięci.
  let ring: LogEntry[] = []
  for (let i = 0; i < LOG_RING_MAX_ENTRIES + 50; i++) {
    ring = appendLogEntry(ring, { at: i, level: 'event', text: `wpis ${i}` })
  }
  expect(ring).toHaveLength(LOG_RING_MAX_ENTRIES)
})

test('przy przepełnieniu wypadają NAJSTARSZE wpisy', () => {
  let ring: LogEntry[] = []
  for (let i = 0; i < LOG_RING_MAX_ENTRIES + 1; i++) {
    ring = appendLogEntry(ring, { at: i, level: 'event', text: `wpis ${i}` })
  }
  expect(ring[0]?.text).toBe('wpis 1')
  expect(ring.at(-1)?.text).toBe(`wpis ${LOG_RING_MAX_ENTRIES}`)
})

test('appendLogEntry nie zmienia tablicy wejściowej', () => {
  const ring: LogEntry[] = [{ at: 1, level: 'event', text: 'pierwszy' }]
  appendLogEntry(ring, { at: 2, level: 'error', text: 'drugi' })
  expect(ring).toHaveLength(1)
})

test('wpis błędu jest w tekście odróżnialny od zdarzenia', () => {
  // Bez tego dziennik jest ścianą tekstu, w której nie widać, co jest awarią.
  const event = formatLogEntry({ at: 0, level: 'event', text: 'Michał wszedł' })
  const error = formatLogEntry({ at: 0, level: 'error', text: 'Nieznany peer' })
  expect(event).not.toBe(error.replace('Nieznany peer', 'Michał wszedł'))
})
```

- [ ] **Step 2: Uruchom testy i potwierdź, że padają**

- [ ] **Step 3: Zaimplementuj `src/shared/lobbyLog.ts`**

`LOG_RING_MAX_ENTRIES` ustaw na konkretną liczbę i **uzasadnij ją w komentarzu rachunkiem** (ile to minut typowej sesji przy spodziewanej częstotliwości zdarzeń, ile pamięci), a nie „wydaje się dość". `formatLogEntry` daje czas lokalny z sekundami i znacznik poziomu.

- [ ] **Step 4: Uruchom testy i potwierdź, że przechodzą**

- [ ] **Step 5: Napisz test bramkowania zapisu (punkt 5 z Review Focus)**

Te testy padają na BRAKU MODUŁU `src/main/lobbyLog.ts` („Cannot find module"), a nie na asercji — modułu jeszcze nie ma, powstaje w kroku 6. Nie diagnozuj tego jako awarii; wykonawca zadania 1 stracił na tym rundę, bo plan obiecywał tam zielono.

```ts
test('wypchnięty wpis trafia do pierścienia niezależnie od zapisu na dysk', () => {
  // Podgląd NIE zależy od ustawienia — zależy od niego wyłącznie pisanie
  // plików. Rozjazd tych dwóch spraw jest cichy: wszystko dalej wygląda
  // poprawnie, tylko znika to, po co to zrobiliśmy.
  const written: string[] = []
  const log = createLobbyLog({ appendLine: (line) => written.push(line), recordToDisk: false })
  log.push({ at: 1, level: 'event', text: 'Michał wszedł' })
  expect(log.read()).toHaveLength(1)
  expect(written).toEqual([])
})

test('przestawienie zapisu w trakcie działa bez tworzenia dziennika od nowa', () => {
  const written: string[] = []
  const log = createLobbyLog({ appendLine: (line) => written.push(line), recordToDisk: false })
  log.push({ at: 1, level: 'event', text: 'przed włączeniem' })
  log.setRecordToDisk(true)
  log.push({ at: 2, level: 'event', text: 'po włączeniu' })
  // Pierścień ma oba wpisy, dysk tylko ten po włączeniu — zapisu nie
  // uzupełniamy wstecz, bo zgoda dotyczy chwili, w której jej udzielono.
  expect(log.read()).toHaveLength(2)
  expect(written).toHaveLength(1)
})
```

- [ ] **Step 6: Zaimplementuj właściciela w `src/main/lobbyLog.ts` i kanały IPC**

Pierścień trzyma proces główny — renderer jest tym, co diagnozujemy, więc gdyby on był właścicielem, przestawałby zapisywać dokładnie w interesującej nas chwili; pierścień przeżywa też przeładowanie renderera.

`createLobbyLog({ appendLine, recordToDisk })` bierze **zapis linii jako parametr, nie import** — to ten sam wzór co `createUpdateLogger(userDataPath)` w `src/main/updateLogger.ts` i jedyny powód, dla którego bramkowanie z kroku 5 da się w ogóle sprawdzić w gołym Node. Zajrzyj tam, zanim zaczniesz. Zwracany obiekt ma `push`, `read` i `setRecordToDisk`.

Kanały dopisz do `src/shared/ipc.ts` i wystaw w `src/preload/index.ts` obok istniejących; zajrzyj do nich po wzór nazewnictwa. Rejestracja **bezwarunkowa**, tak jak w zadaniu 3.

- [ ] **Step 7: Sprawdź całość i zacommituj**

Run: `npx tsc --noEmit && npm test && npm run build`

```bash
git add companion-app/src/shared/lobbyLog.ts companion-app/src/main/lobbyLog.ts companion-app/src/shared/ipc.ts companion-app/src/preload/index.ts companion-app/test/lobby-log.test.ts
git commit -m "feat(dziennik): pierscien wpisow lobby w procesie glownym"
```

---

### Task 5: Zamiana zdarzeń sesji na wpisy

**Files:**
- Create: `companion-app/src/shared/lobbyEvents.ts`
- Create: `companion-app/src/renderer/hooks/useLobbyLog.ts`
- Modify: `companion-app/src/renderer/components/LobbyView.tsx`
- Test: `companion-app/test/lobby-events.test.ts`

**Interfaces:**
- Consumes: `LogEntry`, `LogLevel` z zadania 4; callbacki sesji `onError`, `onPeersChange`, `onStreamersChange`, `onUnreachableChange` z `src/renderer/webrtc/session.ts:183-201`
- Produces: `peerChangeEntries(before: readonly string[], after: readonly string[], at: number): LogEntry[]`; `streamChangeEntries(before: readonly StreamRef[], after: readonly StreamRef[], at: number): LogEntry[]`; `errorEntry(message: string, at: number): LogEntry`; `unreachableEntries(before: readonly string[], after: readonly string[], at: number): LogEntry[]`

> **WYKONANE** (commit `edc11fc`, 424 testy). **Trzy rzeczy w tej sekcji były nieprawdą** — potwierdzone czytaniem kodu:
>
> 1. **Źródłem jest STAN, nie callbacki.** `onError`, `onPeersChange`, `onStreamersChange` i `onUnreachableChange` konsumuje `useLobby` w środku i do komponentu nie docierają; widać stąd wyłącznie `lobby.state` (`useLobby.ts:95-119`). Wpisy powstają więc z RÓŻNICY dwóch kolejnych stanów i to jest cały powód, żeby ta logika była czysta.
> 2. **`peerChangeEntries` bierze `PeerInfo[]`, a nie `string[]`** — `lobby.state.peers` to `PeerInfo[]`. W pliku siedzi strukturalny `NamedPeer`, bo `src/shared/*` nie zależy od renderera (ten sam zwyczaj co `buildParticipants`).
> 3. **Nazwy osób SĄ dostępne** — `PeerInfo.displayName` (`SignalingClient.ts:9-12`). Polecenie z kroku 3 („wpisz identyfikator i napisz w komentarzu, że to świadome") pogorszyłoby dziennik, który czyta człowiek, często komuś przez telefon: wpis brzmi „Michał wszedł do lobby", nie „a3f9c1 wszedł do lobby". `StreamRef` i `unreachablePeerIds` nazwy nie niosą, więc `streamChangeEntries` i `unreachableEntries` dostały czwarty parametr `nameOf: (peerId: string) => string` — parametrem, żeby zostały czyste. Doszły `nameResolver(me, peers)` i `lobbyLogEntries(before, after, at)`, bo złożenie resolwera i reguła „co jest tu zmianą" to też decyzje i w hooku byłyby nie do sprawdzenia.
>
> **Szpara zostawiona świadomie i opisana przy `lobbyLogEntries`:** `error` to JEDNO nadpisywane pole, nie kolejka, więc dwa identyczne błędy pod rząd bez wyczyszczenia pola między nimi dają jeden wpis. Czyszczenie na `null` zdarza się w `useLobby` w trzech miejscach, więc sekwencja błąd → ponowna próba → ten sam błąd przechodzi. Zamknięcie tego wymagałoby kolejki błędów w `useLobby`, czyli rozlania dziennika na dwie warstwy.
>
> **Czego ten dziennik nie zobaczy** (do wiadomości zadania 6, które te wpisy pokazuje): zmian pola `connection` — „połączono z pokojem" nie ma w ogóle, bo udane wejście tylko czyści `error`. Przy wejściu widać za to cały skład jako wpisy „wszedł do lobby", bo punktem odniesienia jest stan pusty.

- [ ] **Step 1: Napisz testy zamiany**

Callbacki sesji dają **stan**, nie zdarzenia, więc wpisy powstają z RÓŻNICY dwóch stanów. To jest cała trudność tego zadania i cały powód, żeby ta logika była czysta.

```ts
test('wejście i wyjście osoby dają po jednym wpisie', () => {
  expect(peerChangeEntries(['a'], ['a', 'b'], 0)).toHaveLength(1)
  expect(peerChangeEntries(['a', 'b'], ['a'], 0)).toHaveLength(1)
})

test('brak zmiany nie daje żadnego wpisu', () => {
  // Callbacki stanu odpalają też wtedy, gdy nic się nie zmieniło; bez tego
  // dziennik zasypałby się powtórzeniami i stałby się bezużyteczny.
  expect(peerChangeEntries(['a', 'b'], ['b', 'a'], 0)).toEqual([])
})

test('ekran i kamera tej samej osoby to dwa osobne wpisy', () => {
  // Ten niezmiennik obowiązuje w całym projekcie: ta sama osoba nadająca oba
  // rodzaje ma DWA strumienie i to jest celowe.
  const before: StreamRef[] = []
  const after: StreamRef[] = [
    { peerId: 'a', kind: 'screen' },
    { peerId: 'a', kind: 'camera' }
  ]
  expect(streamChangeEntries(before, after, 0)).toHaveLength(2)
})

test('wpis o niedostępności jest błędem, nie zdarzeniem', () => {
  expect(unreachableEntries([], ['a'], 0)[0]?.level).toBe('error')
})

test('powrót dostępności jest zdarzeniem, nie błędem', () => {
  expect(unreachableEntries(['a'], [], 0)[0]?.level).toBe('event')
})

test('błąd sesji trafia do dziennika z poziomem błędu', () => {
  expect(errorEntry('Nieznany peer', 5).level).toBe('error')
})
```

- [ ] **Step 2: Uruchom testy i potwierdź, że padają**

- [ ] **Step 3: Zaimplementuj `src/shared/lobbyEvents.ts`**

Teksty po polsku, zrozumiałe bez znajomości kodu: nie „peer joined", a „Michał wszedł do lobby".

**Poprawione przy wykonaniu** (pierwotnie stało tu, że nazw osób nie ma i trzeba wpisać identyfikator — to była nieprawda): nazwy SĄ dostępne, `PeerInfo` ma `displayName`, więc wpisy o osobach noszą nazwy. `StreamRef` i `unreachablePeerIds` nazwy nie niosą, więc tamte funkcje biorą resolwer `nameOf` **parametrem** — bo to jedyny sposób, żeby zostały czyste, a nie zakładniczkami stanu uczestników. Każde zdanie trzyma nazwę w MIANOWNIKU („Michał — połączenie padło", nie „połączenie z Michałem padło"): nick z TS3 bywa ozdobny i nie da się go odmienić.

- [ ] **Step 4: Uruchom testy i potwierdź, że przechodzą**

- [ ] **Step 5: Podepnij hook `useLobbyLog` i wypychanie do procesu głównego**

Hook trzyma poprzedni stan w `useRef` i przy każdej zmianie liczy różnicę, a wynikowe wpisy wypycha kanałem z zadania 4. **Pułapka, która w tym projekcie wystąpiła już dwa razy:** hook musi stać PRZED instrukcjami `return` w `LobbyView` — komponent ma wczesne wyjścia przy `bad-key` (linia ~448) i przy otwartym wyborze źródła (~459), a hook wywołany po takim wyjściu łamie zasady Reacta i wywala aplikację przy pierwszym otwarciu pickera. Postaw go razem z pozostałymi hookami.

- [ ] **Step 6: Sprawdź całość i zacommituj**

Run: `npx tsc --noEmit && npm test && npm run build`

```bash
git add companion-app/src/shared/lobbyEvents.ts companion-app/src/renderer/hooks/useLobbyLog.ts companion-app/src/renderer/components/LobbyView.tsx companion-app/test/lobby-events.test.ts
git commit -m "feat(dziennik): zdarzenia lobby zamieniane na wpisy czystymi funkcjami"
```

---

### Task 6: Panel dziennika pod guzikiem

**Files:**
- Modify: `companion-app/src/renderer/components/Diagnostics.tsx`
- Modify: `companion-app/src/renderer/styles.css`

**Interfaces:**
- Consumes: `IPC_LOBBY_LOG_READ` z zadania 4, `formatLogEntry` z zadania 4

- [ ] **Step 1: Dołóż guzik i panel**

Guzik widoczny dla każdego, w rogu obok paska zużycia. Panel na wzór istniejącego `.diag` (`Diagnostics.tsx:316` i dalej) — ten sam `role="dialog"`, ten sam sposób zamykania, ta sama warstwa. Nie drugie okno systemowe: powód jest w specyfikacji i ma trafić do komentarza, razem z jego ceną (nie da się czytać dziennika na drugim monitorze, patrząc na strumienie).

- [ ] **Step 2: Odświeżanie treści**

Panel czyta pierścień przy otwarciu i potem co sekundę, dopóki jest otwarty — **nie** gdy jest zamknięty. Zegar chodzący przy zamkniętym panelu dokładałby pracy w aplikacji, w której diagnozujemy lag.

- [ ] **Step 3: Styl**

Dopisz reguły obok istniejących `.diag*`. Dziennik jest listą przewijalną, z najnowszym wpisem na dole, i musi odróżniać błąd od zdarzenia kolorem **oraz** czymś poza kolorem (znacznik tekstowy), bo sam kolor jest nieczytelny dla części ludzi.

- [ ] **Step 4: Sprawdź budowanie i zacommituj**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: `tsc` zero, liczba testów bez zmian (panelu nie da się przetestować bez jsdom).

```bash
git add companion-app/src/renderer/components/Diagnostics.tsx companion-app/src/renderer/styles.css
git commit -m "feat(dziennik): okno dziennika lobby pod guzikiem"
```

---

### Task 7: Pole wyboru zamiast flagi

**Files:**
- Modify: `companion-app/src/shared/cli.ts`
- Modify: `companion-app/src/main/index.ts`
- Modify: `companion-app/src/main/diagnosticsRecorder.ts`
- Modify: `companion-app/src/main/lobbyLog.ts`
- Modify: `companion-app/src/renderer/components/SettingsPanel.tsx`
- Modify: `companion-app/src/shared/ipc.ts`, `companion-app/src/preload/index.ts`
- Modify: `companion-app/package.json` (usunięcie skryptu npm, patrz krok 6)
- Modify: `companion-app/e2e/diagnostyka.mjs` (patrz krok 7 — NIE uruchamiaj go)
- Delete: `companion-app/scripts/diagnostyka.ps1`
- Test: `companion-app/test/cli.test.ts` (istniejący), `companion-app/test/settings.test.ts` (istniejący)

**Interfaces:**
- Consumes: `Settings`, `readSettings`, `writeSettings` z zadania 1
- Produces: kanały `IPC_GET_SETTINGS`, `IPC_SET_SETTINGS`; `setRecordToDisk(enabled: boolean): void` w `diagnosticsRecorder.ts` i `lobbyLog.ts`

- [ ] **Step 1: Napisz test, że flaga naprawdę zniknęła**

Punkt 5 z Review Focus jest już przypięty w zadaniu 4 i nie powtarzamy go tutaj atrapą.

Dopisz do `test/cli.test.ts` test, że `--diagnostics` jest teraz **nieznaną flagą** i nie trafia do `LaunchOptions`. Bez tego usunięcie pola przeszłoby po cichu, a stary skrót w czyimś pliku `.lnk` zacząłby być ignorowany bez śladu. Zajrzyj do istniejących testów w tym pliku po wzór — jest tam już obsługa flag nieznanych i to jej zachowanie ma teraz objąć `--diagnostics`.

- [ ] **Step 2: Uruchom testy i potwierdź wynik**

- [ ] **Step 3: Usuń flagę**

Wywal pole `diagnostics` z `LaunchOptions` w `src/shared/cli.ts` (linie 40-46, 114, 124, 144) i wszystkie jego odczyty. `tsc` wskaże miejsca — przejdź po nich wszystkich, nie tylko po tych z planu.

- [ ] **Step 4: Podepnij ustawienie do obu właścicieli zapisu**

Proces główny czyta ustawienia przy starcie i przekazuje `recordDiagnostics` do `registerDiagnostics` oraz do dziennika. Kanał `IPC_SET_SETTINGS` zapisuje plik **i** przestawia zapis na gorąco przez `setRecordToDisk` — bez restartu aplikacji, bo o to właśnie szło w punkcie 5.

`writeSettings` zwraca `boolean` (zadanie 1). **Wykorzystaj ten wynik**: gdy zapis się nie udał, pole wyboru nie może pokazywać stanu, który nie przeżyje restartu — powiedz to człowiekowi jednym zdaniem przy polu. Milczenie w tym miejscu jest kłamstwem interfejsu: ustawienie wygląda na zapamiętane, a nie jest.

- [ ] **Step 5: Dołóż pole wyboru w `SettingsPanel.tsx`**

Etykieta mówi, co to robi, a nie jak się nazywa w kodzie: chodzi o zapisywanie diagnostyki na dysk. Pod nią jedno zdanie, gdzie te pliki lądują, bo inaczej nikt ich nie znajdzie. W `styles.css` jest już klasa `.settings__checkbox` — użyj jej.

- [ ] **Step 6: Usuń skrypt, który stracił rację bytu**

`companion-app/scripts/diagnostyka.ps1` istniał wyłącznie po to, żeby podstawić flagę `--diagnostics`: czekał na instancję uruchomioną przez wtyczkę, czytał jej linię poleceń, zamykał ją i uruchamiał ponownie z flagą. Po tej zmianie panel jest dostępny bez żadnego z tych kroków.

```bash
git rm companion-app/scripts/diagnostyka.ps1
```

**Dwie pułapki od wykonawcy zadania 4, który ten plik otwierał obok:**

- **Asymetria `setRecordToDisk`, której NIE WOLNO ujednolicać.** W `diagnosticsRecorder.ts` włączenie **musi** dodatkowo zawołać `openLog()`, bo `appendLine` wychodzi na wejściu przy `logPath === null` (długi komentarz na miejscu tłumaczy dlaczego). W `main/lobbyLog.ts` **nie musi i nie wolno tego kopiować** — tamten plik otwiera się leniwie przy pierwszej linii. Wyglądają na bliźniacze, a nie są.
- **Zdublowana konwencja znacznika czasu w nazwie pliku.** `diagnosticsRecorder.openLog` ma prywatną kopię tych pięciu linii (`pad`, data, godzina), a `lobbyLogFileName` w `src/shared/lobbyLog.ts` ma tę samą rzecz, tylko **przetestowaną**. To ta sama dubla, którą zadanie 3 wycięło dla `formatGigabytes`, i nikt jej dotąd nie przydzielił. Zawołaj wspólny pomocnik z `shared/lobbyLog.ts` w `openLog`, zamiast trzymać dwie konwencje nazw plików w jednym katalogu.

Usuń też wpis `"diagnostyka"` ze `scripts` w `companion-app/package.json` (linia 34) — wskazuje na plik, którego po tym kroku nie ma, więc zostałby martwym skrótem wywalającym się przy wywołaniu. **Nie ruszaj** `"e2e:diagnostyka"` (linia 24), to inny, żywy skrypt.

- [ ] **Step 7: Napraw `e2e/diagnostyka.mjs`, który po odbramkowaniu pilnuje ODWROTNOŚCI celu**

**Tego skryptu NIE URUCHAMIAJ** — otwiera prawdziwe okna Electrona i przechwytuje pulpit właściciela. Naprawiasz go czytając; sprawdzenie naprawy należy do właściciela i w raporcie powiedz wprost, że jest niesprawdzona.

Dwa niezależne miejsca, oba potwierdzone czytaniem:

1. **Linia 517**, asercja `[2 pasek] pasek pokazał się BEZ flagi — diagnostyka nie jest bramkowana`, traktuje odbramkowanie jako AWARIĘ. Był to poprawny sprawdzian w 0.3.3 i jest dokładną odwrotnością celu 0.3.4. Odwróć go: pasek ma być teraz obecny w OBU instancjach, bo widzi go każdy. Nagłówek pliku (linie 1 i 8) też mówi o bramkowaniu flagą — popraw.
2. **Linia 414** uruchamia instancję z `--diagnostics` (flaga już nie istnieje) do świeżego katalogu z `mkdtempSync`, a linia 475 wymaga, by powstał plik `YYYY-MM-DD-HHmmss.jsonl`. Zapis bierze się teraz z `settings.json`, którego w świeżym katalogu nie ma, więc domyślnie jest wyłączony i asercja pada. Zapisz `settings.json` z `recordDiagnostics: true` do katalogu danych tej instancji **przed** uruchomieniem i zdejmij flagę z wywołania.

Na koniec `node --check e2e/diagnostyka.mjs` oraz `grep -n -- "--diagnostics" e2e/diagnostyka.mjs` — nie ma zostać ani jedno odwołanie do flagi.

- [ ] **Step 8: Sprawdź całość i zacommituj**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: `tsc` zero; `grep -rn "options.diagnostics" src/` puste — **po zadaniu 3 już jest**, więc usunięcie pola z `LaunchOptions` jest czysto mechaniczne.

```bash
git add -A companion-app/src companion-app/test
git commit -m "feat(ustawienia): pole wyboru zapisu diagnostyki zamiast flagi"
```

---

### Task 8: Zerwanie połączenia z serwerem trafia do dziennika

**Files:**
- Modify: `companion-app/src/renderer/hooks/useLobby.ts`
- Modify: `companion-app/src/shared/lobbyEvents.ts`
- Test: `companion-app/test/lobby-events.test.ts` (istniejący, dopisanie)

**Interfaces:**
- Consumes: `LogEntry` z zadania 4; `LobbySnapshot`, `lobbyLogEntries` z zadania 5
- Produces: pole w `LobbySnapshot` niosące zerwanie oraz wpis o poziomie `error`

> **Zadanie dopisane po zadaniu 5.** Jego wykonawca znalazł to w kodzie, a ja potwierdziłem: `SignalingClient` emituje zdarzenie zamknięcia gniazda (`SignalingClient.ts:61-64`), ale **nikt go nie subskrybuje** — ani `session.ts`, ani `useLobby.ts`; grep po obu wzorcach nazwy tego zdarzenia w obu plikach jest pusty. Czyli gdy gniazdo do serwera sygnalizacyjnego padnie, ani `connection`, ani `error` się nie zmienia: aplikacja wygląda na połączoną, choć jest głucha, a dziennik nie pokaże najważniejszego wiersza przy „nagle wszystko stanęło". To jest dokładnie ten objaw, który właściciel zgłosił jako najbardziej dokuczliwy — ktoś wychodzi i nie może wrócić do tego samego lobby, trzeba wyjść i wejść.

**ZAKRES: wyłącznie diagnostyczny.** Dopisujesz WPIS do dziennika i nic więcej. **Nie** zmieniaj `connection` na `error`, **nie** dodawaj ponawiania połączenia, **nie** ruszaj interfejsu. Zmiana zachowania przy zerwanym gnieździe to osobna sprawa z listy właściciela — tutaj chodzi tylko o to, żeby dziennik przestał milczeć o najważniejszej przyczynie.

- [ ] **Step 1: Napisz failujący test wpisu**

Dopisz do `test/lobby-events.test.ts` test, że zerwanie połączenia daje dokładnie jeden wpis o poziomie `error`, oraz że powtórzone zerwanie bez odzyskania połączenia nie mnoży wpisów. Trzymaj się reguły MIANOWNIKA z zadania 5 — nazwy z nicków TS3 nie da się odmienić po polsku.

- [ ] **Step 2: Uruchom i potwierdź, że pada**

Run: `npx vitest run test/lobby-events.test.ts`

- [ ] **Step 3: Rozszerz `LobbySnapshot` i `lobbyLogEntries`**

Nowe pole w migawce; różnica liczona tak jak pozostałe. Żadnej nowej ścieżki — wpis jedzie tym samym kanałem co reszta.

- [ ] **Step 4: Zasubskrybuj zamknięcie gniazda w `useLobby`**

Tylko odnotowanie w stanie, które zasila migawkę. **Nie** dotykaj `connection`. Napisz w komentarzu, dlaczego zakres jest celowo wąski: zachowanie przy zerwaniu to osobna decyzja właściciela, a mieszanie jej z diagnostyką zmieniłoby to, co widzi użytkownik, w zadaniu, które miało tylko zacząć notować.

- [ ] **Step 5: Sprawdź całość i zacommituj**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: `tsc` zero; subskrypcja zamknięcia gniazda obecna w `useLobby.ts`.

```bash
git add companion-app/src/renderer/hooks/useLobby.ts companion-app/src/shared/lobbyEvents.ts companion-app/test/lobby-events.test.ts
git commit -m "feat(dziennik): zerwanie polaczenia z serwerem trafia do dziennika"
```

---

### Task 9: Dziennik nie może mylić stanu ze zdarzeniem

**Files:**
- Modify: `companion-app/src/renderer/components/Diagnostics.tsx`
- Modify: `companion-app/src/shared/lobbyLog.ts`
- Modify: `companion-app/src/renderer/styles.css`
- Test: `companion-app/test/lobby-log.test.ts` (istniejący, dopisanie)

**Interfaces:**
- Consumes: `formatLogEntry`, `LogEntry` z zadania 4
- Produces: funkcja składająca nagłówek daty dla panelu

> **Zadanie dopisane po zadaniu 6.** Jego wykonawca zgłosił dwie rzeczy jako decyzje właściciela, zamiast rozstrzygać je sam, i obie przyjmuję do wykonania. To nie są kosmetyki: dotyczą tego, czy dziennik mówi prawdę o CZASIE, a cały ten przyrząd istnieje po to, żeby odpowiedzieć na pytanie „co się stało i kiedy".

**Rzecz pierwsza: skład obecny przed naszym wejściem jest opisany jak zdarzenie.** Punktem odniesienia dla różnicy stanów jest stan pusty, więc wszyscy, którzy siedzieli w pokoju, zanim weszliśmy, dostają wpis „wszedł do lobby" **ze znacznikiem chwili naszego wejścia**. Czytający weźmie to za dowód, że ktoś wszedł o 22:31, choć siedział tam od godziny. Napraw to jedną wyciszoną linią nad listą, mówiącą wprost, że pierwsze wpisy to skład zastany w chwili dołączenia, a nie zdarzenia. Kosztuje ~30 px stałej wysokości panelu i jest tego warte: dziennik, który myli stan ze zdarzeniem, prowadzi diagnozę w złą stronę, a to jest dokładnie ta szkoda, której ten przyrząd ma zapobiegać.

**Rzecz druga: `formatLogEntry` nie niesie daty.** W zadaniu 4 było to świadome („w oknie wszystkie wpisy są z tej sesji"), ale sesja przechodząca przez północ daje w oknie godziny niejednoznaczne — a wieczorne sesje grania przez północ przechodzą regularnie. Na dysku datę niesie tylko nazwa pliku. **Nie dodawaj daty do każdej linii** (rozdęłaby plik i okno bez potrzeby); pokaż ją RAZ, w nagłówku panelu, i zadbaj o to, żeby przy sesji przechodzącej przez północ nagłówek nie kłamał — czyli albo podaj zakres dat, albo wstaw wiersz rozdzielający w liście. Rozstrzygnij które i uzasadnij w komentarzu.

- [ ] **Step 1: Napisz failujące testy**

Dopisz do `test/lobby-log.test.ts` testy funkcji składającej nagłówek: dla wpisów z jednego dnia, dla wpisów z dwóch dni (przejście przez północ), i dla pustego pierścienia. Nazwij w asercjach dokładne napisy, nie kształty.

- [ ] **Step 2: Uruchom i potwierdź, że padają**

Run: `npx vitest run test/lobby-log.test.ts`

- [ ] **Step 3: Zaimplementuj funkcję w `src/shared/lobbyLog.ts`**

Czysta funkcja, bo to jedyne miejsce w tym repozytorium, które daje się przetestować.

- [ ] **Step 4: Dołóż obie linie w panelu i styl**

Wyciszona linia o składzie zastanym oraz nagłówek daty. Styl obok istniejących reguł `.diag-log*`; pamiętaj o budżecie rogu, który zadanie 6 ustawiło na dwóch regułach `:has()` o różnym czasie życia — panel rośnie o te dwie linie, więc sprawdź, czy jego dolna krawędź nadal nie przykrywa guzika, którym się go zamyka.

- [ ] **Step 5: Sprawdź całość i zacommituj**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: `tsc` zero; nowe napisy obecne w `out/renderer/assets/*.js` (ta pułapka wyszła na tej gałęzi już trzy razy — funkcja z `src/shared/*` bez wywołania wypada z bundla przy tree-shakingu, niezależnie od tego, ile ma testów).

```bash
git add companion-app/src/shared/lobbyLog.ts companion-app/src/renderer/components/Diagnostics.tsx companion-app/src/renderer/styles.css companion-app/test/lobby-log.test.ts
git commit -m "fix(dziennik): panel nie myli skladu zastanego ze zdarzeniem"
```

---

## Na koniec części 2

1. Przegląd całej gałęzi — **obu** części razem, bo część pierwsza była recenzowana osobno i jej recenzent nie widział tego kodu.
2. Sprawdzenie w żywym oknie, które należy do właściciela: `npm run e2e:siatka`, przeciąganie kafelków ludzkim okiem, oraz to, czy licznik i dziennik faktycznie pokazują sensowne liczby na jego maszynie i jego karcie.
3. Scalenie do `main` i wydanie 0.3.4 — **raz, dla obu części**. Właściciel poprosił o to wprost: „ale żeby obydwa były w jednym scaleniu i releasie".
