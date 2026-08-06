import { useEffect, useRef, useState } from 'react'

interface StreamTileProps {
  stream: MediaStream
  nazwa: string
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
  toJa,
  powiekszony,
  onToggleZoom
}: StreamTileProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [glosnosc, setGlosnosc] = useState(1)
  const [wyciszony, setWyciszony] = useState(false)

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
      <video ref={videoRef} autoPlay playsInline className="tile__video" />

      <div className="tile__bar">
        <span className="tile__name" title={nazwa}>
          {nazwa}
          {toJa && <span className="peers__you"> (Ty)</span>}
        </span>

        {maDzwiek && !toJa && (
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

        {!maDzwiek && !toJa && <span className="tile__cichy">bez dźwięku</span>}

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
