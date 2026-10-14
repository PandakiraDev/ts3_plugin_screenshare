import { useEffect, useRef, useState } from 'react'
import type { StreamKind } from '@shared/types'

interface StreamTileProps {
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
  onToggleZoom: () => void
}

/**
 * Jeden strumień w siatce. Głośność jest ustawiana per kafelek, bo widz może
 * chcieć słuchać jednej osoby, a drugą tylko oglądać.
 */
export function StreamTile({
  stream,
  peerId,
  name,
  kind,
  isMe,
  leaving,
  zoomed,
  onToggleZoom
}: StreamTileProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)

  // Kamera nigdy nie niesie dźwięku, więc ani suwak, ani napis "bez dźwięku"
  // nie mają tu czego opisywać — to byłby stały, nieusuwalny komunikat.
  const audioApplies = kind === 'screen' && !isMe
  const hasAudio = stream.getAudioTracks().length > 0

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
    <div className={`tile${zoomed ? ' tile--zoom' : ''}${leaving ? ' tile--leaving' : ''}`}>
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
