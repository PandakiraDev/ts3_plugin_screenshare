import type { StreamKind } from './types'

export interface GpuReading {
  utilizationPercent: number
  memoryUsedMb: number
  memoryTotalMb: number
  /**
   * Własny znacznik czasu: odczyt GPU NIE jest jednoczesny z resztą próbki.
   * Pochodzi z osobnego procesu, który wraca po ~46,5 ms, a zegar na niego nie
   * czeka — blokada procesu głównego dawałaby zacinanie interfejsu, czyli
   * dokładnie to, czego w tej aplikacji szukamy. Odpytywanie jest przy tym
   * rzadsze niż próbkowanie (`GPU_POLL_INTERVAL_MS`), więc odczyt starszy od
   * próbki jest tu normą, a nie wyjątkiem.
   *
   * Zegar ścienny (`Date.now()`), ten sam co `DiagnosticsSample.at`: wiek
   * odczytu liczy się jako różnica tych dwóch, więc muszą pochodzić z jednego
   * źródła. Znacznik powstaje PO powrocie wywołania, więc opisuje chwilę, w
   * której wartości były znane, a nie chwilę, w której o nie zapytaliśmy.
   *
   * Czytelnikami są `formatResourceBadge` (pasek) i `formatSystemLine`
   * (panel): po `GPU_STALE_AFTER_MS` oba pokazują kreskę z godziną tego
   * odczytu zamiast liczb. Bez tego zawieszony `nvidia-smi` zamrażałby na
   * pasku i w panelu ostatnie liczby na zawsze. W panelu godzina jest
   * widoczna zawsze, bo tam rzadsze odpytywanie karty daje pięć identycznych
   * odczytów pod rząd i trzeba je czymś wyjaśnić.
   */
  at: number
}

export interface SystemStats {
  cpuPercent: number
  memoryMb: number
  /** `null` znaczy „nie wiemy", nigdy „karta nic nie robi". */
  gpu: GpuReading | null
}

/**
 * Strona łańcucha, której dotyczy wpis.
 *
 * Alias, a nie literał powtórzony w sygnaturach: ta sama para wartości
 * rozstrzyga teraz, które kolumny panelu mają dla wiersza sens
 * (`columnAppliesTo`), więc jest regułą, a nie zapisem pola.
 */
export type StreamDirection = 'inbound' | 'outbound'

export interface StreamStats {
  peerId: string
  kind: StreamKind
  direction: StreamDirection
  /** Pola nieobecne dla danego kierunku są `null`, a nie zerem. */
  framesReceived: number | null
  framesDecoded: number | null
  framesPresented: number | null
  framesDropped: number | null
  framesEncoded: number | null
  framesSent: number | null
  /**
   * Ta sama reguła co dla liczników klatek: brak odczytu to `null`, nigdy zero.
   * Bez wpisu `inbound-rtp`/`outbound-rtp` (uzgadnianie ICE w toku, połączenie
   * zamknięte między pobraniem listy a odczytem statystyk) nie wiemy, ile
   * bajtów poszło — a `0` czytałoby się jako „nadaję zero kilobitów", czyli
   * fałszywa diagnoza w wierszu, w którym bajty są dziś JEDYNĄ liczbą.
   */
  bytes: number | null
  qualityLimitationReason: string | null
}

