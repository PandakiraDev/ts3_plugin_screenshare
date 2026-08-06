import { afterEach, beforeEach, expect, test } from 'vitest'
import type { SignalingServer } from '../src/server.js'
import { ROOM_A, startTestServer, TestClient } from './helpers.js'

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

/** Wiadomości, które muszą zostać odrzucone błędem, a nie wywalić serwera. */
const zleWiadomosci: [string, unknown][] = [
  ['join bez roomId', { type: 'join', role: 'stream' }],
  ['join z roomId nie-stringiem', { type: 'join', roomId: 42, role: 'stream' }],
  ['join z pustym roomId', { type: 'join', roomId: '', role: 'stream' }],
  // Poniższe mają poprawny roomId, żeby padały z powodu roli, a nie ID pokoju.
  
  
  ['signal bez pola to', { type: 'signal', payload: {} }],
  ['signal z to nie-stringiem', { type: 'signal', to: 7, payload: {} }],
  ['wiadomość bez typu', { roomId: ROOM_A }],
  ['tablica zamiast obiektu', [1, 2, 3]],
  ['goły null', null]
]

test.each(zleWiadomosci)('odrzuca błędem: %s', async (_opis, wiadomosc) => {
  const client = await connect()

  client.send(wiadomosc)

  const message = await client.next()
  expect(message.type).toBe('error')
})

test('serwer żyje dalej po serii złych wiadomości', async () => {
  const client = await connect()
  for (const [, wiadomosc] of zleWiadomosci) {
    client.send(wiadomosc)
    await client.next()
  }

  // Po tym wszystkim normalne dołączenie ma zadziałać.
  client.send({ type: 'join', roomId: ROOM_A, role: 'stream' })
  const message = await client.next()
  expect(message.type).toBe('joined')
})
