import { expect, test } from 'vitest'
import {
  AVATAR_COLORS,
  avatarColorFrom,
  initialsFrom,
  badgesFor,
  buildParticipants,
  emptyGridMessage,
  hiddenKindsFor,
  splitByStreaming,
  streamCountLabel
} from '../src/shared/participants'
import { connectionKey } from '../src/renderer/webrtc/session'
import type { RemoteStream, Tile } from '../src/renderer/hooks/useLobby'

test('dwa słowa dają dwie pierwsze litery', () => {
  expect(initialsFrom('Jan Kowalski')).toBe('JK')
})

test('jedno słowo daje jego dwie pierwsze litery', () => {
  expect(initialsFrom('Marek')).toBe('MA')
})

test('polskie litery mają wyjść wielkie, a nie zniknąć', () => {
  expect(initialsFrom('Łukasz Żak')).toBe('ŁŻ')
})

test('nick z samych ozdobników daje znak zapytania', () => {
  // Na TS3 to normalny nick, a nie przypadek brzegowy z podręcznika.
  expect(initialsFrom('⭐⭐⭐')).toBe('?')
})

test('cyfry i podkreślenia nie trafiają do inicjałów', () => {
  expect(initialsFrom('xXx_Marek_xXx')).toBe('XM')
  expect(initialsFrom('3maniak')).toBe('MA')
})

test('pusta nazwa nie wywraca inicjałów', () => {
  expect(initialsFrom('')).toBe('?')
})

test('ta sama nazwa zawsze daje ten sam kolor', () => {
  // Kolor liczony z nazwy, a nie z peerId: peerId zmienia się między sesjami,
  // więc kolor skakałby po każdym ponownym wejściu do kanału.
  expect(avatarColorFrom('Marek')).toBe(avatarColorFrom('Marek'))
})

test('kolor pochodzi z palety', () => {
  expect(AVATAR_COLORS).toContain(avatarColorFrom('Ania'))
})

test('różne nazwy nie lądują wszystkie na jednym kolorze', () => {
  const names = ['Ala', 'Marek', 'Ania', 'Piotrek', 'Kasia', 'Tomek', 'Zosia', 'Bartek']
  const used = new Set(names.map(avatarColorFrom))
  expect(used.size).toBeGreaterThan(1)
})

test('kolejność plakietek jest stała', () => {
  expect(
    badgesFor({
      hasScreen: true,
      hasCamera: true,
      isWatchingUs: true,
      quality: 'ok',
      isUnreachable: true
    })
  ).toEqual([
    { kind: 'screen' },
    { kind: 'camera' },
    { kind: 'watching', quality: 'ok' },
    { kind: 'unreachable' }
  ])
})

test('plakietka „Ogląda" tylko dla osób, które nas oglądają', () => {
  const badges = badgesFor({
    hasScreen: false,
    hasCamera: false,
    isWatchingUs: false,
    quality: 'ok',
    isUnreachable: false
  })
  expect(badges).toEqual([])
})

test('nieznana jakość zostaje nieznana, a nie zamienia się w „płynnie"', () => {
  // Reguła z 0.3.1: cisza nie jest dobrą wiadomością. Gdyby brak raportu
  // dawał tu 'ok', wskaźnik kłamałby przez pierwsze sekundy oglądania.
  const badges = badgesFor({
    hasScreen: false,
    hasCamera: false,
    isWatchingUs: true,
    quality: 'unknown',
    isUnreachable: false
  })
  expect(badges).toEqual([{ kind: 'watching', quality: 'unknown' }])
})

test('brak połączenia widać także u osoby, która nic nie nadaje', () => {
  const badges = badgesFor({
    hasScreen: false,
    hasCamera: false,
    isWatchingUs: false,
    quality: 'unknown',
    isUnreachable: true
  })
  expect(badges).toEqual([{ kind: 'unreachable' }])
})

test('sama kamera bez ekranu daje jedną plakietkę', () => {
  const badges = badgesFor({
    hasScreen: false,
    hasCamera: true,
    isWatchingUs: false,
    quality: 'unknown',
    isUnreachable: false
  })
  expect(badges).toEqual([{ kind: 'camera' }])
})

const EMPTY_QUALITY = new Map<string, 'ok' | 'poor' | 'unknown'>()

