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
    // sam nie jest kolejną flagą (wtedy to flaga bez wartości, np. --inspect).
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next)
      i++
    }
  }
  return flags
}

export function parseLaunchArgs(argv: string[]): LaunchParseResult {
  const flags = readFlags(argv)
  const signalingUrl = flags.get('signaling') ?? DEFAULT_SIGNALING_URL
  const ts3Server = flags.get('ts3-server')
  const channel = flags.get('channel')

  // Bez danych z TS3 nie ma do czego dołączać — działamy jak w kroku 1.
  const displayName = flags.get('nick')?.trim() || null

  if (!ts3Server && !channel) {
    return {
      ok: true,
      options: { mode: 'standalone', roomId: null, signalingUrl, displayName }
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
        signalingUrl,
        displayName
      }
    }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