export interface DiagnosticsSample {
  at: number
  /**
   * Który proces zapisał tę linię. Nadawany raz przy starcie rejestratora.
   *
   * NIE USUWAJ tego pola „bo mamy jedno okno": ta gałąź świadomie nie bierze
   * `requestSingleInstanceLock`, więc dwa okna z flagą `--diagnostics` piszą
   * do katalogu naraz, a przy starcie w tej samej sekundzie nawet do jednego
   * pliku. Bez znacznika w KAŻDEJ linii (nie w nagłówku pliku — linie się
   * przeplatają) czytający widzi jedną sesję, w której co sekundę zmienia się
   * komplet strumieni, i wnioskuje „połączenia zrywają się i wracają co
   * sekundę". To ten sam błędny wniosek, któremu zapobiega `streamsAgeMs`.
   */
  instanceId: string
  system: SystemStats
  streams: StreamStats[]
  /**
   * Ile milisekund mają dane o strumieniach w tej próbce, licząc od chwili,
   * gdy proces główny je ODEBRAŁ od renderera. `null` znaczy, że renderer nie
   * przysłał ich ani razu.
   *
   * To wiek od odebrania, nie od odczytu w rendererze: różnica to czas
   * `getStats()` plus kolejka IPC i rośnie przy głodzeniu renderera, czyli
   * właśnie w badanym przypadku (patrz `streamsReceivedAt`).
   *
   * Bez tego pola nie da się odróżnić „nie ma strumieni" od „renderer
   * przestał się odzywać" — a to drugie jest objawem, którego szukamy:
   * zagłodzony renderer przestaje wysyłać, a rejestrator w procesie głównym
   * tyka dalej. Stare liczby powtarzane w kolejnych próbkach kazałyby
   * wskazać złe ogniwo łańcucha.
   */
  streamsAgeMs: number | null
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

/**
 * Kolumna liczbowa tabeli strumieni: tempo licznika albo powód ograniczenia
 * jakości, który tempem nie jest, ale stoi w tej samej tabeli.
 */
export type StreamColumn = keyof StreamRates | 'qualityLimitationReason'

/**
 * Których kierunków dotyczy dana kolumna.
 *
 * Każdy wiersz ma STRUKTURALNIE puste cztery z sześciu kolumn klatkowych, bo
 * liczniki pochodzą z trzech różnych źródeł, a na drugim kierunku tych źródeł
 * nie ma wcale (patrz `useDiagnosticsReporter`):
 *
 * - `receivedPerS`, `decodedPerS` — z wpisu `inbound-rtp`, którego na
 *   połączeniu wychodzącym nie ma;
 * - `presentedPerS`, `droppedPerS` — z elementu `<video>`, który istnieje
 *   tylko po stronie odbierającej;
 * - `encodedPerS`, `sentPerS` — z wpisu `outbound-rtp`, którego na połączeniu
 *   przychodzącym nie ma;
 * - `qualityLimitationReason` — pole samego `outbound-rtp`: koder mówi, czemu
 *   zszedł z jakości, a odbierający o cudzym koderze nie wie nic;
 * - `kilobitsPerS` — bajty liczą się w obie strony
 *   (`bytesReceived`/`bytesSent`).
 *
 * `Record` po `StreamColumn`, a nie dwie listy nazw: nowe pole w `StreamRates`
 * wywali kompilację, dopóki ktoś nie rozstrzygnie, którego kierunku dotyczy —
 * a cicho dołożona kolumna wróciłaby dokładnie do usterki, którą to zamyka.
 */
const COLUMN_DIRECTIONS: Record<StreamColumn, readonly StreamDirection[]> = {
  receivedPerS: ['inbound'],
  decodedPerS: ['inbound'],
  presentedPerS: ['inbound'],
  droppedPerS: ['inbound'],
  encodedPerS: ['outbound'],
  sentPerS: ['outbound'],
  kilobitsPerS: ['inbound', 'outbound'],
  qualityLimitationReason: ['outbound']
}

/**
 * Czy ta kolumna w ogóle dotyczy tego kierunku.
 *
 * Panel ma dwa zupełnie różne komunikaty do przekazania i bez tej reguły
 * pokazywał oba tą samą kreską: „tego pola tu nie ma" (strukturalnie, zawsze)
 * i „pole jest, ale nie ręczę za liczbę" (przestarzałe dane, brak poprzedniej
 * próbki, cofnięty licznik). Zlane w jedno, połowa każdego wiersza wyglądała
 * na awarię przyrządu, a wiersz nadawania — na martwy.
 */
export function columnAppliesTo(column: StreamColumn, direction: StreamDirection): boolean {
  return COLUMN_DIRECTIONS[column].includes(direction)
}

export const SAMPLE_INTERVAL_MS = 1_000
export const BUFFER_MAX_AGE_MS = 10 * 60 * 1_000
/**
 * Tyle próbek mieści się w oknie wieku przy interwale próbkowania: dokładnie
 * dziesięć minut przy 1 Hz. Sam sufit nie zostawia zapasu. Istnieje jako
 * zabezpieczenie na wypadek, gdy filtr wieku zawiedzie, na przykład po cofnięciu
 * zegara, gdy w buforze siedzą dwie epoki naraz.
 */
export const BUFFER_MAX_SAMPLES = BUFFER_MAX_AGE_MS / SAMPLE_INTERVAL_MS

/**
 * Jak często odpytujemy kartę graficzną — rzadziej niż próbkujemy.
 *
 * `nvidia-smi` to jedyne miejsce, w którym przyrząd dotyka badanego obiektu:
 * odpytuje sterownik karty, czyli główny podejrzany w zgłoszeniu „laguje, gdy
 * gram". Jedno wywołanie mierzy 46,5 ms (min 45,5, max 47,9; z tego ~10 ms to
 * samo uruchomienie procesu) i jest o trzy rzędy wielkości droższe od
 * wszystkiego innego w tym przyrządzie razem (zapis linii 0,164 ms,
 * `JSON.stringify` 0,0067 ms, serializacja IPC 0,012 ms).
 *
 * Co sekundę to 4,6% rdzenia STALE, także gdy panel jest zamknięty, i 36 000
 * uruchomień procesu na dziesięciogodzinny wieczór. Co pięć sekund to 0,9%
 * rdzenia i 7 200 uruchomień.
 *
 * Rozrzedzenie jest darmowe projektowo, bo odczyt nigdy nie musiał być
 * jednoczesny z próbką — po to właśnie `GpuReading.at` ma własny znacznik
 * czasu. Częstotliwość równa `SAMPLE_INTERVAL_MS` wynikała wyłącznie z symetrii
 * z zegarem próbek.
 */
export const GPU_POLL_INTERVAL_MS = 5 * SAMPLE_INTERVAL_MS

/**
 * Sufit rozmiaru jednego pliku zapisu.
 *
 * To nie jest budżet sesji, tylko bezpiecznik przed plikiem rosnącym bez końca
 * (zapętlony zegar, zapis nie wiadomo jak długi). Jedna sesja musi się w nim
 * zmieścić CAŁA, bo zapis jest źródłem prawdy: objaw zdarza się wtedy, gdy
 * nikt nie patrzy, więc plik ucięty w połowie wieczoru milczy dokładnie o tej
 * godzinie, o którą pytamy.
 *
 * Zmierzony rozmiar linii przy pełnych UUID-ach i realnych licznikach, oraz
 * ile zajmie dziesięciogodzinny wieczór przy 1 Hz:
 *
 *   2 osoby, tylko ekran      (2 połączenia)    768 B/linia    26 MiB
 *   2 osoby, ekran + kamera   (4 połączenia)  1 317 B/linia    45 MiB
 *   4 osoby, ekran + kamera  (12 połączeń)   3 513 B/linia   121 MiB
 *   6 osób, ekran + kamera   (20 połączeń)   5 709 B/linia   196 MiB
 *
 * 256 MiB bierze najgorszy wiersz z zapasem. Poprzednie 8 MiB kończyło się po
 * 24,5 minuty przy sześciu osobach. Chudszy zapis tego nie ratował (też
 * zmierzone): zaokrąglenie `cpuPercent` i `memoryMb` daje 99% rozmiaru,
 * skrócenie `peerId` do ośmiu znaków 90%, wyrzucenie pól `null` 62% — czyli
 * 39 minut zamiast 24,5.
 */
export const LOG_SIZE_CEILING_BYTES = 256 * 1024 * 1024

/**
 * Ile plików zapisu zostaje w katalogu `userData/diagnostics`.
 *
 * Nic dotąd nie usuwało tych plików, a przy stale włączonej fladze katalog
 * rósł bez ograniczenia — tym bardziej po podniesieniu sufitu wyżej.
 *
 * Liczba plików, a NIE wiek: dwie reguły w jednej są zbędne, bo sama liczba
 * ogranicza katalog, a do tego jest odporna na zegar — „starsze niż N dni"
 * wyrzucałoby cały zapis po przestawieniu zegara w przód.
 */
export const LOG_FILES_KEPT = 20

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

