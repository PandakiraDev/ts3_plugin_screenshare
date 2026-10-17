import type { ViewerQuality } from './viewerQuality'
import type { StreamRef } from './types'

/**
 * Barwy krążków. Dobrane pod tło `--bg-raised` (#2b2d31) — każda ma dawać
 * czytelny biały tekst i różnić się od sąsiadek na tyle, żeby dwie osoby obok
 * siebie nie wyglądały tak samo.
 */
export const AVATAR_COLORS: readonly string[] = [
  '#5865f2',
  '#b5591f',
  '#3a7d5c',
  '#6b4d94',
  '#a8434f',
  '#2f6f8f',
  '#8a6d1f',
  '#4f5d75'
]

/**
 * Dwie litery na krążek. Nicki na TS3 bywają ozdobne (`⭐⭐⭐`, `xXx_Marek_xXx`,
 * `3maniak`), więc dzielimy nazwę po WSZYSTKIM, co nie jest literą — dzięki
 * temu w słowach zostają same litery i pierwszy znak słowa jest zawsze literą.
 * Gdy liter nie ma w ogóle, zostaje `?`: lepszy uczciwy znak zapytania niż
 * pusty krążek, który wygląda na błąd renderowania.
 */
export function initialsFrom(displayName: string): string {
  const words = displayName.split(/[^\p{L}]+/u).filter((word) => word.length > 0)
  if (words.length === 0) return '?'
  const raw = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]
  return raw.toLocaleUpperCase('pl')
}

/**
 * Kolor krążka z NAZWY, nie z `peerId`. `peerId` jest losowany na sesję, więc
 * kolor skakałby przy każdym ponownym wejściu do kanału; nazwa jest stała, więc
 * ta sama osoba ma zawsze ten sam kolor — również u wszystkich pozostałych
 * uczestników, bo liczą to z tej samej nazwy.
 *
 * Hash djb2: nie potrzebujemy tu kryptografii, tylko powtarzalności.
 */
