import { expect, test } from 'vitest'
import type { StreamRef } from '@shared/types'
// Import WARTOŚCI z `@shared`, nie typu — alias rozwiązuje `vitest.config.ts`,
// a nie `tsconfig.json`; import samego typu przeszedłby nawet bez aliasu, bo
// znika przy kompilacji, więc niczego by nie pilnował.
import {
  errorEntry,
  lobbyLogEntries,
  nameResolver,
  peerChangeEntries,
  signalingClosedEntries,
  streamChangeEntries,
  unreachableEntries,
  type LobbySnapshot,
  type NamedPeer
} from '@shared/lobbyEvents'

/** Skrót: nazwa domyślnie inna niż identyfikator, żeby pomyłkę było widać. */
const peer = (peerId: string, displayName: string): NamedPeer => ({ peerId, displayName })

/**
 * Resolwer, który nie zna NIKOGO — oddaje sam identyfikator.
 *
 * Tak wygląda najgorszy przypadek z produkcji: strumień kończy się w tym samym
 * tyknięciu, w którym osoba wyszła z lobby.
 */
const idOnly = (peerId: string): string => peerId

const EMPTY: LobbySnapshot = {
  me: null,
  peers: [],
  streams: [],
  error: null,
  unreachablePeerIds: [],
  signalingClosed: false
}

// --- osoby ----------------------------------------------------------------

test('wejście i wyjście osoby dają po jednym wpisie', () => {
  const anna = peer('a', 'Anna')
  const bartek = peer('b', 'Bartek')
  expect(peerChangeEntries([anna], [anna, bartek], 0)).toHaveLength(1)
  expect(peerChangeEntries([anna, bartek], [anna], 0)).toHaveLength(1)
})

test('brak zmiany nie daje żadnego wpisu', () => {
  // Identyczny skład w innej kolejności nie jest zmianą. Kolejność bierze się
  // z kolejności wstawiania do mapy w sesji, czyli nie jest obietnicą — a wpis
  // „wszedł do lobby" za każde przetasowanie zasypałby dziennik.
  const anna = peer('a', 'Anna')
  const bartek = peer('b', 'Bartek')
  expect(peerChangeEntries([anna, bartek], [bartek, anna], 0)).toEqual([])
})

test('wpis o wejściu nosi NAZWĘ osoby, a nie jej identyfikator', () => {
  // Dziennik czyta człowiek, często komuś przez telefon: „Michał wszedł do
  // lobby", a nie „a3f9c1 wszedł do lobby".
  const [entry] = peerChangeEntries([], [peer('a3f9c1', 'Michał')], 0)
  expect(entry?.text).toContain('Michał')
  expect(entry?.text).not.toContain('a3f9c1')
})

test('wpis o wyjściu nosi nazwę, choć osoby nie ma już w nowym stanie', () => {
  // Nazwa bierze się tu z POPRZEDNIEGO stanu — w nowym tej osoby już nie ma.
  const [entry] = peerChangeEntries([peer('a3f9c1', 'Michał')], [], 0)
  expect(entry?.text).toContain('Michał')
  expect(entry?.text).not.toContain('a3f9c1')
})

test('wejście i wyjście mają różne teksty', () => {
  const michal = peer('a', 'Michał')
  const [entered] = peerChangeEntries([], [michal], 0)
  const [left] = peerChangeEntries([michal], [], 0)
  expect(entered?.text).not.toBe(left?.text)
})

test('wymiana składu w jednym tyknięciu: najpierw wyjście, potem wejście', () => {
  // Kolejność ma znaczenie przy powrocie tej samej osoby (nowy peerId, ta sama
  // nazwa): „wyszedł" przed „wszedł" czyta się jako ponowne wejście, odwrotna
  // kolejność jako zniknięcie kogoś, kto właśnie przyszedł.
  const entries = peerChangeEntries([peer('a', 'Anna')], [peer('b', 'Bartek')], 0)
  expect(entries).toHaveLength(2)
  expect(entries[0]?.text).toContain('Anna')
  expect(entries[1]?.text).toContain('Bartek')
})

test('ruch osób to zdarzenia, nie błędy', () => {
  const michal = peer('a', 'Michał')
  expect(peerChangeEntries([], [michal], 0)[0]?.level).toBe('event')
  expect(peerChangeEntries([michal], [], 0)[0]?.level).toBe('event')
})

