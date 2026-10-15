import type { StreamKind } from '../../shared/types'

/**
 * Treść wiadomości o rezygnacji z odbioru i o powrocie do odbioru.
 *
 * Osobny plik, a nie `session.ts`: tamten ciągnie typy przeglądarkowe, a ta
 * część musi dać się sprawdzić testem w gołym Node — bo właśnie ona decyduje
 * o zgodności ze starszymi wersjami aplikacji.
 */
export interface SubscriptionPayload {
  kind: 'unsubscribe' | 'subscribe'
  streamKind: StreamKind
}

/*
 * Pole nazywa się `streamKind`, a NIE `stream`, i to jest warunek zgodności
 * wstecz, nie kwestia gustu — pełne uzasadnienie w `test/signal-compat.test.ts`.
 * Ten sam wzorzec ma wiadomość `quality` z 0.3.1.
 *
 * NIE ZMIENIAJ tej nazwy na krótszą. Skutek byłby widoczny wyłącznie u osób
 * ze starszą wersją aplikacji, jako nieudane zestawianie połączenia, i nikt nie
 * powiązałby tego z tą zmianą.
 */
export function unsubscribePayload(streamKind: StreamKind): SubscriptionPayload {
  return { kind: 'unsubscribe', streamKind }
}

export function subscribePayload(streamKind: StreamKind): SubscriptionPayload {
  return { kind: 'subscribe', streamKind }
}
