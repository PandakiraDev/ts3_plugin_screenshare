/** Nazwy kanałów IPC — jedno miejsce, żeby main i preload nie rozjechały się literówką. */

export const IPC_GET_SOURCES = 'sources:get'
export const IPC_GET_LAUNCH = 'launch:get'
/**
 * Renderer zapowiada, co zaraz przechwyci. getDisplayMedia nie przyjmuje id
 * źródła — wybór trafia do handlera w main process, a ten musi wiedzieć,
 * które źródło użytkownik kliknął.
 */
export const IPC_SET_CAPTURE_TARGET = 'capture:target'

/** Klucz dostępu do serwera sygnalizacyjnego — odczyt i zapis w userData. */
export const IPC_GET_API_KEY = 'apikey:get'
export const IPC_SET_API_KEY = 'apikey:set'

/** Dźwięk wybranej aplikacji: start (podaje PID) i stop. */
export const IPC_AUDIO_START = 'audio:start'
export const IPC_AUDIO_STOP = 'audio:stop'

/**
 * Kanał, którym main przekazuje `MessagePort` z próbkami PCM. Osobno od
 * zwykłego IPC, bo pakietów jest około stu na sekundę — nie mają zapychać
 * kanału, którym lecą wywołania interfejsu.
 *
 * Port trafia do renderera przez `window.postMessage` z preloada, bo przez
 * contextBridge nie przechodzi.
 *
 * UWAGA na kolejność: port przychodzi *w trakcie* `startAppAudio()`, więc
 * nasłuch trzeba założyć wcześniej, inaczej wiadomość przepadnie:
 *
 * ```ts
 * const oczekiwanie = new Promise((resolve) => { ...nasłuch na IPC_AUDIO_PORT... })
 * const format = await window.companion.startAppAudio(pid)
 * const port = await oczekiwanie
 * ```
 */
export const IPC_AUDIO_PORT = 'audio:port'
