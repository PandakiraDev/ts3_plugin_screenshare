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

test('puste pole między przecinkami daje brak odczytu, nie zero', () => {
  // Bez tego przypadku regex osłabiony z `\d+` na `\d*` przechodzi wszystkie
  // testy, a puste pole daje `Number('')` === 0 — czyli dokładnie to fałszywe
  // zero, którego ta funkcja ma nie produkować.
  expect(parseNvidiaSmi('1, , 3', 1)).toBeNull()
  expect(parseNvidiaSmi('1, 2,', 1)).toBeNull()
  expect(parseNvidiaSmi(',,', 1)).toBeNull()
})

test('za dużo pól daje brak odczytu', () => {
  // Pilnuje `parts.length !== 3`: przy osłabieniu do `< 3` cztery pola
  // dawałyby odczyt złożony z pierwszych trzech, bez śladu, że coś nie gra.
  expect(parseNvidiaSmi('1, 2, 3, 4', 1)).toBeNull()
})

test('[N/A] w ostatnim polu też daje brak odczytu', () => {
  // Osobny przypadek, bo sprawdzanie tylko dwóch pierwszych pól przechodziło
  // dotąd na zielono — trzecie było pokryte wyłącznie wejściem z trzema [N/A].
  expect(parseNvidiaSmi('99, 10034, [N/A]', 1)).toBeNull()
})

test('zakończenie CRLF z Windowsa nie przeszkadza', () => {
  // Zmierzone na prawdziwym nvidia-smi: zwraca "70, 10268, 12282\r\n", więc
  // po split('\n') pierwsza linia kończy się znakiem CR. Oba trim() zdejmują go
  // niezależnie, więc osłabienie jednego z nich nie psuje odczytu. Test łapie
  // dopiero osłabienie obu naraz: wtedy każdy odczyt z Windowsa dawałby brak
  // odczytu, czyli ciche „GPU —".
  const reading = parseNvidiaSmi('70, 10268, 12282\r\n', 9)
  expect(reading).toEqual({
    utilizationPercent: 70,
    memoryUsedMb: 10268,
    memoryTotalMb: 12282,
    at: 9
  })
})

test('liczba zbyt duża, by być skończoną, daje brak odczytu', () => {
  // 400 cyfr przechodzi regex `^\d+$`, ale Number() daje Infinity.
  // Nieskończoność nie jest ani poprawnym odczytem, ani brakiem odczytu, więc
  // bez tego sprawdzenia wyciekałaby do reszty aplikacji jako „prawdziwa" wartość.
  // Z nvidia-smi to się nie zdarzy — to zabezpieczenie na wypadek, gdyby
  // ktoś kiedyś podstawił tu inne źródło danych.
  const absurd = '9'.repeat(400)
  expect(parseNvidiaSmi(`${absurd}, 100, 200`, 1)).toBeNull()
})
