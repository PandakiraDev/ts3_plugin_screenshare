import { useEffect, useRef, useState } from 'react'
import type { CameraSettings, CaptureSource, QualitySettings, StreamKind } from '@shared/types'
import { CAMERA_BITRATE_KBPS, DEFAULT_CAMERA_SETTINGS, DEFAULT_QUALITY } from '@shared/types'
import type { LaunchOptions } from '../../shared/cli'
import { useCamera } from '../hooks/useCamera'
import { useCapture } from '../hooks/useCapture'
import { buildTiles, useLobby } from '../hooks/useLobby'
import { SourcePicker } from './SourcePicker'
import { PeerPanel } from './PeerPanel'
import { SettingsPanel } from './SettingsPanel'
import { StreamTile } from './StreamTile'
import { ApiKeyPrompt } from './ApiKeyPrompt'

interface LobbyViewProps {
  options: LaunchOptions
}

/**
 * Jedno okno na wszystko. Domyślnie oglądasz to, co ktoś udostępnia; wybór
 * źródła pojawia się dopiero po kliknięciu "Udostępnij ekran", żeby lobby
 * zostało czyste. Kamera jest niezależna od ekranu — można mieć jedno, drugie
 * albo oba naraz, każde jako osobny kafelek.
 */
export function LobbyView({ options }: LobbyViewProps): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false)
  // Jedyna droga do ustawień kamery podczas trwającego udostępniania ekranu —
  // SourcePicker (a z nim SettingsPanel) jest wtedy niedostępny, bo przycisk
  // "Udostępnij ekran" zamienia się w "Zakończ udostępnianie".
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [zoomed, setZoomed] = useState<string | null>(null)
  // Zmiana klucza musi przelaczyc widok od razu, bez restartu aplikacji.
  const [apiKeyVersion, setApiKeyVersion] = useState(0)
  const [selected, setSelected] = useState<CaptureSource | null>(null)
  const [quality, setQuality] = useState<QualitySettings>(DEFAULT_QUALITY)
  const [cameraSettings, setCameraSettings] = useState<CameraSettings>(DEFAULT_CAMERA_SETTINGS)
  const [cameraEnabled, setCameraEnabled] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [cameraError, setCameraError] = useState<string | null>(null)

  const capture = useCapture(selected, quality)
  const camera = useCamera(cameraEnabled, cameraSettings)
  const lobby = useLobby(options, apiKeyVersion)
  const { startStream, stopStream, replaceStream, applyQuality } = lobby

  const sharingScreen = lobby.state.myStreamKinds.includes('screen')
  const sharingCamera = lobby.state.myStreamKinds.includes('camera')

  /**
   * Kafelki: cudze strumienie plus nasze wlasne podglady. Wlasne bierzemy
   * z lokalnego capture, a nie z sieci — nie wysylamy obrazu do samych siebie.
   */
  const own: { kind: StreamKind; stream: MediaStream }[] = []
  if (sharingScreen && capture.stream) own.push({ kind: 'screen', stream: capture.stream })
  if (sharingCamera && camera.stream) own.push({ kind: 'camera', stream: camera.stream })

  const tiles = buildTiles(
    own,
    lobby.state.remoteStreams.values(),
    lobby.state.me,
    lobby.state.peers
  )

  // Zmiana rozdzielczości albo FPS w trakcie nadawania: podmieniamy ścieżkę
  // zamiast zrywać połączenia (chwilowy null w trakcie restartu ignorujemy).
  useEffect(() => {
    if (sharingScreen && capture.stream) replaceStream(capture.stream, 'screen')
  }, [sharingScreen, capture.stream, replaceStream])

  useEffect(() => {
    if (sharingCamera && camera.stream) replaceStream(camera.stream, 'camera')
  }, [sharingCamera, camera.stream, replaceStream])

  // Bitrate i limit FPS idą przez setParameters — bez dotykania strumienia.
  // Osobno dla każdego rodzaju: kamera ma własny sufit i własny limit klatek,
  // więc ustawienia ekranu nie mają prawa na nią spłynąć.
  useEffect(() => {
    applyQuality('screen', quality.bitrateKbps, quality.fps)
  }, [quality.bitrateKbps, quality.fps, applyQuality])

  useEffect(() => {
    applyQuality('camera', CAMERA_BITRATE_KBPS, cameraSettings.fps)
  }, [cameraSettings.fps, applyQuality])

  /**
   * Zgłoszenie kamery leci osobnym efektem, a nie z handlera przycisku:
   * `useCamera` oddaje strumień dopiero po starcie urządzenia, więc w chwili
   * kliknięcia nie ma jeszcze czego wysłać.
   */
  const cameraStartInProgress = useRef(false)
  useEffect(() => {
    if (!cameraEnabled || !camera.stream || sharingCamera || cameraStartInProgress.current) return
    cameraStartInProgress.current = true
    void startStream(camera.stream, 'camera')
      .catch((err: unknown) => {
        setCameraError(err instanceof Error ? err.message : String(err))
        setCameraEnabled(false)
      })
      .finally(() => {
        cameraStartInProgress.current = false
      })
  }, [cameraEnabled, camera.stream, sharingCamera, startStream])

  // Zdjęcie transmisji też efektem: przycisk może zgasnąć zanim serwer w ogóle
  // potwierdzi start, a wtedy zatrzymywanie z handlera nie miałoby czego zdjąć.
  useEffect(() => {
    if (cameraEnabled || !sharingCamera) return
    // Serwer może odmówić (np. przy zerwanym łączu). Bez tego byłoby to ciche
    // odrzucenie obietnicy, a kafelek kamery zostałby u wszystkich widzów.
    void stopStream('camera').catch((err: unknown) => {
      setCameraError(err instanceof Error ? err.message : String(err))
    })
  }, [cameraEnabled, sharingCamera, stopStream])

  // Powiekszony kafelek moze zniknac (nadajacy skonczyl) — wtedy wracamy do siatki.
  useEffect(() => {
    if (zoomed && !tiles.some((t) => t.tileKey === zoomed)) setZoomed(null)
  })

  const confirmSelection = async (): Promise<void> => {
    if (!capture.stream) return
    setStartError(null)
    try {
      await startStream(capture.stream, 'screen')
      setPickerOpen(false)
    } catch (err: unknown) {
      setStartError(err instanceof Error ? err.message : String(err))
    }
  }

  const endScreenShare = async (): Promise<void> => {
    // Bez tego odrzucenie obietnicy byłoby nieobsłużone, a setSelected(null)
    // nigdy by się nie wykonał — przechwytywanie pulpitu zostałoby żywe mimo
    // przełączonego przycisku. Ten sam wzorzec co przy zatrzymaniu kamery.
    await stopStream('screen').catch((err: unknown) => {
      setStartError(err instanceof Error ? err.message : String(err))
    })
    setSelected(null)
  }

  const toggleCamera = (): void => {
    setCameraError(null)
    setCameraEnabled((enabled) => !enabled)
  }

  if (lobby.state.connection === 'bad-key') {
    return (
      <ApiKeyPrompt
        error={lobby.state.error}
        onSave={(key) => {
          void window.companion.setApiKey(key).then(() => setApiKeyVersion((n) => n + 1))
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
        cameraSettings={cameraSettings}
        onCameraSettingsChange={setCameraSettings}
        cameraDevices={camera.devices}
        capture={capture}
        error={startError}
        onConfirm={() => void confirmSelection()}
        onCancel={() => {
          setPickerOpen(false)
          setSelected(null)
          setStartError(null)
        }}
      />
    )
  }

  // Kamera potrafi nie wstać (zajęta przez Discorda, brak zgody) albo zostać
  // odrzucona przez serwer. Bez tego paska jedynym śladem byłaby konsola.
  const cameraErrorText = cameraError ?? camera.error

  return (
    <div className="app">
      <header className="app__titlebar">
        <h1 className="app__title">TS3 Screen Share</h1>
        <span className="app__stage-tag">
          {lobby.state.connection === 'connecting' && 'Łączenie z kanałem…'}
          {lobby.state.connection === 'error' && 'Brak połączenia'}
          {lobby.state.connection === 'ready' &&
            (tiles.length === 0
              ? 'Nikt nie nadaje obrazu'
              : `${tiles.length} ${tiles.length === 1 ? 'transmisja' : 'transmisje'}` +
                (sharingScreen || sharingCamera
                  ? ` · Ty: ${
                      lobby.state.viewers === 0
                        ? 'nikt nie ogląda'
                        : `${lobby.state.viewers} ${lobby.state.viewers === 1 ? 'widz' : 'widzów'}`
                    }`
                  : ''))}
        </span>

        <div className="app__actions">
          <button
            type="button"
            className={`btn ${cameraEnabled ? 'btn--danger' : 'btn--ghost'}`}
            onClick={toggleCamera}
            disabled={lobby.state.connection !== 'ready'}
            aria-pressed={cameraEnabled}
          >
            {cameraEnabled ? '📷 Wyłącz kamerę' : '📷 Włącz kamerę'}
          </button>

          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setSettingsOpen((open) => !open)}
            aria-pressed={settingsOpen}
            aria-label="Ustawienia"
            title="Ustawienia"
          >
            ⚙️
          </button>

          {sharingScreen ? (
            <button type="button" className="btn btn--danger" onClick={() => void endScreenShare()}>
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

      {cameraErrorText && (
        <div className="sharebar">
          <div className="notice notice--error sharebar__error">
            <strong>Kamera</strong>
            <span>{cameraErrorText}</span>
          </div>
        </div>
      )}

      <div className="lobby">
        <div className="viewer">
          {lobby.state.connection === 'error' ? (
            <div className="notice notice--error">
              <strong>Nie udało się połączyć z kanałem.</strong>
              <span>{lobby.state.error}</span>
            </div>
          ) : tiles.length === 0 ? (
            <div className="viewer__stage">
              <div className="viewer__waiting">
                {lobby.state.streams.length > 0
                  ? 'Odbieranie obrazu…'
                  : 'Nikt nie nadaje obrazu. Możesz zacząć jako pierwszy.'}
              </div>
            </div>
          ) : (
            <div
              className={`siatka${zoomed ? ' siatka--zoom' : ''}`}
              data-ile={Math.min(tiles.length, 4)}
            >
              {tiles
                .filter((t) => !zoomed || t.tileKey === zoomed)
                .map((t) => (
                  <StreamTile
                    key={t.tileKey}
                    stream={t.stream}
                    name={t.label}
                    kind={t.kind}
                    isMe={t.isMe}
                    zoomed={zoomed === t.tileKey}
                    onToggleZoom={() =>
                      setZoomed((c) => (c === t.tileKey ? null : t.tileKey))
                    }
                  />
                ))}
            </div>
          )}
        </div>

        <PeerPanel
          me={lobby.state.me}
          peers={lobby.state.peers}
          streams={lobby.state.streams}
          collapsed={panelCollapsed}
          onToggle={() => setPanelCollapsed((current) => !current)}
        />

        {settingsOpen && (
          <SettingsPanel
            quality={quality}
            onChange={setQuality}
            cameraSettings={cameraSettings}
            onCameraSettingsChange={setCameraSettings}
            cameraDevices={camera.devices}
          />
        )}
      </div>
    </div>
  )
}
