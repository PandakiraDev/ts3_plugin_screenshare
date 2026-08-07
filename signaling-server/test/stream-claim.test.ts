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

async function join(client: TestClient, roomId: string): Promise<string> {
  client.send({ type: 'join', roomId })
  const message = await client.next()
  if (message.type !== 'joined') throw new Error(`oczekiwano joined, jest ${message.type}`)
  return message.peerId
}

test('zgłoszenie transmisji potwierdza samemu nadawcy', async () => {
  const client = await connect()
  const peerId = await join(client, ROOM_A)

  client.send({ type: 'start-stream', kind: 'screen' })

  expect(await client.next()).toEqual({ type: 'stream-started', peerId, kind: 'screen' })
})

test('pozostali w pokoju dowiadują się, że ktoś zaczął nadawać', async () => {
  const viewer = await connect()
  await join(viewer, ROOM_A)
  const streamer = await connect()
  const streamerId = await join(streamer, ROOM_A)
  await viewer.next() // peer-joined

  streamer.send({ type: 'start-stream', kind: 'screen' })
  await streamer.next()

  expect(await viewer.next()).toEqual({ type: 'stream-started', peerId: streamerId, kind: 'screen' })
})

test('kilka osób może nadawać jednocześnie', async () => {
  // Sedno zmiany: limit jednego nadającego zniesiony.
  const first = await connect()
  const firstId = await join(first, ROOM_A)
  const second = await connect()
  const secondId = await join(second, ROOM_A)
  await first.next() // peer-joined

  first.send({ type: 'start-stream', kind: 'screen' })
  await first.next()
  await second.next() // stream-started pierwszego

  second.send({ type: 'start-stream', kind: 'screen' })

  expect(await second.next()).toEqual({ type: 'stream-started', peerId: secondId, kind: 'screen' })
  expect(await first.next()).toEqual({ type: 'stream-started', peerId: secondId, kind: 'screen' })
  expect(firstId).not.toBe(secondId)
})

test('dołączający widzi wszystkich aktualnie nadających', async () => {
  const a = await connect()
  const aId = await join(a, ROOM_A)
  const b = await connect()
  const bId = await join(b, ROOM_A)
  await a.next()

  a.send({ type: 'start-stream', kind: 'screen' })
  await a.next()
  await b.next()
  b.send({ type: 'start-stream', kind: 'screen' })
  await b.next()
  await a.next()

  const latecomer = await connect()
  latecomer.send({ type: 'join', roomId: ROOM_A })
  const joined = await latecomer.next()

  if (joined.type !== 'joined') throw new Error('zły typ')
  expect(joined.streams).toHaveLength(2)
  expect(joined.streams).toContainEqual({ peerId: aId, kind: 'screen' })
  expect(joined.streams).toContainEqual({ peerId: bId, kind: 'screen' })
})

test('pusty pokój nie ma nadających', async () => {
  const client = await connect()
  client.send({ type: 'join', roomId: ROOM_A })
  const joined = await client.next()

  if (joined.type !== 'joined') throw new Error('zły typ')
  expect(joined.streams).toEqual([])
})

test('zakończenie transmisji zdejmuje tylko tego nadającego', async () => {
  const a = await connect()
  const aId = await join(a, ROOM_A)
  const b = await connect()
  const bId = await join(b, ROOM_A)
  await a.next()

  a.send({ type: 'start-stream', kind: 'screen' })
  await a.next()
  await b.next()
  b.send({ type: 'start-stream', kind: 'screen' })
  await b.next()
  await a.next()

  a.send({ type: 'stop-stream', kind: 'screen' })
  await a.next()
  await b.next() // stream-stopped a

  const latecomer = await connect()
  latecomer.send({ type: 'join', roomId: ROOM_A })
  const joined = await latecomer.next()

  if (joined.type !== 'joined') throw new Error('zły typ')
  expect(joined.streams).toEqual([{ peerId: bId, kind: 'screen' }])
  expect(joined.streams.map((s) => s.peerId)).not.toContain(aId)
})

test('rozłączenie nadającego zdejmuje go z listy', async () => {
  const streamer = await connect()
  await join(streamer, ROOM_A)
  const viewer = await connect()
  await join(viewer, ROOM_A)
  await streamer.next()

  streamer.send({ type: 'start-stream', kind: 'screen' })
  await streamer.next()
  await viewer.next()

  streamer.close()
  await viewer.next()
  await viewer.next()

  const latecomer = await connect()
  latecomer.send({ type: 'join', roomId: ROOM_A })
  const joined = await latecomer.next()

  if (joined.type !== 'joined') throw new Error('zły typ')
  expect(joined.streams).toEqual([])
})

test('ponowne start-stream od tego samego peera nie duplikuje wpisu', async () => {
  const client = await connect()
  const peerId = await join(client, ROOM_A)

  client.send({ type: 'start-stream', kind: 'screen' })
  await client.next()
  client.send({ type: 'start-stream', kind: 'screen' })
  await client.next()

  const latecomer = await connect()
  latecomer.send({ type: 'join', roomId: ROOM_A })
  const joined = await latecomer.next()

  if (joined.type !== 'joined') throw new Error('zły typ')
  expect(joined.streams).toEqual([{ peerId, kind: 'screen' }])
})

test('nadawanie w innym pokoju nie miesza się z tym pokojem', async () => {
  const inRoomA = await connect()
  await join(inRoomA, ROOM_A)
  inRoomA.send({ type: 'start-stream', kind: 'screen' })
  await inRoomA.next()

  const inRoomB = await connect()
  inRoomB.send({ type: 'join', roomId: ROOM_B })
  const joined = await inRoomB.next()

  if (joined.type !== 'joined') throw new Error('zły typ')
  expect(joined.streams).toEqual([])
})

test('start-stream przed dołączeniem to błąd', async () => {
  const client = await connect()

  client.send({ type: 'start-stream', kind: 'screen' })

  expect((await client.next()).type).toBe('error')
})

test('stop-stream od kogoś, kto nie nadaje, to błąd', async () => {
  // Inaczej dowolny widz mógłby zrzucić cudzą transmisję.
  const streamer = await connect()
  await join(streamer, ROOM_A)
  streamer.send({ type: 'start-stream', kind: 'screen' })
  await streamer.next()

  const viewer = await connect()
  await join(viewer, ROOM_A)
  await streamer.next()

  viewer.send({ type: 'stop-stream', kind: 'screen' })

  expect((await viewer.next()).type).toBe('error')
})