// --- strumienie -----------------------------------------------------------

test('ekran i kamera tej samej osoby to dwa osobne wpisy', () => {
  // Ten niezmiennik obowiązuje w całym projekcie: ta sama osoba nadająca oba
  // rodzaje ma DWA strumienie i to jest celowe.
  const before: StreamRef[] = []
  const after: StreamRef[] = [
    { peerId: 'a', kind: 'screen' },
    { peerId: 'a', kind: 'camera' }
  ]
  expect(streamChangeEntries(before, after, 0, idOnly)).toHaveLength(2)
})

test('ekran i kamera mają różne teksty', () => {
  const screen = streamChangeEntries([], [{ peerId: 'a', kind: 'screen' }], 0, idOnly)
  const camera = streamChangeEntries([], [{ peerId: 'a', kind: 'camera' }], 0, idOnly)
  expect(screen[0]?.text).not.toBe(camera[0]?.text)
})

test('początek i koniec strumienia mają różne teksty', () => {
  const stream: StreamRef[] = [{ peerId: 'a', kind: 'screen' }]
  const started = streamChangeEntries([], stream, 0, idOnly)
  const stopped = streamChangeEntries(stream, [], 0, idOnly)
  expect(started[0]?.text).not.toBe(stopped[0]?.text)
})

test('wpis o strumieniu bierze nazwę z resolwera', () => {
  // `StreamRef` to samo `{peerId, kind}` i nazwy nie niesie — dlatego resolwer
  // jest parametrem, a nie odczytem stanu uczestników w środku funkcji.
  const entries = streamChangeEntries([], [{ peerId: 'a3f9c1', kind: 'screen' }], 0, () => 'Michał')
  expect(entries[0]?.text).toContain('Michał')
  expect(entries[0]?.text).not.toContain('a3f9c1')
})

test('nieznana osoba zostawia w tekście identyfikator, nie puste miejsce', () => {
  // Strumień może się skończyć w tym samym tyknięciu, w którym ktoś wyszedł.
  // Identyfikator jest wtedy jedyną prawdą, jaką mamy — a puste miejsce albo
  // „Uczestnik" kazałoby zgadywać, kogo dotyczył wpis.
  const entries = streamChangeEntries([{ peerId: 'a3f9c1', kind: 'camera' }], [], 0, idOnly)
  expect(entries[0]?.text).toContain('a3f9c1')
})

test('brak zmiany strumieni nie daje żadnego wpisu', () => {
  const streams: StreamRef[] = [
    { peerId: 'a', kind: 'screen' },
    { peerId: 'b', kind: 'camera' }
  ]
  expect(streamChangeEntries(streams, [...streams].reverse(), 0, idOnly)).toEqual([])
})

test('zmiana rodzaju u tej samej osoby to koniec jednego i początek drugiego', () => {
  // Para (peerId, kind), nie sam peerId: inaczej przełączenie ekranu na kamerę
  // wyglądałoby na brak zmiany.
  const entries = streamChangeEntries(
    [{ peerId: 'a', kind: 'screen' }],
    [{ peerId: 'a', kind: 'camera' }],
    0,
    () => 'Michał'
  )
  expect(entries).toHaveLength(2)
})

test('przełączenie ekranu na kamerę: najpierw zakończenie, potem rozpoczęcie', () => {
  // Bliźniak testu kolejności przy osobach („wymiana składu w jednym tyknięciu")
  // i z tego samego powodu: oba wpisy niosą ten sam czas, więc o tym, co się
  // z nich czyta, decyduje WYŁĄCZNIE kolejność w tablicy. „Włączył kamerę"
  // przed „zakończył udostępnianie ekranu" czyta się jako dwa niezależne
  // zdarzenia w losowej kolejności, a nie jako jedno przełączenie.
  //
  // Z dwóch bliźniaczych reguł przypięta była jedna: zmierzone, odwrócenie
  // kolejności w `streamChangeEntries` przechodziło cały zestaw, a to samo
  // odwrócenie w `peerChangeEntries` ginęło natychmiast. Test wyżej liczył same
  // wpisy, a liczba przy odwróceniu się nie zmienia.
  const entries = streamChangeEntries(
    [{ peerId: 'a', kind: 'screen' }],
    [{ peerId: 'a', kind: 'camera' }],
    0,
    () => 'Michał'
  )
  expect(entries[0]?.text).toContain('zakończył udostępnianie ekranu')
  expect(entries[1]?.text).toContain('włączył kamerę')
})

