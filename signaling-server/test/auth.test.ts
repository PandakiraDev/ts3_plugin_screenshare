import { afterEach, expect, test } from 'vitest'
import { startSignalingServer, type SignalingServer } from '../src/server.js'
import { generateApiKey, hashApiKey, MemoryKeyStore, OpenKeyStore } from '../src/keys.js'
import { ROOM_A, TestClient } from './helpers.js'

// Nie kazdy test startuje serwer (czesc sprawdza sama logike kluczy),
// wiec po zamknieciu zerujemy referencje — inaczej kolejny afterEach
// probowalby zamknac juz zamknieta instancje.
let server: SignalingServer | undefined
const clients: TestClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  if (server) {
    await server.close()
    server = undefined
  }
})

async function connect(): Promise<TestClient> {
  if (!server) throw new Error('serwer nie wystartowal')
  const client = await TestClient.connect(server.port)
  clients.push(client)
  return client
}

const KEY = 'a'.repeat(64)

// --- same klucze ---------------------------------------------------------

test('wygenerowany klucz jest długi i losowy', () => {
  const a = generateApiKey()
  const b = generateApiKey()

  expect(a).toMatch(/^[0-9a-f]{64}$/)
  expect(a).not.toBe(b)
})

test('w bazie ląduje skrót, nie sam klucz', () => {
  // Wyciek zrzutu bazy nie moze dawac dzialajacych kluczy.
  const key = generateApiKey()

  const hash = hashApiKey(key)

  expect(hash).not.toBe(key)
  expect(hash).toMatch(/^[0-9a-f]{64}$/)
})

test('białe znaki wokół klucza nie psują dopasowania', () => {
  // Klucz wedruje przez czat i schowek — spacja na koncu to norma.
  expect(hashApiKey(' abc ')).toBe(hashApiKey('abc'))
})

// --- serwer z autoryzacją ------------------------------------------------

test('poprawny klucz wpuszcza do pokoju', async () => {
  server = await startSignalingServer({ port: 0, keyStore: new MemoryKeyStore([KEY]) })
  const client = await connect()

  client.send({ type: 'join', roomId: ROOM_A, apiKey: KEY })

  expect((await client.next()).type).toBe('joined')
})

test('zły klucz odrzuca z czytelnym błędem', async () => {
  server = await startSignalingServer({ port: 0, keyStore: new MemoryKeyStore([KEY]) })
  const client = await connect()

  client.send({ type: 'join', roomId: ROOM_A, apiKey: 'b'.repeat(64) })

  const message = await client.next()
  expect(message.type).toBe('error')
  if (message.type !== 'error') throw new Error('zły typ')
  expect(message.message).toMatch(/klucz/i)
})

test('brak klucza odrzuca', async () => {
  server = await startSignalingServer({ port: 0, keyStore: new MemoryKeyStore([KEY]) })
  const client = await connect()

  client.send({ type: 'join', roomId: ROOM_A })

  expect((await client.next()).type).toBe('error')
})

test('odrzucony peer nie trafia do pokoju', async () => {
  // Inaczej ktos bez klucza i tak widzialby, kto jest w kanale.
  server = await startSignalingServer({ port: 0, keyStore: new MemoryKeyStore([KEY]) })
  const withKey = await connect()
  withKey.send({ type: 'join', roomId: ROOM_A, apiKey: KEY })
  await withKey.next()

  const withoutKey = await connect()
  withoutKey.send({ type: 'join', roomId: ROOM_A, apiKey: 'zly' })
  await withoutKey.next()

  // Peer z kluczem nie moze dostac powiadomienia o tamtym.
  await withKey.expectSilence()
})

test('bez skonfigurowanej bazy serwer wpuszcza wszystkich', async () => {
  // Darmowy Postgres na Renderze znika po 30 dniach. Brak bazy ma oznaczac
  // "brak autoryzacji", a nie "nikt nie wejdzie".
  server = await startSignalingServer({ port: 0, keyStore: new OpenKeyStore() })
  const client = await connect()

  client.send({ type: 'join', roomId: ROOM_A })

  expect((await client.next()).type).toBe('joined')
})

// --- lista kluczy ze zmiennej srodowiskowej -------------------------------

test('lista kluczy czyta się z linii, przecinków i średników', async () => {
  const { parseKeyList } = await import('../src/keys.js')

  expect(parseKeyList('aaa\nbbb')).toEqual(['aaa', 'bbb'])
  expect(parseKeyList('aaa, bbb')).toEqual(['aaa', 'bbb'])
  expect(parseKeyList('aaa;bbb')).toEqual(['aaa', 'bbb'])
})

test('puste linie i spacje nie tworzą pustych kluczy', async () => {
  // Wklejenie z panelu zostawia puste linie na koncu — pusty klucz
  // wpuszczalby kazdego, kto nie poda zadnego.
  const { parseKeyList } = await import('../src/keys.js')

  expect(parseKeyList('  aaa  \n\n , \n bbb ')).toEqual(['aaa', 'bbb'])
  expect(parseKeyList('')).toEqual([])
  expect(parseKeyList(undefined)).toEqual([])
})

test('klucze ze zmiennej realnie wpuszczają do serwera', async () => {
  const { parseKeyList, MemoryKeyStore } = await import('../src/keys.js')
  const envValue = `${KEY}\n${'c'.repeat(64)}`

  server = await startSignalingServer({
    port: 0,
    keyStore: new MemoryKeyStore(parseKeyList(envValue))
  })
  const client = await connect()

  client.send({ type: 'join', roomId: ROOM_A, apiKey: 'c'.repeat(64) })

  expect((await client.next()).type).toBe('joined')
})
