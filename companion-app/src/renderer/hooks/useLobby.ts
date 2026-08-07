import { useCallback, useEffect, useRef, useState } from 'react'
import type { StreamKind, StreamRef } from '../../shared/types'
import type { LaunchOptions } from '../../shared/cli'
import { SignalingClient } from '../signaling/SignalingClient'
import type { PeerInfo } from '../signaling/SignalingClient'
import { LobbySession, connectionKey } from '../webrtc/session'

/** Jeden odebrany strumień. Ta sama osoba może mieć tu dwa wpisy: ekran i kamerę. */
export interface RemoteStream {
  peerId: string
  kind: StreamKind
  stream: MediaStream
}

/** Jeden kafelek siatki — gotowy do wyrenderowania, bez dalszych obliczeń w JSX. */
export interface Kafelek {
  /** `connectionKey`: jednoznaczny nawet wtedy, gdy jedna osoba nadaje oba rodzaje. */
  klucz: string
  peerId: string
  kind: StreamKind
  stream: MediaStream
  podpis: string
  toJa: boolean
}

/**
 * Kamera to domyślny widok osoby, więc nie potrzebuje dopisku — ekran tak,
 * bo inaczej dwa kafelki tej samej osoby byłyby nie do rozróżnienia.
 */
export function podpisKafelka(nazwa: string, kind: StreamKind): string {
  return kind === 'screen' ? `${nazwa} — ekran` : nazwa
}

/**
 * Układa siatkę: najpierw nasze własne strumienie, potem cudze w kolejności
 * napływania. Własny obraz bierzemy z lokalnego capture, a nie z sieci — do
 * samych siebie nic nie wysyłamy.
 */
export function ulozKafelki(
  wlasne: { kind: StreamKind; stream: MediaStream }[],
  zdalne: Iterable<RemoteStream>,
  me: PeerInfo | null,
  peers: PeerInfo[]
): Kafelek[] {
  const kafelki: Kafelek[] = []

  // Bez własnego wpisu nie ma czym podpisać kafelka ani czym go zakluczować.
  if (me) {
    for (const { kind, stream } of wlasne) {
      kafelki.push({
        klucz: connectionKey(me.peerId, kind),
        peerId: me.peerId,
        kind,
        stream,
        podpis: podpisKafelka(me.displayName, kind),
        toJa: true
      })
    }
  }

  for (const { peerId, kind, stream } of zdalne) {
    const nazwa = peers.find((p) => p.peerId === peerId)?.displayName ?? 'Uczestnik'
    kafelki.push({
      klucz: connectionKey(peerId, kind),
      peerId,
      kind,
      stream,
      podpis: podpisKafelka(nazwa, kind),
      toJa: false
    })
  }

  return kafelki
}

/**
 * Wyrzuca strumienie osób, których nie ma już w pokoju. Odejście osoby musi
 * zabrać WSZYSTKIE jej strumienie, nie jeden — po wyjściu kogoś z ekranem
 * i kamerą naraz zostałby osierocony kafelek, którego nic już nie odświeży.
 *
 * Bez zmian zwraca tę samą mapę: nowa referencja przy każdym zdarzeniu
 * o uczestnikach przerysowywałaby całą siatkę, więc wideo by mrugało.
 */
export function odsiejNieobecnych(
  strumienie: Map<string, RemoteStream>,
  obecni: Iterable<string>
): Map<string, RemoteStream> {
  const zbior = new Set(obecni)
  const zostaje = [...strumienie].filter(([, wpis]) => zbior.has(wpis.peerId))
  if (zostaje.length === strumienie.size) return strumienie
  return new Map(zostaje)
}

export interface LobbyState {
  connection: 'connecting' | 'ready' | 'error' | 'zly-klucz'
  /** Rodzaje, które nadajemy MY. Ekran i kamera są niezależne — mogą być oba. */
  mojeRodzaje: StreamKind[]
  /** Wszystkie nadawane strumienie w pokoju, łącznie z naszymi. */
  streams: StreamRef[]
  /** connectionKey(peerId, kind) -> odebrany obraz. Jedna osoba może mieć dwa wpisy. */
  remoteStreams: Map<string, RemoteStream>
  viewers: number
  /** Pozostali uczestnicy pokoju (bez nas). */
  peers: PeerInfo[]
  /** Nasz własny wpis na liście. */
  me: PeerInfo | null
  error: string | null
}

const INITIAL: LobbyState = {
  connection: 'connecting',
  mojeRodzaje: [],
  streams: [],
  remoteStreams: new Map(),
  viewers: 0,
  peers: [],
  me: null,
  error: null
}

export interface Lobby {
  state: LobbyState
  /** Zgłasza nadawanie danego rodzaju i przy powodzeniu zaczyna wysyłać obraz. */
  startStream: (stream: MediaStream, kind: StreamKind) => Promise<void>
  stopStream: (kind: StreamKind) => Promise<void>
  replaceStream: (stream: MediaStream, kind: StreamKind) => void
  /** Bitrate i limit FPS danego rodzaju — działa też w trakcie nadawania, bez renegocjacji. */
  applyQuality: (kind: StreamKind, bitrateKbps: number, fps: number) => void
}

