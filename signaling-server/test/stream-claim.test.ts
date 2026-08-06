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

  expect(await client.next()).toEqual({ type: 'stream-started', peerId })
})

test('pozostali w pokoju dowiadują się, że ktoś zaczął nadawać', async () => {
  const widz = await connect()
  await join(widz, ROOM_A)
  const streamer = await connect()
  const streamerId = await join(streamer, ROOM_A)
  await widz.next() // peer-joined

  streamer.send({ type: 'start-stream', kind: 'screen' })
  await streamer.next()

  expect(await widz.next()).toEqual({ type: 'stream-started', peerId: streamerId })
})

test('kilka osób może nadawać jednocześnie', async () => {
  // Sedno zmiany: limit jednego nadającego zniesiony.
  const pierwszy = await connect()
  const pierwszyId = await join(pierwszy, ROOM_A)
  const drugi = await connect()
  const drugiId = await join(drugi, ROOM_A)
  await pierwszy.next() // peer-joined

  pierwszy.send({ type: 'start-stream', kind: 'screen' })
  await pierwszy.next()
  await drugi.next() // stream-started pierwszego

  drugi.send({ type: 'start-stream', kind: 'screen' })

  expect(await drugi.next()).toEqual({ type: 'stream-started', peerId: drugiId })
  expect(await pierwszy.next()).toEqual({ type: 'stream-started', peerId: drugiId })
  expect(pierwszyId).not.toBe(drugiId)
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

  const pozny = await connect()
  pozny.send({ type: 'join', roomId: ROOM_A })
  const joined = await pozny.next()

  if (joined.type !== 'joined') throw new Error('zły typ')
  expect([...joined.streamers].sort()).toEqual([aId, bId].sort())
})

test('pusty pokój nie ma nadających', async () => {
  const client = await connect()
  client.send({ type: 'join', roomId: ROOM_A })
  const joined = await client.next()

  if (joined.type !== 'joined') throw new Error('zły typ')
  expect(joined.streamers).toEqual([])
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

  const pozny = await connect()
  pozny.send({ type: 'join', roomId: ROOM_A })
  const joined = await pozny.next()

  if (joined.type !== 'joined') throw new Error('zły typ')
  expect(joined.streamers).toEqual([bId])
  expect(joined.streamers).not.toContain(aId)
})

test('rozłączenie nadającego zdejmuje go z listy', async () => {
  const streamer = await connect()
  await join(streamer, ROOM_A)
  const widz = await connect()
  await join(widz, ROOM_A)
  await streamer.next()

  streamer.send({ type: 'start-stream', kind: 'screen' })
  await streamer.next()
  await widz.next()

  streamer.close()
  await widz.next()
  await widz.next()

  const pozny = await connect()
  pozny.send({ type: 'join', roomId: ROOM_A })
  const joined = await pozny.next()

  if (joined.type !== 'joined') throw new Error('zły typ')
  expect(joined.streamers).toEqual([])
})

test('ponowne start-stream od tego samego peera nie duplikuje wpisu', async () => {
  const client = await connect()
  const peerId = await join(client, ROOM_A)

  client.send({ type: 'start-stream', kind: 'screen' })
  await client.next()
  client.send({ type: 'start-stream', kind: 'screen' })
  await client.next()

  const pozny = await connect()
  pozny.send({ type: 'join', roomId: ROOM_A })
  const joined = await pozny.next()

  if (joined.type !== 'joined') throw new Error('zły typ')
  expect(joined.streamers).toEqual([peerId])
})

test('nadawanie w innym pokoju nie miesza się z tym pokojem', async () => {
  const wA = await connect()
  await join(wA, ROOM_A)
  wA.send({ type: 'start-stream', kind: 'screen' })
  await wA.next()

  const wB = await connect()
  wB.send({ type: 'join', roomId: ROOM_B })
  const joined = await wB.next()

  if (joined.type !== 'joined') throw new Error('zły typ')
  expect(joined.streamers).toEqual([])
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

  const widz = await connect()
  await join(widz, ROOM_A)
  await streamer.next()

  widz.send({ type: 'stop-stream', kind: 'screen' })

  expect((await widz.next()).type).toBe('error')
})
