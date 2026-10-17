import type { StreamKind } from '../../shared/types'

/*
 * Osobny moduł, a nie kawałek `session.ts`: reguła zgodności wstecz siedzi
 * tu w kilkunastu linijkach z własnym testem obok, zamiast tonąć w ośmiuset
 * linijkach sesji. Importu `session.ts` goły Node by zniósł — wywraca się
 * dopiero WYKONANIE `new RTCPeerConnection` — więc nie o to chodzi.
 */

/** Widz rezygnuje z odbioru tego strumienia. */
export interface UnsubscribePayload {
  kind: 'unsubscribe'
  streamKind: StreamKind
}

/** Widz wraca do odbioru tego strumienia. */
export interface SubscribePayload {
  kind: 'subscribe'
  streamKind: StreamKind
}

/*
 * Dwa osobne interfejsy, a nie jeden z unią w polu `kind`: `SignalPayload`
 * w `session.ts` zwęża się po `payload.kind`, a to działa tylko wtedy, gdy
 * każdy wariant unii ma w tym polu JEDEN literał.
 */
export type SubscriptionPayload = UnsubscribePayload | SubscribePayload

/*
 * Pole nazywa się `streamKind`, a NIE `stream`, i to jest warunek zgodności
 * wstecz, nie kwestia gustu — pełne uzasadnienie w `test/signal-compat.test.ts`.
 * Ten sam wzorzec ma wiadomość `quality` z 0.3.1.
 *
 * NIE ZMIENIAJ tej nazwy na krótszą. Skutek byłby widoczny wyłącznie u osób
 * ze starszą wersją aplikacji, jako nieudane zestawianie połączenia, i nikt nie
 * powiązałby tego z tą zmianą.
 */
export function unsubscribePayload(streamKind: StreamKind): UnsubscribePayload {
  return { kind: 'unsubscribe', streamKind }
}

export function subscribePayload(streamKind: StreamKind): SubscribePayload {
  return { kind: 'subscribe', streamKind }
}
