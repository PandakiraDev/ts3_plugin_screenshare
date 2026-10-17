import { useCallback, useEffect, useState } from 'react'
import type { CameraSettings, CaptureSource, QualitySettings } from '@shared/types'
import { DEFAULT_CAMERA_SETTINGS, DEFAULT_QUALITY } from '@shared/types'
import type { UpdateState } from '@shared/update'
import type { LaunchParseResult } from '../shared/cli'
import { SourceGrid } from './components/SourceGrid'
import { PreviewPane } from './components/PreviewPane'
import { SettingsPanel } from './components/SettingsPanel'
import { LobbyView } from './components/LobbyView'
import { ResourceBadge } from './components/ResourceBadge'
import { AppVersion, UpdateNotice } from './components/UpdateNotice'
import { useCamera } from './hooks/useCamera'
import { useCapture } from './hooks/useCapture'
import { useAppUpdate } from './hooks/useAppUpdate'

export default function App(): JSX.Element {
  const [launch, setLaunch] = useState<LaunchParseResult | null>(null)
  const { version, update } = useAppUpdate()

  useEffect(() => {
    void window.companion.getLaunch().then(setLaunch)
  }, [])

  if (!launch) {
    return (
      <div className="app">
        <div className="app__main">
          <p className="preview__placeholder">Uruchamianie…</p>
        </div>
      </div>
    )
  }

  if (!launch.ok) {
    return (
      <div className="app">
        <header className="app__titlebar">
          <h1 className="app__title">TS3 Screen Share</h1>
          <AppVersion version={version} />
        </header>
        <div className="app__main">
          <div className="notice notice--error">
            <strong>Błędne argumenty uruchomienia.</strong>
            <span>{launch.error}</span>
          </div>
        </div>
      </div>
    )
  }

  if (launch.options.mode === 'lobby') {
    return <LobbyView options={launch.options} version={version} update={update} />
  }
  return <StandaloneApp version={version} update={update} />
}

/** Uruchomienie bez pluginu: sam picker i lokalny podgląd, bez sieci. */
function StandaloneApp({
  version,
  update
}: {
  version: string
  update: UpdateState
}): JSX.Element {
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [isLoadingSources, setIsLoadingSources] = useState(true)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [selected, setSelected] = useState<CaptureSource | null>(null)
  const [quality, setQuality] = useState<QualitySettings>(DEFAULT_QUALITY)
  const [cameraSettings, setCameraSettings] = useState<CameraSettings>(DEFAULT_CAMERA_SETTINGS)

  const capture = useCapture(selected, quality)
  // Tryb samodzielny niczego nie nadaje, więc kamery nie włączamy (`false`) —
  // hook wołamy wyłącznie po listę urządzeń do selektora w ustawieniach.
  const camera = useCamera(false, cameraSettings)

  const loadSources = useCallback(async (): Promise<void> => {
    setIsLoadingSources(true)
    setSourcesError(null)
    try {
      const result = await window.companion.getSources()
      setSources(result)
      // Wybrane źródło mogło w międzyczasie zniknąć (zamknięte okno) —
      // wtedy zrzucamy zaznaczenie zamiast trzymać martwe id.
      setSelected((current) =>
        current && result.some((source) => source.id === current.id) ? current : null
      )
    } catch (err: unknown) {
      setSourcesError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoadingSources(false)
    }
  }, [])

  useEffect(() => {
    void loadSources()
  }, [loadSources])

  return (
    <div className="app">
      <header className="app__titlebar">
        <h1 className="app__title">TS3 Screen Share</h1>
        <AppVersion version={version} />
        <span className="app__stage-tag">tryb samodzielny · lokalny podgląd</span>
      </header>

      <UpdateNotice update={update} />

      <div className="app__body">
        <main className="app__main">
          {/* Licznik zużycia także tutaj, nie tylko w lobby. Do 0.3.4 rysował
              go `Diagnostics` jako nakładkę na całe okno, więc był w każdym
              trybie za darmo; odkąd jest wierszem w układzie, rysuje go ten,
              kto układ składa — a wtedy tryb pominięty znaczy tryb bez
              licznika. Ten tryb przechwytuje ekran lokalnie, czyli naprawdę
              zjada maszynę, więc pytanie „czy to ja" jest w nim sensowne. */}
          <ResourceBadge />
          <SourceGrid
            sources={sources}
            selectedId={selected?.id ?? null}
            isLoading={isLoadingSources}
            error={sourcesError}
            onSelect={setSelected}
            onRefresh={() => void loadSources()}
          />
          <PreviewPane
            source={selected}
            stream={capture.stream}
            error={capture.error}
            isStarting={capture.isStarting}
            onStop={() => setSelected(null)}
          />
        </main>
        <SettingsPanel
          quality={quality}
          onChange={setQuality}
          cameraSettings={cameraSettings}
          onCameraSettingsChange={setCameraSettings}
          cameraDevices={camera.devices}
        />
      </div>
    </div>
  )
}
