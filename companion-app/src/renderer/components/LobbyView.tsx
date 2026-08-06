import { useEffect, useState } from 'react'
import type { CaptureSource, QualitySettings } from '@shared/types'
import { DEFAULT_QUALITY } from '@shared/types'
import type { LaunchOptions } from '../../shared/cli'
import { useCapture } from '../hooks/useCapture'
import { useLobby } from '../hooks/useLobby'
import { SourcePicker } from './SourcePicker'
import { PeerPanel } from './PeerPanel'
import { StreamTile } from './StreamTile'
import { ApiKeyPrompt } from './ApiKeyPrompt'

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
  const [powiekszony, setPowiekszony] = useState<string | null>(null)
  // Zmiana klucza musi przelaczyc widok od razu, bez restartu aplikacji.
  const [kluczZapisany, setKluczZapisany] = useState(0)
  const [selected, setSelected] = useState<CaptureSource | null>(null)
  const [quality, setQuality] = useState<QualitySettings>(DEFAULT_QUALITY)
  const [startError, setStartError] = useState<string | null>(null)

  const capture = useCapture(selected, quality)
  const lobby = useLobby(options, kluczZapisany)

  const jaNadaje = lobby.state.jaNadaje

  /**
   * Kafelki: cudze strumienie plus nasz wlasny podglad, gdy nadajemy.
   * Wlasny bierzemy z lokalnego capture, a nie z sieci — nie wysylamy
   * obrazu do samych siebie.
   */
  const kafelki: { peerId: string; stream: MediaStream; nazwa: string; toJa: boolean }[] = []
  if (jaNadaje && capture.stream && lobby.state.me) {
    kafelki.push({
      peerId: lobby.state.me.peerId,
      stream: capture.stream,
      nazwa: lobby.state.me.displayName,
      toJa: true
    })
  }
  for (const [peerId, stream] of lobby.state.remoteStreams) {
    const peer = lobby.state.peers.find((p) => p.peerId === peerId)
    kafelki.push({ peerId, stream, nazwa: peer?.displayName ?? 'Uczestnik', toJa: false })
  }

  // Zmiana rozdzielczości albo FPS w trakcie nadawania: podmieniamy ścieżkę
  // zamiast zrywać połączenia (chwilowy null w trakcie restartu ignorujemy).
  useEffect(() => {
    if (jaNadaje && capture.stream) lobby.replaceStream(capture.stream)
  }, [jaNadaje, capture.stream, lobby])

  // Bitrate i limit FPS idą przez setParameters — bez dotykania strumienia.
  useEffect(() => {
    lobby.applyQuality(quality.bitrateKbps, quality.fps)
  }, [quality.bitrateKbps, quality.fps, lobby])

  // Powiekszony kafelek moze zniknac (streamer skonczyl) — wtedy wracamy do siatki.
  useEffect(() => {
    if (powiekszony && !kafelki.some((k) => k.peerId === powiekszony)) setPowiekszony(null)
  })

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

  if (lobby.state.connection === 'zly-klucz') {
    return (
      <ApiKeyPrompt
        error={lobby.state.error}
        onSave={(klucz) => {
          void window.companion.setApiKey(klucz).then(() => setKluczZapisany((n) => n + 1))
        }}
      />
    )
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

  return (
    <div className="app">
      <header className="app__titlebar">
        <h1 className="app__title">TS3 Screen Share</h1>
        <span className="app__stage-tag">
          {lobby.state.connection === 'connecting' && 'Łączenie z kanałem…'}
          {lobby.state.connection === 'error' && 'Brak połączenia'}
          {lobby.state.connection === 'ready' &&
            (kafelki.length === 0
              ? 'Nikt nie udostępnia ekranu'
              : `${kafelki.length} ${kafelki.length === 1 ? 'transmisja' : 'transmisje'}` +
                (jaNadaje
                  ? ` · Ty: ${
                      lobby.state.viewers === 0
                        ? 'nikt nie ogląda'
                        : `${lobby.state.viewers} ${lobby.state.viewers === 1 ? 'widz' : 'widzów'}`
                    }`
                  : ''))}
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
              disabled={lobby.state.connection !== 'ready'}
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
          ) : kafelki.length === 0 ? (
            <div className="viewer__stage">
              <div className="viewer__waiting">
                {lobby.state.streamerIds.length > 0
                  ? 'Odbieranie obrazu…'
                  : 'Nikt nie udostępnia ekranu. Możesz zacząć jako pierwszy.'}
              </div>
            </div>
          ) : (
            <div
              className={`siatka${powiekszony ? ' siatka--zoom' : ''}`}
              data-ile={Math.min(kafelki.length, 4)}
            >
              {kafelki
                .filter((k) => !powiekszony || k.peerId === powiekszony)
                .map((k) => (
                  <StreamTile
                    key={k.peerId}
                    stream={k.stream}
                    nazwa={k.nazwa}
                    toJa={k.toJa}
                    powiekszony={powiekszony === k.peerId}
                    onToggleZoom={() =>
                      setPowiekszony((c) => (c === k.peerId ? null : k.peerId))
                    }
                  />
                ))}
            </div>
          )}
        </div>

        <PeerPanel
          me={lobby.state.me}
          peers={lobby.state.peers}
          streamerIds={lobby.state.streamerIds}
          collapsed={panelCollapsed}
          onToggle={() => setPanelCollapsed((current) => !current)}
        />
      </div>
    </div>
  )
}
