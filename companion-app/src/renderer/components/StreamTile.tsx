import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { StreamKind } from '@shared/types'
import { canToggleStream, STREAM_TOGGLE_BLOCKED_TEXT } from '@shared/tileLayout'

interface StreamTileProps {
  /**
   * Klucz tego kafelka w siatce (`connectionKey(peerId, kind)`), wystawiony
   * w DOM-ie jako `data-tile-key`: po nim `LobbyView` rozpoznaje kafelek pod
   * wskaźnikiem przy upuszczaniu. Przychodzi z zewnątrz, a nie składa się
   * tu z `peerId` i `kind` — inaczej istniałyby dwa źródła tej samej prawdy.
   */
  tileKey: string
  stream: MediaStream
  /** Czyj to strumień — po tym hook diagnostyczny dopasowuje element `<video>`. */
  peerId: string
  name: string
  /** Rodzaj strumienia — kamera nie ma i nie będzie miała ścieżki audio. */
  kind: StreamKind
  /** Własny obraz nie ma sensu odtwarzać z dźwiękiem — słyszelibyśmy siebie. */
  isMe: boolean
  /** Nadawca zakończył transmisję i kafelek właśnie odjeżdża. */
  leaving: boolean
  zoomed: boolean
  /** Ten kafelek jest właśnie przeciągany — przygaszamy go, żeby gest było widać. */
  dragged: boolean
  onToggleZoom: () => void
  /**
   * Ukryj ten kafelek w SWOJEJ siatce, krzyżykiem na samym kafelku. `undefined`
   * znaczy tylko „ten kafelek nie ma krzyżyka" — wtedy guzika nie ma wcale,
   * zamiast nieaktywnego. NIE znaczy „nie da się go ukryć": ukrywać można też
   * oczkiem w liście uczestników, niezależnie od tego propsa.
   *
   * Stan NIEAKTYWNY to osobna sprawa i ma osobny props (`signalingClosed`
   * niżej): tam guzik jest, tylko ukrycie byłoby nieodwracalne, a to jest
   * wiadomość, którą trzeba pokazać, a nie schować razem z guzikiem.
   */
  onHide?: () => void
  /**
   * Gniazdo sygnalizacji jest martwe. Krzyżyk na CUDZYM kafelku jest wtedy
   * nieaktywny, bo ukrycie byłoby nieodwracalne — rozstrzyga o tym
   * `canToggleStream`, a nie ten komponent.
   */
  signalingClosed: boolean
  /**
   * Zaczyna przeciąganie tego kafelka. `undefined` znaczy „nie da się go teraz
   * przestawić" (jest powiększony albo dogasa) — wtedy uchwytu nie ma wcale,
   * zamiast nieaktywnego.
   */
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void
}

/**
 * Jeden strumień w siatce. Głośność jest ustawiana per kafelek, bo widz może
 * chcieć słuchać jednej osoby, a drugą tylko oglądać.
 */
