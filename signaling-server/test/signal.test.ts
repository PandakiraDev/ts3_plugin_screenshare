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

test('sygnał trafia do wskazanego peera z oznaczeniem nadawcy', async () => {
  const streamer = await connect()
  const streamerId = await join(streamer, ROOM_A)
  const viewer = await connect()
  const viewerId = await join(viewer, ROOM_A)
  await streamer.next() // peer-joined

  const offer = { sdp: 'v=0 fake offer', kind: 'offer' }
  streamer.send({ type: 'signal', to: viewerId, payload: offer })

  const message = await viewer.next()
  expect(message).toEqual({ type: 'signal', from: streamerId, payload: offer })
})

test('serwer nie interpretuje payloadu — przekazuje go bez zmian', async () => {
  const a = await connect()
  await join(a, ROOM_A)
  const b = await connect()
  const bId = await join(b, ROOM_A)
  await a.next() // peer-joined

  // Cokolwiek WebRTC przyśle później, serwer ma to przepuścić nietknięte.
  const oddPayload = {
    candidate: 'candidate:0 1 UDP 2122252543 192.168.1.5 54321 typ host',
    nested: { array: [1, 2, { deep: true }], nullable: null }
  }
  a.send({ type: 'signal', to: bId, payload: oddPayload })

  const message = await b.next()
  if (message.type !== 'signal') throw new Error('zły typ')
  expect(message.payload).toEqual(oddPayload)
})

test('sygnał nie wycieka do pozostałych peerów w pokoju', async () => {
  const a = await connect()
  await join(a, ROOM_A)
  const b = await connect()
  const bId = await join(b, ROOM_A)
  const c = await connect()
  await join(c, ROOM_A)

  await a.next() // peer-joined b
  await a.next() // peer-joined c
  await b.next() // peer-joined c

  a.send({ type: 'signal', to: bId, payload: { sdp: 'tylko dla b' } })

  await b.next()
  await c.expectSilence()
})

test('sygnał do nieznanego peera zwraca błąd nadawcy', async () => {
  const client = await connect()
  await join(client, ROOM_A)

  client.send({ type: 'signal', to: 'nie-ma-takiego', payload: {} })

  const message = await client.next()
  expect(message.type).toBe('error')
})

test('sygnał do peera z innego pokoju jest odrzucany', async () => {
  const a = await connect()
  await join(a, ROOM_A)
  const stranger = await connect()
  const strangerId = await join(stranger, ROOM_B)

  a.send({ type: 'signal', to: strangerId, payload: { sdp: 'nie powinno dojść' } })

  const message = await a.next()
  expect(message.type).toBe('error')
  await stranger.expectSilence()
})
