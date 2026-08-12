import { expect, test } from 'vitest'
import { AVATAR_COLORS, avatarColorFrom, initialsFrom, badgesFor } from '../src/shared/participants'

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

test('kolejność plakietek jest stała', () => {
  expect(
    badgesFor({
      hasScreen: true,
      hasCamera: true,
      isWatchingUs: true,
      quality: 'ok',
      isUnreachable: true
    })
  ).toEqual([
    { kind: 'screen' },
    { kind: 'camera' },
    { kind: 'watching', quality: 'ok' },
    { kind: 'unreachable' }
  ])
})

test('plakietka „Ogląda" tylko dla osób, które nas oglądają', () => {
  const badges = badgesFor({
    hasScreen: false,
    hasCamera: false,
    isWatchingUs: false,
    quality: 'ok',
    isUnreachable: false
  })
  expect(badges).toEqual([])
})

test('nieznana jakość zostaje nieznana, a nie zamienia się w „płynnie"', () => {
  // Reguła z 0.3.1: cisza nie jest dobrą wiadomością. Gdyby brak raportu
  // dawał tu 'ok', wskaźnik kłamałby przez pierwsze sekundy oglądania.
  const badges = badgesFor({
    hasScreen: false,
    hasCamera: false,
    isWatchingUs: true,
    quality: 'unknown',
    isUnreachable: false
  })
  expect(badges).toEqual([{ kind: 'watching', quality: 'unknown' }])
})

test('brak połączenia widać także u osoby, która nic nie nadaje', () => {
  const badges = badgesFor({
    hasScreen: false,
    hasCamera: false,
    isWatchingUs: false,
    quality: 'unknown',
    isUnreachable: true
  })
  expect(badges).toEqual([{ kind: 'unreachable' }])
})

test('sama kamera bez ekranu daje jedną plakietkę', () => {
  const badges = badgesFor({
    hasScreen: false,
    hasCamera: true,
    isWatchingUs: false,
    quality: 'unknown',
    isUnreachable: false
  })
  expect(badges).toEqual([{ kind: 'camera' }])
})