test('nasz wiersz stoi pierwszy i jest oznaczony jako nasz', () => {
  const views = buildParticipants({
    me: { peerId: 'me', displayName: 'Konrad' },
    peers: [{ peerId: 'p1', displayName: 'Marek' }],
    streams: [],
    viewerPeerIds: [],
    viewerQuality: EMPTY_QUALITY,
    unreachablePeerIds: []
  })
  expect(views.map((view) => view.peerId)).toEqual(['me', 'p1'])
  expect(views[0].isMe).toBe(true)
  expect(views[1].isMe).toBe(false)
})

test('osoba z ekranem i kamerą naraz dostaje obie plakietki', () => {
  const views = buildParticipants({
    me: null,
    peers: [{ peerId: 'p1', displayName: 'Marek' }],
    streams: [
      { peerId: 'p1', kind: 'screen' },
      { peerId: 'p1', kind: 'camera' }
    ],
    viewerPeerIds: [],
    viewerQuality: EMPTY_QUALITY,
    unreachablePeerIds: []
  })
  expect(views[0].badges).toEqual([{ kind: 'screen' }, { kind: 'camera' }])
  expect(views[0].isStreaming).toBe(true)
})

test('widz bez raportu jakości dostaje plakietkę „nie wiadomo"', () => {
  const views = buildParticipants({
    me: null,
    peers: [{ peerId: 'p1', displayName: 'Marek' }],
    streams: [],
    viewerPeerIds: ['p1'],
    viewerQuality: EMPTY_QUALITY,
    unreachablePeerIds: []
  })
  expect(views[0].badges).toEqual([{ kind: 'watching', quality: 'unknown' }])
})

test('nieosiągalny peer jest oznaczony', () => {
  const views = buildParticipants({
    me: null,
    peers: [{ peerId: 'p1', displayName: 'Piotrek' }],
    streams: [],
    viewerPeerIds: [],
    viewerQuality: EMPTY_QUALITY,
    unreachablePeerIds: ['p1']
  })
  expect(views[0].badges).toEqual([{ kind: 'unreachable' }])
})

test('nasz wiersz nie dostaje ani „Ogląda", ani „Brak połączenia"', () => {
  // Nie łączymy się sami ze sobą, więc nie ma nas ani w viewerPeerIds, ani
  // w unreachablePeerIds. Test pilnuje, żeby nikt tego nie „naprawił"
  // dopisując nas do którejś z tych list.
  const views = buildParticipants({
    me: { peerId: 'me', displayName: 'Konrad' },
    peers: [],
    streams: [{ peerId: 'me', kind: 'screen' }],
    viewerPeerIds: ['me'],
    viewerQuality: EMPTY_QUALITY,
    unreachablePeerIds: ['me']
  })
  // Gdyby buildParticipants brał te listy bezkrytycznie, byłyby tu trzy
  // plakietki. Ma być jedna — ta o ekranie.
  expect(views[0].badges).toEqual([{ kind: 'screen' }])
})

test('podział na sekcje wstawia nas po stronie nadających, gdy nadajemy', () => {
  const views = buildParticipants({
    me: { peerId: 'me', displayName: 'Konrad' },
    peers: [{ peerId: 'p1', displayName: 'Marek' }],
    streams: [{ peerId: 'me', kind: 'screen' }],
    viewerPeerIds: [],
    viewerQuality: EMPTY_QUALITY,
    unreachablePeerIds: []
  })
  const sections = splitByStreaming(views, (view) => view.isStreaming)
  expect(sections.streaming.map((view) => view.peerId)).toEqual(['me'])
  expect(sections.others.map((view) => view.peerId)).toEqual(['p1'])
})

test('podział działa też na wierszach opakowanych w znacznik wyjścia', () => {
  // To NIE jest ten sam test co wyżej: sekcje dzielimy dopiero PO przejściu
  // wyjścia, więc do splitByStreaming trafia opakowany wiersz, a nie goły
  // ParticipantView. Test pilnuje dwóch rzeczy:
  // 1) W czasie wykonania — że funkcja rzeczywiście używa przekazanego predykatu
  //    (row.item.isStreaming), a nie sięga sztywno po pole `isStreaming` na
  //    opakowanym obiekcie, gdzie byłoby undefined.
  // 2) Na poziomie typów — że tsc (teraz mający test/ w tsconfig.json) wyłapie,
  //    gdyby ktoś kiedyś usunął generyczność z ParticipantView[].
  const rows = [
    { item: { isStreaming: true, peerId: 'a' }, leaving: false },
    { item: { isStreaming: false, peerId: 'b' }, leaving: true }
  ]
  const sections = splitByStreaming(rows, (row) => row.item.isStreaming)
  expect(sections.streaming).toHaveLength(1)
  expect(sections.others).toHaveLength(1)
  expect(sections.others[0].leaving).toBe(true)
})

