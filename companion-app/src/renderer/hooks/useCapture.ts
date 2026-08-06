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
  /**
   * Dźwięk systemowy (loopback). Electron przyjmuje go tym samym nieoficjalnym
   * polem `mandatory` co obraz, ale BEZ `chromeMediaSourceId` — identyfikator
   * źródła dotyczy tylko wideo, a audio jest zawsze miksem całego systemu.
   */
  audio: false | { mandatory: { chromeMediaSource: 'desktop' } }
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
    audio: quality.shareAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
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
  /** Ustawiane, gdy poproszono o dźwięk, ale udało się wziąć tylko obraz. */
  audioWarning: string | null
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
  const [audioWarning, setAudioWarning] = useState<string | null>(null)

  // Trzymamy aktywny stream też w refie: cleanup efektu musi go zatrzymać
  // niezależnie od tego, czy setState zdążył się przepropagować.
  const activeStream = useRef<MediaStream | null>(null)

  const sourceId = source?.id ?? null
  const { resolution, fps, shareAudio } = quality

  useEffect(() => {
    const stopActive = (): void => {
      activeStream.current?.getTracks().forEach((track) => track.stop())
      activeStream.current = null
    }

    stopActive()
    setStream(null)
    setError(null)
    setAudioWarning(null)

    if (!sourceId) {
      setIsStarting(false)
      return
    }

    // Efekt mógł zostać wyczyszczony zanim getUserMedia się rozwiązał
    // (szybkie klikanie po źródłach, StrictMode w dev) — wtedy porzucamy wynik.
    let cancelled = false
    setIsStarting(true)

    /**
     * Dźwięk systemowy potrafi się nie udać (`NotReadableError: Could not start
     * audio source`) — zależnie od wersji Windows i sterowników. Wtedy NIE
     * przerywamy udostępniania: bierzemy sam obraz i mówimy o tym wprost.
     * Bez tego zaznaczenie "udostępnij dźwięk" blokowało całą transmisję.
     */
    const pobierz = async (): Promise<MediaStream> => {
      // Bitrate nie dotyczy capture — trafia dopiero do RTCRtpSender.
      const zAudio = buildConstraints(sourceId, {
        resolution,
        fps,
        shareAudio,
        bitrateKbps: 0
      }) as unknown as MediaStreamConstraints

      try {
        return await navigator.mediaDevices.getUserMedia(zAudio)
      } catch (err: unknown) {
        if (!shareAudio) throw err
        const bezAudio = buildConstraints(sourceId, {
          resolution,
          fps,
          shareAudio: false,
          bitrateKbps: 0
        }) as unknown as MediaStreamConstraints
        const stream = await navigator.mediaDevices.getUserMedia(bezAudio)
        if (!cancelled) {
          setAudioWarning(
            'Nie udało się przechwycić dźwięku systemowego — udostępniany jest ' +
              'sam obraz. Windows nie zawsze na to pozwala.'
          )
        }
        return stream
      }
    }

    pobierz()
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
    // shareAudio w zaleznosciach: wlaczenie dzwieku wymaga nowego getUserMedia,
    // bo sciezki audio nie da sie dolozyc do istniejacego strumienia.
  }, [sourceId, resolution, fps, shareAudio])

  return { stream, error, isStarting, audioWarning }
}
