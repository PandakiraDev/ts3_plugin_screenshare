import { useCallback, useEffect, useState } from 'react'
import type { CaptureSource, QualitySettings } from '@shared/types'
import { DEFAULT_QUALITY } from '@shared/types'
import type { LaunchParseResult } from '../shared/cli'
import { SourceGrid } from './components/SourceGrid'
import { PreviewPane } from './components/PreviewPane'
import { SettingsPanel } from './components/SettingsPanel'
import { LobbyView } from './components/LobbyView'
import { useCapture } from './hooks/useCapture'

export default function App(): JSX.Element {
  const [launch, setLaunch] = useState<LaunchParseResult | null>(null)

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

  if (launch.options.mode === 'lobby') return <LobbyView options={launch.options} />
  return <StandaloneApp />
}

/** Uruchomienie bez pluginu: sam picker i lokalny podgląd, bez sieci. */
function StandaloneApp(): JSX.Element {
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [isLoadingSources, setIsLoadingSources] = useState(true)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [selected, setSelected] = useState<CaptureSource | null>(null)
  const [quality, setQuality] = useState<QualitySettings>(DEFAULT_QUALITY)

  const capture = useCapture(selected, quality)

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
        <span className="app__stage-tag">tryb samodzielny · lokalny podgląd</span>
      </header>

      <div className="app__body">
        <main className="app__main">
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
        <SettingsPanel quality={quality} onChange={setQuality} />
      </div>
    </div>
  )
}
