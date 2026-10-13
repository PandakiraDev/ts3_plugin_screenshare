import { expect, test } from 'vitest'
import { parseNvidiaSmi } from '../src/shared/diagnostics'

test('poprawny odczyt jednej karty', () => {
  const reading = parseNvidiaSmi('99, 10034, 12282', 1000)
  expect(reading).toEqual({
    utilizationPercent: 99,
    memoryUsedMb: 10034,
    memoryTotalMb: 12282,
    at: 1000
  })
})

test('nadmiarowe spacje i koniec linii nie przeszkadzają', () => {
  expect(parseNvidiaSmi('  23 ,  512 , 8192  \n', 5)?.utilizationPercent).toBe(23)
})

test('dwie karty: bierzemy pierwszą linię', () => {
  // nvidia-smi wypisuje jedną linię na kartę i tylko karty NVIDIA.
  const reading = parseNvidiaSmi('99, 10034, 12282\n5, 100, 8192', 1)
  expect(reading?.utilizationPercent).toBe(99)
  expect(reading?.memoryTotalMb).toBe(12282)
})

test('wartość [N/A] daje brak odczytu, a nie zero', () => {
  // Zero znaczyłoby „karta nic nie robi" — to kłamstwo. Część kart zwraca
  // [N/A] dla zużycia i wtedy po prostu NIE WIEMY.
  expect(parseNvidiaSmi('[N/A], 10034, 12282', 1)).toBeNull()
  expect(parseNvidiaSmi('99, [N/A], 12282', 1)).toBeNull()
})

test('puste wyjście daje brak odczytu', () => {
  expect(parseNvidiaSmi('', 1)).toBeNull()
  expect(parseNvidiaSmi('   \n  ', 1)).toBeNull()
})

test('śmieci dają brak odczytu', () => {
  expect(parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate', 1)).toBeNull()
  expect(parseNvidiaSmi('99, 10034', 1)).toBeNull()
})

test('brak odczytu nigdy nie udaje bezczynnej karty', () => {
  // Test pilnuje reguły jako takiej, osobno od pojedynczych przypadków:
  // ŻADNE złe wejście nie może dać liczby zero zamiast null.
  for (const bad of ['', '   ', '[N/A], [N/A], [N/A]', 'blad', '1, 2']) {
    const reading = parseNvidiaSmi(bad, 1)
    expect(reading, `wejście ${JSON.stringify(bad)}`).toBeNull()
  }
})
