import { afterEach, beforeEach, expect, test } from 'vitest'
import type { SignalingServer } from '../src/server.js'
import { ROOM_A, ROOM_B, startTestServer, TestClient } from './helpers.js'

let server: SignalingServer
const clients: TestClient[] = []

beforeEach(async () => {
  server = await startTestServer()
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

async function join(
  client: TestClient,
  roomId: string,
  displayName?: string
): Promise<{ peerId: string; displayName: string; peers: { peerId: string; displayName: string }[] }> {
  client.send(
    displayName === undefined
      ? { type: 'join', roomId }
      : { type: 'join', roomId, displayName }
  )
  const message = await client.next()
  if (message.type !== 'joined') throw new Error(`oczekiwano joined, jest ${message.type}`)
  return { peerId: message.peerId, displayName: message.displayName, peers: message.peers }
}

test('nick z TS3 wraca w odpowiedzi na join', async () => {
  const client = await connect()

  const joined = await join(client, ROOM_A, 'Konrad')

  expect(joined.displayName).toBe('Konrad')
})

test('bez nicku serwer nadaje kolejny numer w pokoju', async () => {
  // Numeruje serwer, nie klient — inaczej każdy widziałby inną listę.
  const first = await connect()
  const second = await connect()

  expect((await join(first, ROOM_A)).displayName).toBe('Użytkownik 1')
  expect((await join(second, ROOM_A)).displayName).toBe('Użytkownik 2')
})

test('numeracja jest osobna dla każdego pokoju', async () => {
  const inRoomA = await connect()
  const inRoomB = await connect()

  await join(inRoomA, ROOM_A)
  expect((await join(inRoomB, ROOM_B)).displayName).toBe('Użytkownik 1')
})

test('lista peerów przy wejściu zawiera nazwy', async () => {
  const first = await connect()
  const firstJoined = await join(first, ROOM_A, 'Ala')

  const second = await connect()
  const secondJoined = await join(second, ROOM_A, 'Bartek')

  expect(secondJoined.peers).toEqual([
    { peerId: firstJoined.peerId, displayName: 'Ala' }
  ])
})

test('powiadomienie o nowym peerze niesie jego nazwę', async () => {
  const first = await connect()
  await join(first, ROOM_A, 'Ala')

  const second = await connect()
  const secondJoined = await join(second, ROOM_A, 'Bartek')

  expect(await first.next()).toEqual({
    type: 'peer-joined',
    peerId: secondJoined.peerId,
    displayName: 'Bartek'
  })
})

test('wszyscy widzą te same nazwy', async () => {
  const a = await connect()
  const b = await connect()
  const c = await connect()
  const aJoined = await join(a, ROOM_A)
  const bJoined = await join(b, ROOM_A)
  await join(c, ROOM_A)

  const lastJoined = await join(await connect(), ROOM_A, 'Ostatni')

  // Czwarty widzi trzech poprzednich dokładnie tak, jak nazwał ich serwer.
  expect(lastJoined.peers.map((p) => p.displayName)).toEqual([
    'Użytkownik 1',
    'Użytkownik 2',
    'Użytkownik 3'
  ])
  expect(aJoined.displayName).toBe('Użytkownik 1')
  expect(bJoined.displayName).toBe('Użytkownik 2')
})

test('pusty albo sam z białych znaków nick traktujemy jak brak', async () => {
  const client = await connect()

  expect((await join(client, ROOM_A, '   ')).displayName).toBe('Użytkownik 1')
})

test('zbyt długi nick jest przycinany, a nie odrzucany', async () => {
  // Nick z TS3 bywa długi; lepiej przyciąć niż nie wpuścić do kanału.
  const client = await connect()

  const joined = await join(client, ROOM_A, 'x'.repeat(200))

  expect(joined.displayName.length).toBeLessThanOrEqual(64)
})

test('nick nie-string jest odrzucany', async () => {
  const client = await connect()

  client.send({ type: 'join', roomId: ROOM_A, displayName: 42 })

  expect((await client.next()).type).toBe('error')
})
