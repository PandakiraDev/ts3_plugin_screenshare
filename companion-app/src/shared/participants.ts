import type { ViewerQuality } from './viewerQuality'

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
