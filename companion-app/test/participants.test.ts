import { expect, test } from 'vitest'
import { AVATAR_COLORS, avatarColorFrom, initialsFrom } from '../src/shared/participants'

test('dwa słowa dają dwie pierwsze litery', () => {
  expect(initialsFrom('Jan Kowalski')).toBe('JK')
})

test('jedno słowo daje jego dwie pierwsze litery', () => {
  expect(initialsFrom('Marek')).toBe('MA')
})

test('polskie litery mają wyjść wielkie, a nie zniknąć', () => {
  expect(initialsFrom('Łukasz Żak')).toBe('ŁŻ')
})

test('nick z samych ozdobników daje znak zapytania', () => {
  // Na TS3 to normalny nick, a nie przypadek brzegowy z podręcznika.
  expect(initialsFrom('⭐⭐⭐')).toBe('?')
})

test('cyfry i podkreślenia nie trafiają do inicjałów', () => {
  expect(initialsFrom('xXx_Marek_xXx')).toBe('XM')
  expect(initialsFrom('3maniak')).toBe('MA')
})

test('pusta nazwa nie wywraca inicjałów', () => {
  expect(initialsFrom('')).toBe('?')
})

test('ta sama nazwa zawsze daje ten sam kolor', () => {
  // Kolor liczony z nazwy, a nie z peerId: peerId zmienia się między sesjami,
  // więc kolor skakałby po każdym ponownym wejściu do kanału.
  expect(avatarColorFrom('Marek')).toBe(avatarColorFrom('Marek'))
})

test('kolor pochodzi z palety', () => {
  expect(AVATAR_COLORS).toContain(avatarColorFrom('Ania'))
})

test('różne nazwy nie lądują wszystkie na jednym kolorze', () => {
  const names = ['Ala', 'Marek', 'Ania', 'Piotrek', 'Kasia', 'Tomek', 'Zosia', 'Bartek']
  const used = new Set(names.map(avatarColorFrom))
  expect(used.size).toBeGreaterThan(1)
})
