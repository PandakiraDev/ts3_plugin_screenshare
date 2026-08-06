import { useEffect, useRef, useState } from 'react'
import type { CaptureSource, QualitySettings } from '@shared/types'
import { DEFAULT_QUALITY } from '@shared/types'
import type { LaunchOptions } from '../../shared/cli'
import { useCapture } from '../hooks/useCapture'
import { useLobby } from '../hooks/useLobby'
import { SourcePicker } from './SourcePicker'
import { PeerPanel } from './PeerPanel'

interface LobbyViewProps {
  options: LaunchOptions
}

/**
 * Jedno okno na wszystko. Domyślnie oglądasz to, co ktoś udostępnia; wybór
 * źródła pojawia się dopiero po kliknięciu "Udostępnij ekran", żeby lobby
 * zostało czyste.
 */
export function LobbyView({ options }: LobbyViewProps): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [selected, setSelected] = useState<CaptureSource | null>(null)
  const [quality, setQuality] = useState<QualitySettings>(DEFAULT_QUALITY)
  const [startError, setStartError] = useState<string | null>(null)

  const capture = useCapture(selected, quality)
  const lobby = useLobby(options)
  const videoRef = useRef<HTMLVideoElement>(null)

  const jaNadaje = lobby.state.streamer === 'me'
  const ktosInnyNadaje = lobby.state.streamer !== null && !jaNadaje

  // Podgląd pokazuje obraz zdalny, a gdy sami nadajemy — własny.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = jaNadaje ? capture.stream : lobby.state.remoteStream
  }, [jaNadaje, capture.stream, lobby.state.remoteStream])

  // Zmiana rozdzielczości albo FPS w trakcie nadawania: podmieniamy ścieżkę
  // zamiast zrywać połączenia (chwilowy null w trakcie restartu ignorujemy).
  useEffect(() => {
    if (jaNadaje && capture.stream) lobby.replaceStream(capture.stream)
  }, [jaNadaje, capture.stream, lobby])

  // Bitrate i limit FPS idą przez setParameters — bez dotykania strumienia.
  useEffect(() => {
    lobby.applyQuality(quality.bitrateKbps, quality.fps)
  }, [quality.bitrateKbps, quality.fps, lobby])

  const potwierdzWybor = async (): Promise<void> => {
    if (!capture.stream) return
    setStartError(null)
    try {
      await lobby.startSharing(capture.stream)
      setPickerOpen(false)
    } catch (err: unknown) {
      setStartError(err instanceof Error ? err.message : String(err))
    }
  }

  const zakoncz = async (): Promise<void> => {
    await lobby.stopSharing()
    setSelected(null)
  }

  if (pickerOpen) {
    return (
      <SourcePicker
        selected={selected}
        onSelect={setSelected}
        quality={quality}
        onQualityChange={setQuality}
        capture={capture}
        error={startError}
        onConfirm={() => void potwierdzWybor()}
        onCancel={() => {
          setPickerOpen(false)
          setSelected(null)
          setStartError(null)
        }}
      />
    )
  }

  const maObraz = jaNadaje ? capture.stream !== null : lobby.state.remoteStream !== null

  return (
    <div className="app">
      <header className="app__titlebar">
        <h1 className="app__title">TS3 Screen Share</h1>
        <span className="app__stage-tag">
          {lobby.state.connection === 'connecting' && 'Łączenie z kanałem…'}
          {lobby.state.connection === 'error' && 'Brak połączenia'}
          {lobby.state.connection === 'ready' &&
            (jaNadaje
              ? `Udostępniasz ekran · ${
                  lobby.state.viewers === 0
                    ? 'nikt jeszcze nie ogląda'
                    : `${lobby.state.viewers} ${lobby.state.viewers === 1 ? 'widz' : 'widzów'}`
                }`
              : ktosInnyNadaje
                ? 'Ktoś udostępnia ekran'
                : 'Nikt nie udostępnia ekranu')}
        </span>

        <div className="app__actions">
          {jaNadaje ? (
            <button type="button" className="btn btn--danger" onClick={() => void zakoncz()}>
              Zakończ udostępnianie
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setPickerOpen(true)}
              disabled={ktosInnyNadaje || lobby.state.connection !== 'ready'}
              title={ktosInnyNadaje ? 'Ktoś już udostępnia ekran w tym kanale' : undefined}
            >
              Udostępnij ekran
            </button>
          )}
        </div>
      </header>

      <div className="lobby">
        <div className="viewer">
          {lobby.state.connection === 'error' ? (
            <div className="notice notice--error">
              <strong>Nie udało się połączyć z kanałem.</strong>
              <span>{lobby.state.error}</span>
            </div>
          ) : (
            <div className="viewer__stage">
              <video ref={videoRef} autoPlay muted playsInline className="viewer__video" />
              {!maObraz && (
                <div className="viewer__waiting">
                  {ktosInnyNadaje
                    ? 'Odbieranie obrazu…'
                    : 'Nikt nie udostępnia ekranu. Możesz zacząć jako pierwszy.'}
                </div>
              )}
              {jaNadaje && <span className="viewer__badge">Twój obraz</span>}
            </div>
          )}
        </div>

        <PeerPanel
          me={lobby.state.me}
          peers={lobby.state.peers}
          streamerPeerId={lobby.state.streamerPeerId}
          collapsed={panelCollapsed}
          onToggle={() => setPanelCollapsed((current) => !current)}
        />
      </div>
    </div>
  )
}
