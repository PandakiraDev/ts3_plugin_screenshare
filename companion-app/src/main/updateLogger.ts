import { appendFileSync, existsSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Logger plikowy dla `electron-updater`.
 *
 * Spakowana aplikacja Windows nie ma podpiętej konsoli — `console.warn` w
 * `update.ts` idzie w próżnię. Bez tego pliku nieudana autoaktualizacja jest
 * całkowicie niewidoczna, zarówno dla użytkownika, jak i dla właściciela
 * projektu.
 *
 * Interfejs (`info`/`warn`/`error`/`debug`) to dokładnie to, czego oczekuje
 * `autoUpdater.logger` — patrz `electron-updater/out/types.d.ts`. Ustawienie
 * go przechwytuje też wewnętrzne logi biblioteki, nie tylko nasz handler
 * `on('error')` w `update.ts`.
 */
export interface UpdateLogger {
  info(message?: unknown): void
  warn(message?: unknown): void
  error(message?: unknown): void
  debug(message?: unknown): void
}

/** Rozsądny sufit rozmiaru pliku logu — patrz komentarz przy `trimIfTooLarge`. */
const MAX_LOG_BYTES = 256 * 1024

/**
 * Obcina log, gdy przekroczy `MAX_LOG_BYTES`, zamiast nadpisywać go przy
 * każdym starcie aplikacji. Aplikacja żyje krótko (jedna sesja udostępniania
 * — patrz `update.ts`), więc "nadpisuj przy starcie" skasowałoby log z
 * POPRZEDNIEJ sesji, zanim ktokolwiek zdążyłby go przeczytać. Sprawdzamy
 * rozmiar raz, przy tworzeniu loggera, nie przy każdym wpisie — koszt
 * jednego `statSync` na start aplikacji jest nieistotny.
 */
function trimIfTooLarge(logPath: string): void {
  try {
    if (existsSync(logPath) && statSync(logPath).size > MAX_LOG_BYTES) {
      truncateSync(logPath, 0)
    }
  } catch {
    // Nieudany odczyt/obciecie nie ma prawa zablokowac startu aplikacji ani
    // aktualizacji — logowanie jest diagnostyka, nie funkcja krytyczna.
  }
}

function timestamp(): string {
  return new Date().toISOString()
}

function formatMessage(message: unknown): string {
  if (message instanceof Error) return `${message.message}\n${message.stack ?? ''}`
  return typeof message === 'string' ? message : String(message)
}

function appendEntry(logPath: string, level: string, message: unknown): void {
  try {
    appendFileSync(logPath, `[${timestamp()}] [${level}] ${formatMessage(message)}\n`)
  } catch {
    // Blad zapisu do logu nie moze wywalic aplikacji ani przeszkodzic w
    // aktualizacji — to tylko diagnostyka, nie sciezka krytyczna.
  }
}

/**
 * Tworzy logger zapisujący do `<userData>/update.log`.
 *
 * @param userDataPath `app.getPath('userData')` — parametr, nie import
 *   `electron` w tym pliku, żeby dało się to przetestować w gołym vitest.
 */
export function createUpdateLogger(userDataPath: string): UpdateLogger {
  const logPath = join(userDataPath, 'update.log')
  trimIfTooLarge(logPath)

  return {
    info: (message) => appendEntry(logPath, 'info', message),
    warn: (message) => appendEntry(logPath, 'warn', message),
    error: (message) => appendEntry(logPath, 'error', message),
    debug: (message) => appendEntry(logPath, 'debug', message)
  }
}
