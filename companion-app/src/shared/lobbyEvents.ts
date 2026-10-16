import type { StreamKind, StreamRef } from './types'
import type { LogEntry, LogLevel } from './lobbyLog'

/**
 * Zamiana tego, co się stało w lobby, na wpisy dziennika — czystymi funkcjami.
 *
 * DLACZEGO Z RÓŻNICY DWÓCH STANÓW, A NIE ZE ZDARZEŃ. Sesja WebRTC nie oddaje
 * zdarzeń, tylko STAN: `onPeersChange` dostaje całą listę uczestników,
 * `onStreamersChange` całą listę strumieni, `onUnreachableChange` cały zbiór
 * niedostępnych. Te callbacki konsumuje `useLobby` i do komponentu nie
 * docierają — jedynym źródłem jest `lobby.state`. Co więcej, wywołanie
 * callbacku nie znaczy zmiany: `onUnreachableChange` dostaje ZBIÓR osób
 * policzony z połączeń, a jedna osoba ma ich kilka (ekran i kamera, w obie
 * strony), więc padnięcie drugiego połączenia tej samej osoby daje dokładnie
 * ten sam zbiór — i „wpis na każde wywołanie" dopisałby drugie „połączenie
 * padło" o kimś, komu nic nowego się nie stało (`markReachability`
 * w `src/renderer/webrtc/session.ts`). Wpis powstaje więc z RÓŻNICY
 * poprzedniego i nowego stanu i właśnie ta różnica jest całą trudnością tego
 * pliku.
 *
 * DLACZEGO W `src/shared/*`, A NIE W HOOKU. vitest chodzi w gołym Node bez
 * jsdom, więc hooka nikt nie wywoła. Tutaj da się sprawdzić każdą decyzję:
 * co jest zmianą, co jest błędem, a co tylko powtórzeniem tego samego stanu.
 * W `src/renderer/hooks/useLobbyLog.ts` zostaje sama obsługa Reacta —
 * trzymanie poprzedniego stanu i wypchnięcie wyniku przez IPC.
 *
 * NAZWY, NIE IDENTYFIKATORY. Dziennik czyta człowiek, często komuś przez
 * telefon, więc wpis brzmi „Michał wszedł do lobby", a nie „a3f9c1 wszedł do
 * lobby". `PeerInfo` niesie `displayName`, więc ruch osób ma nazwę pod ręką;
 * `StreamRef` i lista niedostępnych to same identyfikatory, dlatego tamte
 * funkcje biorą resolwer nazw PARAMETREM (`nameOf`). Parametrem, bo to jedyny
 * sposób, żeby zostały czyste i testowalne — gdyby zaglądały do stanu
 * uczestników same, byłyby jego zakładniczkami.
 *
 * MIANOWNIK W KAŻDYM TEKŚCIE. Nazwa pochodzi od użytkownika TS3 i bywa
 * ozdobna (`xXx_Marek_xXx`, `⭐Ola⭐`), więc nie da się jej odmienić po polsku.
 * Wszystkie zdania są tak zbudowane, że nazwa stoi w mianowniku: nie
 * „połączenie z Michałem padło", a „Michał — połączenie padło". Zmieniając
 * teksty trzymaj tę regułę, bo przy nicku bez odmiany wyjdzie bełkot.
 *
 * Pierścień i zapis na dysk mieszkają w `src/main/lobbyLog.ts`, a kształt
 * wpisu w `src/shared/lobbyLog.ts`.
 */

/**
 * Osoba z nazwą do pokazania.
 *
 * Typ strukturalny, a nie import `PeerInfo` z `src/renderer/signaling/*`:
 * `src/shared/*` nie zależy od renderera i nie ma zacząć. Ten sam zwyczaj co
 * w `buildParticipants` (`participants.ts`), która też opisuje uczestnika
 * polami, a nie importem.
 */
export interface NamedPeer {
  peerId: string
  displayName: string
}

/** Pytanie „jak nazywa się ta osoba" — patrz nagłówek pliku. */
export type NameResolver = (peerId: string) => string

/**
 * Składa resolwer nazw z nas samych i listy uczestników.
 *
 * Dla nieznanego identyfikatora oddaje SAM IDENTYFIKATOR, a nie „Uczestnik":
 * strumień potrafi się skończyć w tym samym tyknięciu, w którym ktoś wyszedł
 * z lobby, i wtedy identyfikator jest jedyną prawdą, jaką mamy. Napis
 * „Uczestnik zakończył udostępnianie ekranu" przy trzech osobach w pokoju
 * kazałby zgadywać, o kogo chodzi.
 *
 * Wygrywa PIERWSZE wystąpienie identyfikatora na listach. Na tej regule opiera
 * się `lobbyLogEntries`, które podaje nowy stan przed poprzednim.
 *
 * @param me nasz wpis; `null` do chwili wejścia do pokoju. Nas nie ma na
 *   liście `peers` (serwer rozgłasza pozostałych), a własne strumienie
 *   w `lobby.state.streams` są — bez tego parametru własny ekran byłby
 *   podpisany identyfikatorem.
 */