export function StreamTile({
  tileKey,
  stream,
  peerId,
  name,
  kind,
  isMe,
  leaving,
  zoomed,
  dragged,
  onToggleZoom,
  onHide,
  signalingClosed,
  onDragStart
}: StreamTileProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)

  // Kamera nigdy nie niesie dźwięku, więc ani suwak, ani napis "bez dźwięku"
  // nie mają tu czego opisywać — to byłby stały, nieusuwalny komunikat.
  const audioApplies = kind === 'screen' && !isMe
  const hasAudio = stream.getAudioTracks().length > 0

  // Nieaktywny krzyżyk, a nie schowany: schowany kazałby szukać, czy guzik był
  // kiedykolwiek, a podpowiedź na nieaktywnym mówi wprost, dlaczego go nie ma.
  // Reguła jest WSPÓLNA z oczkiem w liście uczestników i mieszka w `shared`,
  // bo w komponencie nie da się jej sprawdzić testem.
  const hideBlocked = !canToggleStream({ isMe, signalingClosed })

  useEffect(() => {
    const video = videoRef.current
    if (video) video.srcObject = stream
  }, [stream])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    // Własny obraz zawsze wyciszony: inaczej słyszelibyśmy echo swojego systemu.
    video.muted = isMe || muted
    video.volume = volume
  }, [isMe, muted, volume])

  return (
    <div
      className={`tile${zoomed ? ' tile--zoom' : ''}${leaving ? ' tile--leaving' : ''}${
        dragged ? ' tile--dragged' : ''
      }`}
      data-tile-key={tileKey}
    >
      {onHide && (
        <button
          type="button"
          className="tile__hide"
          onClick={onHide}
          disabled={hideBlocked}
          title={hideBlocked ? STREAM_TOGGLE_BLOCKED_TEXT : 'Ukryj ten kafelek u siebie'}
          aria-label={hideBlocked ? STREAM_TOGGLE_BLOCKED_TEXT : 'Ukryj ten kafelek u siebie'}
        >
          <span aria-hidden="true">✕</span>
        </button>
      )}

      {/*
        Uchwyt przeciągania, rodzeństwo sceny (tak jak krzyżyk), nie jej dziecko:
        dzięki temu zdarzenia wskaźnika nie wchodzą w handler powiększenia.

        Przestawianie jest CELOWO dostępne tylko wskaźnikiem. Uchwyt wypada
        z kolejności tabulacji i z drzewa dostępności (`tabIndex={-1}`,
        `aria-hidden`), żeby klawiatura nie prowadziła do kontrolki, która z niej
        nie działa. To wybór dla tej wersji, nie przeoczenie: krzyżyk, powiększenie
        i oczko w liście uczestników są osiągalne z klawiatury, a samo przestawianie
        jest wygodą, nie jedyną drogą do jakiejkolwiek funkcji.
      */}
      {onDragStart && (
        <button
          type="button"
          className="tile__grip"
          onPointerDown={onDragStart}
          tabIndex={-1}
          aria-hidden="true"
          title="Przeciągnij, żeby zmienić kolejność"
        >
          <span aria-hidden="true">⠿</span>
        </button>
      )}

      {/*
        Powiększenie kliknięciem w sam obraz. Osobny element zamiast handlera na
        całym kafelku, bo pasek na dole ma własne kontrolki — suwak głośności
        przeciągany myszą kończyłby się przypadkowym powiększeniem.
      */}
      <div
        className="tile__stage"
        onClick={onToggleZoom}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onToggleZoom()
        }}
        role="button"
        tabIndex={0}
        aria-label={zoomed ? `Wróć do siatki: ${name}` : `Powiększ: ${name}`}
      >
        {/*
          Atrybuty `data-*` czyta hook diagnostyczny: klatki wystawione na ekran
          istnieją tylko na elemencie `<video>`, nie w `getStats()`. Sam
          `peerId` nie wystarcza — ta sama osoba może nadawać ekran i kamerę
          naraz, a to dwa osobne elementy i dwa osobne strumienie.
        */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className="tile__video"
          data-peer-id={peerId}
          data-stream-kind={kind}
        />
      </div>

      <div className="tile__bar">
        <span className="tile__name" title={name}>
          {name}
          {isMe && <span className="tile__you"> (Ty)</span>}
        </span>

        {audioApplies && hasAudio && (
          <div className="tile__audio">
            <button
              type="button"
              className="tile__btn"
              onClick={() => setMuted((m) => !m)}
              title={muted ? 'Włącz dźwięk' : 'Wycisz'}
            >
              {muted ? '🔇' : '🔊'}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              onChange={(e) => {
                setVolume(Number(e.target.value))
                if (muted) setMuted(false)
              }}
              className="tile__volume"
              title="Głośność"
              aria-label={`Głośność: ${name}`}
            />
          </div>
        )}

        {audioApplies && !hasAudio && <span className="tile__silent">bez dźwięku</span>}

        <button
          type="button"
          className="tile__btn"
          onClick={onToggleZoom}
          title={zoomed ? 'Wróć do siatki' : 'Powiększ'}
        >
          {zoomed ? '⤡' : '⤢'}
        </button>
      </div>
    </div>
  )
}
