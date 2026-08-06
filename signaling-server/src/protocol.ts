/**
 * Protokół sygnalizacji — model "lobby".
 *
 * Peer nie ma przypisanej roli. Wchodzi do pokoju i jest równy pozostałym;
 * nadawanie to osobne, odwoływalne zgłoszenie (`start-stream`). Dzięki temu
 * każdy może zacząć udostępniać bez restartu aplikacji, a zakończenie
 * transmisji jest zwykłym stanem pokoju, nie błędem po stronie oglądających.
 *
 * Nadających może być wielu naraz — serwer niczego tu nie limituje.
 *
 * Serwer nie wie nic o WebRTC — `payload` w `signal` jest dla niego
 * nieprzezroczysty (SDP, ICE, cokolwiek dojdzie później).
 */

export interface PeerInfo {
  peerId: string
  /** Nick z TS3, albo nadany przez serwer zastępnik ("Użytkownik 3"). */
  displayName: string
}

/** Nick z TS3 bywa długi — przycinamy zamiast odrzucać, żeby wpuścić do kanału. */
export const MAX_DISPLAY_NAME = 64

/** Wiadomości klient → serwer. */
export type ClientMessage =
  | { type: 'join'; roomId: string; displayName: string | null }
  | { type: 'signal'; to: string; payload: unknown }
  | { type: 'start-stream' }
  | { type: 'stop-stream' }

/** Wiadomości serwer → klient. */
export type ServerMessage =
  | {
      type: 'joined'
      peerId: string
      displayName: string
      peers: PeerInfo[]
      /** Wszyscy aktualnie nadający w pokoju. Pusta lista = nikt nie nadaje. */
      streamers: string[]
    }
  | { type: 'peer-joined'; peerId: string; displayName: string }
  | { type: 'peer-left'; peerId: string }
  | { type: 'stream-started'; peerId: string }
  | { type: 'stream-stopped'; peerId: string }
  | { type: 'signal'; from: string; payload: unknown }
  | { type: 'error'; message: string }

/**
 * Identyfikator pokoju to SHA-256 (hex) wyliczony po stronie klienta z adresu
 * serwera TS3 i ID kanału. Serwer nie zna tych danych wejściowych i nie musi —
 * ale wymusza format, i to z dwóch powodów:
 *
 * 1. Surowe ID kanału TS3 to mała liczba ("42"). Gdyby serwer je przyjmował,
 *    ktokolwiek mógłby przelecieć ID od 1 w górę i trafić na cudzy pokój.
 * 2. Jedna postać kanoniczna. Gdyby przechodziły też wielkie litery, ten sam
 *    pokój istniałby pod dwoma identyfikatorami i peery by się nie spotkały.
 */
const ROOM_ID_PATTERN = /^[0-9a-f]{64}$/

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string }

/**
 * Jedyne wejście dla danych z sieci. Wszystko przychodzące jest niezaufane,
 * więc walidujemy tu kształt raz, a reszta serwera pracuje już na typach.
 */
export function parseClientMessage(raw: string): ParseResult {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'Niepoprawny JSON' }
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'Oczekiwano obiektu JSON' }
  }

  const fields = data as Record<string, unknown>
  switch (fields['type']) {
    case 'join': {
      const roomId = fields['roomId']
      if (typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) {
        return {
          ok: false,
          error: 'join: roomId musi być kluczem SHA-256 (64 znaki hex, małe litery)'
        }
      }
      const raw = fields['displayName']
      if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        return { ok: false, error: 'join: displayName musi być tekstem' }
      }
      const trimmed = typeof raw === 'string' ? raw.trim() : ''
      return {
        ok: true,
        message: {
          type: 'join',
          roomId,
          // Pusty nick to brak nicku — zastępnik nada serwer.
          displayName: trimmed.length === 0 ? null : trimmed.slice(0, MAX_DISPLAY_NAME)
        }
      }
    }
    case 'signal': {
      const to = fields['to']
      if (typeof to !== 'string' || to.length === 0) {
        return { ok: false, error: 'signal: to musi być niepustym tekstem' }
      }
      // payload celowo bez walidacji — serwer go nie interpretuje.
      return { ok: true, message: { type: 'signal', to, payload: fields['payload'] } }
    }
    case 'start-stream':
      return { ok: true, message: { type: 'start-stream' } }
    case 'stop-stream':
      return { ok: true, message: { type: 'stop-stream' } }
    default:
      return { ok: false, error: `Nieznany typ wiadomości: ${String(fields['type'])}` }
  }
}