test('ukrycie wszystkich strumieni NIE mówi, że nikt nie nadaje', () => {
  // Najłatwiejszy sposób zablokowania sobie obrazu to ukrycie wszystkiego, a
  // pusta siatka wygląda wtedy tak samo jak siatka, w której nikt nie nadaje.
  // Komunikat, który tego nie rozróżnia, nie podpowiada wyjścia — człowiek
  // uznałby to za awarię, a nie za skutek własnego kliknięcia.
  const streams = [
    { peerId: 'a', kind: 'screen' as const },
    { peerId: 'a', kind: 'camera' as const }
  ]
  const hidden = new Set([connectionKey('a', 'screen'), connectionKey('a', 'camera')])
  expect(emptyGridMessage({ streams, hidden, myPeerId: 'ja', signalingClosed: false })).toBe(
    'all-hidden'
  )
})

test('własny i cudzy strumień, oba ukryte: wszystko ukryte', () => {
  // Własne strumienie są na liście ogłoszonych tak samo jak cudze, więc
  // ukrycie własnego podglądu i cudzego ekranu razem opróżnia siatkę.
  const streams = [
    { peerId: 'ja', kind: 'screen' as const },
    { peerId: 'a', kind: 'screen' as const }
  ]
  const hidden = new Set([connectionKey('ja', 'screen'), connectionKey('a', 'screen')])
  expect(emptyGridMessage({ streams, hidden, myPeerId: 'ja', signalingClosed: false })).toBe(
    'all-hidden'
  )
})

test('cudzy strumień ukryty przy martwym gnieździe nie obiecuje powrotu', () => {
  // Prośba `subscribe` jedzie gniazdem sygnalizacji i po jego zerwaniu ginie po
  // cichu, a oczko przy cudzym strumieniu jest wtedy nieaktywne
  // (`canToggleStream`). Zdanie o oczku byłoby tu obietnicą, której nic nie
  // dowiezie — obraz nie wróci do końca życia okna.
  const streams = [{ peerId: 'a', kind: 'screen' as const }]
  const hidden = new Set([connectionKey('a', 'screen')])
  expect(emptyGridMessage({ streams, hidden, myPeerId: 'ja', signalingClosed: true })).toBe(
    'all-hidden-unrecoverable'
  )
})

test('sam własny podgląd ukryty przy martwym gnieździe WRÓCI, więc tekst zostaje', () => {
  // Druga strona tej samej uczciwości: własny podgląd jest lokalny, oczko przy
  // naszym wierszu zostaje aktywne i faktycznie go przywraca. Odebranie tu
  // obietnicy byłoby kłamstwem w drugą stronę, a tekst rozjechałby się
  // z przyciskiem.
  const streams = [{ peerId: 'ja', kind: 'screen' as const }]
  const hidden = new Set([connectionKey('ja', 'screen')])
  expect(emptyGridMessage({ streams, hidden, myPeerId: 'ja', signalingClosed: true })).toBe(
    'all-hidden'
  )
})

test('własny i cudzy razem w ukryciu: liczy się ten, który nie wróci', () => {
  // Oczko przywróci jeden z dwóch, a nie oba, więc zdanie „przywraca je" jest
  // już nieprawdą. Warunek „wszystkie ukryte należą do nas" przepuściłby ten
  // układ do łagodniejszego wariantu.
  const streams = [
    { peerId: 'ja', kind: 'screen' as const },
    { peerId: 'a', kind: 'screen' as const }
  ]
  const hidden = new Set([connectionKey('ja', 'screen'), connectionKey('a', 'screen')])
  expect(emptyGridMessage({ streams, hidden, myPeerId: 'ja', signalingClosed: true })).toBe(
    'all-hidden-unrecoverable'
  )
})

test('część ukryta przy martwym gnieździe to nadal nie „wszystko ukryte"', () => {
  // Zerwane gniazdo nie zmienia przyczyny pustej siatki: jeden strumień jest
  // nieukryty, więc siatka jest pusta dlatego, że obraz nie doszedł. Warunek
  // zaczynający od `signalingClosed` zamiast od `allHidden` pomyliłby te dwa.
  const streams = [
    { peerId: 'a', kind: 'screen' as const },
    { peerId: 'b', kind: 'screen' as const }
  ]
  expect(
    emptyGridMessage({
      streams,
      hidden: new Set([connectionKey('a', 'screen')]),
      myPeerId: 'ja',
      signalingClosed: true
    })
  ).toBe('connecting')
})

