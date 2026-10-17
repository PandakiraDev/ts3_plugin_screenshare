import type { ParticipantBadge, ParticipantView } from '@shared/participants'
import { canToggleStream, STREAM_TOGGLE_BLOCKED_TEXT } from '@shared/tileLayout'
import type { StreamKind } from '@shared/types'

interface ParticipantRowProps {
  view: ParticipantView
  /** Osoba wyszła z kanału i wiersz właśnie dogasa. */
  leaving: boolean
  /**
   * Które rodzaje strumieni tej osoby są ukryte u nas, i przełącznik. Oczko
   * pojawia się tylko przy plakietce rodzaju, który osoba faktycznie nadaje,
   * więc kto nic nie nadaje, nie dostaje żadnego. Każdy kafelek da się ukryć
   * krzyżykiem, a ukryty znika z siatki — nie ma czego najechać, żeby go
   * przywrócić — więc oczko jest jedyną drogą powrotu. Dlatego przy martwym
   * gnieździe sygnalizacji oba przełączniki CUDZEGO strumienia gasną razem
   * (`signalingClosed` niżej): droga powrotu wiedzie przez nadawcę, a ten
   * przestał nas słyszeć.
   */
  hiddenKinds: { screen: boolean; camera: boolean }
  /**
   * Gniazdo sygnalizacji jest martwe. Oczka przy CUDZYCH strumieniach są wtedy
   * nieaktywne — rozstrzyga o tym `canToggleStream`, nie ten komponent.
   */
  signalingClosed: boolean
  onToggleStream: (kind: StreamKind) => void
}

const EYE_TARGET: Record<StreamKind, string> = { screen: 'ekran', camera: 'kamerę' }

interface StreamEyeButtonProps {
  kind: StreamKind
  hidden: boolean
  /** Dlaczego oczko jest nieaktywne; `null` = jest aktywne. */
  blockedReason: string | null
  onToggle: () => void
}

function StreamEyeButton({
  kind,
  hidden,
  blockedReason,
  onToggle
}: StreamEyeButtonProps): JSX.Element {
  const label = blockedReason ?? `${hidden ? 'Pokaż' : 'Ukryj'} ${EYE_TARGET[kind]} tej osoby`
  return (
    <button
      type="button"
      className={`participant__eye${hidden ? ' participant__eye--off' : ''}`}
      onClick={onToggle}
      disabled={blockedReason !== null}
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
  signalingClosed,
  onToggleStream
}: ParticipantRowProps): JSX.Element {
  /*
   * Powód nieaktywności liczymy RAZ na wiersz, nie w każdej plakietce: oba
   * oczka tej samej osoby są aktywne albo nieaktywne razem, bo warunek zależy
   * od `isMe` i od gniazda, a nie od rodzaju strumienia.
   */
  const blockedReason = canToggleStream({ isMe: view.isMe, signalingClosed })
    ? null
    : STREAM_TOGGLE_BLOCKED_TEXT

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
                    blockedReason={blockedReason}
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
