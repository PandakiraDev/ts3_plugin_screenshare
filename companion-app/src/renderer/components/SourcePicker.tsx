import { useCallback, useEffect, useState } from 'react'
import type { CaptureSource, QualitySettings } from '@shared/types'
import type { CaptureState } from '../hooks/useCapture'
import { SourceGrid } from './SourceGrid'
import { PreviewPane } from './PreviewPane'
import { SettingsPanel } from './SettingsPanel'

interface SourcePickerProps {
  selected: CaptureSource | null
  onSelect: (source: CaptureSource) => void
  quality: QualitySettings
  onQualityChange: (quality: QualitySettings) => void
  capture: CaptureState
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}

/** Ekran wyboru źródła — pokazywany dopiero po kliknięciu "Udostępnij ekran". */
export function SourcePicker({
  selected,
  onSelect,
  quality,
  onQualityChange,
  capture,
  error,
  onConfirm,
  onCancel
}: SourcePickerProps): JSX.Element {
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [sourcesError, setSourcesError] = useState<string | null>(null)

  const loadSources = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    setSourcesError(null)
    try {
      setSources(await window.companion.getSources())
    } catch (err: unknown) {
      setSourcesError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSources()
  }, [loadSources])

  return (
    <div className="app">
      <header className="app__titlebar">
        <h1 className="app__title">Co chcesz udostępnić?</h1>
        <div className="app__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Anuluj
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={onConfirm}
            disabled={capture.stream === null}
          >
            Rozpocznij udostępnianie
          </button>
        </div>
      </header>

      {error && (
        <div className="sharebar">
          <div className="notice notice--error sharebar__error">
            <span>{error}</span>
          </div>
        </div>
      )}

      {capture.audioWarning && (
        <div className="sharebar">
          <div className="notice sharebar__error">
            <span>{capture.audioWarning}</span>
          </div>
        </div>
      )}

      <div className="app__body">
        <main className="app__main">
          <SourceGrid
            sources={sources}
            selectedId={selected?.id ?? null}
            isLoading={isLoading}
            error={sourcesError}
            onSelect={onSelect}
            onRefresh={() => void loadSources()}
          />
          <PreviewPane
            source={selected}
            stream={capture.stream}
            error={capture.error}
            isStarting={capture.isStarting}
            onStop={onCancel}
          />
        </main>
        <SettingsPanel quality={quality} onChange={onQualityChange} />
      </div>
    </div>
  )
}
