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
  roomId: string
): Promise<string> {
  client.send({ type: 'join', roomId })
  const message = await client.next()
  if (message.type !== 'joined') throw new Error(`oczekiwano joined, jest ${message.type}`)
  return message.peerId
}

test('rozłączenie peera powiadamia resztę pokoju', async () => {
  const streamer = await connect()
  await join(streamer, ROOM_A)
  const viewer = await connect()
  const viewerId = await join(viewer, ROOM_A)
  await streamer.next() // peer-joined

  viewer.close()

  const message = await streamer.next()
  expect(message).toEqual({ type: 'peer-left', peerId: viewerId })
})

test('rozłączony peer znika z listy widzianej przez kolejnych dołączających', async () => {
  const first = await connect()
  await join(first, ROOM_A)

  first.close()
  await first.waitClosed()

  const second = await connect()
  second.send({ type: 'join', roomId: ROOM_A, role: 'watch' })
  const message = await second.next()

  if (message.type !== 'joined') throw new Error('zły typ')
  expect(message.peers).toEqual([])
})

test('rozłączenie nie dotyka peerów z innych pokojów', async () => {
  const other = await connect()
  await join(other, ROOM_B)
  const leaving = await connect()
  await join(leaving, ROOM_A)

  leaving.close()

  await other.expectSilence()
})

test('niepoprawny JSON zwraca błąd i nie zrywa połączenia', async () => {
  const client = await connect()
  await join(client, ROOM_A)

  client.sendRaw('to nie jest {json')

  const message = await client.next()
  expect(message.type).toBe('error')

  // Połączenie ma dalej działać — kolejny poprawny sygnał przechodzi.
  client.send({ type: 'signal', to: 'ktokolwiek', payload: {} })
  const nextMessage = await client.next()
  expect(nextMessage.type).toBe('error')
})

test('nieznany typ wiadomości zwraca błąd', async () => {
  const client = await connect()
  await join(client, ROOM_A)

  client.send({ type: 'zrób-kawę' })

  const message = await client.next()
  expect(message.type).toBe('error')
})

test('sygnał wysłany przed dołączeniem zwraca błąd', async () => {
  const client = await connect()

  client.send({ type: 'signal', to: 'ktoś', payload: {} })

  const message = await client.next()
  expect(message.type).toBe('error')
})
