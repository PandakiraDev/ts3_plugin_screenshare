import { expect, test } from 'vitest'
import { DEFAULT_PORT, resolvePort } from '../src/config.js'

test('brak zmiennej PORT daje port domyślny', () => {
  expect(resolvePort(undefined)).toBe(DEFAULT_PORT)
})

test('poprawny PORT jest używany', () => {
  expect(resolvePort('9000')).toBe(9000)
})

test('pusty lub niepoprawny PORT nie ubija startu — wraca domyślny', () => {
  // Hosting potrafi wstrzyknąć pusty string; lepiej wystartować na domyślnym
  // porcie niż paść przy starcie kontenera.
  expect(resolvePort('')).toBe(DEFAULT_PORT)
  expect(resolvePort('osiem-tysiecy')).toBe(DEFAULT_PORT)
  expect(resolvePort('-1')).toBe(DEFAULT_PORT)
  expect(resolvePort('70000')).toBe(DEFAULT_PORT)
})
