import { useEffect, useRef, useState } from 'react'
import type { CaptureSource, QualitySettings } from '@shared/types'
import { RESOLUTION_DIMENSIONS } from '@shared/types'
import { windowHandleFromSourceId } from '@shared/audio'
import { createAppAudioTrack, waitForAudioPort } from '../audio/appAudioTrack'

/**
 * Górny limit dla presetu 'source'. Electron/Chromium potrzebuje jawnego maxWidth/
 * maxHeight — bez nich desktop capture zjeżdża do niskiej rozdzielczości domyślnej.
 * 8K jest ponad każdy realny monitor, więc efektywnie oznacza "nie skaluj".
 */
const NATIVE_MAX = { width: 7680, height: 4320 }

/**
 * Standardowe constrainty getDisplayMedia. Identyfikator źródła NIE idzie tędy —
 * podaje go main process w handlerze (patrz IPC_SET_CAPTURE_TARGET), bo
 * getDisplayMedia nie ma na niego miejsca w API.
 */
function buildConstraints(quality: QualitySettings): MediaStreamConstraints {
  const size = RESOLUTION_DIMENSIONS[quality.resolution] ?? NATIVE_MAX
  return {
    video: {
      width: { max: size.width },
      height: { max: size.height },
      frameRate: { ideal: quality.fps, max: quality.fps }
    },
    audio: quality.shareAudio
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

  // Dźwięk z jednej aplikacji żyje poza MediaStreamem — trzeba go zatrzymać
  // osobno, inaczej wątek natywny zostaje po zmianie źródła.
  const stopAppAudio = useRef<(() => void) | null>(null)

  const sourceId = source?.id ?? null
  const { resolution, fps, shareAudio } = quality

  useEffect(() => {
    const stopActive = (): void => {
      stopAppAudio.current?.()
      stopAppAudio.current = null
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
      const jakosc = { resolution, fps, shareAudio, bitrateKbps: 0 }

      /*
       * Okno udostępniamy z dźwiękiem TYLKO tej aplikacji. To cała różnica
       * względem `audio: 'loopback'`, przez które do streamu szedł miks całego
       * systemu — łącznie z TeamSpeakiem, więc rozmówca słyszał sam siebie.
       *
       * Ekran nie należy do żadnego procesu, więc dla niego zostaje stara
       * droga: miks systemowy albo nic.
       */
      if (shareAudio && windowHandleFromSourceId(sourceId) !== null) {
        await window.companion.setCaptureTarget({ sourceId, withAudio: false })
        const mediaStream = await navigator.mediaDevices.getDisplayMedia(
          buildConstraints({ ...jakosc, shareAudio: false })
        )
        try {
          // Nasłuch przed startAppAudio — port przychodzi w trakcie tamtego
          // wywołania.
          const oczekiwanie = waitForAudioPort()
          const format = await window.companion.startAppAudio(sourceId)
          const audio = createAppAudioTrack(await oczekiwanie, format)
          mediaStream.addTrack(audio.track)
          stopAppAudio.current = () => {
            audio.stop()
            void window.companion.stopAppAudio()
          }
        } catch (err: unknown) {
          // Sam obraz jest lepszy niż nic — tak samo jak przy dźwięku
          // systemowym. Powód pokazujemy wprost.
          void window.companion.stopAppAudio()
          if (!cancelled) {
            setAudioWarning(
              'Nie udało się przechwycić dźwięku tej aplikacji: ' +
                (err instanceof Error ? err.message : String(err))
            )
          }
        }
        return mediaStream
      }

      // Main process musi wiedziec, ktore zrodlo wybrano, ZANIM zawolamy
      // getDisplayMedia — handler odpala sie synchronicznie z tym wywolaniem.
      await window.companion.setCaptureTarget({ sourceId, withAudio: shareAudio })

      try {
        return await navigator.mediaDevices.getDisplayMedia(buildConstraints(jakosc))
      } catch (err: unknown) {
        if (!shareAudio) throw err
        // Dzwiek systemowy potrafi paść na kartach z nietypowymi sterownikami
        // (sprawdzone: Sound Blaster -> NotReadableError). Bierzemy sam obraz.
        await window.companion.setCaptureTarget({ sourceId, withAudio: false })
        const stream = await navigator.mediaDevices.getDisplayMedia(
          buildConstraints({ ...jakosc, shareAudio: false })
        )
        if (!cancelled) {
          setAudioWarning(
            'Nie udało się przechwycić dźwięku systemowego — udostępniany jest ' +
              'sam obraz. Nie wszystkie karty i sterowniki dźwiękowe na to pozwalają.'
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
