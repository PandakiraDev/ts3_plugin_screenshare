import { useEffect, useRef } from 'react'
import { lobbyLogEntries, type LobbySnapshot } from '@shared/lobbyEvents'
import type { Lobby } from './useLobby'

/**
 * Pusty stan wyjściowy, czyli to, co widzieliśmy przed wejściem do pokoju.
 *
 * ŚWIADOMIE pusty, a nie „pierwszy zobaczony stan jako punkt odniesienia":
 * dzięki temu osoby, które były w lobby przed nami, dostają wpisy i dziennik
 * otwiera się listą obecnych. Bez tego czytający nie wie w ogóle, kto był
 * w pokoju, a to pierwsza rzecz potrzebna przy „dlaczego go nie widzę".
 *
 * Cena jest realna i trzeba ją znać: te osoby są opisane jako „wszedł do
 * lobby" w chwili NASZEGO wejścia, choć siedziały tam wcześniej. Pierwszy
 * wiersz dziennika jest więc stanem, nie zdarzeniem — a wpisy niżej już
 * zdarzeniami.
 */
const EMPTY_SNAPSHOT: LobbySnapshot = {
  me: null,
  peers: [],
  streams: [],
  error: null,
  unreachablePeerIds: [],
  signalingClosed: false
}

/**
 * Zamienia zmiany stanu lobby na wpisy dziennika i wypycha je do procesu
 * głównego.
 *
 * DLACZEGO Z RÓŻNICY STANÓW, A NIE Z CALLBACKÓW SESJI. Callbacki
 * (`onPeersChange`, `onStreamersChange`, `onError`, `onUnreachableChange`)
 * konsumuje `useLobby` w środku i do komponentu nie docierają — widać stąd
 * wyłącznie `lobby.state`. Poza tym każdy z nich niesie CAŁY stan, a nie
 * zdarzenie, a samo wywołanie nie znaczy zmiany (przykład z niedostępnymi
 * osobami stoi w nagłówku `src/shared/lobbyEvents.ts`). Cała decyzja „co
 * jest tu zmianą" siedzi więc w `lobbyLogEntries` w `src/shared/lobbyEvents.ts`
 * — tam da się ją sprawdzić testem, bo vitest chodzi w gołym Node bez jsdom
 * i tego hooka nikt nie wywoła.
 *
 * TEN HOOK MUSI STAĆ PRZED INSTRUKCJAMI `return` W `LobbyView`. Komponent
 * wychodzi wcześniej przy `bad-key` i przy otwartym wyborze źródła; hook
 * wywołany po takim wyjściu łamie zasady Reacta i wywala aplikację przy
 * pierwszym otwarciu pickera. Ta pułapka wystąpiła w tym projekcie już dwa
 * razy, stąd ta uwaga tutaj, a nie tylko tam.
 *
 * CZEGO TEN DZIENNIK NIE ZOBACZY. Dwie rzeczy, bo dziennik czyta się jak dowód
 * i czytający ma wiedzieć, czego w nim nie ma:
 * - Zmiany, które Reactowi zdążą się zgrupować w jedno przerysowanie, są
 *   nierozróżnialne od braku zmiany: osoba, która weszła i wyszła między dwoma
 *   renderami, nie zostawia śladu. Wymiana czegokolwiek w lobby trwa tyle, ile
 *   obieg po serwerze sygnalizacyjnym, więc to przypadek teoretyczny — ale jest.
 * - Drugi raz ten sam komunikat błędu bez wyczyszczenia pola pomiędzy; pełny
 *   opis tej szpary stoi przy `lobbyLogEntries`.
 */
export function useLobbyLog(lobby: Lobby): void {
  const { state } = lobby
  /*
   * Poprzedni stan w ref, nie w `useState`: to materiał do porównania, a nie
   * dana do wyrenderowania — ustawienie stanu wywoływałoby tu dodatkowe
   * przerysowanie na każdą zmianę w lobby, w aplikacji, w której diagnozujemy
   * lag. Ref przeżywa też podwójne montowanie w `StrictMode`: drugie
   * wykonanie efektu porównuje ten sam stan ze sobą, więc nie dubluje wpisów.
   */
  const previous = useRef<LobbySnapshot>(EMPTY_SNAPSHOT)

  /*
   * Pola stanu pojedynczo w zależnościach, nie całe `state`: ten obiekt jest
   * nowy przy KAŻDEJ zmianie w lobby (także przy odebranej klatce albo
   * raporcie jakości), a pola, których dziennik nie czyta, zachowują wtedy
   * swoje referencje. Bez tego efekt chodziłby kilka razy na sekundę tylko po
   * to, żeby policzyć zerową różnicę.
   */
  useEffect(() => {
    const next: LobbySnapshot = {
      me: state.me,
      peers: state.peers,
      streams: state.streams,
      error: state.error,
      unreachablePeerIds: state.unreachablePeerIds,
      signalingClosed: state.signalingClosed
    }
    // Czas, w którym ZOBACZYLIŚMY zmianę, nie w którym padła na serwerze.
    // Różnica to jedno przerysowanie, czyli poniżej rozdzielczości sekundowej
    // wpisu — a innego zegara dla tych zdarzeń po prostu nie ma.
    const entries = lobbyLogEntries(previous.current, next, Date.now())
    /*
     * Punkt odniesienia przesuwamy PRZED wysłaniem, nie po nim. Gdyby wysyłka
     * padła, wpisy przepadają — ale nieprzesunięty punkt odniesienia dawałby
     * je w kółko przy każdej następnej zmianie, czyli zamieniałby jedną
     * zgubioną linię na zalany dziennik.
     */
    previous.current = next
    if (entries.length === 0) return
    void window.companion.pushLobbyLog(entries).catch((err: unknown) => {
      // Dziennik jest dodatkiem: jego awaria nie może wywrócić interfejsu ani
      // zostawić nieobsłużonego odrzucenia obietnicy. Ten sam układ co
      // w `useDiagnosticsReporter`.
      console.debug('[dziennik] nieudane wypchnięcie wpisów:', err)
    })
  }, [
    state.me,
    state.peers,
    state.streams,
    state.error,
    state.unreachablePeerIds,
    state.signalingClosed
  ])
}
