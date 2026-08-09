import { expect, test } from 'vitest'
import { NO_UPDATE, reduceUpdate, updateNoticeText } from '../src/shared/update'

test('bez pobranej aktualizacji pasek się nie pokazuje', () => {
  expect(updateNoticeText(NO_UPDATE)).toBeNull()
})

test('pobrana wersja trafia do tekstu paska', () => {
  const state = reduceUpdate(NO_UPDATE, { type: 'downloaded', version: '0.3.0' })
  expect(state.readyVersion).toBe('0.3.0')
  expect(updateNoticeText(state)).toContain('0.3.0')
})

test('błąd sprawdzania nie kasuje już pobranej wersji', () => {
  // Reguła nieoczywista i jedyny prawdziwy powód, żeby ten reduktor istniał.
  // Plik leży już na dysku i zainstaluje się po wyjściu z aplikacji. Nieudane
  // jest KOLEJNE sprawdzenie, nie ta aktualizacja — schowanie paska
  // okłamałoby użytkownika.
  const downloaded = reduceUpdate(NO_UPDATE, { type: 'downloaded', version: '0.3.0' })
  const afterError = reduceUpdate(downloaded, { type: 'error' })
  expect(afterError.readyVersion).toBe('0.3.0')
})

test('sprawdzanie i brak nowej wersji nie pokazują niczego', () => {
  expect(updateNoticeText(reduceUpdate(NO_UPDATE, { type: 'checking' }))).toBeNull()
  expect(updateNoticeText(reduceUpdate(NO_UPDATE, { type: 'not-available' }))).toBeNull()
})

test('błąd bez wcześniejszego pobrania nie wyczarowuje paska', () => {
  expect(updateNoticeText(reduceUpdate(NO_UPDATE, { type: 'error' }))).toBeNull()
})