// --- niedostępność --------------------------------------------------------

test('wpis o niedostępności jest błędem, nie zdarzeniem', () => {
  expect(unreachableEntries([], ['a'], 0, idOnly)[0]?.level).toBe('error')
})

test('powrót dostępności jest zdarzeniem, nie błędem', () => {
  expect(unreachableEntries(['a'], [], 0, idOnly)[0]?.level).toBe('event')
})

test('wpisy o dostępności też noszą nazwę osoby', () => {
  const entries = unreachableEntries([], ['a3f9c1'], 0, () => 'Michał')
  expect(entries[0]?.text).toContain('Michał')
  expect(entries[0]?.text).not.toContain('a3f9c1')
})

test('niezmieniona lista niedostępnych nie daje wpisów', () => {
  // To nie jest przypadek teoretyczny: `onUnreachableChange` dostaje ZBIÓR
  // osób policzony z połączeń, a jedna osoba ma ich kilka — padnięcie drugiego
  // z nich daje ten sam zbiór i bez tego odsiewania drugie „połączenie padło".
  expect(unreachableEntries(['a', 'b'], ['b', 'a'], 0, idOnly)).toEqual([])
})

// --- błędy ----------------------------------------------------------------

test('błąd sesji trafia do dziennika z poziomem błędu', () => {
  expect(errorEntry('Nieznany peer', 5).level).toBe('error')
})

test('wpis błędu niesie komunikat bez przerabiania', () => {
  // Komunikaty sesji są już po polsku i dla człowieka. Dopisywanie do nich
  // czegokolwiek robiłoby z nich zdania, których nikt nie napisał.
  expect(errorEntry('Nie udało się ustawić jakości wysyłania', 5).text).toBe(
    'Nie udało się ustawić jakości wysyłania'
  )
})

// --- zerwane gniazdo do serwera -------------------------------------------

test('zerwanie połączenia z serwerem daje dokładnie jeden wpis o poziomie błędu', () => {
  // To jest NAJWAŻNIEJSZY wiersz przy „nagle wszystko stanęło": aplikacja
  // wygląda wtedy na połączoną, bo ani `connection`, ani `error` się nie
  // zmienia, a lobby jest od tej chwili głuche.
  const entries = signalingClosedEntries(false, true, 7)
  expect(entries).toHaveLength(1)
  expect(entries[0]?.level).toBe('error')
  expect(entries[0]?.at).toBe(7)
})

test('wpis o zerwaniu mówi dokładnie to zdanie', () => {
  // Dokładny napis, nie kształt: ten wiersz czyta człowiek, który nie zna kodu,
  // i po nim ma wiedzieć, że dalsza cisza w lobby nie jest ciszą w pokoju.
  expect(signalingClosedEntries(false, true, 0)[0]?.text).toBe(
    'Połączenie z serwerem sygnalizacyjnym zerwane — wejścia, wyjścia i nowe transmisje nie będą już widoczne'
  )
})

test('powtórzone zerwanie bez odzyskania połączenia nie mnoży wpisów', () => {
  // Pole jest STANEM gniazda, nie kolejką zdarzeń: dopóki nikt nie zaczął
  // nowej próby połączenia, nie ma nowej informacji do zapisania.
  expect(signalingClosedEntries(true, true, 1)).toEqual([])
})

test('nowa próba połączenia nie daje wpisu o powrocie', () => {
  // Wyzerowanie pola to sprzątnięcie przed kolejną próbą, a nie zdarzenie
  // w lobby — ta sama reguła co przy czyszczeniu `error` na `null`. Wpis
  // „połączono" musiałby czytać `connection`, czego ten dziennik świadomie nie
  // robi (patrz nagłówek przy `signalingClosedEntries`).
  expect(signalingClosedEntries(true, false, 1)).toEqual([])
})

test('gniazdo całą sesję sprawne nie daje żadnego wpisu', () => {
  expect(signalingClosedEntries(false, false, 1)).toEqual([])
})

