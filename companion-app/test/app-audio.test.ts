import { expect, test } from 'vitest'
import {
  toOwnBuffer,
  AppAudioStream,
  AudioTimeline,
  windowHandleFromSourceId
} from '../src/shared/audio'

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

// --- wybrane okno -> proces ------------------------------------------------

// Electron nadaje zrodlom id "window:<HWND>:0" — ta liczba to gotowy uchwyt
// okna, z ktorego WinAPI wyciaga PID wlasciciela.
test('wyciaga uchwyt okna z id zrodla', () => {
  expect(windowHandleFromSourceId('window:12345:0')).toBe(12345)
})

// Ekran nie nalezy do zadnego procesu, wiec nie ma z czego brac dzwieku
// jednej aplikacji. Musi byc null, a nie przypadkowa liczba.
test('ekran nie ma wlasciciela', () => {
  expect(windowHandleFromSourceId('screen:0:0')).toBeNull()
})

test('id bez sensu daje null zamiast NaN', () => {
  expect(windowHandleFromSourceId('window:abc:0')).toBeNull()
  expect(windowHandleFromSourceId('')).toBeNull()
  expect(windowHandleFromSourceId('window')).toBeNull()
})

// --- zegar znacznikow ------------------------------------------------------

test('pierwszy pakiet zaczyna sie od zera', () => {
  const zegar = new AudioTimeline(48000)

  expect(zegar.next(480)).toBe(0)
})

test('drugi znacznik odpowiada dlugosci pierwszego pakietu', () => {
  const zegar = new AudioTimeline(48000)
  zegar.next(480)

  // 480 ramek przy 48 kHz to rowne 10 ms.
  expect(zegar.next(480)).toBe(10_000)
})

// Gdyby zegar sumowal zaokraglone przyrosty, kazdy pakiet o dlugosci
// niedzielacej sie rowno dokladalby ulamek bledu. Po godzinie streamu to
// slyszalny rozjazd dzwieku z obrazem — a nikt by nie wiedzial, skad.
test('znaczniki nie dryfuja przy dlugosciach niedzielacych sie rowno', () => {
  const zegar = new AudioTimeline(48000)
  for (let i = 0; i < 1000; i++) zegar.next(441)

  // 1000 x 441 ramek = 441 000 ramek = dokladnie 9 187 500 us.
  // Sumowanie zaokraglen daloby 9 188 000 — o pol milisekundy za duzo.
  expect(zegar.next(441)).toBe(9_187_500)
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
