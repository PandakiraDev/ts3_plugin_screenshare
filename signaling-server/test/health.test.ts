import { afterEach, expect, test } from 'vitest'
import { startSignalingServer, type SignalingServer } from '../src/server.js'
import { ROOM_A, TestClient } from './helpers.js'

let server: SignalingServer

afterEach(async () => {
  if (server) await server.close()
})

test('GET / zwraca 200 — health check hostingu musi przejść', async () => {
  // Render/Railway ubijają deploy, gdy health check nie dostanie 200.
  // Sam serwer WebSocket odpowiada na zwykłe GET błędem 400.
  server = await startSignalingServer({ port: 0 })

  const res = await fetch(`http://127.0.0.1:${server.port}/`)

  expect(res.status).toBe(200)
})

test('health check mówi, że to serwer sygnalizacyjny', async () => {
  server = await startSignalingServer({ port: 0 })

  const res = await fetch(`http://127.0.0.1:${server.port}/`)
  const body = await res.text()

  expect(body).toMatch(/signaling/i)
})

test('WebSocket dalej działa na tym samym porcie', async () => {
  // Dołożenie HTTP nie może zepsuć właściwej funkcji serwera.
  server = await startSignalingServer({ port: 0 })

  const client = await TestClient.connect(server.port)
  client.send({ type: 'join', roomId: ROOM_A })
  const message = await client.next()
  client.close()

  expect(message.type).toBe('joined')
})