test('wpis o zerwaniu nie obarcza nim żadnego uczestnika', () => {
  // Reguła MIANOWNIKA jest tu spełniona trywialnie, bo tekst nie nosi nazwy
  // osoby — i to jest celowe. Gniazdo należy do serwera, nie do uczestnika,
  // a wpisy o konkretnych ludziach robi `unreachableEntries`. Wpis z nickiem
  // wskazywałby winnego, którego nie ma.
  const nick = 'xXx_Marek_xXx'
  expect(signalingClosedEntries(false, true, 0)[0]?.text).not.toContain(nick)
})

test('zerwanie gniazda jedzie tym samym złożeniem co reszta źródeł', () => {
  // Żadnej nowej ścieżki: wpis powstaje z różnicy dwóch migawek i wychodzi
  // tym samym kanałem co wejścia, wyjścia i błędy.
  const entries = lobbyLogEntries(EMPTY, { ...EMPTY, signalingClosed: true }, 3)
  expect(entries).toHaveLength(1)
  expect(entries[0]?.level).toBe('error')
  expect(entries[0]?.at).toBe(3)
})

// --- czas i nazwy ---------------------------------------------------------

test('każdy wpis niesie podaną chwilę', () => {
  const at = 1_760_000_000_000
  expect(peerChangeEntries([], [peer('a', 'Anna')], at)[0]?.at).toBe(at)
  expect(streamChangeEntries([], [{ peerId: 'a', kind: 'screen' }], at, idOnly)[0]?.at).toBe(at)
  expect(unreachableEntries([], ['a'], at, idOnly)[0]?.at).toBe(at)
  expect(errorEntry('cokolwiek', at).at).toBe(at)
})

test('nazwa trafia do wpisu znak w znak, bez odmieniania', () => {
  // Nicki z TS3 bywają ozdobne (`xXx_Marek_xXx`, `⭐Ola⭐`) i nie da się ich
  // odmienić po polsku. Wszystkie teksty muszą więc trzymać nazwę w mianowniku.
  const nick = 'xXx_Marek_xXx'
  const texts = [
    ...peerChangeEntries([], [peer('a', nick)], 0),
    ...peerChangeEntries([peer('a', nick)], [], 0),
    ...streamChangeEntries([], [{ peerId: 'a', kind: 'screen' }], 0, () => nick),
    ...streamChangeEntries([{ peerId: 'a', kind: 'camera' }], [], 0, () => nick),
    ...unreachableEntries([], ['a'], 0, () => nick),
    ...unreachableEntries(['a'], [], 0, () => nick)
  ].map((entry) => entry.text)
  expect(texts).toHaveLength(6)
  for (const text of texts) expect(text).toContain(nick)
})

test('resolwer zna nas, zna uczestników i oddaje identyfikator dla obcego', () => {
  const nameOf = nameResolver(peer('me', 'Ja'), [peer('a', 'Anna')])
  expect(nameOf('me')).toBe('Ja')
  expect(nameOf('a')).toBe('Anna')
  expect(nameOf('nieznany')).toBe('nieznany')
})

test('resolwer bez naszego wpisu nadal działa', () => {
  // `lobby.state.me` jest `null` do chwili wejścia do pokoju, a wpisy mogą
  // powstać wcześniej (błąd połączenia).
  expect(nameResolver(null, [peer('a', 'Anna')])('a')).toBe('Anna')
})

test('w resolwerze wygrywa PIERWSZE wystąpienie identyfikatora', () => {
  // Składanie list „nowy stan, potem poprzedni" opiera się na tej regule:
  // nazwa z nowego stanu ma bić nazwę z poprzedniego.
  const nameOf = nameResolver(null, [peer('a', 'nowa'), peer('a', 'stara')])
  expect(nameOf('a')).toBe('nowa')
})

// --- złożenie -------------------------------------------------------------

test('lobbyLogEntries składa wpisy ze wszystkich pięciu źródeł', () => {
  const after: LobbySnapshot = {
    me: peer('me', 'Ja'),
    peers: [peer('a', 'Anna')],
    streams: [{ peerId: 'a', kind: 'screen' }],
    error: 'Serwer odrzucił zgłoszenie',
    unreachablePeerIds: ['a'],
    signalingClosed: true
  }
  const entries = lobbyLogEntries(EMPTY, after, 0)
  expect(entries).toHaveLength(5)
  expect(entries.filter((entry) => entry.level === 'error')).toHaveLength(3)
})

