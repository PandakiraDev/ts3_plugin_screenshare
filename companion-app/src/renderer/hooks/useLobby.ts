import { useCallback, useEffect, useRef, useState } from 'react'
import type { LaunchOptions } from '../../shared/cli'
import { SignalingClient } from '../signaling/SignalingClient'
import type { PeerInfo } from '../signaling/SignalingClient'
import { LobbySession } from '../webrtc/session'

export interface LobbyState {
  connection: 'connecting' | 'ready' | 'error'
  /** Kto nadaje: 'me', peerId kogoś innego, albo null gdy nikt. */
  streamer: 'me' | string | null
  /** peerId nadającego — także wtedy, gdy to my. Panel po tym rysuje ikonę. */
  streamerPeerId: string | null
  remoteStream: MediaStream | null
  viewers: number
  /** Pozostali uczestnicy pokoju (bez nas). */
  peers: PeerInfo[]
  /** Nasz własny wpis na liście. */
  me: PeerInfo | null
  error: string | null
}

const INITIAL: LobbyState = {
  connection: 'connecting',
  streamer: null,
  streamerPeerId: null,
  remoteStream: null,
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
export function useLobby(options: LaunchOptions): Lobby {
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
          onRemoteStream: (remoteStream) =>
            setState((current) => ({ ...current, remoteStream })),
          onStreamerChange: (peerId) =>
            setState((current) => ({
              ...current,
              streamerPeerId: peerId,
              streamer: peerId === myPeerIdRef.current && peerId ? 'me' : peerId
            })),
          onPeersChange: (peers) => setState((current) => ({ ...current, peers })),
          onViewerCountChange: (viewers) =>
            setState((current) => ({ ...current, viewers })),
          onError: (message) => setState((current) => ({ ...current, error: message }))
        })
        sessionRef.current = session

        const joined = await signaling.join(options.roomId as string, options.displayName)
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
        setState((current) => ({
          ...current,
          connection: 'error',
          error: err instanceof Error ? err.message : String(err)
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
  }, [options.roomId, options.signalingUrl, options.displayName])

  const startSharing = useCallback(async (stream: MediaStream): Promise<void> => {
    const signaling = signalingRef.current
    const session = sessionRef.current
    if (!signaling || !session) throw new Error('Brak połączenia z serwerem')

    // Najpierw pytamy serwer o prawo do nadawania — dopiero po zgodzie
    // wysyłamy cokolwiek. Odmowa ("ktoś już udostępnia") wraca jako wyjątek.
    await signaling.startStream()
    session.startStreaming(stream)
    setState((current) => ({
      ...current,
      streamer: 'me',
      streamerPeerId: myPeerIdRef.current,
      error: null
    }))
  }, [])

  const stopSharing = useCallback(async (): Promise<void> => {
    sessionRef.current?.stopStreaming()
    await signalingRef.current?.stopStream()
    setState((current) => ({
      ...current,
      streamer: null,
      streamerPeerId: null,
      viewers: 0
    }))
  }, [])

  const replaceStream = useCallback((stream: MediaStream): void => {
    void sessionRef.current?.replaceStream(stream)
  }, [])

  const applyQuality = useCallback((bitrateKbps: number, fps: number): void => {
    sessionRef.current?.setMaxFramerate(fps)
    void sessionRef.current?.setBitrate(bitrateKbps)
  }, [])

  return { state, startSharing, stopSharing, replaceStream, applyQuality }
}