export function avatarColorFrom(displayName: string): string {
  let hash = 5381
  for (const char of displayName) {
    hash = ((hash << 5) + hash + (char.codePointAt(0) ?? 0)) | 0
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

export type ParticipantBadge =
  | { kind: 'screen' }
  | { kind: 'camera' }
  | { kind: 'watching'; quality: ViewerQuality }
  | { kind: 'unreachable' }

export interface BadgeInput {
  hasScreen: boolean
  hasCamera: boolean
  /** Nas samych nie ma na liście widzów, więc własny wiersz tego nie dostaje. */
  isWatchingUs: boolean
  quality: ViewerQuality
  isUnreachable: boolean
}

/**
 * Plakietki w stałej kolejności: co nadaje, potem czy nas ogląda, na końcu
 * kłopot z połączeniem. Kolejność jest stała celowo — wiersz ma wyglądać
 * tak samo za każdym razem, żeby oko wiedziało, gdzie patrzeć.
 */
export function badgesFor(input: BadgeInput): ParticipantBadge[] {
  const badges: ParticipantBadge[] = []
  if (input.hasScreen) badges.push({ kind: 'screen' })
  if (input.hasCamera) badges.push({ kind: 'camera' })
  if (input.isWatchingUs) badges.push({ kind: 'watching', quality: input.quality })
  if (input.isUnreachable) badges.push({ kind: 'unreachable' })
  return badges
}

export interface ParticipantView {
  peerId: string
  displayName: string
  isMe: boolean
  initials: string
  color: string
  /** Nadaje cokolwiek — decyduje o przydziale do sekcji. */
  isStreaming: boolean
  badges: ParticipantBadge[]
}

/**
 * Strumienie OGŁOSZONE przez serwer, czyli `StreamRef`.
 *
 * `stream?: never` odrzuca kafelki (`Tile`) i odebrane strumienie
 * (`RemoteStream`). Oba mają `peerId` i `kind`, więc samo strukturalne
 * typowanie przyjęłoby je jako ogłoszone — a to są strumienie, których obraz
 * już dotarł, więc lista z nich jest krótsza dokładnie o to, co
 * `emptyGridMessage` ma rozstrzygnąć: strumienie w drodze. Oba niosą
 * `MediaStream` w polu `stream` i tylko po braku tego pola typ je odróżnia:
 * nie pilnuje, że obiekt nie ma żadnych innych pól. Celowa projekcja
 * `tiles.map(({ peerId, kind }) => ({ peerId, kind }))` nadal się kompiluje.
 */
type AnnouncedStreams = readonly (StreamRef & { stream?: never })[]

export interface ParticipantsInput {
  me: { peerId: string; displayName: string } | null
  peers: readonly { peerId: string; displayName: string }[]
  streams: AnnouncedStreams
  viewerPeerIds: readonly string[]
  viewerQuality: ReadonlyMap<string, ViewerQuality>
  unreachablePeerIds: readonly string[]
}

/**
 * Płaska lista w kolejności wyświetlania: my, potem pozostali w kolejności
 * z serwera. PŁASKA, a nie od razu podzielona na sekcje — podział musi się
 * odbyć dopiero po przejściu wyjścia, inaczej osoba kończąca transmisję byłaby
 * przez chwilę widoczna dwa razy naraz (dogasająca w „Nadają" i już wstawiona
 * do „W kanale").
 */
export function buildParticipants(input: ParticipantsInput): ParticipantView[] {
  const viewers = new Set(input.viewerPeerIds)
  const unreachable = new Set(input.unreachablePeerIds)
  const everyone = [
    ...(input.me ? [{ ...input.me, isMe: true }] : []),
    ...input.peers.map((peer) => ({ ...peer, isMe: false }))
  ]

  return everyone.map((person) => {
    const kinds = input.streams.filter((stream) => stream.peerId === person.peerId)
    const hasScreen = kinds.some((stream) => stream.kind === 'screen')
    const hasCamera = kinds.some((stream) => stream.kind === 'camera')
    return {
      peerId: person.peerId,
      displayName: person.displayName,
      isMe: person.isMe,
      initials: initialsFrom(person.displayName),
      color: avatarColorFrom(person.displayName),
      isStreaming: hasScreen || hasCamera,
      badges: badgesFor({
        hasScreen,
        hasCamera,
        // `!person.isMe` to strażnik, nie ozdobnik. Nie łączymy się sami ze
        // sobą, więc nas na tych listach BYĆ NIE POWINNO — ale gdyby kiedyś
        // trafiły tam przez pomyłkę, własny wiersz twierdziłby, że sam siebie
        // ogląda i sam do siebie nie może się dobić. Reguła zamiast założenia.
        isWatchingUs: !person.isMe && viewers.has(person.peerId),
        quality: input.viewerQuality.get(person.peerId) ?? 'unknown',
        isUnreachable: !person.isMe && unreachable.has(person.peerId)
      })
    }
  })
}

/**
 * Generyczne, bo w chwili podziału wiersz jest już opakowany w znacznik
 * `leaving` i nie jest gołym `ParticipantView`.
 */
export function splitByStreaming<T>(
  items: readonly T[],
  isStreaming: (item: T) => boolean
): { streaming: T[]; others: T[] } {
  return {
    streaming: items.filter((item) => isStreaming(item)),
    others: items.filter((item) => !isStreaming(item))
  }
}

/** Co pokazać, gdy siatka jest pusta. */
export type EmptyGridMessage =
  | 'nobody-streaming'
  | 'connecting'
  | 'all-hidden'
  /**
   * Wszystko ukryte, a wśród ukrytych jest CUDZY strumień i gniazdo
   * sygnalizacji jest martwe — czyli oczko go już nie przywróci. Osobny
   * wariant, nie odmiana tekstu składana wyżej: patrz nagłówek funkcji.
   */
  | 'all-hidden-unrecoverable'

/**
 * Rozstrzyga, dlaczego siatka jest pusta.
 *
 * Cztery różne przyczyny, które wyglądają identycznie: nikt nie nadaje, obraz
 * jeszcze nie doszedł, widz ukrył wszystko, albo ukrył wszystko i stracił
 * połączenie z serwerem. Trzeci przypadek doszedł razem z ukrywaniem i bez
 * niego pusta siatka po ukryciu wszystkiego mówiłaby „Odbieranie obrazu…" bez
 * końca — czyli kłamała, i to w jedynym miejscu, w którym człowiek szuka
 * wyjaśnienia.
 *
 * CZWARTY wariant, a nie drugi tekst składany w komponencie, i to jest
 * rozstrzygnięcie, nie przypadek. Gdyby komponent wybierał zdanie z pary
 * (wariant, `signalingClosed`), ta decyzja wylądowałaby w `LobbyView` — czyli
 * w miejscu, którego vitest w gołym Node nie wywoła, bo nie ma tam ani
 * `document`, ani `window`. Jako wariant typu zostaje w `src/shared`, ma test,
 * a `Record<EmptyGridMessage, string>` po stronie komponentu nie skompiluje
 * się bez dopisanego zdania — więc nie da się dodać przyczyny i zapomnieć
 * tekstu.
 *
 * Dlaczego to zależy TAKŻE od `myPeerId`, a nie od samego `signalingClosed`:
 * własny podgląd jest lokalny i oczko przywraca go także przy martwym
 * gnieździe. Przy samych własnych strumieniach w ukryciu obietnica powrotu
 * jest PRAWDZIWA i odebranie jej byłoby tym samym rodzajem kłamstwa, tylko
 * w drugą stronę — a oczko przy własnym wierszu zostaje wtedy aktywne
 * (`canToggleStream` w `shared/tileLayout.ts`), więc tekst i przycisk muszą
 * mówić to samo.
 *
 * `streams` po zerwaniu gniazda jest ZAMROŻONE i tak ma być: to lista
 * strumieni, o których wiemy, i dokładnie one są tymi, które zostały ukryte
 * bez drogi powrotu. Nowy strumień i tak by do nas nie dotarł.
 *
 * Dostaje DANE, a nie gotowe liczby, bo właśnie w liczeniu da się pomylić:
 * `streams` to strumienie ogłoszone przez serwer (nie kafelki, które powstają
 * dopiero po dotarciu obrazu), a ukrycie sprawdzamy dla każdego z nich osobno,
 * nie przez rozmiar zbioru `hidden` — ten może zawierać klucze strumieni,
 * których już nie ma, i zawyżałby wynik.
 */
export function emptyGridMessage(input: {
  streams: AnnouncedStreams
  hidden: ReadonlySet<string>
  /** Nasz identyfikator; `null` przed dołączeniem, czyli żaden strumień nie jest nasz. */
  myPeerId: string | null
  signalingClosed: boolean
}): EmptyGridMessage {
  if (input.streams.length === 0) return 'nobody-streaming'
  const allHidden = input.streams.every(
    (stream) => hiddenKindsFor(stream.peerId, input.hidden)[stream.kind]
  )
  if (!allHidden) return 'connecting'
  const anyFromOthers = input.streams.some((stream) => stream.peerId !== input.myPeerId)
  return input.signalingClosed && anyFromOthers ? 'all-hidden-unrecoverable' : 'all-hidden'
}

/**
 * Liczba transmisji z odmienionym rzeczownikiem, np. „5 transmisji”.
 *
 * Pełna polska reguła: „transmisja” tylko dla 1; „transmisje” dla liczb
 * kończących się na 2-4, ale NIE na 12-14; w pozostałych przypadkach
 * „transmisji” (w tym 0, 5-21, 25-31 i 112). Samo `count === 1 ? … : …`
 * dawało „5 transmisje”.
 */
export function streamCountLabel(count: number): string {
  const lastDigit = count % 10
  const lastTwoDigits = count % 100
  const isFew = lastDigit >= 2 && lastDigit <= 4 && !(lastTwoDigits >= 12 && lastTwoDigits <= 14)
  const noun = count === 1 ? 'transmisja' : isFew ? 'transmisje' : 'transmisji'
  return `${count} ${noun}`
}

/**
 * Które rodzaje strumieni tej osoby są u nas ukryte.
 *
 * Klucz `peerId:rodzaj` składamy tu ręcznie, bo `shared` nie importuje
 * renderera, a tam mieszka `connectionKey`, którym kafelki są ukrywane. Format
 * musi się z nim zgadzać; pilnuje tego test, bo rozjazd nie wywaliłby niczego
 * głośno — oczko po prostu nigdy nie pokazałoby, że strumień jest ukryty.
 */
export function hiddenKindsFor(
  peerId: string,
  hidden: ReadonlySet<string>
): { screen: boolean; camera: boolean } {
  return {
    screen: hidden.has(`${peerId}:screen`),
    camera: hidden.has(`${peerId}:camera`)
  }
}
