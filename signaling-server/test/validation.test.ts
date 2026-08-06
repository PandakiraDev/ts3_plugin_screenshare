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

async function join(client: TestClient, roomId: string): Promise<string> {
  client.send({ type: 'join', roomId })
  const message = await client.next()
  if (message.type !== 'joined') throw new Error(`oczekiwano joined, jest ${message.type}`)
  return message.peerId
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

// Brak pola kind i zła wartość pola kind to dwie różne sytuacje: pierwsza to
// stara wersja aplikacji (nie wie, że pole w ogóle istnieje), druga to zwykła
// literówka klienta. Użytkownik ma dostać różne podpowiedzi.
test('start-stream bez pola kind mówi wprost o starej wersji aplikacji', async () => {
  const client = await connect()
  await join(client, ROOM_A)

  client.send({ type: 'start-stream' })

  expect(await client.next()).toEqual({
    type: 'error',
    message: 'Ta wersja aplikacji jest za stara — zainstaluj nową, żeby udostępniać.'
  })
})

test('stop-stream bez pola kind dostaje tę samą instrukcję', async () => {
  const client = await connect()
  await join(client, ROOM_A)

  client.send({ type: 'stop-stream' })

  expect(await client.next()).toEqual({
    type: 'error',
    message: 'Ta wersja aplikacji jest za stara — zainstaluj nową, żeby udostępniać.'
  })
})

test('nieznany rodzaj strumienia to zwykły błąd walidacji, nie komunikat o wersji', async () => {
  // Inaczej literówka w kliencie ('ekran' zamiast 'screen') tworzyłaby
  // cichy, niewidoczny strumień albo myliłaby użytkownika komunikatem o
  // przestarzałej aplikacji, choć wcale o to nie chodzi.
  const client = await connect()
  await join(client, ROOM_A)

  client.send({ type: 'start-stream', kind: 'ekran' })

  expect(await client.next()).toEqual({ type: 'error', message: 'Nieznany rodzaj strumienia.' })
})

test('jawne kind: null to zła wartość, nie brak pola', async () => {
  // Rozróżnienie jest celowe i wąskie: parser sprawdza dokładnie `kind ===
  // undefined`, żeby odróżnić starą wersję aplikacji (w ogóle nie wysyła
  // pola) od obecnego klienta, który wysłał złą wartość. Uproszczenie tego
  // warunku do np. `!kind` albo `kind == null` po cichu zmieniłoby ten
  // przypadek na komunikat o starej wersji — mylący, bo aplikacja wcale nie
  // jest stara. Ten test ma złapać taką regresję.
  const client = await connect()
  await join(client, ROOM_A)

  client.send({ type: 'start-stream', kind: null })

  expect(await client.next()).toEqual({ type: 'error', message: 'Nieznany rodzaj strumienia.' })
})

test('poprawny rodzaj strumienia przechodzi', async () => {
  const client = await connect()
  const peerId = await join(client, ROOM_A)

  client.send({ type: 'start-stream', kind: 'camera' })

  expect(await client.next()).toEqual({ type: 'stream-started', peerId })
})
