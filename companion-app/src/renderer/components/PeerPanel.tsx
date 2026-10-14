import { splitByStreaming, type ParticipantView } from '@shared/participants'
import { ParticipantRow } from './ParticipantRow'

interface PeerPanelProps {
  /**
   * Wiersze PO przejściu wyjścia. Podział na sekcje robimy tutaj, a nie przed
   * przejściem: inaczej osoba kończąca transmisję byłaby przez chwilę widoczna
   * dwa razy naraz — dogasająca w „Nadają" i już wstawiona do „W kanale".
   */
  rows: { item: ParticipantView; leaving: boolean }[]
  collapsed: boolean
  onToggle: () => void
  /**
   * Odcisk palca pokoju i opis, z czego go wyliczono. `null` w trybie
   * standalone, gdzie żadnego pokoju nie ma.
   */
  roomFingerprint: { short: string; derivedFrom: string } | null
}

/**
 * Lista uczestników kanału. Zwijana, bo przy oglądaniu na pełnym ekranie
 * obraz jest ważniejszy niż lista — ale zwinięta zostawia pasek z liczbą osób,
 * żeby nie znikała bez śladu.
 */
export function PeerPanel({
  rows,
  collapsed,
  onToggle,
  roomFingerprint
}: PeerPanelProps): JSX.Element {
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
          {/* Licznik na zwiniętym pasku jest ŁĄCZNY — tu nie ma podziału na sekcje. */}
          <span className="peers__count-badge">{rows.length}</span>
        </button>
      </aside>
    )
  }

  const { streaming, others } = splitByStreaming(rows, (row) => row.item.isStreaming)

  return (
    <aside className="peers">
      <header className="peers__header">
        <h2 className="peers__title">Uczestnicy</h2>
        {/* Odcisk celowo tylko w rozwiniętym nagłówku: zwinięty pasek (52 px) mieści
            wyłącznie licznik osób, a odcisk jest potrzebny jednorazowo, przy
            porównywaniu przez telefon — wtedy panel można rozwinąć. */}
        {roomFingerprint && (
          <span className="peers__room" title={roomFingerprint.derivedFrom}>
            lobby {roomFingerprint.short}
          </span>
        )}
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

      {streaming.length > 0 && (
        <>
          <h3 className="peers__section">
            Nadają <span className="peers__section-count">{streaming.length}</span>
          </h3>
          <ul className="peers__list">
            {streaming.map((row) => (
              <ParticipantRow key={row.item.peerId} view={row.item} leaving={row.leaving} />
            ))}
          </ul>
        </>
      )}

      {others.length > 0 && (
        <>
          <h3 className="peers__section">
            W kanale <span className="peers__section-count">{others.length}</span>
          </h3>
          <ul className="peers__list">
            {others.map((row) => (
              <ParticipantRow key={row.item.peerId} view={row.item} leaving={row.leaving} />
            ))}
          </ul>
        </>
      )}

      {rows.length <= 1 && (
        <p className="settings__hint">Nikt inny nie dołączył jeszcze do kanału.</p>
      )}
    </aside>
  )
}
