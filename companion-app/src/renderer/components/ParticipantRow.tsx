import type { ParticipantBadge, ParticipantView } from '@shared/participants'

interface ParticipantRowProps {
  view: ParticipantView
  /** Osoba wyszła z kanału i wiersz właśnie dogasa. */
  leaving: boolean
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

export function ParticipantRow({ view, leaving }: ParticipantRowProps): JSX.Element {
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
              </span>
            ))}
          </span>
        )}
      </div>
    </li>
  )
}
