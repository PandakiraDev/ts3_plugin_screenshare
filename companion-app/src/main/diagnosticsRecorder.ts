import { app, ipcMain } from 'electron'
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  BUFFER_MAX_AGE_MS,
  BUFFER_MAX_SAMPLES,
  GPU_POLL_INTERVAL_MS,
  LOG_FILES_KEPT,
  LOG_SIZE_CEILING_BYTES,
  SAMPLE_INTERVAL_MS,
  appendSample,
  logFilesToDelete,
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
/**
 * Ostatnie statystyki strumieni przysłane przez renderer. Celowo NIE czyścimy
 * ich, gdy renderer milknie: stare dane opisane wiekiem (`streamsAgeMs`) są
 * uczciwe, a wyrzucone są stracone.
 */
let pendingStreams: StreamStats[] = []
/**
 * Moment ostatniego `push` z renderera, `null` do pierwszego. Zegar
 * monotoniczny (`performance.now()`), nie `Date.now()`: cofnięcie zegara
 * systemowego dałoby ujemny wiek, a wiek ma mówić, jak długo renderer milczy.
 */
let lastPushAt: number | null = null
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

  /*
   * Serializacja też w `try`: `streams` przychodzą z renderera przez IPC,
   * a nie z naszego własnego kodu, więc nie zakładamy, że da się je
   * zserializować. Strukturalne kopiowanie Electrona przenosi cykle bez
   * protestu, a `JSON.stringify` rzuciłby na takiej strukturze i przewrócił
   * tyknięcie zegara w procesie głównym. Taka próbka trafia do bufora
   * w pamięci, tylko nie do pliku.
   */
  let line: string
  let lineBytes: number
  try {
    line = JSON.stringify(sample) + '\n'
    lineBytes = Buffer.byteLength(line, 'utf8')
  } catch {
    return
  }

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

/**
 * Zostawia w katalogu `LOG_FILES_KEPT` najnowszych plików zapisu.
 *
 * Wołane PRZED otwarciem nowego pliku, więc nowy plik nie bierze udziału
 * w liczeniu i nie da się go usunąć zaraz po utworzeniu.
 *
 * Nieudane usunięcie JEDNEGO pliku (otwarty przez drugie okno, podglądany
 * w edytorze) nie przerywa usuwania pozostałych ani otwarcia nowego — stąd
 * `try` wewnątrz pętli, a nie tylko wokół niej.
 */
function pruneOldLogs(directory: string): void {
  try {
    for (const name of logFilesToDelete(readdirSync(directory), LOG_FILES_KEPT)) {
      try {
        unlinkSync(join(directory, name))
      } catch {
        /* jeden plik został — katalog i tak się skurczy przy następnym starcie */
      }
    }
  } catch {
    /* nie dało się przeczytać katalogu: zapis jest ważniejszy niż porządki */
  }
}

