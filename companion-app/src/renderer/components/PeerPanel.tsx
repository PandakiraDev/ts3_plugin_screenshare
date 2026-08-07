import type { StreamRef } from '@shared/types'
import type { PeerInfo } from '../signaling/SignalingClient'

interface PeerPanelProps {
  me: PeerInfo | null
  peers: PeerInfo[]
  /**
   * Wszystkie nadawane strumienie. Lista par, nie samych peerId: osoba
   * z ekranem i kamerą naraz ma pokazać obie ikony, nie jedną.
   */
  streams: StreamRef[]
  collapsed: boolean
  onToggle: () => void
}

/**
 * Lista uczestników kanału. Zwijana, bo przy oglądaniu na pełnym ekranie
 * obraz jest ważniejszy niż lista — ale zwinięta zostawia pasek z liczbą osób,
 * żeby nie znikała bez śladu.
 */
export function PeerPanel({
  me,
  peers,
  streams,
  collapsed,
  onToggle
}: PeerPanelProps): JSX.Element {
  const everyone: (PeerInfo & { isMe: boolean })[] = [
    ...(me ? [{ ...me, isMe: true }] : []),
    ...peers.map((peer) => ({ ...peer, isMe: false }))
  ]

  if (collapsed) {
    return (
      <aside className="peers peers--collapsed">
        <button
          type="button"
          className="peers__toggle"
          onClick={onToggle}
          title="Pokaż listę uczestników"
          aria-expanded={false}
        >
          <span aria-hidden="true">‹</span>
          <span className="peers__count-badge">{everyone.length}</span>
        </button>
      </aside>
    )
  }

  return (
    <aside className="peers">
      <header className="peers__header">
        <h2 className="peers__title">
          W kanale <span className="source-grid__count">{everyone.length}</span>
        </h2>
        <button
          type="button"
          className="peers__toggle"
          onClick={onToggle}
          title="Ukryj listę uczestników"
          aria-expanded={true}
        >
          <span aria-hidden="true">›</span>
        </button>
      </header>

      <ul className="peers__list">
        {everyone.map((peer) => {
          const kinds = streams.filter((s) => s.peerId === peer.peerId)
          const hasScreen = kinds.some((s) => s.kind === 'screen')
          const hasCamera = kinds.some((s) => s.kind === 'camera')
          const labels: string[] = []
          if (hasScreen) labels.push('Udostępnia ekran')
          if (hasCamera) labels.push('Ma włączoną kamerę')
          const label = labels.join(' · ') || undefined
          return (
            <li
              key={peer.peerId}
              className={`peers__item${hasScreen || hasCamera ? ' peers__item--streaming' : ''}`}
            >
              <span className="peers__icon" title={label} aria-label={label}>
                {hasScreen && '🖥'}
                {hasCamera && '📷'}
                {!hasScreen && !hasCamera && '•'}
              </span>
              <span className="peers__name">
                {peer.displayName}
                {peer.isMe && <span className="peers__you"> (Ty)</span>}
              </span>
            </li>
          )
        })}
      </ul>

      {everyone.length <= 1 && (
        <p className="settings__hint">Nikt inny nie dołączył jeszcze do kanału.</p>
      )}
    </aside>
  )
}