test('zerwane gniazdo bez ani jednego strumienia nie zmienia przyczyny', () => {
  // „Nikt nie nadaje" zostaje „nikt nie nadaje": nie ma czego przywracać, więc
  // nie ma też czego obiecywać.
  expect(
    emptyGridMessage({ streams: [], hidden: new Set(), myPeerId: 'ja', signalingClosed: true })
  ).toBe('nobody-streaming')
})

test('brak strumieni mówi, że nikt nie nadaje', () => {
  expect(
    emptyGridMessage({ streams: [], hidden: new Set(), myPeerId: 'ja', signalingClosed: false })
  ).toBe('nobody-streaming')
})

test('strumienie są, ale obraz jeszcze nie doszedł', () => {
  expect(
    emptyGridMessage({
      streams: [{ peerId: 'a', kind: 'screen' }],
      hidden: new Set(),
      myPeerId: 'ja',
      signalingClosed: false
    })
  ).toBe('connecting')
})

test('część ukryta, a reszta jeszcze nie doszła', () => {
  // Jeden ukryty i jeden w drodze: siatka jest pusta, ale nie dlatego, że
  // wszystko ukryto — podpowiedź o oczku byłaby tu myląca.
  const streams = [
    { peerId: 'a', kind: 'screen' as const },
    { peerId: 'b', kind: 'screen' as const }
  ]
  expect(
    emptyGridMessage({
      streams,
      hidden: new Set([connectionKey('a', 'screen')]),
      myPeerId: 'ja',
      signalingClosed: false
    })
  ).toBe('connecting')
})

test('ukryty ekran nie ukrywa kamery tej samej osoby', () => {
  // Ekran i kamera to osobne strumienie z osobnymi kluczami. Ukrycie jednego
  // nie może zaliczyć drugiego do ukrytych, bo siatka wygląda wtedy na pustą
  // z powodu, który nie istnieje.
  const streams = [
    { peerId: 'a', kind: 'screen' as const },
    { peerId: 'a', kind: 'camera' as const }
  ]
  expect(
    emptyGridMessage({
      streams,
      hidden: new Set([connectionKey('a', 'screen')]),
      myPeerId: 'ja',
      signalingClosed: false
    })
  ).toBe('connecting')
})

test('ukryte oba skraje, środkowy strumień jeszcze nie doszedł', () => {
  // Skrajne ukryte, środkowy nie: warunek patrzący tylko na pierwszy strumień
  // albo tylko na ostatni uznałby tu siatkę za całkiem ukrytą i odesłał do
  // oczka, choć jeden strumień jest w drodze. Trzy strumienie, bo przy dwóch nie
  // da się ukryć obu krańców i zostawić czegoś nieukrytego, a każdy z tych
  // warunków myli się dopiero wtedy, gdy ukryty jest jego kraniec, a co innego
  // nie.
  const streams = [
    { peerId: 'a', kind: 'screen' as const },
    { peerId: 'b', kind: 'screen' as const },
    { peerId: 'c', kind: 'screen' as const }
  ]
  const edges = new Set([connectionKey('a', 'screen'), connectionKey('c', 'screen')])
  expect(emptyGridMessage({ streams, hidden: edges, myPeerId: 'ja', signalingClosed: false })).toBe(
    'connecting'
  )

  // Odwrotny układ tych samych trzech: ukryty sam środkowy. Warunek patrzący
  // tylko na środek uznałby to za wszystko ukryte.
  const middle = new Set([connectionKey('b', 'screen')])
  expect(emptyGridMessage({ streams, hidden: middle, myPeerId: 'ja', signalingClosed: false })).toBe(
    'connecting'
  )
})

test('emptyGridMessage nie przyjmuje kafelków', () => {
  // Ta asercja żyje w `tsc`, nie w vitest: `@ts-expect-error` przy poluzowanym
  // typie daje TS2578, a esbuild i tak wycina typy, więc sam `npm test` jej nie
  // widzi. Działa, bo `test/**/*.ts` jest w `include` w `tsconfig.json`.
  const tiles: Tile[] = []
  // @ts-expect-error kafelki powstają po dotarciu obrazu, a nie po ogłoszeniu strumienia
  emptyGridMessage({ streams: tiles, hidden: new Set(), myPeerId: 'ja', signalingClosed: false })
})

