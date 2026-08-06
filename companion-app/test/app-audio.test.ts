import { expect, test } from 'vitest'
import { toOwnBuffer, AppAudioStream } from '../src/shared/audio'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Node alokuje male Buffery z jednej puli, wiec `chunk.buffer` to zwykle 8 KB
// cudzych danych, a nie nasz pakiet. Wyslanie tego do renderera dalby szum
// i rozjechany rozmiar — blad, ktory slychac dopiero w sluchawkach.
test('pakiet z puli Node trafia do transferu bez sasiadow', () => {
  const pula = Buffer.alloc(64, 0xaa)
  const pakiet = pula.subarray(16, 24)
  pakiet.fill(0x11)

  const bufor = toOwnBuffer(pakiet)

  expect(bufor.byteLength).toBe(8)
  expect([...new Uint8Array(bufor)]).toEqual([0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11])
})

test('probki docieraja do renderera jako Float32Array', async () => {
  const kanal = new MessageChannel()
  const stream = new AppAudioStream(kanal.port2 as unknown as MessagePort)
  const odebrane: Float32Array[] = []
  stream.onChunk((probki) => odebrane.push(probki))

  const zrodlo = Float32Array.from([0.25, -0.5, 1, -1])
  kanal.port1.postMessage(zrodlo.buffer, [zrodlo.buffer])
  await sleep(20)

  expect(odebrane).toHaveLength(1)
  expect([...odebrane[0]]).toEqual([0.25, -0.5, 1, -1])
})

// Ten sam problem, ktory wyszedl w module natywnym: po zatrzymaniu do
// konsumenta nie moze dojechac ani jeden pakiet.
test('po close() nie przychodza kolejne pakiety', async () => {
  const kanal = new MessageChannel()
  const stream = new AppAudioStream(kanal.port2 as unknown as MessagePort)
  let pakietow = 0
  stream.onChunk(() => {
    pakietow += 1
  })

  stream.close()
  const zrodlo = new Float32Array(4)
  kanal.port1.postMessage(zrodlo.buffer, [zrodlo.buffer])
  await sleep(20)

  expect(pakietow).toBe(0)
})