function openLog(): void {
  try {
    const directory = join(app.getPath('userData'), 'diagnostics')
    mkdirSync(directory, { recursive: true })
    pruneOldLogs(directory)
    /*
     * Nazwa pliku to lokalna data i godzina startu, czyli JEDEN PLIK NA SESJĘ.
     * To jest cel tej nazwy, nie jej skutek uboczny: sufit rozmiaru
     * (`LOG_SIZE_CEILING_BYTES`) liczy się per plik, bo `statSync` niżej dolicza
     * to, co już w nim jest. Przy nazwie dziennej druga sesja tego samego
     * wieczoru startowała więc z budżetem nadgryzionym przez pierwszą, a trzecia
     * potrafiła zapisać samą notkę o sufcie. Każda sesja ma dostać pełny budżet,
     * bo diagnozujemy pojedynczy wieczór, a nie dzień.
     *
     * Czas LOKALNY, nie UTC: `toISOString()` dałoby w Polsce między północą
     * a 1:00 (zimą) lub 2:00 (latem) wczorajszą datę, a właściciel szuka
     * „dzisiejszego" pliku właśnie wtedy, gdy wieczorem coś lagowało. Składamy
     * z lokalnych getterów, a nie z `toLocaleString`, bo jego format zależy od
     * ustawień regionalnych — a ta nazwa musi sortować się leksykograficznie
     * zgodnie z czasem, na tym opiera się retencja wyżej.
     *
     * `openLog` jest wołane RAZ przy starcie, więc sesja trwająca przez północ
     * pisze cały czas do pliku z datą swojego początku. Teraz nazwa już tego nie
     * zaciemnia: mówi, kiedy sesja się ZACZĘŁA.
     */
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const path = join(directory, `${day}-${time}.jsonl`)
    /*
     * Odczyt rozmiaru zostaje, choć po zmianie nazwy prawie zawsze powie „pliku
     * nie ma": nazwa NIE jest unikalna. Dwa okna odpalone z flagą w tej samej
     * sekundzie trafiają w ten sam plik (ta gałąź świadomie nie bierze
     * `requestSingleInstanceLock`), a wtedy sufit musi obejmować to, co już tam
     * jest. Rozplecenie takiego pliku na instancje umożliwia `instanceId`.
     */
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
  /*
   * Znacznik tego uruchomienia, nadawany RAZ i wpisywany w każdą linię.
   * Osiem znaków skrótu UUID, nie PID: systemy recyklingują PID-y, więc po
   * restarcie wtyczki dwa różne uruchomienia mogłyby dostać ten sam numer —
   * a wtedy znacznik myli bardziej, niż pomaga.
   */
  const instanceId = randomUUID().slice(0, 8)
  // Rzadziej niż próbkujemy: `nvidia-smi` jest jedynym niepomijalnym kosztem
  // tego przyrządu i jedynym miejscem, w którym dotyka badanego obiektu
  // (sterownika karty) — patrz `GPU_POLL_INTERVAL_MS`.
  const stopGpu = startGpuPolling(GPU_POLL_INTERVAL_MS)

  /*
   * Renderer przysyła statystyki strumieni, a proces główny dokłada wiersz
   * systemowy i scala jednym zegarem. Rejestrator celowo nie mieszka
   * w rendererze: podejrzanym jest głodzony renderer, a dziennik prowadzony
   * przez podejrzanego przestaje być dziennikiem dokładnie wtedy, gdy staje
   * się potrzebny.
   */
  ipcMain.handle(IPC_DIAGNOSTICS_PUSH, (_event, streams: StreamStats[]) => {
    pendingStreams = Array.isArray(streams) ? streams : []
    lastPushAt = performance.now()
  })
  ipcMain.handle(IPC_DIAGNOSTICS_LATEST, () => buffer[buffer.length - 1] ?? null)
  ipcMain.handle(IPC_DIAGNOSTICS_READ, () => buffer)

  const timer = setInterval(() => {
    const sample: DiagnosticsSample = {
      // Zegar ścienny, bo to znacznik czasu; `streamsAgeMs` niżej liczymy innym
      // zegarem (`performance.now()`), bo czas trwania mierzy się zegarem
      // monotonicznym, a znacznik czasu ściennym.
      at: Date.now(),
      instanceId,
      system: readSystemStats(),
      streams: pendingStreams,
      // Wiek liczymy w procesie głównym: renderer jest podejrzanym i nie
      // wolno zrzucać na niego odpowiedzi, czy się jeszcze odzywa.
      streamsAgeMs: lastPushAt === null ? null : Math.round(performance.now() - lastPushAt)
    }
    buffer = appendSample(buffer, sample, BUFFER_MAX_AGE_MS, BUFFER_MAX_SAMPLES)
    appendLine(sample)
  }, SAMPLE_INTERVAL_MS)

  // Oba zatrzymania są potrzebne: zegar próbek i odpytywanie GPU to dwa
  // osobne zegary, a teraz dzieli je też okres. Wywołanie `nvidia-smi`
  // w toku w chwili zatrzymania wraca jeszcze do trzech sekund później, ale
  // jego wynik jest już porzucany (patrz `startGpuPolling`).
  app.on('will-quit', () => {
    clearInterval(timer)
    stopGpu()
  })
}
