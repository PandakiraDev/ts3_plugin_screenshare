import { useCallback, useEffect, useRef, useState } from 'react'
import type { LaunchOptions } from '../../shared/cli'
import { SignalingClient } from '../signaling/SignalingClient'
import type { PeerInfo } from '../signaling/SignalingClient'
import { LobbySession } from '../webrtc/session'

export interface LobbyState {
  connection: 'connecting' | 'ready' | 'error' | 'zly-klucz'
  /** Czy to my nadajemy. */
  jaNadaje: boolean
  /** peerId wszystkich nadających (łącznie z nami, jeśli nadajemy). */
  streamerIds: string[]
  /** peerId nadającego -> jego obraz. Wiele naraz jest normalne. */
  remoteStreams: Map<string, MediaStream>
  viewers: number
  /** Pozostali uczestnicy pokoju (bez nas). */
  peers: PeerInfo[]
  /** Nasz własny wpis na liście. */
  me: PeerInfo | null
  error: string | null
}

const INITIAL: LobbyState = {
  connection: 'connecting',
  jaNadaje: false,
  streamerIds: [],
  remoteStreams: new Map(),
  viewers: 0,
  peers: [],
  me: null,
  error: null
}

export interface Lobby {
  state: LobbyState
  /** Zgłasza nadawanie i przy powodzeniu zaczyna wysyłać obraz. */
  startSharing: (stream: MediaStream) => Promise<void>
  stopSharing: () => Promise<void>
  replaceStream: (stream: MediaStream) => void
  /** Bitrate i limit FPS — działa też w trakcie nadawania, bez renegocjacji. */
  applyQuality: (bitrateKbps: number, fps: number) => void
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
          // Pelna przebudowa pod dwa niezalezne strumienie to Task 7 — na razie
          // panel widzi tylko ekran, wiec kamere po prostu ignorujemy.
          onRemoteStream: (peerId, kind, stream) => {
            if (kind !== 'screen') return
            setState((current) => {
              // Nowa mapa, nie mutacja: React porownuje referencje.
              const remoteStreams = new Map(current.remoteStreams)
              if (stream) remoteStreams.set(peerId, stream)
              else remoteStreams.delete(peerId)
              return { ...current, remoteStreams }
            })
          },
          onStreamersChange: (streams) => {
            const peerIds = streams.filter((s) => s.kind === 'screen').map((s) => s.peerId)
            setState((current) => ({
              ...current,
              streamerIds: peerIds,
              // Serwer rozglasza tez nasze wlasne start/stop-stream.
              jaNadaje: myPeerIdRef.current !== null && peerIds.includes(myPeerIdRef.current)
            }))
          },
          onPeersChange: (peers) => setState((current) => ({ ...current, peers })),
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

  const startSharing = useCallback(async (stream: MediaStream): Promise<void> => {
    const session = sessionRef.current
    if (!session) throw new Error('Brak połączenia z serwerem')

    // Zgloszenie u serwera i start wysylania siedza teraz razem w
    // LobbySession.startStream — patrz jej komentarz co do kolejnosci.
    // Na razie zawsze 'screen': kamera jako osobny strumien to Task 7.
    await session.startStream(stream, 'screen')
    setState((current) => ({ ...current, jaNadaje: true, error: null }))
  }, [])

  const stopSharing = useCallback(async (): Promise<void> => {
    await sessionRef.current?.stopStream('screen')
    setState((current) => ({ ...current, jaNadaje: false, viewers: 0 }))
  }, [])

  const replaceStream = useCallback((stream: MediaStream): void => {
    void sessionRef.current?.replaceStream(stream, 'screen')
  }, [])

  const applyQuality = useCallback((bitrateKbps: number, fps: number): void => {
    sessionRef.current?.setMaxFramerate(fps)
    void sessionRef.current?.setBitrate(bitrateKbps)
  }, [])

  return { state, startSharing, stopSharing, replaceStream, applyQuality }
}
