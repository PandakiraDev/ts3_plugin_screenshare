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
