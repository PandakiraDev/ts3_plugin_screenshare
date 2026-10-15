import { expect, test } from 'vitest'
import { unsubscribePayload } from '../src/renderer/webrtc/signalCompat'

/*
 * Dlaczego ten plik istnieje.
 *
 * `onSignal` w WYDANYCH wersjach aplikacji (0.3.3 i starszych) nie ma gałęzi
 * „nieznany rodzaj": wszystko, co nie jest `quality`, `offer` ani `answer`,
 * spada na ścieżkę kandydata ICE i wykonuje
 * `incomingBuffers.get(connectionKey(from, payload.stream))?.add(payload.candidate)`.
 *
 * Przy polu `streamKind` klucz wychodzi „peer:undefined", nie pasuje do
 * żadnego bufora, operator `?.` wycisza wywołanie i stary klient ignoruje
 * wiadomość DOWODNIE. Gdyby pole nazywało się `stream`, klucz trafiłby
 * w prawdziwy bufor.
 *
 * Okno szkody jest przy tym WĘŻSZE, niż wygląda, i warto je znać dokładnie:
 * dopóki bufor czeka na `setRemoteDescription`, `add` tylko odkłada
 * `undefined` do kolejki, a `flush()` ma `if (candidate)` i po cichu je
 * wyrzuca. Groźna jest ścieżka PO `setRemoteDescription`: tam `add` woła już
 * `addIceCandidate(undefined)`, co w WebRTC znaczy „koniec kandydatów" —
 * u kogoś, kto o tej funkcji nawet nie wie.
 *
 * Ten sam wzorzec i z tego samego powodu ma wiadomość `quality` z 0.3.1 —
 * patrz jej komentarz w `session.ts`.
 */

test('treść rezygnacji NIE MA pola `stream` — to warunek zgodności wstecz', () => {
  const payload = unsubscribePayload('screen')
  expect('stream' in payload).toBe(false)
})

test('rodzaj strumienia jedzie w polu `streamKind`', () => {
  expect(unsubscribePayload('screen').streamKind).toBe('screen')
  expect(unsubscribePayload('camera').streamKind).toBe('camera')
})

test('treść rezygnacji nie ma pola `candidate` ani `owner`', () => {
  // Oba są czytane przez starą ścieżkę ICE. `candidate: undefined` byłoby
  // nieszkodliwe tylko przez przypadek, a `owner` równy nam skierowałby
  // starego klienta do drugiego bufora.
  const payload = unsubscribePayload('screen')
  expect('candidate' in payload).toBe(false)
  expect('owner' in payload).toBe(false)
})
