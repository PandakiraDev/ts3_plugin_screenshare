import { afterEach, beforeEach, expect, test } from 'vitest'
import type { SignalingServer } from '../src/server.js'
import { ROOM_A, startTestServer, TestClient } from './helpers.js'

/**
 * Duchy w liście uczestników.
 *
 * Serwer wykrywał odejście wyłącznie po zdarzeniu zamknięcia gniazda TCP.
 * Zmierzone przed poprawką: czyste `close()` i ubity proces (RST) wykrywane
 * po ~60 ms, ale klient, którego zamknięcie NIE dociera — uśpiony laptop,
 * zerwane Wi-Fi, pośrednik trzymający połączenie w górę — nie był wykrywany
 * NIGDY. Zostawał w pokoju i u wszystkich na liście.
 *
 * Stąd puls: serwer sam pyta, kto żyje, zamiast czekać na wiadomość, która
 * może nie przyjść.
 */

const PULS_MS = 150

let server: SignalingServer
const clients: TestClient[] = []

beforeEach(async () => {
  server = await startTestServer({ heartbeatMs: PULS_MS })
})

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  await server.close()
})

async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(server.port)
  clients.push(client)
  return client
}

async function join(client: TestClient, roomId: string): Promise<string> {
  client.send({ type: 'join', roomId })
  const message = await client.next()
  if (message.type !== 'joined') throw new Error(`oczekiwano joined, jest ${message.type}`)
  return message.peerId
}

test('zamrożony klient znika z pokoju, choć nie zamknął połączenia', async () => {
  const zostajacy = await connect()
  await join(zostajacy, ROOM_A)
  const znikajacy = await connect()
  const znikajacyId = await join(znikajacy, ROOM_A)
  await zostajacy.next() // peer-joined

  znikajacy.freeze()

  // Wykrycie zajmuje między jedną a dwiema rundami pulsu: pierwsza wysyła
  // pinga, druga stwierdza brak odpowiedzi. Limit z zapasem na wolną maszynę.
  const message = await zostajacy.next(PULS_MS * 8)
  expect(message).toEqual({ type: 'peer-left', peerId: znikajacyId })
})

test('zamrożony nadający zwalnia swoją transmisję', async () => {
  // Bez tego kafelek nadającego-ducha zostałby u wszystkich widzów, a kanał
  // pokazywałby transmisję, której nikt nie wysyła.
  const widz = await connect()
  await join(widz, ROOM_A)
  const nadajacy = await connect()
  const nadajacyId = await join(nadajacy, ROOM_A)
  await widz.next() // peer-joined

  nadajacy.send({ type: 'start-stream', kind: 'screen' })
  const start = await widz.next()
  expect(start).toEqual({ type: 'stream-started', peerId: nadajacyId, kind: 'screen' })

  nadajacy.freeze()

  const stop = await widz.next(PULS_MS * 8)
  expect(stop).toEqual({ type: 'stream-stopped', peerId: nadajacyId, kind: 'screen' })
})

test('odpowiadający klient NIE jest wyrzucany', async () => {
  // Puls nie może zrywać połączeń zdrowym klientom — to byłoby lekarstwo
  // gorsze od choroby.
  const zostajacy = await connect()
  await join(zostajacy, ROOM_A)
  const zdrowy = await connect()
  await join(zdrowy, ROOM_A)
  await zostajacy.next() // peer-joined

  // Kilka pełnych rund pulsu bez żadnej ingerencji.
  await zostajacy.expectSilence(PULS_MS * 6)
})