export function nameResolver(me: NamedPeer | null, peers: readonly NamedPeer[]): NameResolver {
  const names = new Map<string, string>()
  if (me) names.set(me.peerId, me.displayName)
  for (const peer of peers) {
    if (!names.has(peer.peerId)) names.set(peer.peerId, peer.displayName)
  }
  return (peerId) => names.get(peerId) ?? peerId
}

function entry(at: number, level: LogLevel, text: string): LogEntry {
  return { at, level, text }
}

/**
 * Wpisy o wejściach i wyjściach z lobby.
 *
 * Bierze `NamedPeer[]`, a nie listę identyfikatorów: `lobby.state.peers` to
 * `PeerInfo[]` i nazwa jest w nim pod ręką — także dla osoby, która wyszła,
 * bo tę czytamy z POPRZEDNIEGO stanu.
 *
 * Kolejność w jednym tyknięciu: najpierw wyjścia, potem wejścia. Ma to
 * znaczenie przy powrocie tej samej osoby — serwer losuje `peerId` na sesję,
 * więc ponowne wejście to inny identyfikator i w jednym tyknięciu widzimy
 * wyjście starego oraz wejście nowego. „Wyszedł" przed „wszedł" czyta się jako
 * ponowne połączenie; odwrotna kolejność jako zniknięcie kogoś, kto właśnie
 * przyszedł.
 *
 * W obrębie jednej grupy trzymamy kolejność z serwera, bez sortowania: nic
 * sensownego nie da się po niej posortować, a alfabetycznie przestawiłaby
 * zdarzenia względem tego, jak się stały.
 */
export function peerChangeEntries(
  before: readonly NamedPeer[],
  after: readonly NamedPeer[],
  at: number
): LogEntry[] {
  const beforeIds = new Set(before.map((peer) => peer.peerId))
  const afterIds = new Set(after.map((peer) => peer.peerId))
  return [
    ...before
      .filter((peer) => !afterIds.has(peer.peerId))
      .map((peer) => entry(at, 'event', `${peer.displayName} wyszedł z lobby`)),
    ...after
      .filter((peer) => !beforeIds.has(peer.peerId))
      .map((peer) => entry(at, 'event', `${peer.displayName} wszedł do lobby`))
  ]
}

/** Teksty o strumieniach. Rodzaj decyduje o zdaniu, nie o dopisku w nawiasie. */
const STREAM_TEXTS: Record<StreamKind, { started: string; stopped: string }> = {
  screen: { started: 'zaczął udostępniać ekran', stopped: 'zakończył udostępnianie ekranu' },
  camera: { started: 'włączył kamerę', stopped: 'wyłączył kamerę' }
}

/**
 * Czy ten sam strumień jest na liście.
 *
 * Porównanie PARY (`peerId`, `kind`), nie samego `peerId`: ta sama osoba może
 * nadawać ekran i kamerę naraz, a przełączenie jednego na drugi musi dać koniec
 * jednego i początek drugiego, nie „brak zmiany".
 *
 * Dwa porównania w pętli, a nie zbiór sklejonych kluczy: list jest tu najwyżej
 * kilkanaście pozycji, a klucz z napisów wymagałby separatora, o którym trzeba
 * udowodnić, że nie wystąpi w `peerId` z serwera.
 */
function hasStream(streams: readonly StreamRef[], ref: StreamRef): boolean {
  return streams.some((stream) => stream.peerId === ref.peerId && stream.kind === ref.kind)
}

/**
 * Wpisy o rozpoczętych i zakończonych transmisjach.
 *
 * `nameOf` jest parametrem, bo `StreamRef` to samo `{peerId, kind}` i nazwy nie
 * niesie — patrz nagłówek pliku. Najpierw zakończenia, potem rozpoczęcia, z tego
 * samego powodu co przy osobach: zmiana rodzaju u jednej osoby ma się czytać
 * jako przełączenie, a nie jako dwa niezależne zdarzenia w losowej kolejności.
 */
export function streamChangeEntries(
  before: readonly StreamRef[],
  after: readonly StreamRef[],
  at: number,
  nameOf: NameResolver
): LogEntry[] {
  return [
    ...before
      .filter((ref) => !hasStream(after, ref))
      .map((ref) => entry(at, 'event', `${nameOf(ref.peerId)} ${STREAM_TEXTS[ref.kind].stopped}`)),
    ...after
      .filter((ref) => !hasStream(before, ref))
      .map((ref) => entry(at, 'event', `${nameOf(ref.peerId)} ${STREAM_TEXTS[ref.kind].started}`))
  ]
}

/**
 * Wpisy o padniętych i przywróconych połączeniach.
 *
 * Padnięcie jest BŁĘDEM, przywrócenie zdarzeniem: pierwsze jest odpowiedzią na
 * „dlaczego go nie widzę", drugie tylko domknięciem historii.
 *
 * `nameOf` parametrem z tego samego powodu co przy strumieniach —
 * `unreachablePeerIds` to lista samych identyfikatorów.
 */
