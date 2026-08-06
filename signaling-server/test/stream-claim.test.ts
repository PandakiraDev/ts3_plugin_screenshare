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

  client.send({ type: 'start-stream' })

  expect(await client.next()).toEqual({ type: 'stream-started', peerId })
})

test('pozostali w pokoju dowiadują się, że ktoś zaczął nadawać', async () => {
  const widz = await connect()
  await join(widz, ROOM_A)
  const streamer = await connect()
  const streamerId = await join(streamer, ROOM_A)
  await widz.next() // peer-joined

  streamer.send({ type: 'start-stream' })
  await streamer.next()

  expect(await widz.next()).toEqual({ type: 'stream-started', peerId: streamerId })
})

test('drugi chętny dostaje odmowę z komunikatem', async () => {
  const pierwszy = await connect()
  await join(pierwszy, ROOM_A)
  pierwszy.send({ type: 'start-stream' })
  await pierwszy.next()

  const drugi = await connect()
  await join(drugi, ROOM_A)
  await pierwszy.next() // peer-joined

  drugi.send({ type: 'start-stream' })

  const message = await drugi.next()
  expect(message.type).toBe('error')
  if (message.type !== 'error') throw new Error('zły typ')
  expect(message.message).toMatch(/udostępnia/i)
})

test('odmowa nie odbiera transmisji temu, kto nadaje', async () => {
  const pierwszy = await connect()
  const pierwszyId = await join(pierwszy, ROOM_A)
  pierwszy.send({ type: 'start-stream' })
  await pierwszy.next()

  const drugi = await connect()
  await join(drugi, ROOM_A)
  await pierwszy.next() // peer-joined
  drugi.send({ type: 'start-stream' })
  await drugi.next() // odmowa

  // Kolejny dołączający musi nadal widzieć pierwszego jako nadającego.
  const trzeci = await connect()
  trzeci.send({ type: 'join', roomId: ROOM_A })
  const joined = await trzeci.next()
  if (joined.type !== 'joined') throw new Error('zły typ')
  expect(joined.streamerId).toBe(pierwszyId)
})

test('zakończenie transmisji zwalnia miejsce i powiadamia pokój', async () => {
  const streamer = await connect()
  const streamerId = await join(streamer, ROOM_A)
  const widz = await connect()
  await join(widz, ROOM_A)
  await streamer.next() // peer-joined

  streamer.send({ type: 'start-stream' })
  await streamer.next()
  await widz.next() // stream-started

  streamer.send({ type: 'stop-stream' })

  expect(await widz.next()).toEqual({ type: 'stream-stopped', peerId: streamerId })
})

test('po zakończeniu ktoś inny może zacząć nadawać', async () => {
  const pierwszy = await connect()
  await join(pierwszy, ROOM_A)
  const drugi = await connect()
  const drugiId = await join(drugi, ROOM_A)
  await pierwszy.next() // peer-joined

  pierwszy.send({ type: 'start-stream' })
  await pierwszy.next()
  await drugi.next() // stream-started
  pierwszy.send({ type: 'stop-stream' })
  await drugi.next() // stream-stopped

  drugi.send({ type: 'start-stream' })

  expect(await drugi.next()).toEqual({ type: 'stream-started', peerId: drugiId })
})

test('rozłączenie nadającego zwalnia miejsce', async () => {
  // Bez tego zamknięcie okna zablokowałoby kanał na zawsze.
  const streamer = await connect()
  await join(streamer, ROOM_A)
  const widz = await connect()
  const widzId = await join(widz, ROOM_A)
  await streamer.next() // peer-joined
  streamer.send({ type: 'start-stream' })
  await streamer.next()
  await widz.next() // stream-started

  streamer.close()
  await widz.next() // stream-stopped albo peer-left, kolejność nieistotna
  await widz.next()

  widz.send({ type: 'start-stream' })
  expect(await widz.next()).toEqual({ type: 'stream-started', peerId: widzId })
})

test('nadawanie w innym pokoju nie blokuje tego pokoju', async () => {
  const wA = await connect()
  await join(wA, ROOM_A)
  wA.send({ type: 'start-stream' })
  await wA.next()

  const wB = await connect()
  const wBId = await join(wB, ROOM_B)
  wB.send({ type: 'start-stream' })

  expect(await wB.next()).toEqual({ type: 'stream-started', peerId: wBId })
})

test('start-stream przed dołączeniem to błąd', async () => {
  const client = await connect()

  client.send({ type: 'start-stream' })

  expect((await client.next()).type).toBe('error')
})

test('stop-stream od kogoś, kto nie nadaje, to błąd', async () => {
  // Inaczej dowolny widz mógłby zrzucić cudzą transmisję.
  const streamer = await connect()
  await join(streamer, ROOM_A)
  streamer.send({ type: 'start-stream' })
  await streamer.next()

  const widz = await connect()
  await join(widz, ROOM_A)
  await streamer.next() // peer-joined

  widz.send({ type: 'stop-stream' })

  expect((await widz.next()).type).toBe('error')
})
