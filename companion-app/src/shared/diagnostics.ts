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
