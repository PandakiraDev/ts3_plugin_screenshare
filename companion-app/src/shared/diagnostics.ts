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
 * Dokłada próbkę i przycina bufor — po wieku, a na końcu po liczbie wpisów.
 *
 * Oba ograniczenia są parametrami, nie stałymi w środku: inaczej test bufora
 * musiałby czekać dziesięć minut i wstawiać sześćset próbek.
 *
 * Dwie reguły, obie wymuszone przez cofnięcie zegara systemowego
 * (synchronizacja czasu zdarza się w środku sesji):
 *
 * 1. **Granicę wieku liczymy od największego znacznika czasu**, a nie od
 *    znacznika próbki właśnie dokładanej. Cofnięta próbka nie może poluzować
 *    okna: granica liczona od niej zostawiałaby w buforze dane starsze niż
 *    dozwolony wiek względem najnowszego pomiaru.
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