test('emptyGridMessage nie przyjmuje odebranych strumieni', () => {
  // Jak wyżej, dla drugiego typu, który niesie `MediaStream`. Pin z `Tile`
  // go nie obejmuje: typ opisujący wyłącznie brak pola `tileKey` albo `label`
  // przepuściłby `RemoteStream`, a oba piny z kafelkami nadal by przechodziły.
  const remote: RemoteStream[] = []
  // @ts-expect-error odebrany strumień ma obraz, a ogłoszony go nie ma
  emptyGridMessage({ streams: remote, hidden: new Set(), myPeerId: 'ja', signalingClosed: false })
})

test('buildParticipants nie przyjmuje kafelków jako strumieni', () => {
  // To samo co wyżej: pole `streams` ma identyczną ekspozycję, a pin przy
  // `emptyGridMessage` go nie obejmuje, gdyby ktoś poluzował tylko to pole.
  const tiles: Tile[] = []
  buildParticipants({
    me: null,
    peers: [],
    // @ts-expect-error kafelki powstają po dotarciu obrazu, a nie po ogłoszeniu strumienia
    streams: tiles,
    viewerPeerIds: [],
    viewerQuality: EMPTY_QUALITY,
    unreachablePeerIds: []
  })
})

test('wpis po strumieniu, którego już nie ma, nie liczy się jako ukryty', () => {
  // Zbiór ukrytych bywa dłuższy niż lista strumieni: ktoś zakończył nadawanie,
  // a jego klucz został. Liczenie rozmiaru zbioru uznałoby jedyny, jeszcze
  // niedoszły strumień za ukryty i odesłało człowieka do oczka, którego nie ma.
  const streams = [{ peerId: 'a', kind: 'screen' as const }]
  const hidden = new Set([connectionKey('x', 'screen')])
  expect(emptyGridMessage({ streams, hidden, myPeerId: 'ja', signalingClosed: false })).toBe(
    'connecting'
  )
})

test('rodzaje ukryte u danej osoby', () => {
  const hidden = new Set(['a:screen', 'b:camera'])
  expect(hiddenKindsFor('a', hidden)).toEqual({ screen: true, camera: false })
  expect(hiddenKindsFor('b', hidden)).toEqual({ screen: false, camera: true })
  expect(hiddenKindsFor('c', hidden)).toEqual({ screen: false, camera: false })
})

test('ukryte rodzaje są szukane pod tym samym kluczem, pod którym ukrywa kafelek', () => {
  // `hiddenKindsFor` składa klucz sam, bo `shared` nie może importować
  // renderera. Rozjazd z `connectionKey` nie wywaliłby niczego głośno: oczko
  // po prostu nigdy nie pokazałoby, że strumień jest ukryty.
  const hidden = new Set([connectionKey('a', 'screen'), connectionKey('b', 'camera')])
  expect(hiddenKindsFor('a', hidden)).toEqual({ screen: true, camera: false })
  expect(hiddenKindsFor('b', hidden)).toEqual({ screen: false, camera: true })
})

test('liczba transmisji w nagłówku odmienia się po polsku', () => {
  /*
   * Pełna reguła, nie „1 albo reszta": w lobby z dziesięcioma osobami i dwoma
   * rodzajami strumieni dwadzieścia transmisji jest osiągalne. Formy 2-4 biorą
   * się z ostatniej cyfry, ale nie dla 12-14 (dwanaście transmisji), a „jeden"
   * dotyczy wyłącznie liczby 1 — 21 to już „transmisji", nie „transmisja".
   */
  const expected: [number, string][] = [
    [0, '0 transmisji'],
    [1, '1 transmisja'],
    [2, '2 transmisje'],
    [3, '3 transmisje'],
    [4, '4 transmisje'],
    [5, '5 transmisji'],
    [9, '9 transmisji'],
    [11, '11 transmisji'],
    [12, '12 transmisji'],
    [13, '13 transmisji'],
    [14, '14 transmisji'],
    [15, '15 transmisji'],
    [20, '20 transmisji'],
    [21, '21 transmisji'],
    [22, '22 transmisje'],
    [24, '24 transmisje'],
    [25, '25 transmisji'],
    [32, '32 transmisje'],
    [101, '101 transmisji'],
    [102, '102 transmisje'],
    [111, '111 transmisji'],
    [112, '112 transmisji'],
    [114, '114 transmisji'],
    [122, '122 transmisje']
  ]
  for (const [count, label] of expected) {
    expect(streamCountLabel(count)).toBe(label)
  }
})
