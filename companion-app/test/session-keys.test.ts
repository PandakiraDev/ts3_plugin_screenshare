import { expect, test } from 'vitest'
import { connectionKey } from '../src/renderer/webrtc/session'

// Ekran i kamera tej samej osoby musza trafic do dwoch roznych polaczen.
// Wspolny klucz oznaczalby, ze wlaczenie kamery rozwala trwajacy stream ekranu.
test('ekran i kamera tej samej osoby maja rozne klucze', () => {
  expect(connectionKey('abc', 'screen')).not.toBe(connectionKey('abc', 'camera'))
})

test('klucz rozroznia osoby', () => {
  expect(connectionKey('abc', 'screen')).not.toBe(connectionKey('abd', 'screen'))
})
