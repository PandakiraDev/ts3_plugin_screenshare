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
 * const portReady = new Promise((resolve) => { ...nasłuch na IPC_AUDIO_PORT... })
 * const format = await window.companion.startAppAudio(pid)
 * const port = await portReady
 * ```
 */
export const IPC_AUDIO_PORT = 'audio:port'

/** Numer wersji aplikacji — do plakietki w nagłówku. */
export const IPC_GET_VERSION = 'app:version'

/**
 * Stan aktualizacji. Dwa kanały, bo renderer montuje się później niż main:
 * zdarzenie `update-downloaded` może przyjść, zanim ktokolwiek słucha, więc
 * `IPC_GET_UPDATE_STATE` pozwala dociągnąć stan raz na starcie, a
 * `IPC_UPDATE_STATE` niesie każdą kolejną zmianę.
 */
export const IPC_GET_UPDATE_STATE = 'update:get'
export const IPC_UPDATE_STATE = 'update:state'