export function unreachableEntries(
  before: readonly string[],
  after: readonly string[],
  at: number,
  nameOf: NameResolver
): LogEntry[] {
  const beforeIds = new Set(before)
  const afterIds = new Set(after)
  return [
    ...before
      .filter((peerId) => !afterIds.has(peerId))
      .map((peerId) => entry(at, 'event', `${nameOf(peerId)} — połączenie wróciło`)),
    ...after
      .filter((peerId) => !beforeIds.has(peerId))
      .map((peerId) => entry(at, 'error', `${nameOf(peerId)} — połączenie padło`))
  ]
}

/**
 * Błąd sesji jako wpis dziennika.
 *
 * Komunikat idzie BEZ PRZERABIANIA: `onError` dostaje zdania już napisane po
 * polsku dla człowieka („Nie udało się ustawić jakości wysyłania: …"),
 * a dokładanie do nich czegokolwiek robiłoby zdania, których nikt nie napisał.
 * Znacznik `[BŁĄD]` dokłada `formatLogEntry`, więc i tego nie powtarzamy.
 */
export function errorEntry(message: string, at: number): LogEntry {
  return entry(at, 'error', message)
}

/**
 * Stan lobby w jednej chwili — tyle, ile dziennik potrzebuje.
 *
 * Podzbiór `LobbyState` z `useLobby`, a nie on sam: tamten niesie też
 * `MediaStream`-y i mapy jakości odbioru, których ten plik nie czyta, a import
 * tamtego typu wciągnąłby `src/shared/*` w zależność od renderera.
 */
export interface LobbySnapshot {
  me: NamedPeer | null
  peers: readonly NamedPeer[]
  streams: readonly StreamRef[]
  error: string | null
  unreachablePeerIds: readonly string[]
}

/**
 * Wszystkie wpisy wynikające z przejścia między dwoma stanami lobby.
 *
 * Kolejność źródeł jest kolejnością czytania: kto się pojawił i zniknął, co
 * zaczął nadawać, z kim padło połączenie, co odbił serwer. Wszystkie wpisy
 * jednego przejścia mają ten sam `at` — bo naprawdę stały się w tej samej
 * chwili.
 *
 * Resolwer nazw składamy z NOWEGO stanu, a za nim z poprzedniego (pierwsze
 * wystąpienie wygrywa, patrz `nameResolver`). To ratuje najczęstszy przypadek
 * brzydkiego wpisu: strumień kończy się w tym samym tyknięciu, w którym osoba
 * wyszła z lobby, więc w nowym stanie jej już nie ma — a bez poprzedniego
 * dziennik napisałby „a3f9c1 zakończył udostępnianie ekranu" o kimś, kogo imię
 * znaliśmy sekundę wcześniej.
 *
 * ZNANA SZPARA — `error` to JEDNO NADPISYWANE POLE, NIE KOLEJKA. Wpis o błędzie
 * powstaje tylko wtedy, gdy treść pola się ZMIENIŁA, bo innej informacji nie ma
 * skąd wziąć. Konsekwencja: dwa identyczne błędy pod rząd, bez wyczyszczenia
 * pola między nimi, nie dają żadnej zmiany stanu, więc drugiego w dzienniku nie
 * będzie. W praktyce ratuje to czyszczenie pola na `null`, które `useLobby`
 * robi w trzech miejscach (start próby połączenia, udane wejście, udany start
 * nadawania), więc typowa sekwencja błąd → ponowna próba → ten sam błąd
 * przechodzi. Sekwencja błąd → ten sam błąd bez próby pomiędzy — nie. Zamknięcie
 * tej szpary wymagałoby kolejki błędów w `useLobby`, czyli rozlania dziennika na
 * dwie warstwy; świadomie tego nie robimy, ale nie wolno tego też przemilczeć:
 * dziennik czyta się jak dowód i czytający ma wiedzieć, czego w nim nie ma.
 *
 * Wyczyszczenie błędu (`null`) nie daje wpisu — to sprzątnięcie pola przed
 * kolejną próbą, a nie zdarzenie w lobby. Komunikat z samych odstępów też nie:
 * `new Error()` ma `message === ''`, a wiersz „[BŁĄD]" bez treści nie mówi nic
 * i wygląda na uszkodzony dziennik.
 */
export function lobbyLogEntries(
  before: LobbySnapshot,
  after: LobbySnapshot,
  at: number
): LogEntry[] {
  const nameOf = nameResolver(after.me ?? before.me, [...after.peers, ...before.peers])
  const entries = [
    ...peerChangeEntries(before.peers, after.peers, at),
    ...streamChangeEntries(before.streams, after.streams, at, nameOf),
    ...unreachableEntries(before.unreachablePeerIds, after.unreachablePeerIds, at, nameOf)
  ]
  // Zmienna lokalna, a nie `after.error` w warunku: tylko ona zawęża typ do
  // `string` dla wywołania niżej. Warunek wyniesiony do `const` nie zawęża
  // niczego — na tym `tsc` już raz tutaj zatrzymał budowanie.
  const { error } = after
  if (error !== null && error !== before.error && error.trim().length > 0) {
    entries.push(errorEntry(error, at))
  }
  return entries
}
