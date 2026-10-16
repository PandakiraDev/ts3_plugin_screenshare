import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings, serializeSettings } from '@shared/settings'
import { readSettings, writeSettings } from '../src/main/settings'

// Import WARTOŚCI z `@shared`, nie typu — alias rozwiązuje vitest.config.ts,
// a nie tsconfig.json; import typu przeszedłby nawet bez aliasu, bo znika przy
// kompilacji.
//
// Ten plik NIE importuje 'electron': `readSettings`/`writeSettings` biorą
// ścieżkę `userData` parametrem właśnie po to, żeby dało się je sprawdzić
// w gołym vitest — ten sam wzór co `createUpdateLogger` w `updateLogger.ts`.

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'settings-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

test('brak pliku daje wartości domyślne', () => {
  expect(parseSettings(null)).toEqual({ recordDiagnostics: false })
})

test('uszkodzony JSON daje wartości domyślne, nie wyjątek', () => {
  expect(parseSettings('{to nie jest json')).toEqual(DEFAULT_SETTINGS)
})

test('obcy typ pola jest odrzucany na rzecz wartości domyślnej', () => {
  // Nie `Boolean('nie')`, bo to dałoby `true` — napis „nie" znaczyłby „tak".
  expect(parseSettings('{"recordDiagnostics":"nie"}')).toEqual(DEFAULT_SETTINGS)
})

test('liczba w polu logicznym też jest odrzucana', () => {
  // Ta sama pułapka z drugiej strony: `Boolean(1)` dałoby `true`, czyli zapis
  // na dysk włączony przez plik, w którym nikt go nie włączył. `0` ukryłoby
  // błąd, bo przypadkiem zgadza się z wartością domyślną — dlatego pilnujemy
  // obu.
  expect(parseSettings('{"recordDiagnostics":1}')).toEqual(DEFAULT_SETTINGS)
  expect(parseSettings('{"recordDiagnostics":0}')).toEqual(DEFAULT_SETTINGS)
})

test('nieznane klucze są ignorowane, znane zachowane', () => {
  expect(parseSettings('{"recordDiagnostics":true,"czegoNieZnamy":7}')).toEqual({
    recordDiagnostics: true
  })
})

test('poprawne `false` w pliku zostaje `false`', () => {
  expect(parseSettings('{"recordDiagnostics":false}')).toEqual({ recordDiagnostics: false })
})

test('zapis i odczyt wracają tym samym', () => {
  expect(parseSettings(serializeSettings({ recordDiagnostics: true }))).toEqual({
    recordDiagnostics: true
  })
})

test('poprawny JSON, który nie jest obiektem, daje wartości domyślne', () => {
  // `null` jest tu najgroźniejszy: `typeof null === 'object'`, więc sprawdzenie
  // samego `typeof` przepuściłoby go dalej i odczyt pola wywaliłby się na
  // `null`. Pozostałe kształty przychodzą z obciętego albo podmienionego pliku.
  for (const raw of ['null', '[]', '7', '"tekst"', 'true']) {
    expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS)
  }
})

test('pusty plik daje wartości domyślne', () => {
  // Przerwany zapis zostawia zero bajtów, a `JSON.parse('')` rzuca.
  expect(parseSettings('')).toEqual(DEFAULT_SETTINGS)
  expect(parseSettings('   \n')).toEqual(DEFAULT_SETTINGS)
})

test('wartości domyślnych nie da się zepsuć zmianą wyniku', () => {
  // `parseSettings` musi zwracać ŚWIEŻY obiekt. Gdyby zwracała
  // `DEFAULT_SETTINGS`, pierwszy właściciel, który przestawi sobie pole
  // w otrzymanym obiekcie, zmieniłby wartość domyślną dla całego procesu.
  const first = parseSettings(null)
  first.recordDiagnostics = true

  expect(parseSettings(null)).toEqual({ recordDiagnostics: false })
  expect(DEFAULT_SETTINGS.recordDiagnostics).toBe(false)
})

test('readSettings bez pliku daje wartości domyślne', () => {
  expect(readSettings(workDir)).toEqual(DEFAULT_SETTINGS)
})

test('readSettings po writeSettings wraca tym samym', () => {
  writeSettings(workDir, { recordDiagnostics: true })

  expect(existsSync(join(workDir, 'settings.json'))).toBe(true)
  expect(readSettings(workDir)).toEqual({ recordDiagnostics: true })
})

test('readSettings na uszkodzonym pliku daje wartości domyślne, nie wyjątek', () => {
  // Punkt 1 z „Review Focus" na całej drodze: od bajtów na dysku do wartości,
  // z którą startuje aplikacja. Taki plik powstaje po przerwanym zapisie albo
  // po ręcznej edycji.
  writeFileSync(join(workDir, 'settings.json'), '{"recordDiagnostics":tr', 'utf8')

  expect(() => readSettings(workDir)).not.toThrow()
  expect(readSettings(workDir)).toEqual(DEFAULT_SETTINGS)
})

test('readSettings daje wartości domyślne, gdy pliku nie da się przeczytać', () => {
  // Katalog w miejscu pliku zamiast odebranych uprawnień: prawdziwej odmowy
  // dostępu nie da się na Windows zrobić w teście bez grzebania w ACL, a dla
  // `readFileSync` liczy się to samo — rzucony wyjątek na odczycie.
  mkdirSync(join(workDir, 'settings.json'))

  expect(() => readSettings(workDir)).not.toThrow()
  expect(readSettings(workDir)).toEqual(DEFAULT_SETTINGS)
})

test('writeSettings nie rzuca, gdy katalog nie istnieje', () => {
  const missingDir = join(workDir, 'nie-ma-takiego-katalogu')

  expect(() => writeSettings(missingDir, { recordDiagnostics: true })).not.toThrow()
  expect(writeSettings(missingDir, { recordDiagnostics: true })).toBe(false)
  expect(existsSync(join(missingDir, 'settings.json'))).toBe(false)
})

test('writeSettings mówi, że zapisał, gdy zapisał', () => {
  expect(writeSettings(workDir, { recordDiagnostics: true })).toBe(true)
})

test('zapisany plik da się przeczytać człowiekowi', () => {
  // Ustawienia będzie się czytało przez telefon przy szukaniu przyczyny, więc
  // plik nie może być jedną linią bez spacji.
  writeSettings(workDir, { recordDiagnostics: true })
  const content = readFileSync(join(workDir, 'settings.json'), 'utf8')

  expect(content).toContain('recordDiagnostics')
  expect(content.endsWith('\n')).toBe(true)
})
