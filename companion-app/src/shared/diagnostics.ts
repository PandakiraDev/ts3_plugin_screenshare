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

export const SAMPLE_INTERVAL_MS = 1_000
export const BUFFER_MAX_AGE_MS = 10 * 60 * 1_000
/**
 * Tyle próbek mieści się w oknie wieku przy interwale próbkowania: dokładnie
 * dziesięć minut przy 1 Hz. Sam sufit nie zostawia zapasu. Istnieje jako
 * zabezpieczenie na wypadek, gdy filtr wieku zawiedzie, na przykład po cofnięciu
 * zegara, gdy w buforze siedzą dwie epoki naraz.
 */
export const BUFFER_MAX_SAMPLES = BUFFER_MAX_AGE_MS / SAMPLE_INTERVAL_MS
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
  at: number
): Promise<GpuReading | null> {
  try {
    return parseNvidiaSmi(await run(), at)
  } catch {
    return null
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
