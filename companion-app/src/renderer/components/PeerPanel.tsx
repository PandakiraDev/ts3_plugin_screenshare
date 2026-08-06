import type { PeerInfo } from '../signaling/SignalingClient'

interface PeerPanelProps {
  me: PeerInfo | null
  peers: PeerInfo[]
  /** peerId wszystkich nadających — ikona przy każdym z nich. */
  streamerIds: string[]
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
  streamerIds,
  collapsed,
  onToggle
}: PeerPanelProps): JSX.Element {
  const wszyscy: (PeerInfo & { toJa: boolean })[] = [
    ...(me ? [{ ...me, toJa: true }] : []),
    ...peers.map((peer) => ({ ...peer, toJa: false }))
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
          <span className="peers__count-badge">{wszyscy.length}</span>
        </button>
      </aside>
    )
  }

  return (
    <aside className="peers">
      <header className="peers__header">
        <h2 className="peers__title">
          W kanale <span className="source-grid__count">{wszyscy.length}</span>
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
        {wszyscy.map((peer) => {
          const nadaje = streamerIds.includes(peer.peerId)
          return (
            <li
              key={peer.peerId}
              className={`peers__item${nadaje ? ' peers__item--streaming' : ''}`}
            >
              <span
                className="peers__icon"
                title={nadaje ? 'Udostępnia ekran' : undefined}
                aria-label={nadaje ? 'Udostępnia ekran' : undefined}
              >
                {nadaje ? '🖥' : '•'}
              </span>
              <span className="peers__name">
                {peer.displayName}
                {peer.toJa && <span className="peers__you"> (Ty)</span>}
              </span>
            </li>
          )
        })}
      </ul>

      {wszyscy.length <= 1 && (
        <p className="settings__hint">Nikt inny nie dołączył jeszcze do kanału.</p>
      )}
    </aside>
  )
}
