import type { CaptureSource } from '@shared/types'
import { SourceCard } from './SourceCard'

interface SourceGridProps {
  sources: CaptureSource[]
  selectedId: string | null
  isLoading: boolean
  error: string | null
  onSelect: (source: CaptureSource) => void
  onRefresh: () => void
}

export function SourceGrid({
  sources,
  selectedId,
  isLoading,
  error,
  onSelect,
  onRefresh
}: SourceGridProps): JSX.Element {
  const screens = sources.filter((source) => source.type === 'screen')
  const windows = sources.filter((source) => source.type === 'window')

  return (
    <div className="source-grid">
      <header className="source-grid__header">
        <h2>Wybierz co udostępnić</h2>
        <button type="button" className="btn btn--ghost" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? 'Odświeżanie…' : 'Odśwież'}
        </button>
      </header>

      {error && (
        <div className="notice notice--error">
          <strong>Nie udało się pobrać źródeł.</strong>
          <span>{error}</span>
        </div>
      )}

      {!error && !isLoading && sources.length === 0 && (
        <div className="notice">Nie znaleziono żadnych ekranów ani okien.</div>
      )}

      <Section title="Ekrany" sources={screens} selectedId={selectedId} onSelect={onSelect} />
      <Section title="Okna" sources={windows} selectedId={selectedId} onSelect={onSelect} />
    </div>
  )
}

interface SectionProps {
  title: string
  sources: CaptureSource[]
  selectedId: string | null
  onSelect: (source: CaptureSource) => void
}

function Section({ title, sources, selectedId, onSelect }: SectionProps): JSX.Element | null {
  if (sources.length === 0) return null
  return (
    <section className="source-grid__section">
      <h3 className="source-grid__section-title">
        {title} <span className="source-grid__count">{sources.length}</span>
      </h3>
      <div className="source-grid__items">
        {sources.map((source) => (
          <SourceCard
            key={source.id}
            source={source}
            isSelected={source.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  )
}
