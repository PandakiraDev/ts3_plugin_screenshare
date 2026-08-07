import { useEffect, useRef, useState } from 'react'
import type { StreamKind } from '@shared/types'

interface StreamTileProps {
  stream: MediaStream
  nazwa: string
  /** Rodzaj strumienia — kamera nie ma i nie będzie miała ścieżki audio. */
  kind: StreamKind
  /** Własny obraz nie ma sensu odtwarzać z dźwiękiem — słyszelibyśmy siebie. */
  toJa: boolean
  powiekszony: boolean
  onToggleZoom: () => void
}

/**
 * Jeden strumień w siatce. Głośność jest ustawiana per kafelek, bo widz może
 * chcieć słuchać jednej osoby, a drugą tylko oglądać.
 */
export function StreamTile({
  stream,
  nazwa,
  kind,
  toJa,
  powiekszony,
  onToggleZoom
}: StreamTileProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [glosnosc, setGlosnosc] = useState(1)
  const [wyciszony, setWyciszony] = useState(false)

  // Kamera nigdy nie niesie dźwięku, więc ani suwak, ani napis "bez dźwięku"
  // nie mają tu czego opisywać — to byłby stały, nieusuwalny komunikat.
  const dotyczyDzwieku = kind === 'screen' && !toJa
  const maDzwiek = stream.getAudioTracks().length > 0

  useEffect(() => {
    const video = videoRef.current
    if (video) video.srcObject = stream
  }, [stream])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    // Własny obraz zawsze wyciszony: inaczej słyszelibyśmy echo swojego systemu.
    video.muted = toJa || wyciszony
    video.volume = glosnosc
  }, [toJa, wyciszony, glosnosc])

  return (
    <div className={`tile${powiekszony ? ' tile--zoom' : ''}`}>
      {/*
        Powiększenie kliknięciem w sam obraz. Osobny element zamiast handlera na
        całym kafelku, bo pasek na dole ma własne kontrolki — suwak głośności
        przeciągany myszą kończyłby się przypadkowym powiększeniem.
      */}
      <div
        className="tile__ekran"
        onClick={onToggleZoom}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onToggleZoom()
        }}
        role="button"
        tabIndex={0}
        aria-label={powiekszony ? `Wróć do siatki: ${nazwa}` : `Powiększ: ${nazwa}`}
      >
        <video ref={videoRef} autoPlay playsInline className="tile__video" />
      </div>

      <div className="tile__bar">
        <span className="tile__name" title={nazwa}>
          {nazwa}
          {toJa && <span className="peers__you"> (Ty)</span>}
        </span>

        {dotyczyDzwieku && maDzwiek && (
          <div className="tile__audio">
            <button
              type="button"
              className="tile__btn"
              onClick={() => setWyciszony((w) => !w)}
              title={wyciszony ? 'Włącz dźwięk' : 'Wycisz'}
            >
              {wyciszony ? '🔇' : '🔊'}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={glosnosc}
              onChange={(e) => {
                setGlosnosc(Number(e.target.value))
                if (wyciszony) setWyciszony(false)
              }}
              className="tile__volume"
              title="Głośność"
              aria-label={`Głośność: ${nazwa}`}
            />
          </div>
        )}

        {dotyczyDzwieku && !maDzwiek && <span className="tile__cichy">bez dźwięku</span>}

        <button
          type="button"
          className="tile__btn"
          onClick={onToggleZoom}
          title={powiekszony ? 'Wróć do siatki' : 'Powiększ'}
        >
          {powiekszony ? '⤡' : '⤢'}
        </button>
      </div>
    </div>
  )
}
