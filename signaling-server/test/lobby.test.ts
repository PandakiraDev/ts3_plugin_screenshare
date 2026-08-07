import { afterEach, beforeEach, expect, test } from 'vitest'
import { startSignalingServer, type SignalingServer } from '../src/server.js'
import { MemoryKeyStore } from '../src/keys.js'
import { ROOM_A, TestClient } from './helpers.js'

/**
 * Ekran i kamera tej samej osoby muszą żyć jako dwa niezależne wpisy w
 * pokoju — to test na regres, którego się boimy: zamknięcie jednego
 * strumienia nie może po cichu ubić drugiego.
 */
const KEY = 'a'.repeat(64)

let server: SignalingServer
const clients: TestClient[] = []

beforeEach(async () => {
  server = await startSignalingServer({ port: 0, keyStore: new MemoryKeyStore([KEY]) })
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

test('ekran i kamera tej samej osoby to dwa niezalezne strumienie', async () => {
  const a = await connect()
  a.send({ type: 'join', roomId: ROOM_A, apiKey: KEY })
  await a.next()
  const b = await connect()
  b.send({ type: 'join', roomId: ROOM_A, apiKey: KEY })
  await b.next()
  await a.next() // peer-joined

  b.send({ type: 'start-stream', kind: 'screen' })
  b.send({ type: 'start-stream', kind: 'camera' })
  expect((await a.next())).toMatchObject({ type: 'stream-started', kind: 'screen' })
  expect((await a.next())).toMatchObject({ type: 'stream-started', kind: 'camera' })

  // Wylaczenie kamery nie moze ubic ekranu — to jest ten regres, ktorego sie boimy.
  b.send({ type: 'stop-stream', kind: 'camera' })
  expect((await a.next())).toMatchObject({ type: 'stream-stopped', kind: 'camera' })

  const c = await connect()
  c.send({ type: 'join', roomId: ROOM_A, apiKey: KEY })
  const joined = await c.next()
  if (joined.type !== 'joined') throw new Error('zly typ')
  expect(joined.streams).toEqual([{ peerId: expect.any(String), kind: 'screen' }])
})

test('rozlaczenie sprzata wszystkie strumienie peera', async () => {
  const a = await connect()
  a.send({ type: 'join', roomId: ROOM_A, apiKey: KEY })
  await a.next()
  const b = await connect()
  b.send({ type: 'join', roomId: ROOM_A, apiKey: KEY })
  await b.next()
  await a.next()

  b.send({ type: 'start-stream', kind: 'screen' })
  b.send({ type: 'start-stream', kind: 'camera' })
  await a.next()
  await a.next()
  b.close()
  await a.next() // peer-left

  const c = await connect()
  c.send({ type: 'join', roomId: ROOM_A, apiKey: KEY })
  const joined = await c.next()
  if (joined.type !== 'joined') throw new Error('zly typ')
  expect(joined.streams).toEqual([])
})

test('stara wersja aplikacji dostaje instrukcje, nie ogolny blad', async () => {
  const a = await connect()
  a.send({ type: 'join', roomId: ROOM_A, apiKey: KEY })
  await a.next()

  a.sendRaw(JSON.stringify({ type: 'start-stream' }))

  const response = await a.next()
  if (response.type !== 'error') throw new Error('zly typ')
  expect(response.message).toMatch(/wersj/i)
})