  // Całkowitość wynika z `--format=csv,noheader,nounits`: bez jednostek i bez
  // części dziesiętnej. `Number.isFinite` łapie liczby z ponad 308 cyframi,
  // które `Number` zamienia na `Infinity`.
  const numbers = parts.map((part) => {
    if (!/^\d+$/.test(part)) return null
    const value = Number(part)
    return Number.isFinite(value) ? value : null
  })
  if (numbers.some((value) => value === null)) return null

  const [utilizationPercent, memoryUsedMb, memoryTotalMb] = numbers as number[]
  return { utilizationPercent, memoryUsedMb, memoryTotalMb, at }
}

/**
 * Odczyt GPU z wstrzykiwanym uruchamiaczem.
 *
 * Uruchamianie procesu nie siedzi tutaj celowo: gdyby siedziało, nie dałoby
 * się przetestować ścieżki, która w praktyce zdarza się najczęściej — braku
 * `nvidia-smi` (karta AMD, narzędzie nie w `PATH`, sterownik w aktualizacji).
 * Proces główny wstrzykuje funkcję, która naprawdę uruchamia narzędzie.
 *
 * Łapiemy WSZYSTKO, z dwóch powodów. Odrzucona obietnica może nieść
 * cokolwiek, nie tylko `Error`. Uruchamiacz może też rzucić SYNCHRONICZNIE,
 * zanim zwróci obietnicę, a to nie jest jej odrzucenie, więc nie złapie tego
 * `.catch` na wyniku — łapie dopiero `try` obejmujący samo wywołanie.
 * Diagnostyka jest dodatkiem: jej awaria nie może zatrzymać zapisu.
 */
export async function readGpu(
  run: () => Promise<string>,
  now: () => number
): Promise<GpuReading | null> {
  try {
    const stdout = await run()
    // Znacznik PO powrocie wywołania, nie przed nim. `nvidia-smi` mierzy
    // 46,5 ms, więc znacznik zdjęty przed uruchomieniem procesu byłby o tyle
    // starszy od wartości, którą opisuje — a ten wiek decyduje o tym, czy pasek
    // pokaże liczby, czy kreskę, więc stałe zaniżanie go nie wchodzi w grę.
    return parseNvidiaSmi(stdout, now())
  } catch {
    return null
  }
}

