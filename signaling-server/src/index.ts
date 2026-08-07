import { resolvePort } from './config.js'
import { startSignalingServer } from './server.js'
import { MemoryKeyStore, OpenKeyStore, parseKeyList, type KeyStore } from './keys.js'

const port = resolvePort(process.env['PORT'])

/**
 * Klucze bierzemy ze zmiennej `API_KEYS` (po jednym w linii albo po przecinku).
 * Bez niej serwer działa jak przed dodaniem autoryzacji — wpuszcza wszystkich.
 * Brak konfiguracji ma oznaczać "bez autoryzacji", a nie "nikt nie wejdzie".
 */
function chooseKeyStore(): KeyStore {
  const keys = parseKeyList(process.env['API_KEYS'])
  if (keys.length === 0) {
    console.warn('API_KEYS nieustawione — serwer dziala BEZ autoryzacji.')
    return new OpenKeyStore()
  }
  console.log(`Autoryzacja wlaczona: ${keys.length} aktywnych kluczy.`)
  return new MemoryKeyStore(keys)
}

startSignalingServer({ port, keyStore: chooseKeyStore() })
  .then((server) => {
    console.log(`Signaling server nasłuchuje na ws://0.0.0.0:${server.port}`)
  })
  .catch((err: unknown) => {
    // Sam komunikat, bez stack trace'u — przy zajętym porcie ślad stosu
    // prowadzi w głąb `ws` i tylko zaciemnia to, co trzeba zrobić.
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
