import type { ParticipantBadge, ParticipantView } from '@shared/participants'
import type { StreamKind } from '@shared/types'

interface ParticipantRowProps {
  view: ParticipantView
  /** Osoba wyszła z kanału i wiersz właśnie dogasa. */
  leaving: boolean
  /**
   * Które rodzaje strumieni tej osoby są ukryte u nas, i przełącznik. Oczko
   * pojawia się tylko przy plakietce rodzaju, który osoba faktycznie nadaje,
   * więc kto nic nie nadaje, nie dostaje żadnego. Dotyczy też własnego wiersza.
   * Każdy kafelek da się ukryć krzyżykiem, a po ukryciu nie ma na nim czego
   * najechać, więc oczko jest jedyną drogą powrotu.
   */
  hiddenKinds: { screen: boolean; camera: boolean }
  onToggleStream: (kind: StreamKind) => void
}

const EYE_TARGET: Record<StreamKind, string> = { screen: 'ekran', camera: 'kamerę' }

interface StreamEyeButtonProps {
  kind: StreamKind
  hidden: boolean
  onToggle: () => void
}

function StreamEyeButton({ kind, hidden, onToggle }: StreamEyeButtonProps): JSX.Element {
  const label = `${hidden ? 'Pokaż' : 'Ukryj'} ${EYE_TARGET[kind]} tej osoby`
  return (
    <button
      type="button"
      className={`participant__eye${hidden ? ' participant__eye--off' : ''}`}
      onClick={onToggle}
      title={label}
      aria-label={label}
    >
      <span aria-hidden="true">{hidden ? '🚫' : '👁'}</span>
    </button>
  )
}

function badgeLabel(badge: ParticipantBadge): string {
  switch (badge.kind) {
    case 'screen':
      return '🖥 Ekran'
    case 'camera':
      return '📷 Kamera'
    case 'unreachable':
      return '⚠ Brak połączenia'
    case 'watching':
      if (badge.quality === 'ok') return '👁 Ogląda · płynnie'
      if (badge.quality === 'poor') return '👁 Ogląda · zacina'
      // Brak dopisku to NIE to samo co „płynnie" — to „jeszcze nie wiadomo".
      return '👁 Ogląda'
  }
}

function badgeModifier(badge: ParticipantBadge): string {
  return badge.kind === 'watching' ? `watching-${badge.quality}` : badge.kind
}

export function ParticipantRow({
  view,
  leaving,
  hiddenKinds,
  onToggleStream
}: ParticipantRowProps): JSX.Element {
  return (
    <li className={`participant${leaving ? ' participant--leaving' : ''}`}>
      {/*
        `key` z `isStreaming` jest tu jedynym mechanizmem uruchamiającym puls:
        zmiana klucza montuje element od nowa, a animacja CSS gra przy montowaniu.
        Klasa z pulsem wisi tylko przy `true`, więc przejście `true → false`
        (koniec transmisji) przemontowuje krążek BEZ animacji — i tak ma być,
        koniec transmisji ma być spokojny.
      */}
      <span
        key={`${view.peerId}-${view.isStreaming}`}
        className={`participant__avatar${view.isStreaming ? ' participant__avatar--started' : ''}`}
        style={{ background: view.color }}
        aria-hidden="true"
      >
        {view.initials}
      </span>

      <div className="participant__body">
        <span className="participant__name" title={view.displayName}>
          {view.displayName}
          {view.isMe && <span className="participant__you"> (Ty)</span>}
        </span>

        {view.badges.length > 0 && (
          <span className="participant__badges">
            {view.badges.map((badge) => (
              /*
                `key` to sam `kind`, CELOWO bez `quality`. Gdyby jakość weszła
                do klucza, plakietka „Ogląda" montowałaby się od nowa przy każdej
                zmianie jakości — czyli podskakiwałaby co pięć sekund, przy każdym
                raporcie z 0.3.1. Zmiana „płynnie" ↔ „zacina" ma być przemalowaniem
                istniejącej plakietki, nie nową plakietką.
              */
              <span key={badge.kind} className={`participant__badge participant__badge--${badgeModifier(badge)}`}>
                {badgeLabel(badge)}
                {/* Oczko siedzi W plakietce, żeby przy zawinięciu wiersza nie oderwało się od swojego rodzaju. */}
                {(badge.kind === 'screen' || badge.kind === 'camera') && (
                  <StreamEyeButton
                    kind={badge.kind}
                    hidden={hiddenKinds[badge.kind]}
                    onToggle={() => onToggleStream(badge.kind)}
                  />
                )}
              </span>
            ))}
          </span>
        )}
      </div>
    </li>
  )
}