/**
 * Wpis strumienia przed odczytaniem czegokolwiek: wszystkie liczniki `null`.
 *
 * Istnieje jako funkcja, a nie literał w `useDiagnosticsReporter.ts`, żeby dało
 * się sprawdzić testem regułę „brak odczytu nigdy nie udaje zera" także dla
 * wartości POCZĄTKOWYCH. W tym repozytorium nie ma testów komponentów (vitest
 * chodzi w gołym Node, bez `document`), więc wpis składany w hooku byłby polem
 * bez żadnego strażnika — a `bytes: 0` przeżyło tam dwanaście zadań i jedenaście
 * przeglądów właśnie dlatego.
 */
export function emptyStreamStats(
  peerId: string,
  kind: StreamKind,
  direction: StreamDirection
): StreamStats {
  return {
    peerId,
    kind,
    direction,
    framesReceived: null,
    framesDecoded: null,
    framesPresented: null,
    framesDropped: null,
    framesEncoded: null,
    framesSent: null,
    bytes: null,
    qualityLimitationReason: null
  }
}

/**
 * Przyrost jednego licznika na sekundę.
 *
 * `null` oznacza „nie wiem" i wychodzi w trzech przypadkach: licznika brakuje
 * po którejkolwiek stronie, poszedł w tył albo nie jest skończoną liczbą.
 * Cofnięcie jest realne — WebRTC zeruje liczniki przy przełączeniu kodeka — a
 * bez tej reguły panel pokazywałby ujemne tempo, czyli bzdurę wyglądającą na
 * pomiar.
 */
function deltaPerSecond(
  previous: number | null,
  next: number | null,
  elapsedMs: number
): number | null {
  if (previous === null || next === null) return null
  // Tylko skończone liczby. NaN i nieskończoność nie są pomiarem: nieskończoność
  // odjęta od siebie daje NaN, a nieskończony licznik daje nieskończone tempo.
  if (!Number.isFinite(previous) || !Number.isFinite(next)) return null
  if (next < previous) return null
  return ((next - previous) * 1000) / elapsedMs
}

/**
 * Tempo wszystkich liczników strumienia między dwiema próbkami.
 *
 * Zwraca `null` jako CAŁOŚĆ tylko wtedy, gdy nie ma czego liczyć: brak
 * poprzedniej próbki (strumień właśnie się pojawił) albo odstęp czasu, który
 * nie jest dodatnią, skończoną liczbą. Pojedyncze pola mogą być `null`
 * niezależnie od siebie — patrz `deltaPerSecond`.
 */