/**
 * Utrzymuje połączenie z pokojem kanału TS3. Peer wchodzi jako zwykły
 * uczestnik: od razu widzi cudzy obraz, jeśli ktoś nadaje, i w każdej chwili
 * może sam zacząć — bez restartu aplikacji i bez wyboru trybu na starcie.
 */
export function useLobby(options: LaunchOptions, kluczVersion = 0): Lobby {
  const [state, setState] = useState<LobbyState>(INITIAL)
  const signalingRef = useRef<SignalingClient | null>(null)
  const sessionRef = useRef<LobbySession | null>(null)
  const myPeerIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!options.roomId) return

    let cancelled = false
    void (async () => {
      try {
        const signaling = await SignalingClient.connect(options.signalingUrl)
        if (cancelled) {
          signaling.close()
          return
        }
        signalingRef.current = signaling

        const session = new LobbySession(signaling, {
          onRemoteStream: (peerId, kind, stream) => {
            setState((current) => {
              // Nowa mapa, nie mutacja: React porownuje referencje.
              const remoteStreams = new Map(current.remoteStreams)
              const klucz = connectionKey(peerId, kind)
              // null = koniec TEGO strumienia; drugi strumien tej samej osoby zostaje.
              if (stream) remoteStreams.set(klucz, { peerId, kind, stream })
              else remoteStreams.delete(klucz)
              return { ...current, remoteStreams }
            })
          },
          onStreamersChange: (streams) => {
            setState((current) => ({
              ...current,
              streams,
              // Serwer rozglasza tez nasze wlasne start/stop-stream.
              mojeRodzaje: streams
                .filter((s) => s.peerId === myPeerIdRef.current)
                .map((s) => s.kind)
            }))
          },
          onPeersChange: (peers) =>
            setState((current) => ({
              ...current,
              peers,
              // Lista uczestnikow jest jedynym miejscem, w ktorym widac odejscie
              // osoby w calosci — po niej sprzatamy oba jej strumienie naraz.
              remoteStreams: odsiejNieobecnych(
                current.remoteStreams,
                peers.map((p) => p.peerId)
              )
            })),
          onViewerCountChange: (viewers) =>
            setState((current) => ({ ...current, viewers })),
          onError: (message) => setState((current) => ({ ...current, error: message }))
        })
        sessionRef.current = session

        const apiKey = await window.companion.getApiKey()
        const joined = await signaling.join(
          options.roomId as string,
          options.displayName,
          apiKey
        )
        myPeerIdRef.current = joined.peerId
        setState((current) => ({
          ...current,
          connection: 'ready',
          error: null,
          me: { peerId: joined.peerId, displayName: joined.displayName }
        }))
        session.begin(joined)
      } catch (err: unknown) {
        if (cancelled) return
        const komunikat = err instanceof Error ? err.message : String(err)
        // Odrzucony klucz to nie awaria — użytkownik ma go poprawić, a nie
        // patrzeć na ogólny błąd połączenia.
        setState((current) => ({
          ...current,
          connection: /klucz/i.test(komunikat) ? 'zly-klucz' : 'error',
          error: komunikat
        }))
      }
    })()

    return () => {
      cancelled = true
      sessionRef.current?.dispose()
      sessionRef.current = null
      signalingRef.current?.close()
      signalingRef.current = null
    }
    // kluczVersion w zaleznosciach: zapisanie nowego klucza ma ponowic
    // polaczenie, a nie czekac na restart aplikacji.
  }, [options.roomId, options.signalingUrl, options.displayName, kluczVersion])

  const startStream = useCallback(
    async (stream: MediaStream, kind: StreamKind): Promise<void> => {
      const session = sessionRef.current
      if (!session) throw new Error('Brak połączenia z serwerem')

      // Zgloszenie u serwera i start wysylania siedza razem w
      // LobbySession.startStream — patrz jej komentarz co do kolejnosci.
      // Stan `mojeRodzaje` przyjdzie z rozgloszenia stream-started, wiec nie
      // ustawiamy go tu na zapas: serwer moze zgloszenie odrzucic.
      await session.startStream(stream, kind)
      setState((current) => ({ ...current, error: null }))
    },
    []
  )

  const stopStream = useCallback(async (kind: StreamKind): Promise<void> => {
    await sessionRef.current?.stopStream(kind)
  }, [])

  const replaceStream = useCallback((stream: MediaStream, kind: StreamKind): void => {
    void sessionRef.current?.replaceStream(stream, kind)
  }, [])

  const applyQuality = useCallback(
    (kind: StreamKind, bitrateKbps: number, fps: number): void => {
      void sessionRef.current?.setQuality(kind, bitrateKbps, fps)
    },
    []
  )

  return { state, startStream, stopStream, replaceStream, applyQuality }
}
