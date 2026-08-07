import { expect, test } from 'vitest'
import { connectionKey, countViewers } from '../src/renderer/webrtc/session'

// Ekran i kamera tej samej osoby musza trafic do dwoch roznych polaczen.
// Wspolny klucz oznaczalby, ze wlaczenie kamery rozwala trwajacy stream ekranu.
test('ekran i kamera tej samej osoby maja rozne klucze', () => {
  expect(connectionKey('abc', 'screen')).not.toBe(connectionKey('abc', 'camera'))
})

test('klucz rozroznia osoby', () => {
  expect(connectionKey('abc', 'screen')).not.toBe(connectionKey('abd', 'screen'))
})

// Widz ogladajacy nasz ekran I nasza kamere ma DWA polaczenia, ale jest jedna
// osoba. Liczenie polaczen pokazywaloby "2 widzow", choc siedzi tam jeden.
test('ten sam widz na ekranie i kamerze liczy sie raz', () => {
  const connections = new Set([
    connectionKey('widz', 'screen'),
    connectionKey('widz', 'camera')
  ])
  expect(countViewers(['widz'], (key) => connections.has(key))).toBe(1)
})

test('dwie rozne osoby to dwoch widzow', () => {
  const connections = new Set([connectionKey('a', 'screen'), connectionKey('b', 'camera')])
  expect(countViewers(['a', 'b'], (key) => connections.has(key))).toBe(2)
})

test('uczestnik bez polaczenia z nami nie jest widzem', () => {
  expect(countViewers(['a', 'b'], () => false)).toBe(0)
})
