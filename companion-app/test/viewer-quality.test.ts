import { expect, test } from 'vitest'
import {
  FROZEN_FRACTION_POOR,
  QUALITY_STALE_AFTER_MS,
  allViewersStruggling,
  qualityFromReport,
  type ViewerQuality
} from '../src/shared/viewerQuality'

test('brak raportu to nie jest dobra wiadomość', () => {
  // Cisza znaczy "nie wiemy", nie "wszystko gra". Bez tego rozróżnienia
  // wskaźnik kłamałby przez pierwsze sekundy po dołączeniu widza.
  expect(qualityFromReport(null, 0)).toBe('unknown')
})

test('raport w progu jest w porządku, powyżej progu już nie', () => {
  const okno = 10_000
  const naProgu = okno * FROZEN_FRACTION_POOR
  expect(qualityFromReport({ frozenMs: naProgu, windowMs: okno }, 0)).toBe('ok')
  expect(qualityFromReport({ frozenMs: naProgu + 1, windowMs: okno }, 0)).toBe('poor')
})

test('obraz stojący prawie cały czas to zdecydowanie słabo', () => {
  expect(qualityFromReport({ frozenMs: 9_000, windowMs: 10_000 }, 0)).toBe('poor')
})

test('brak zamrożeń to dobrze', () => {
  expect(qualityFromReport({ frozenMs: 0, windowMs: 10_000 }, 0)).toBe('ok')
})

test('stary raport przestaje cokolwiek znaczyć', () => {
  const dobry = { frozenMs: 0, windowMs: 10_000 }
  expect(qualityFromReport(dobry, QUALITY_STALE_AFTER_MS - 1)).toBe('ok')
  expect(qualityFromReport(dobry, QUALITY_STALE_AFTER_MS)).toBe('unknown')
})

test('okno zerowej długości nie dzieli przez zero', () => {
  expect(qualityFromReport({ frozenMs: 0, windowMs: 0 }, 0)).toBe('unknown')
})

test('jeden widz z problemem to jego problem, nie nasz', () => {
  // Przy jednym widzu nie da się odróżnić "moje łącze" od "jego komputer",
  // więc pasek ma milczeć, a informacja zostaje przy nazwisku.
  expect(allViewersStruggling(['poor'])).toBe(false)
})

test('dwóch widzów z problemem to już wspólny mianownik', () => {
  expect(allViewersStruggling(['poor', 'poor'])).toBe(true)
})

test('jeden słabo i jeden dobrze to nie jest wina nadawcy', () => {
  expect(allViewersStruggling(['poor', 'ok'])).toBe(false)
})

test('nie wiemy, więc nie krzyczymy', () => {
  expect(allViewersStruggling(['unknown', 'unknown'])).toBe(false)
  expect(allViewersStruggling(['poor', 'unknown'])).toBe(false)
})

test('brak widzów to brak problemu', () => {
  const pusto: ViewerQuality[] = []
  expect(allViewersStruggling(pusto)).toBe(false)
})