export function ratesBetween(
  previous: StreamStats | undefined,
  next: StreamStats,
  elapsedMs: number
): StreamRates | null {
  if (previous === undefined) return null
  // Skończoność odrzuca NaN i nieskończoność, a `<= 0` zero i wartości ujemne.
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null

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

/**
 * Po tym czasie uznajemy dane o strumieniach za przestarzałe.
 *
 * Trzy okresy próbkowania, nie jeden: zdrowy renderer przysyła raz na sekundę,
 * więc w chwili tyknięcia jego dane mają od zera do około sekundy, plus drżenie
 * zegara. Próg równy jednemu okresowi zapalałby się więc przy normalnej pracy.
 * Ten sam wzorzec co QUALITY_STALE_AFTER_MS w wydaniu 0.3.1.
 */
export const STREAMS_STALE_AFTER_MS = 3 * SAMPLE_INTERVAL_MS

export type StreamsFreshness = 'fresh' | 'stale' | 'never'

/**
 * Czy liczbom o strumieniach w tej próbce można wierzyć.
 *
 * `never` znaczy, że renderer nie odezwał się ani razu — inaczej niż `stale`,
 * które znaczy, że się odezwał i zamilkł. Rozróżnienie jest istotne: pierwsze
 * to tryb bez pokoju albo start aplikacji, drugie to objaw, którego szukamy.
 *
 * Granica jest wyłączna od strony świeżości: wiek równy progowi jest już
 * przestarzały. Ujemny wiek znaczy drżenie zegara, nie milczenie, więc jest
 * świeży. Wiek, który nie jest liczbą (`NaN`), nie jest pomiarem, więc nie
 * wolno za niego ręczyć — daje `stale`, tak samo jak nieskończoność.
 */
export function streamsFreshness(ageMs: number | null): StreamsFreshness {
  if (ageMs === null) return 'never'
  if (Number.isNaN(ageMs) || ageMs >= STREAMS_STALE_AFTER_MS) return 'stale'
  return 'fresh'
}

/**
 * Odstęp krótszy niż połowa okresu próbkowania nie jest pomiarem.
 *
 * `at` idzie zegarem ściennym, a `streamsAgeMs` monotonicznym, i oba są
 * odczytywane w różnych chwilach tyknięcia — dla TEGO SAMEGO pusha odstęp
 * wychodzi więc od kilku milisekund na minus do kilku na plus, a nie zero.
 * Przy dodatnim znaku `ratesBetween` policzyłby tempo z niezmienionych
 * liczników i pokazał 0 klatek na sekundę jako dane świeże, czyli fałszywe
 * „strumień stoi" — dokładnie to, czemu `streamsAgeMs` miało zapobiec.
 */
export const STREAMS_MIN_INTERVAL_MS = SAMPLE_INTERVAL_MS / 2

/**
 * Chwila, w której proces główny ODEBRAŁ dane o strumieniach tej próbki.
 *
 * To nie chwila odczytu w rendererze: różnica to czas `getStats()` plus kolejka
 * IPC i rośnie przy głodzeniu renderera, czyli właśnie w badanym przypadku.
 * Dokładny pomiar wymagałby znacznika czasu nadanego po stronie renderera.
 */
function streamsReceivedAt(sample: DiagnosticsSample): number | null {
  return sample.streamsAgeMs === null ? null : sample.at - sample.streamsAgeMs
}

/**
 * Ile milisekund dzieli dwa zestawy statystyk strumieni — liczone od chwili,
 * gdy proces główny je ODEBRAŁ od renderera, a nie od chwili tyknięcia
 * rejestratora.
 *
 * Ta różnica ma znaczenie, gdy renderer milczy. Rejestrator tyka dalej i
 * powtarza ostatnie liczby, więc odstęp między tyknięciami (sekunda) przy
 * niezmienionych licznikach dałby tempo 0 klatek na sekundę, czyli wniosek
 * „strumień stoi", któremu pole `streamsAgeMs` miało zapobiec. Licząc od
 * chwili odebrania, dwie kopie tego samego pusha dają odstęp bliski zeru, a
 * ten odrzuca próg `STREAMS_MIN_INTERVAL_MS`. Po powrocie renderera odstęp
 * obejmuje całą ciszę, więc tempo jest średnią z niej, a nie skokiem
 * wielokrotnie za dużym.
 *
 * `null` w trzech przypadkach:
 * - po którejkolwiek stronie renderer nie odezwał się jeszcze ani razu;
 * - odstęp nie jest skończoną liczbą;
 * - odstęp jest krótszy niż `STREAMS_MIN_INTERVAL_MS` (także ujemny). Zalicza
 *   się tu ten sam push widziany dwa razy i cofnięty zegar, ale też dwa RÓŻNE
 *   pushe bliższe niż próg. To zdarza się, gdy czas `collect()` w rendererze
 *   się zmienia: odczyt 800 ms, potem 50 ms daje pushe o 250 ms od siebie.
 *   Uznajemy to za akceptowalny koszt: kreska znaczy „nie wiem", a błąd w
 *   drugą stronę byłby fałszywym zerem.
 *
 * Wynik, który nie jest `null`, jest więc zawsze dodatni.
 */
export function streamsIntervalMs(
  previous: DiagnosticsSample,
  next: DiagnosticsSample
): number | null {
  const from = streamsReceivedAt(previous)
  const to = streamsReceivedAt(next)
  if (from === null || to === null) return null
  const interval = to - from
  if (!Number.isFinite(interval) || interval < STREAMS_MIN_INTERVAL_MS) return null
  return interval
}

/**
 * Dokłada próbkę i przycina bufor — po wieku, a na końcu po liczbie wpisów.
 *
 * Oba ograniczenia są parametrami, nie stałymi w środku: inaczej test bufora
 * musiałby czekać dziesięć minut i wstawiać sześćset próbek.
 *
 * Granica wieku liczy się od znacznika próbki właśnie dokładanej. Przy zegarze
 * idącym w przód to to samo co od największego znacznika w buforze, bo nowa
 * próbka jest wtedy najnowsza. Różnica pojawia się dopiero przy cofnięciu
 * zegara systemowego (synchronizacja czasu zdarza się w środku sesji): cofnięta
 * próbka poluzowuje wtedy okno zamiast wyrzucać dane, a stare wpisy wypycha
 * sufit liczby wpisów. Ten wariant odzyskuje świeżość po `maxCount` dopisaniach,
 * niezależnie od wielkości cofnięcia, o ile takty nie są dłuższe niż okno.
 *
 * Nowa próbka zostaje zawsze, ale z budowy funkcji, a nie z arytmetyki wieku:
 * filtr działa wyłącznie na wpisach, które już są w buforze, więc dokładana
 * próbka w ogóle przez niego nie przechodzi, a `slice` przy `maxCount >= 1`
 * zostawia ostatni wpis.
 *
 * Zakłada `maxCount >= 1` oraz że `maxCount` i `sample.at` są skończone.
 * Produkcja podaje stałą 600, więc to kontrakt, nie obsługa błędu.
 */
export function appendSample(
  buffer: readonly DiagnosticsSample[],
  sample: DiagnosticsSample,
  maxAgeMs: number,
  maxCount: number
): DiagnosticsSample[] {
  // Granica od próbki właśnie dokładanej, nie od największego znacznika w buforze.
  const newest = sample.at
  const kept = buffer.filter((entry) => newest - entry.at <= maxAgeMs)
  const next = [...kept, sample]
  return next.length > maxCount ? next.slice(next.length - maxCount) : next
}

/**
 * Czy linia zmieści się pod sufitem rozmiaru pliku.
 *
 * Granica jest włącznie: linia równa wolnemu miejscu jeszcze się mieści.
 * `currentBytes` i `lineBytes` to bajty, nie znaki. Polskie litery zajmują
 * w UTF-8 po dwa bajty, więc liczenie znaków zaniżałoby rozmiar pliku.
 */
export function shouldAppendLine(
  currentBytes: number,
  lineBytes: number,
  ceilingBytes: number
): boolean {
  return currentBytes + lineBytes <= ceilingBytes
}

/**
 * Które pliki zapisu usunąć, żeby zostało `keep` najnowszych.
 *
 * Sortujemy PO NAZWIE, nie po `mtime`, a wolno tak tylko dlatego, że nazwa to
 * `YYYY-MM-DD-HHmmss.jsonl` — format, który porządkuje się leksykograficznie
 * zgodnie z czasem. To jedyny powód; przy innym formacie nazwy trzeba by wrócić
 * do czasu modyfikacji. Nazwa jest przy tym lepsza od `mtime`: `mtime` zmienia
 * się przy każdym dopisaniu linii, więc długa sesja wyglądałaby jak najnowszy
 * plik także wtedy, gdy zaczęła się przedwczoraj.
 *
 * Pliki o starej, dziennej nazwie (`YYYY-MM-DD.jsonl`) też tu wpadają: filtrem
 * jest samo rozszerzenie, więc stary układ nazw da się sprzątnąć, a nie zostaje
 * w katalogu na zawsze.
 *
 * Decyzja jest osobno od `node:fs`, bo to jedyna część tej retencji, w której
 * da się pomylić stronę sortowania albo zgubić plik, który właśnie otwieramy.
 */
export function logFilesToDelete(names: readonly string[], keep: number): string[] {
  const logs = names.filter((name) => name.endsWith('.jsonl')).sort()
  return logs.slice(0, Math.max(logs.length - keep, 0))
}

/** Pamięć karty w gigabajtach, z przecinkiem — interfejs jest polski. */
function formatGigabytes(megabytes: number): string {
  return (megabytes / 1024).toFixed(1).replace('.', ',')
}

/** Godzina HH:MM z lokalnych getterów, spójnie z nazwą pliku zapisu. */
function formatClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Po tym czasie przestajemy ręczyć za liczby z odczytu GPU.
 *
 * Dwa okresy odpytywania, nie trzy jak w `STREAMS_STALE_AFTER_MS`: tam okres
 * to sekunda, więc jeden okres zapasu znikał w drżeniu zegara. Tu okres ma pięć
 * sekund, czyli zapas jednego okresu jest już o rzędy wielkości większy od
 * drżenia, a mieści też jedno pominięte tyknięcie (wywołanie jeszcze nie
 * wróciło, więc następne jest pomijane — patrz `gpuPollInFlight` w
 * `metrics.ts`). Trzeci okres opóźniałby tylko wykrycie zamarłego sterownika,
 * czyli dokładnie tego zjawiska, którego tu szukamy. Ten sam wzorzec co
 * `QUALITY_STALE_AFTER_MS` z 0.3.1: próg wyrażony w okresach odpytywania, a nie
 * liczbą milisekund, bo to okres decyduje, co jest normą.
 */
export const GPU_STALE_AFTER_MS = 2 * GPU_POLL_INTERVAL_MS

/**
 * Tekst paska w rogu okna. Znacznik `at` to chwila PRÓBKI, nie chwila
 * rysowania — pasek pokazuje najnowszą próbkę, a nie „teraz". Linia w panelu
 * ma własny wariant (`formatSystemLine`), bo opisuje próbkę wskazaną suwakiem
 * czasu, czyli zwykle chwilę z przeszłości.
 *
 * Trzy stany GPU, celowo rozróżnialne:
 * - `GPU —` — nie mamy odczytu W OGÓLE (brak `nvidia-smi`, karta AMD, sterownik
 *   w aktualizacji, nieczytelne wyjście). Kreska, bo zero znaczyłoby „karta nic
 *   nie robi", a my po prostu nie wiemy.
 * - `GPU — (odczyt z 22:03)` — odczyt BYŁ, ale zamarł: minęło co najmniej
 *   `GPU_STALE_AFTER_MS`. Godzina jest tu całą informacją — mówi, kiedy
 *   `nvidia-smi` przestał wracać, a to zwykle moment, w którym zaczęło się
 *   zjawisko, o które pytamy. Bez tej gałęzi zawieszony sterownik pokazywałby
 *   „GPU 97% · VRAM 11,2/12,0 GB" dla każdej kolejnej próbki aż do restartu, a
 *   właściciel przewijający suwak odczytałby przyklejone 97% jako przyczynę.
 * - liczby — odczyt świeży. Zero jest wtedy pomiarem i zostaje zerem.
 */
export function formatResourceBadge(system: SystemStats, at: number): string {
  return formatSystemStats(system, at, 'when-stale')
}

/**
 * Ta sama treść dla linii `diag__system` w panelu, ale z godziną odczytu GPU
 * pokazywaną ZAWSZE, nie tylko po progu przestarzałości.
 *
 * Odpytujemy kartę co `GPU_POLL_INTERVAL_MS`, a próbkujemy co
 * `SAMPLE_INTERVAL_MS`, więc te same liczby GPU powtarzają się w pięciu
 * kolejnych próbkach. Właściciel przewijający suwak czasu widzi pięć
 * identycznych odczytów pod rząd i bez godziny odczytuje to jako „karta
 * przyklejona" — czyli to samo złe wrażenie, któremu zapobiega gałąź
 * z zamarłym sterownikiem. Godzina jest wyjaśnieniem powtórzeń.
 *
 * W pasku w rogu okna zostaje `when-stale`: pasek jest wąski i ma być cichy,
 * a przy nim „teraz" jest zawsze tą samą chwilą co próbka.
 */
export function formatSystemLine(system: SystemStats, at: number): string {
  return formatSystemStats(system, at, 'always')
}

/**
 * Kiedy pokazać godzinę odczytu GPU. Nazwany wariant, a nie flaga logiczna:
 * `formatResourceBadge(system, at, true)` w miejscu wywołania nie mówi nic.
 */
type GpuClockVisibility = 'when-stale' | 'always'

/** Wspólne ciało paska i linii panelu — jedno formatowanie, dwa warianty. */
function formatSystemStats(
  system: SystemStats,
  at: number,
  gpuClock: GpuClockVisibility
): string {
  const parts = [
    `CPU ${Math.round(system.cpuPercent)}%`,
    `RAM ${Math.round(system.memoryMb)} MB`
  ]
  const gpu = system.gpu
  // Odczyt, którego nie da się umiejscowić w czasie (`at` nie jest skończoną
  // liczbą), traktujemy jak brak odczytu: nie wiemy, czy jest aktualny, i nie
  // mamy godziny, którą moglibyśmy pokazać — także w wariancie `always`.
  if (gpu === null || !Number.isFinite(gpu.at)) {
    parts.push('GPU —')
    return parts.join(' · ')
  }
  // Granica włącznie od strony przestarzałości, tak samo jak w
  // `streamsFreshness`. Wiek ujemny to drżenie albo cofnięty zegar, nie zamarły
  // odczyt, więc zostaje świeży. Wiek, który nie jest liczbą, nie jest
  // pomiarem, więc nie wolno za niego ręczyć — liczy się za przestarzały.
  const ageMs = at - gpu.at
  if (!Number.isFinite(ageMs) || ageMs >= GPU_STALE_AFTER_MS) {
    parts.push(`GPU — (odczyt z ${formatClock(gpu.at)})`)
  } else {
    parts.push(`GPU ${Math.round(gpu.utilizationPercent)}%`)
    parts.push(
      `VRAM ${formatGigabytes(gpu.memoryUsedMb)}/${formatGigabytes(gpu.memoryTotalMb)} GB`
    )
    // Godzina idzie na koniec, po VRAM-ie: opisuje oba te pola naraz, bo oba
    // pochodzą z tego samego wywołania `nvidia-smi`.
    if (gpuClock === 'always') parts.push(`odczyt z ${formatClock(gpu.at)}`)
  }
  return parts.join(' · ')
}

/** Od tego progu milczenie renderera liczymy w minutach, nie w sekundach. */
const SILENCE_MINUTES_FROM_S = 60
/** A od tego w godzinach. */
const SILENCE_HOURS_FROM_S = 60 * 60

/**
 * Jak długo renderer milczy, w jednostce dopasowanej do długości ciszy.
 *
 * Same sekundy wystarczały, dopóki panel był zrzutem z chwili otwarcia: cisza
 * trwała wtedy kilka tyknięć. Przy panelu, który nadąża, i przy przewijaniu
 * zapisu z całego wieczoru ta sama funkcja pisała „Renderer milczy od 3600 s",
 * czyli liczbę, którą trzeba przeliczać w głowie, żeby zobaczyć, że to godzina.
 *
 * Reszta jest pomijana, gdy wychodzi zerowa: „1 godz." zamiast „1 godz. 0 min".
 * Zaokrąglamy raz, do pełnych sekund, i dopiero z tego składamy jednostki —
 * inaczej 119,6 s dałoby „1 min 60 s".
 *
 * Wiek, który nie jest skończoną liczbą (`null`, `NaN`, nieskończoność), nie
 * jest pomiarem, więc nie dostaje liczby — tak samo jak przed przeniesieniem
 * tej funkcji z `Diagnostics.tsx`. Wieku ujemnego tu nie obsługujemy osobno,
 * bo `streamsFreshness` uznaje go za drżenie zegara i świeżość, więc do tego
 * napisu nie dochodzi.
 */
export function formatSilence(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return 'nieznanego czasu'

  const totalSeconds = Math.round(ageMs / 1000)
  if (totalSeconds < SILENCE_MINUTES_FROM_S) return `${totalSeconds} s`

  if (totalSeconds < SILENCE_HOURS_FROM_S) {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`
  }

  const hours = Math.floor(totalSeconds / SILENCE_HOURS_FROM_S)
  const minutes = Math.floor((totalSeconds % SILENCE_HOURS_FROM_S) / 60)
  return minutes === 0 ? `${hours} godz.` : `${hours} godz. ${minutes} min`
}

/**
 * Historia pokazywana w panelu razem z położeniem suwaka czasu.
 *
 * Jeden stan, nie dwa: położenie suwaka ma sens tylko wobec konkretnej
 * listy próbek, a reguła „suwak stoi na końcu" czyta oba pola naraz. Trzymane
 * osobno rozjeżdżały się na jeden render przy każdym dopisaniu.
 */
export interface PanelTimeline {
  samples: readonly DiagnosticsSample[]
  cursor: number
}

/**
 * Dopisuje najnowszą próbkę do historii panelu, jeśli jest nowsza od ostatniej.
 *
 * Panel był zamrożony od chwili otwarcia, a pasek w tym samym oknie tykał co
 * sekundę — właściciel otwiera panel właśnie dlatego, że coś się ZACIĘŁO,
 * i widział nieruchome liczby przy ruchomym pasku. Dopisujemy tę samą próbkę,
 * którą i tak pobiera zegar paska: `readDiagnostics()` co sekundę to 3,09 MB
 * i 13,6 ms serializacji na każdy takt, więc odpada.
 *
 * Trzy reguły, wszystkie wyliczane PRZED dopisaniem, bo po nim indeks końca
 * jest już inny:
 *
 * - suwak stojący na końcu idzie dalej za teraźniejszością. Warunek jest
 *   nierównością, nie równością: `>=` obejmuje też pustą historię (koniec ma
 *   wtedy indeks −1) i suwak poza listą, więc żadne położenie, jakie poda
 *   wywołujący, nie zostawia panelu zamrożonego na próbce, której nie ma;
 * - suwak przewinięty w tył zostaje na TEJ SAMEJ próbce, a nie na tym samym
 *   indeksie: przycięcie zabiera wpisy z początku listy, więc sam indeks
 *   wędrowałby w czasie w przód i panel przewijałby się właścicielowi pod
 *   ręką — a przewinięcie w tył jest czynnością świadomą;
 * - próbka nie nowsza od ostatniej nie zmienia nic i funkcja zwraca TEN SAM
 *   obiekt, żeby React mógł pominąć przerysowanie. To też strażnik podwójnego
 *   wykonania efektów w `StrictMode`: drugie wywołanie nie dokłada duplikatu.
 *
 * Granice są te same, co w buforze procesu głównego (`appendSample`
 * w `diagnosticsRecorder`), bo panel ma pokazywać to samo okno czasu co zapis;
 * bez sufitu liczby wpisów historia panelu przegoniłaby bufor po dziesięciu
 * minutach otwarcia.
 */
export function advancePanelTimeline(
  timeline: PanelTimeline,
  latest: DiagnosticsSample
): PanelTimeline {
  const { samples, cursor } = timeline
  const last = samples[samples.length - 1]
  if (last !== undefined && latest.at <= last.at) return timeline

  const atEnd = cursor >= samples.length - 1
  const next = appendSample(samples, latest, BUFFER_MAX_AGE_MS, BUFFER_MAX_SAMPLES)
  if (atEnd) return { samples: next, cursor: next.length - 1 }

  // Ile wpisów zabrało przycięcie: dołożyliśmy jeden, więc długość rośnie
  // o jeden tylko wtedy, gdy nic nie wypadło.
  const removed = samples.length + 1 - next.length
  return { samples: next, cursor: Math.max(0, cursor - removed) }
}

/**
 * Skrót identyfikatora pokoju do porównania przez telefon. Osiem znaków
 * z szesnastkowego skrótu to 32 bity — na dwie osoby w jednym kanale
 * z zapasem, a da się to przeczytać na głos bez pomyłki.
 */
export function shortRoomFingerprint(roomId: string): string {
  return roomId.slice(0, ROOM_FINGERPRINT_LENGTH)
}
