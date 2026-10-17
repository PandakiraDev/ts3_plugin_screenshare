import { deriveRoomId } from './room.js'

/**
 * Adres serwera sygnalizacyjnego — jeden, utrzymywany centralnie (Render).
 * Użytkownik końcowy nic nie stawia i nic nie wpisuje; `--signaling` służy
 * wyłącznie do testów lokalnych.
 *
 * Musi być `wss://`, nie `ws://`: Render terminuje TLS i odrzuca połączenia
 * nieszyfrowane.
 *
 * Uwaga na darmowy plan: usługa usypia po ~15 minutach bezczynności, więc
 * pierwsze wejście po przerwie potrafi trwać ~50 s. Dlatego UI pokazuje
 * "Łączenie z kanałem…" zamiast od razu błędu.
 */
export const DEFAULT_SIGNALING_URL = 'wss://ts3-screenshare-signaling.onrender.com'

/**
 * `standalone` = uruchomienie bez pluginu: sam picker i lokalny podgląd.
 * `lobby` = odpalone z TS3: wchodzisz do pokoju kanału, oglądasz to, co ktoś
 * udostępnia, i sam możesz zacząć nadawać. Nie ma osobnych trybów widza
 * i streamera — rola nie jest przypisywana na starcie.
 */
export type AppMode = 'standalone' | 'lobby'

export interface LaunchOptions {
  mode: AppMode
  /** null tylko w trybie standalone. */
  roomId: string | null
  /**
   * Wejścia, z których wyliczono `roomId`. Oba `null` w trybie standalone.
   * Trzymamy je w postaci SUROWEJ, a nie znormalizowanej przez `deriveRoomId`:
   * to surowa postać jest tym, o czym da się rozmawiać przez telefon przy
   * porównywaniu odcisków. Uwaga na nazwę: `ts3ServerAddress` dostaje od
   * wtyczki IDENTYFIKATOR serwera, nie adres (zob. `plugin.c`), więc między
   * osobami z jednego serwera różni się wyłącznie `channelId`.
   */
  ts3ServerAddress: string | null
  channelId: string | null
  /*
   * Flagi `--diagnostics` tu NIE MA i nie ma wracać. Od 0.3.4 podgląd zużycia
   * i dziennik lobby należą do każdego bez włączania, a jedyna rzecz, która
   * potrzebuje zgody — zapis na dysk — mieszka w `<userData>/settings.json`
   * i ma pole wyboru w ustawieniach. Pole uruchomieniowe znaczyłoby dziś
   * „zgoda na jedną sesję", czyli coś innego niż zapamiętane ustawienie, i nie
   * miałoby ani jednego czytelnika. Stare skróty z tą flagą działają dalej —
   * jest po prostu ignorowana jak każda nieznana (`test/cli.test.ts`).
   */
  signalingUrl: string
  /**
   * Nick z TS3, przekazywany później przez plugin. Gdy go brak, serwer nada
   * zastępnik ("Użytkownik 3") — i zrobi to spójnie dla wszystkich w pokoju.
   */
  displayName: string | null
}

export type LaunchParseResult =
  | { ok: true; options: LaunchOptions }
  | { ok: false; error: string }

/**
 * Wyciąga flagi z argv. Akceptuje `--klucz=wartość` i `--klucz wartość`,
 * ignoruje wszystko, co nie zaczyna się od `--` (ścieżka do exe, flagi Electrona).
 */
function readFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg?.startsWith('--')) continue

    const equals = arg.indexOf('=')
    if (equals !== -1) {
      flags.set(arg.slice(2, equals), arg.slice(equals + 1))
      continue
    }
    // Postać `--klucz wartość`: wartością jest następny argument, o ile
    // sam nie jest kolejną flagą.
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next)
      i++
      continue
    }
    /*
     * Flaga bez wartości (`--inspect`, stare `--diagnostics` w czyimś skrócie).
     * Wcześniej była tu cisza: `flags.set` nie wykonywało się wcale, więc flaga
     * logiczna milcząco nie działała. Pusty łańcuch pozwala sprawdzić jej
     * OBECNOŚĆ przez `flags.has`, a flagom Electrona nie szkodzi, bo czytamy
     * tylko znane nam klucze.
     *
     * UCZCIWIE o stanie po 0.3.4: po usunięciu `--diagnostics` `LaunchOptions`
     * nie ma ani jednego pola logicznego, więc NIKT już tej obecności nie
     * czyta. Zmierzone mutacją: usunięcie obu linii niżej nie łamie ani jednego
     * z 22 testów `cli.test.ts`, bo dla wszystkich dzisiejszych czytelników
     * („brak klucza" i „klucz z pustą wartością" znaczą to samo) są to gałęzie
     * równoważne. Zostają świadomie, bo następna flaga logiczna wejdzie przez
     * `flags.has` i bez nich nie zadziałałaby po cichu — dokładnie ten błąd
     * naprawiało 0.3.3. To, co nadal DA się zmierzyć, to warunkowość `set`
     * niżej, i tego pilnują trzy testy.
     *
     * Tylko gdy klucza jeszcze NIE MA: bezwarunkowy `set` kasował wartość
     * podaną wcześniej w tym samym `argv`. `--signaling=ws://x --signaling`
     * cicho porzucało jawnie podany adres i wracało do serwera produkcyjnego,
     * a `--channel=42 … --channel --ts3-server` zamieniało lobby na standalone
     * bez jednego słowa — czyli dokładnie ten „cichy powrót do standalone",
     * którego zabrania komentarz niżej. Powtórzona flaga BEZ wartości nie
     * wnosi nic poza obecnością, a tę pierwsze wystąpienie już ustaliło.
     */
    const key = arg.slice(2)
    if (!flags.has(key)) flags.set(key, '')
  }
  return flags
}

export function parseLaunchArgs(argv: string[]): LaunchParseResult {
  const flags = readFlags(argv)
  // `||`, a nie `??`: po naprawie flag logicznych puste `--signaling` trafia do mapy
  // jako pusty łańcuch, a `??` cofa się do wartości domyślnej tylko przy `null`
  // i `undefined`. Puste ma znaczyć „użyj domyślnego", tak jak puste `--nick` niżej.
  const signalingUrl = flags.get('signaling') || DEFAULT_SIGNALING_URL
  const ts3Server = flags.get('ts3-server')
  const channel = flags.get('channel')

  // Bez danych z TS3 nie ma do czego dołączać — działamy jak w kroku 1.
  const displayName = flags.get('nick')?.trim() || null

  if (!ts3Server && !channel) {
    return {
      ok: true,
      options: {
        mode: 'standalone',
        roomId: null,
        ts3ServerAddress: null,
        channelId: null,
        signalingUrl,
        displayName
      }
    }
  }

  // Połowa danych to pomyłka wywołania, nie tryb samodzielny. Cichy powrót do
  // standalone dałby okno, które donikąd się nie łączy, bez śladu dlaczego.
  if (!ts3Server) return { ok: false, error: 'Podano --channel bez --ts3-server' }
  if (!channel) return { ok: false, error: 'Podano --ts3-server bez --channel' }

  try {
    return {
      ok: true,
      options: {
        mode: 'lobby',
        roomId: deriveRoomId(ts3Server, channel),
        ts3ServerAddress: ts3Server,
        channelId: channel,
        signalingUrl,
        displayName
      }
    }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