test('zerwanie gniazda czyta się PRZED skutkami z tego samego tyknięcia', () => {
  // Kolejność nie jest kosmetyką: zerwanie jest PRZYCZYNĄ, a wszystko inne
  // w tym samym tyknięciu jej skutkiem. Czytający ma zobaczyć przyczynę pierwszą.
  const entries = lobbyLogEntries(EMPTY, {
    ...EMPTY,
    peers: [peer('a', 'Anna')],
    signalingClosed: true
  }, 0)
  expect(entries).toHaveLength(2)
  expect(entries[0]?.text).toContain('serwerem sygnalizacyjnym')
})

test('identyczne stany nie dają ani jednego wpisu', () => {
  const snapshot: LobbySnapshot = {
    me: peer('me', 'Ja'),
    peers: [peer('a', 'Anna')],
    streams: [{ peerId: 'a', kind: 'camera' }],
    error: 'coś padło',
    unreachablePeerIds: ['a'],
    signalingClosed: true
  }
  expect(lobbyLogEntries(snapshot, { ...snapshot }, 0)).toEqual([])
})

test('TEN SAM błąd dwa razy pod rząd daje JEDEN wpis — znana szpara', () => {
  // `error` to jedno nadpisywane pole, nie kolejka: dwa identyczne błędy bez
  // wyczyszczenia między nimi nie dają żadnej zmiany stanu, więc drugiego nie
  // da się tu zobaczyć. Pełny opis przy `lobbyLogEntries`.
  const first = lobbyLogEntries(EMPTY, { ...EMPTY, error: 'Nieznany peer' }, 0)
  const second = lobbyLogEntries(
    { ...EMPTY, error: 'Nieznany peer' },
    { ...EMPTY, error: 'Nieznany peer' },
    1
  )
  expect(first).toHaveLength(1)
  expect(second).toEqual([])
})

test('błąd po wyczyszczeniu daje nowy wpis', () => {
  // Typowa sekwencja: błąd, ponowna próba połączenia (czyści `error` na null),
  // znowu błąd. Ta przechodzi i to ona ratuje szparę wyżej w praktyce.
  const entries = lobbyLogEntries({ ...EMPTY, error: null }, { ...EMPTY, error: 'Nieznany peer' }, 0)
  expect(entries).toHaveLength(1)
})

test('wyczyszczenie błędu nie daje wpisu', () => {
  // Zniknięcie komunikatu nie jest zdarzeniem w lobby — to tylko sprzątnięcie
  // pola przed kolejną próbą.
  expect(lobbyLogEntries({ ...EMPTY, error: 'Nieznany peer' }, EMPTY, 0)).toEqual([])
})

test('pusty komunikat błędu nie daje wpisu', () => {
  // `new Error()` ma `message === ''`, a `useLobby` przepisuje `err.message`
  // wprost. Wpis „[BŁĄD]" bez treści nie mówi nic, a wygląda jak uszkodzony
  // dziennik.
  expect(lobbyLogEntries(EMPTY, { ...EMPTY, error: '   ' }, 0)).toEqual([])
})

test('złożenie zna nazwę osoby, która wyszła w tym samym tyknięciu', () => {
  // Strumień i obecność gasną razem. Resolwer składany z NOWEGO i poprzedniego
  // stanu pozwala napisać „Michał zakończył…", a nie „a3f9c1 zakończył…".
  const before: LobbySnapshot = {
    ...EMPTY,
    peers: [peer('a3f9c1', 'Michał')],
    streams: [{ peerId: 'a3f9c1', kind: 'screen' }]
  }
  const entries = lobbyLogEntries(before, EMPTY, 0)
  expect(entries).toHaveLength(2)
  for (const entry of entries) {
    expect(entry.text).toContain('Michał')
    expect(entry.text).not.toContain('a3f9c1')
  }
})

test('nasze własne strumienie też trafiają do dziennika pod naszą nazwą', () => {
  // `lobby.state.streams` zawiera także nasze — serwer rozgłasza start i stop
  // wszystkim, łącznie z nadającym.
  const me = peer('me', 'Ja')
  const entries = lobbyLogEntries(
    { ...EMPTY, me },
    { ...EMPTY, me, streams: [{ peerId: 'me', kind: 'screen' }] },
    0
  )
  expect(entries).toHaveLength(1)
  expect(entries[0]?.text).toContain('Ja')
})
