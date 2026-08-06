import type { CaptureSource } from '@shared/types'

interface SourceCardProps {
  source: CaptureSource
  isSelected: boolean
  onSelect: (source: CaptureSource) => void
}

export function SourceCard({ source, isSelected, onSelect }: SourceCardProps): JSX.Element {
  return (
    <button
      type="button"
      className={`source-card${isSelected ? ' source-card--selected' : ''}`}
      onClick={() => onSelect(source)}
      aria-pressed={isSelected}
      title={source.name}
    >
      <span className="source-card__thumb">
        {source.thumbnailDataUrl ? (
          <img src={source.thumbnailDataUrl} alt="" draggable={false} />
        ) : (
          <span className="source-card__thumb-empty">Brak podglądu</span>
        )}
      </span>
      <span
        className={`source-card__label${
          source.appIconDataUrl ? ' source-card__label--with-icon' : ''
        }`}
      >
        {source.appIconDataUrl && (
          <img className="source-card__icon" src={source.appIconDataUrl} alt="" />
        )}
        <span className="source-card__name">{source.name}</span>
      </span>
    </button>
  )
}
