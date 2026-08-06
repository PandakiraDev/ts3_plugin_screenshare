import { afterEach, beforeEach, expect, test } from 'vitest'
// Prawdziwy serwer z sąsiedniego pakietu — celowo, żeby test wyłapał
// rozjechanie się protokołu między companion-app a signaling-server.
import {
  startSignalingServer,
  type SignalingServer
} from '../../signaling-server/src/server.js'
import { SignalingClient } from '../src/renderer/signaling/SignalingClient'
import type { StreamRef } from '../src/shared/types'

const ROOM = 'c'.repeat(64)

let server: SignalingServer
const clients: SignalingClient[] = []

beforeEach(async () => {
  server = await startSignalingServer({ port: 0 })
})

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  await server.close()
})

function track(client: SignalingClient): {
  peersJoined: string[]
  peersLeft: string[]
  streamStarted: StreamRef[]
  streamStopped: StreamRef[]
  signals: { from: string; payload: unknown }[]
  errors: string[]
} {
  const box = {
    peersJoined: [] as string[],
    peersLeft: [] as string[],
    streamStarted: [] as StreamRef[],
    streamStopped: [] as StreamRef[],
    signals: [] as { from: string; payload: unknown }[],
    errors: [] as string[]
  }
  client.on('peer-joined', (peer) => box.peersJoined.push(peer.peerId))
  client.on('peer-left', (peerId) => box.peersLeft.push(peerId))
  client.on('stream-started', (ref) => box.streamStarted.push(ref))
  client.on('stream-stopped', (ref) => box.streamStopped.push(ref))
  client.on('signal', (from, payload) => box.signals.push({ from, payload }))
  client.on('error', (message) => box.errors.push(message))
  return box
}

async function connect(): Promise<SignalingClient> {
  const client = await SignalingClient.connect(`ws://127.0.0.1:${server.port}`)
  clients.push(client)
  return client
}

const settle = (ms = 250): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

test('join zwraca peerId, listę obecnych i informację o nadającym', async () => {
  const client = await connect()

  const joined = await client.join(ROOM, null)

  expect(joined.peerId).toMatch(/^[0-9a-f-]{36}$/)
  expect(joined.peers).toEqual([])
  expect(joined.streams).toEqual([])
})

test('bez nicku serwer nadaje zastępczą nazwę', async () => {
  const client = await connect()

  const joined = await client.join(ROOM, null)

  expect(joined.displayName).toBe('Użytkownik 1')
})

test('nick z TS3 jest przekazywany i wraca w liście u pozostałych', async () => {
  const pierwszy = await connect()
  await pierwszy.join(ROOM, 'Konrad')

  const drugi = await connect()
  const joined = await drugi.join(ROOM, 'Ala')

  expect(joined.displayName).toBe('Ala')
  expect(joined.peers).toEqual([
    { peerId: expect.any(String), displayName: 'Konrad' }
  ])
})

test('dołączający w trakcie transmisji od razu zna nadających', async () => {
  const streamer = await connect()
  const streamerJoined = await streamer.join(ROOM, null)
  await streamer.startStream('screen')

  const pozny = await connect()
  const joined = await pozny.join(ROOM, null)

  expect(joined.streams).toEqual([{ peerId: streamerJoined.peerId, kind: 'screen' }])
})

test('klient dostaje powiadomienie o nowym peerze', async () => {
  const first = await connect()
  const box = track(first)
  await first.join(ROOM, null)

  const second = await connect()
  const secondJoined = await second.join(ROOM, null)
  await settle()

  expect(box.peersJoined).toEqual([secondJoined.peerId])
})

test('rozpoczęcie transmisji jest zgłaszane pozostałym', async () => {
  const widz = await connect()
  const box = track(widz)
  await widz.join(ROOM, null)
  const streamer = await connect()
  const streamerJoined = await streamer.join(ROOM, null)

  await streamer.startStream('screen')
  await settle()

  expect(box.streamStarted).toEqual([{ peerId: streamerJoined.peerId, kind: 'screen' }])
})

test('kilka osób może nadawać jednocześnie', async () => {
  // Limit jednego nadającego zniesiony — drugi start-stream ma przejsc.
  const pierwszy = await connect()
  await pierwszy.join(ROOM, null)
  await pierwszy.startStream('screen')

  const drugi = await connect()
  await drugi.join(ROOM, null)

  await expect(drugi.startStream('screen')).resolves.toBeUndefined()
})

test('nadający dostaje zdarzenie także o własnej transmisji', async () => {
  // Bez tego wlasne id nie trafia na liste nadajacych i panel nie pokazuje
  // ikony przy sobie samym.
  const client = await connect()
  const box = track(client)
  const joined = await client.join(ROOM, null)

  await client.startStream('screen')
  await settle()

  expect(box.streamStarted).toContainEqual({ peerId: joined.peerId, kind: 'screen' })
})

test('zakończenie transmisji jest zgłaszane pozostałym', async () => {
  const widz = await connect()
  const box = track(widz)
  await widz.join(ROOM, null)
  const streamer = await connect()
  const streamerJoined = await streamer.join(ROOM, null)
  await streamer.startStream('screen')
  await settle()

  await streamer.stopStream('screen')
  await settle()

  expect(box.streamStopped).toEqual([{ peerId: streamerJoined.peerId, kind: 'screen' }])
})

test('po zakończeniu ktoś inny może przejąć nadawanie', async () => {
  const pierwszy = await connect()
  await pierwszy.join(ROOM, null)
  const drugi = await connect()
  await drugi.join(ROOM, null)

  await pierwszy.startStream('screen')
  await pierwszy.stopStream('screen')
  await settle()

  await expect(drugi.startStream('screen')).resolves.toBeUndefined()
})

test('sygnał dociera do adresata z poprawnym nadawcą', async () => {
  const a = await connect()
  const aJoined = await a.join(ROOM, null)
  const b = await connect()
  const box = track(b)
  const bJoined = await b.join(ROOM, null)

  a.signal(bJoined.peerId, { sdp: 'offer' })
  await settle()

  expect(box.signals).toEqual([{ from: aJoined.peerId, payload: { sdp: 'offer' } }])
})

test('rozłączenie peera jest zgłaszane', async () => {
  const zostaje = await connect()
  const box = track(zostaje)
  await zostaje.join(ROOM, null)
  const wychodzi = await connect()
  const wychodziJoined = await wychodzi.join(ROOM, null)
  await settle()

  wychodzi.close()
  await settle()

  expect(box.peersLeft).toEqual([wychodziJoined.peerId])
})

test('zamknięcie okna nadającego zwalnia kanał dla pozostałych', async () => {
  const widz = await connect()
  const box = track(widz)
  await widz.join(ROOM, null)
  const streamer = await connect()
  await streamer.join(ROOM, null)
  await streamer.startStream('screen')
  await settle()

  streamer.close()
  await settle()

  expect(box.streamStopped).toHaveLength(1)
  await expect(widz.startStream('screen')).resolves.toBeUndefined()
})

test('rodzaj strumienia dociera do drugiego klienta', async () => {
  const a = await connect()
  await a.join(ROOM, null)
  const b = await connect()
  const box = track(b)
  await b.join(ROOM, null)

  await a.startStream('camera')

  await settle()
  expect(box.streamStarted[0]).toMatchObject({ kind: 'camera' })
})
