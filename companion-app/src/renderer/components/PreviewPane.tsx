import { useEffect, useRef, useState } from 'react'
import type { CaptureSource } from '@shared/types'

interface PreviewPaneProps {
  source: CaptureSource | null
  stream: MediaStream | null
  error: string | null
  isStarting: boolean
  onStop: () => void
}

/** To, co realnie negocjowała ścieżka wideo — nie to, o co prosiliśmy. */
interface ActualTrackSettings {
  width: number
  height: number
  frameRate: number
}

function readTrackSettings(stream: MediaStream | null): ActualTrackSettings | null {
  const track = stream?.getVideoTracks()[0]
  if (!track) return null
  const { width, height, frameRate } = track.getSettings()
  if (!width || !height) return null
  return { width, height, frameRate: Math.round(frameRate ?? 0) }
}

export function PreviewPane({
  source,
  stream,
  error,
  isStarting,
  onStop
}: PreviewPaneProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [settings, setSettings] = useState<ActualTrackSettings | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    return () => {
      video.srcObject = null
    }
  }, [stream])

  // Wymiary są dostępne dopiero gdy poleci pierwsza klatka, stąd odczyt
  // na 'loadedmetadata', a nie od razu po dostaniu streamu.
  useEffect(() => {
    if (!stream) {
      setSettings(null)
      return
    }
    const update = (): void => setSettings(readTrackSettings(stream))
    update()
    const video = videoRef.current
    video?.addEventListener('loadedmetadata', update)
    return () => video?.removeEventListener('loadedmetadata', update)
  }, [stream])

  if (!source) {
    return (
      <div className="preview preview--empty">
        <p className="preview__placeholder">
          Kliknij ekran albo okno powyżej, żeby zobaczyć podgląd.
        </p>
      </div>
    )
  }

  return (
    <div className="preview">
      <header className="preview__header">
        <div className="preview__title">
          <span className="preview__dot" aria-hidden="true" />
          <span className="preview__name">{source.name}</span>
        </div>
        <div className="preview__meta">
          {settings && (
            <span className="badge">
              {settings.width}×{settings.height}
              {settings.frameRate > 0 && ` · ${settings.frameRate} FPS`}
            </span>
          )}
          <button type="button" className="btn btn--danger" onClick={onStop}>
            Zatrzymaj podgląd
          </button>
        </div>
      </header>

      <div className="preview__stage">
        {error ? (
          <div className="notice notice--error">
            <strong>Nie udało się uruchomić capture.</strong>
            <span>{error}</span>
          </div>
        ) : (
          <>
            <video ref={videoRef} autoPlay muted playsInline className="preview__video" />
            {isStarting && <div className="preview__spinner">Uruchamianie capture…</div>}
          </>
        )}
      </div>
    </div>
  )
}
