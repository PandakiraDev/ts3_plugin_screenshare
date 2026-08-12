import { expect, test } from 'vitest'
import { connectionKey, viewerPeerIds } from '../src/renderer/webrtc/session'

// Ekran i kamera tej samej osoby musza trafic do dwoch roznych polaczen.
// Wspolny klucz oznaczalby, ze wlaczenie kamery rozwala trwajacy stream ekranu.
test('ekran i kamera tej samej osoby maja rozne klucze', () => {
  expect(connectionKey('abc', 'screen')).not.toBe(connectionKey('abc', 'camera'))
})

test('klucz rozroznia osoby', () => {
  expect(connectionKey('abc', 'screen')).not.toBe(connectionKey('abd', 'screen'))
})

test('widz z ekranem i kamerą liczy się raz', () => {
  // Jedna osoba oglądająca oba nasze strumienie ma dwa połączenia
  // wychodzące, ale to wciąż jedna osoba na liście.
  const connections = new Set([
    connectionKey('widz', 'screen'),
    connectionKey('widz', 'camera')
  ])
  expect(viewerPeerIds(['widz'], (key) => connections.has(key))).toEqual(['widz'])
})

test('osoba bez połączenia wychodzącego nie jest widzem', () => {
  const connections = new Set([connectionKey('a', 'screen')])
  expect(viewerPeerIds(['a', 'b'], (key) => connections.has(key))).toEqual(['a'])
})

test('nikt bez połączenia wychodzącego nie jest widzem', () => {
  expect(viewerPeerIds(['a', 'b'], () => false)).toEqual([])
})

test('kolejność wynika z kolejności uczestników', () => {
  const connections = new Set([
    connectionKey('a', 'screen'),
    connectionKey('b', 'camera')
  ])
  expect(viewerPeerIds(['a', 'b'], (key) => connections.has(key))).toEqual(['a', 'b'])
})
