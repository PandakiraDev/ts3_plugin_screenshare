import { expect, test } from 'vitest'
import { deriveRoomId } from '../src/shared/room'

test('ten sam serwer i kanał dają ten sam klucz', () => {
  // Bez tego streamer i widz wylądowaliby w różnych pokojach.
  const a = deriveRoomId('ts.przyklad.pl:9987', '42')
  const b = deriveRoomId('ts.przyklad.pl:9987', '42')
  expect(a).toBe(b)
})

test('klucz ma format wymagany przez signaling server', () => {
  const key = deriveRoomId('ts.przyklad.pl:9987', '42')
  expect(key).toMatch(/^[0-9a-f]{64}$/)
})

test('inny kanał na tym samym serwerze daje inny klucz', () => {
  const channel1 = deriveRoomId('ts.przyklad.pl:9987', '1')
  const channel2 = deriveRoomId('ts.przyklad.pl:9987', '2')
  expect(channel1).not.toBe(channel2)
})

test('ten sam numer kanału na innym serwerze daje inny klucz', () => {
  // Sedno zmiany: kanał 42 na dwóch różnych serwerach TS3 to dwa różne pokoje.
  const serverA = deriveRoomId('ts.przyklad.pl:9987', '42')
  const serverB = deriveRoomId('inny.serwer.pl:9987', '42')
  expect(serverA).not.toBe(serverB)
})

test('długość klucza nie zależy od długości danych wejściowych', () => {
  // Skrót o stałej długości nie może w sobie nieść oryginalnych danych.
  const short = deriveRoomId('a.pl', '1')
  const long = deriveRoomId('bardzo-dlugi-adres-serwera.przyklad.pl:9987', '9'.repeat(200))
  expect(short).toHaveLength(64)
  expect(long).toHaveLength(64)
})

test('adres serwera jest normalizowany — wielkość liter i spacje nie robią różnicy', () => {
  // Adres bywa wpisany ręcznie; drobna różnica w zapisie nie może rozdzielić pokoju.
  const canonical = deriveRoomId('ts.przyklad.pl:9987', '42')
  expect(deriveRoomId('TS.Przyklad.PL:9987', '42')).toBe(canonical)
  expect(deriveRoomId('  ts.przyklad.pl:9987  ', '42')).toBe(canonical)
})

test('granica między polami nie daje się podrobić', () => {
  // Bez separatora ("ab"+"c") i ("a"+"bc") dałyby ten sam klucz.
  expect(deriveRoomId('ab', 'c')).not.toBe(deriveRoomId('a', 'bc'))
})

test('puste dane wejściowe są odrzucane', () => {
  expect(() => deriveRoomId('', '42')).toThrow()
  expect(() => deriveRoomId('ts.przyklad.pl:9987', '')).toThrow()
})
