import { useEffect, useRef, useState } from 'react'
import type { CaptureSource, QualitySettings } from '@shared/types'
import { RESOLUTION_DIMENSIONS } from '@shared/types'

/**
 * Górny limit dla presetu 'source'. Electron/Chromium potrzebuje jawnego maxWidth/
 * maxHeight — bez nich desktop capture zjeżdża do niskiej rozdzielczości domyślnej.
 * 8K jest ponad każdy realny monitor, więc efektywnie oznacza "nie skaluj".
 */
const NATIVE_MAX = { width: 7680, height: 4320 }

/**
 * Electron przyjmuje desktopowe źródło przez nieoficjalne pole `mandatory`,
 * którego nie ma w standardowym typie MediaTrackConstraints.
 */
interface DesktopCaptureConstraints {
  audio: false
  video: {
    mandatory: {
      chromeMediaSource: 'desktop'
      chromeMediaSourceId: string
      maxWidth: number
      maxHeight: number
      minFrameRate: number
      maxFrameRate: number
    }
  }
}

function buildConstraints(
  sourceId: string,
  quality: QualitySettings
): DesktopCaptureConstraints {
  const size = RESOLUTION_DIMENSIONS[quality.resolution] ?? NATIVE_MAX
  return {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: size.width,
        maxHeight: size.height,
        minFrameRate: quality.fps,
        maxFrameRate: quality.fps
      }
    }
  }
}

export interface CaptureState {
  stream: MediaStream | null
  error: string | null
  isStarting: boolean
}

/**
 * Trzyma lokalny MediaStream dla wybranego źródła. Zmiana źródła lub ustawień
 * jakości restartuje capture; poprzednie tracki są zawsze zatrzymywane.
 */
export function useCapture(
  source: CaptureSource | null,
  quality: QualitySettings
): CaptureState {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)

  // Trzymamy aktywny stream też w refie: cleanup efektu musi go zatrzymać
  // niezależnie od tego, czy setState zdążył się przepropagować.
  const activeStream = useRef<MediaStream | null>(null)

  const sourceId = source?.id ?? null
  const { resolution, fps } = quality

  useEffect(() => {
    const stopActive = (): void => {
      activeStream.current?.getTracks().forEach((track) => track.stop())
      activeStream.current = null
    }

    stopActive()
    setStream(null)
    setError(null)

    if (!sourceId) {
      setIsStarting(false)
      return
    }

    // Efekt mógł zostać wyczyszczony zanim getUserMedia się rozwiązał
    // (szybkie klikanie po źródłach, StrictMode w dev) — wtedy porzucamy wynik.
    let cancelled = false
    setIsStarting(true)

    navigator.mediaDevices
      .getUserMedia(
        // Bitrate nie dotyczy capture — trafia dopiero do RTCRtpSender,
        // więc tutaj jego wartość nie ma znaczenia.
        buildConstraints(sourceId, {
          resolution,
          fps,
          bitrateKbps: 0
        }) as unknown as MediaStreamConstraints
      )
      .then((mediaStream) => {
        if (cancelled) {
          mediaStream.getTracks().forEach((track) => track.stop())
          return
        }
        activeStream.current = mediaStream
        setStream(mediaStream)

        // Część źródeł (np. okna chronione przed Windows Graphics Capture)
        // rozwiązuje getUserMedia poprawnie, ale ścieżka gaśnie chwilę później.
        // Bez tego podgląd byłby po prostu czarny, bez żadnego komunikatu.
        // Ten sam sygnał złapie zamknięcie udostępnianego okna w trakcie streamu.
        const track = mediaStream.getVideoTracks()[0]
        if (!track) {
          setError('Źródło nie zwróciło ścieżki wideo.')
          return
        }
        track.addEventListener('ended', () => {
          if (cancelled) return
          setError(
            'Capture tego źródła został przerwany. Okno mogło zostać zamknięte ' +
              'albo jest chronione przed przechwytywaniem.'
          )
          setStream(null)
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setIsStarting(false)
      })

    return () => {
      cancelled = true
      stopActive()
    }
  }, [sourceId, resolution, fps])

  return { stream, error, isStarting }
}
