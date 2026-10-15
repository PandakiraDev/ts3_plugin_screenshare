import type { ViewerQuality } from './viewerQuality'
import type { StreamKind } from './types'

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

export interface ParticipantsInput {
  me: { peerId: string; displayName: string } | null
  peers: readonly { peerId: string; displayName: string }[]
  streams: readonly { peerId: string; kind: StreamKind }[]
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
export type EmptyGridMessage = 'nobody-streaming' | 'connecting' | 'all-hidden'

/**
 * Rozstrzyga, dlaczego siatka jest pusta.
 *
 * Trzy różne przyczyny, które wyglądają identycznie: nikt nie nadaje, obraz
 * jeszcze nie doszedł, albo widz ukrył wszystko. Trzeci przypadek doszedł razem
 * z ukrywaniem i bez niego pusta siatka po ukryciu wszystkiego mówiłaby
 * „Odbieranie obrazu…" bez końca — czyli kłamała, i to w jedynym miejscu,
 * w którym człowiek szuka wyjaśnienia.
 *
 * Dostaje DANE, a nie gotowe liczby, bo właśnie w liczeniu da się pomylić:
 * `streams` to strumienie ogłoszone przez serwer (nie kafelki, które powstają
 * dopiero po dotarciu obrazu), a ukrycie sprawdzamy dla każdego z nich osobno,
 * nie przez rozmiar zbioru `hidden` — ten może zawierać klucze strumieni,
 * których już nie ma, i zawyżałby wynik.
 */
export function emptyGridMessage(input: {
  streams: readonly { peerId: string; kind: StreamKind }[]
  hidden: ReadonlySet<string>
}): EmptyGridMessage {
  if (input.streams.length === 0) return 'nobody-streaming'
  const allHidden = input.streams.every(
    (stream) => hiddenKindsFor(stream.peerId, input.hidden)[stream.kind]
  )
  return allHidden ? 'all-hidden' : 'connecting'
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
