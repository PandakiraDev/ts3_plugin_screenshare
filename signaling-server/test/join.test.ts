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

/** Dołącza do pokoju i zwraca peerId. Rola nie istnieje — każdy jest równy. */
async function join(client: TestClient, roomId: string): Promise<string> {
  client.send({ type: 'join', roomId })
  const message = await client.next()
  if (message.type !== 'joined') throw new Error(`oczekiwano joined, jest ${message.type}`)
  return message.peerId
}

test('pierwszy peer dostaje swoje id, pusty pokój i pustą listę nadających', async () => {
  const client = await connect()

  client.send({ type: 'join', roomId: ROOM_A })

  const message = await client.next()
  if (message.type !== 'joined') throw new Error('zły typ')
  expect(message.peerId).toBeTypeOf('string')
  expect(message.peers).toEqual([])
  expect(message.streamers).toEqual([])
})

test('drugi peer widzi pierwszego', async () => {
  const first = await connect()
  const firstId = await join(first, ROOM_A)

  const second = await connect()
  second.send({ type: 'join', roomId: ROOM_A })

  const message = await second.next()
  if (message.type !== 'joined') throw new Error('zły typ')
  expect(message.peers).toEqual([{ peerId: firstId, displayName: 'Użytkownik 1' }])
})

test('dołączający w trakcie transmisji od razu wie, kto nadaje', async () => {
  // Sedno lobby: wchodzisz i natychmiast wiesz, czy jest co oglądać.
  const streamer = await connect()
  const streamerId = await join(streamer, ROOM_A)
  streamer.send({ type: 'start-stream' })
  await streamer.next()

  const pozny = await connect()
  pozny.send({ type: 'join', roomId: ROOM_A })

  const message = await pozny.next()
  if (message.type !== 'joined') throw new Error('zły typ')
  expect(message.streamers).toEqual([streamerId])
})

test('obecni dostają powiadomienie o nowym peerze', async () => {
  const first = await connect()
  await join(first, ROOM_A)

  const second = await connect()
  const secondId = await join(second, ROOM_A)

  expect(await first.next()).toEqual({
    type: 'peer-joined',
    peerId: secondId,
    displayName: 'Użytkownik 2'
  })
})

test('peery w różnych pokojach nie widzą się nawzajem', async () => {
  const wPokojuA = await connect()
  await join(wPokojuA, ROOM_A)

  const wPokojuB = await connect()
  wPokojuB.send({ type: 'join', roomId: ROOM_B })
  const message = await wPokojuB.next()

  if (message.type !== 'joined') throw new Error('zły typ')
  expect(message.peers).toEqual([])
  await wPokojuA.expectSilence()
})
