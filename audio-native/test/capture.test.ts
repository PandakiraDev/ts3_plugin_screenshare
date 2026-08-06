import { expect, test } from 'vitest'
import { AudioCapture, FORMAT } from '../index.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Zly PID to najczestszy blad wolajacego — mapowanie okna na proces moze
// zwrocic 0 albo undefined. Musi byc slychac to od razu, a nie dopiero
// jako cicha cisza w streamie.
test('odmawia PID-u, ktory nie jest liczba', () => {
  expect(() => new AudioCapture('explorer' as never)).toThrow(/PID/i)
})

// Windows aktywuje loopback dla NIEISTNIEJACEGO procesu bez bledu i podaje
// cisze w nieskonczonosc (sprawdzone probem: PID 999999 -> 48 000 ramek,
// same zera). Cicha awaria jest gorsza od glosnej, wiec sprawdzamy sami.
test('odmawia PID-u nieistniejacego procesu', () => {
  expect(() => new AudioCapture(999999)).toThrow(/proces/i)
})

// Proces bez wlasnej sesji audio TEZ dostaje ramki — strumien loopback chodzi
// zegarem silnika audio, nie aktywnoscia aplikacji. Zmierzone probem:
// powershell.exe, ktory nic nie gra, dal 95 520 ramek w 2 s (~48 kHz).
// Dzieki temu test nie potrzebuje niczego grajacego w tle.
test('przechwytywanie z zywego procesu dostarcza ramki PCM', async () => {
  const capture = new AudioCapture(process.pid)
  const chunks: Buffer[] = []

  capture.start((chunk: Buffer) => {
    chunks.push(chunk)
  })
  await sleep(1000)
  capture.stop()

  expect(chunks.length).toBeGreaterThan(0)
})

// Renderer musi znac format, zeby zbudowac AudioBuffer — inaczej kazda strona
// zgadywalaby 48 kHz osobno i rozjechalyby sie przy pierwszej zmianie.
test('modul podaje format, w ktorym oddaje probki', () => {
  expect(FORMAT).toEqual({
    sampleRate: 48000,
    channels: 2,
    bytesPerSample: 4,
    encoding: 'float32'
  })
})

test('kazdy pakiet zawiera cale ramki, nie ucieta probke', async () => {
  const capture = new AudioCapture(process.pid)
  const dlugosci: number[] = []

  capture.start((chunk: Buffer) => {
    dlugosci.push(chunk.length)
  })
  await sleep(500)
  capture.stop()

  const ramka = FORMAT.channels * FORMAT.bytesPerSample
  expect(dlugosci.every((n) => n % ramka === 0)).toBe(true)
})

test('tempo strumienia zgadza sie z deklarowanym formatem', async () => {
  const capture = new AudioCapture(process.pid)
  let bajtow = 0

  capture.start((chunk: Buffer) => {
    bajtow += chunk.length
  })
  await sleep(1000)
  capture.stop()

  const ramek = bajtow / (FORMAT.channels * FORMAT.bytesPerSample)
  // Szeroki margines: pierwsze pakiety potrafia sie spoznic, a timer testu
  // nie jest zegarem audio. Chodzi o wykrycie zlego formatu (mono albo
  // 44,1 kHz dalyby polowe albo 92% tej wartosci), nie o precyzje.
  expect(ramek).toBeGreaterThan(FORMAT.sampleRate * 0.7)
  expect(ramek).toBeLessThan(FORMAT.sampleRate * 1.3)
})

// Bez tej blokady drugi start() nadpisalby zyjacy std::thread, a to w C++
// znaczy std::terminate — caly proces Electrona ginie bez sladu.
test('drugi start() bez stop() jest odrzucany', () => {
  const capture = new AudioCapture(process.pid)
  capture.start(() => {})

  expect(() => capture.start(() => {})).toThrow(/trwa/i)

  capture.stop()
})

// Uzytkownik przelacza aplikacje w trakcie streamu, wiec para stop()/start()
// musi dzialac w kolko, a nie tylko raz.
test('po stop() da sie wystartowac ponownie', async () => {
  const capture = new AudioCapture(process.pid)

  capture.start(() => {})
  await sleep(200)
  capture.stop()

  let poWznowieniu = 0
  capture.start(() => {
    poWznowieniu += 1
  })
  await sleep(300)
  capture.stop()

  expect(poWznowieniu).toBeGreaterThan(0)
})

test('stop() zatrzymuje naplyw ramek', async () => {
  const capture = new AudioCapture(process.pid)
  let pakietow = 0

  capture.start(() => {
    pakietow += 1
  })
  await sleep(300)
  capture.stop()
  const poStopie = pakietow

  await sleep(300)

  expect(pakietow).toBe(poStopie)
})
