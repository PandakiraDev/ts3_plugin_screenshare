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

/*
 * Bufor trzyma próbki w kolejności wstawiania, nie posortowane po `at`. Po
 * cofnięciu zegara systemowego mogą przez chwilę współistnieć dwie epoki czasu,
 * więc nie zakładamy sortowania i niczego tu nie sortujemy.
 */
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
      appendFileSync(logPath, JSON.stringify({ note: 'sufit rozmiaru osiągnięty' }) + '\n', 'utf8')
    } catch {
      /* nic więcej nie zrobimy */
    }
    return
  }

  try {
    appendFileSync(logPath, line, 'utf8')
    logBytes += lineBytes
  } catch {
    /* zapis padł — bufor w pamięci działa dalej */
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
    // Bez pliku zostaje bufor w pamięci — panel działa, zapis nie przeżyje
    // restartu. Lepsze niż brak diagnostyki.
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

  // Oba zatrzymania są potrzebne: zegar próbek i odpytywanie GPU to dwa
  // osobne zegary. Wywołanie `nvidia-smi` w toku w chwili zatrzymania zapisze
  // jeszcze jeden odczyt, do trzech sekund później — to w porządku.
  app.on('will-quit', () => {
    clearInterval(timer)
    stopGpu()
  })
}
