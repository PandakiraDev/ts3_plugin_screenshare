import { createHash } from 'node:crypto'

/**
 * Wylicza identyfikator pokoju sygnalizacyjnego z adresu serwera TS3 i ID kanału.
 *
 * Po co skrót zamiast samego ID kanału: ID kanału TS3 to mała liczba ("1", "42").
 * Signaling server jest publiczny i wspólny dla wszystkich użytkowników, więc bez
 * skrótu ktokolwiek mógłby przelecieć ID od 1 w górę i trafić na cudzy pokój.
 * Po zahaszowaniu razem z adresem serwera trzeba znać konkretny serwer TS3, żeby
 * w ogóle wyliczyć klucz — samo zgadywanie numerów przestaje cokolwiek dawać.
 *
 * To nie jest autoryzacja: kto zna adres serwera i numer kanału, ten wejdzie.
 * Odcina enumerację, nie podsłuch przez osobę z tego samego serwera TS3.
 * Prawdziwy auth (token per serwer TS3) to osobny temat z brief.
 *
 * Liczone po stronie klienta celowo — signaling server nigdy nie poznaje
 * adresu serwera TS3 ani numeru kanału, dostaje wyłącznie gotowy klucz.
 */
export function deriveRoomId(ts3ServerAddress: string, channelId: string): string {
  const address = ts3ServerAddress.trim().toLowerCase()
  const channel = channelId.trim()

  if (address.length === 0) throw new Error('deriveRoomId: pusty adres serwera TS3')
  if (channel.length === 0) throw new Error('deriveRoomId: puste ID kanału')

  // '\n' jako separator: bez niego ('ab','c') i ('a','bc') dałyby ten sam klucz,
  // a znak nowej linii nie występuje ani w adresie, ani w ID kanału.
  return createHash('sha256').update(`${address}\n${channel}`).digest('hex')
}
