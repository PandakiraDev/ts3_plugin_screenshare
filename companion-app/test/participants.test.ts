import { expect, test } from 'vitest'
import {
  AVATAR_COLORS,
  avatarColorFrom,
  initialsFrom,
  badgesFor,
  buildParticipants,
  emptyGridMessage,
  hiddenKindsFor,
  splitByStreaming
} from '../src/shared/participants'
import { connectionKey } from '../src/renderer/webrtc/session'

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
  expect(emptyGridMessage({ streams, hidden })).toBe('all-hidden')
})

test('własny i cudzy strumień, oba ukryte: wszystko ukryte', () => {
  // Własne strumienie są na liście ogłoszonych tak samo jak cudze, więc
  // ukrycie własnego podglądu i cudzego ekranu razem opróżnia siatkę.
  const streams = [
    { peerId: 'ja', kind: 'screen' as const },
    { peerId: 'a', kind: 'screen' as const }
  ]
  const hidden = new Set([connectionKey('ja', 'screen'), connectionKey('a', 'screen')])
  expect(emptyGridMessage({ streams, hidden })).toBe('all-hidden')
})

test('brak strumieni mówi, że nikt nie nadaje', () => {
  expect(emptyGridMessage({ streams: [], hidden: new Set() })).toBe('nobody-streaming')
})

test('strumienie są, ale obraz jeszcze nie doszedł', () => {
  expect(
    emptyGridMessage({ streams: [{ peerId: 'a', kind: 'screen' }], hidden: new Set() })
  ).toBe('connecting')
})

test('część ukryta, a reszta jeszcze nie doszła', () => {
  // Jeden ukryty i jeden w drodze: siatka jest pusta, ale nie dlatego, że
  // wszystko ukryto — podpowiedź o oczku byłaby tu myląca.
  const streams = [
    { peerId: 'a', kind: 'screen' as const },
    { peerId: 'b', kind: 'screen' as const }
  ]
  expect(emptyGridMessage({ streams, hidden: new Set([connectionKey('a', 'screen')]) })).toBe(
    'connecting'
  )
})

test('ukryty ekran nie ukrywa kamery tej samej osoby', () => {
  // Ekran i kamera to osobne strumienie z osobnymi kluczami. Ukrycie jednego
  // nie może zaliczyć drugiego do ukrytych, bo siatka wygląda wtedy na pustą
  // z powodu, który nie istnieje.
  const streams = [
    { peerId: 'a', kind: 'screen' as const },
    { peerId: 'a', kind: 'camera' as const }
  ]
  expect(emptyGridMessage({ streams, hidden: new Set([connectionKey('a', 'screen')]) })).toBe(
    'connecting'
  )
})

test('wpis po strumieniu, którego już nie ma, nie liczy się jako ukryty', () => {
  // Zbiór ukrytych bywa dłuższy niż lista strumieni: ktoś zakończył nadawanie,
  // a jego klucz został. Liczenie rozmiaru zbioru uznałoby jedyny, jeszcze
  // niedoszły strumień za ukryty i odesłało człowieka do oczka, którego nie ma.
  const streams = [{ peerId: 'a', kind: 'screen' as const }]
  const hidden = new Set([connectionKey('x', 'screen')])
  expect(emptyGridMessage({ streams, hidden })).toBe('connecting')
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
