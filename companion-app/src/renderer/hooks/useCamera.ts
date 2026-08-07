import { useEffect, useRef, useState } from 'react'
import type { CameraSettings } from '@shared/types'
import { cameraConstraints } from '@shared/types'

export interface CameraState {
  stream: MediaStream | null
  error: string | null
  devices: { deviceId: string; label: string }[]
}

/**
 * Trzy błędy getUserMedia, które zdarzają się realnie przy kamerze —
 * komunikat ma mówić, co się stało, nie tylko że "się nie udało".
 */
function describeError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotFoundError') return 'Nie znalazłem kamery.'
  if (name === 'NotReadableError') {
    return 'Kamera jest zajęta przez inną aplikację (np. Discord albo OBS).'
  }
  if (name === 'NotAllowedError') return 'Brak zgody na dostęp do kamery.'
  return err instanceof Error ? err.message : String(err)
}

/**
 * Kamery bez etykiety wypadają. Przed pierwszą zgodą przeglądarka zwraca
 * urządzenia z pustym `label` — w selektorze byłyby to nierozróżnialne, puste
 * pozycje, czyli gorzej niż nic. Pusta lista jest czytelna: panel ustawień
 * pokazuje wtedy „lista pojawi się po pierwszym włączeniu kamery".
 */
async function listDevices(): Promise<{ deviceId: string; label: string }[]> {
  const all = await navigator.mediaDevices.enumerateDevices()
  return all
    .filter((d) => d.kind === 'videoinput' && d.label !== '')
    .map((d) => ({ deviceId: d.deviceId, label: d.label }))
}

/**
 * Trzyma lokalny MediaStream z kamery. Analogicznie do useCapture: zmiana
 * ustawień restartuje capture, poprzednie ścieżki są zawsze zatrzymywane,
 * a `cancelled` chroni przed wyścigiem przy szybkim przełączaniu.
 */
export function useCamera(enabled: boolean, settings: CameraSettings): CameraState {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([])

  // Jak w useCapture: cleanup efektu musi zatrzymać stream niezależnie od
  // tego, czy setState zdążył się przepropagować.
  const activeStream = useRef<MediaStream | null>(null)

  const { deviceId, resolution, fps } = settings

  useEffect(() => {
    // Pytanie przy montowaniu zostaje: selektor kamery w ustawieniach musi dać
    // się wypełnić PRZED włączeniem kamery, a w trybie samodzielnym kamera nie
    // rusza w ogóle i to jedyne źródło listy. Zgoda na kamerę jest pamiętana
    // w profilu, więc po pierwszym uruchomieniu etykiety są tu od razu; przy
    // pierwszym w życiu starcie lista jest pusta i uzupełnia się po zgodzie.
    let cancelled = false
    listDevices()
      .then((list) => {
        if (!cancelled) setDevices(list)
      })
      .catch(() => {
        // Brak zgody przed pierwszym getUserMedia zwykle daje puste etykiety,
        // nie wyjątek — ale gdyby enumerateDevices padło, lista zostaje pusta.
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const stopActive = (): void => {
      activeStream.current?.getTracks().forEach((track) => track.stop())
      activeStream.current = null
    }

    stopActive()
    setStream(null)
    setError(null)

    if (!enabled) return

    // Efekt mógł zostać wyczyszczony zanim getUserMedia się rozwiązał
    // (szybkie przełączanie ustawień, StrictMode w dev) — wtedy porzucamy wynik.
    let cancelled = false

    navigator.mediaDevices
      .getUserMedia(cameraConstraints({ deviceId, resolution, fps }))
      .then(async (mediaStream) => {
        if (cancelled) {
          mediaStream.getTracks().forEach((track) => track.stop())
          return
        }
        activeStream.current = mediaStream
        setStream(mediaStream)

        // Przed pierwszą zgodą enumerateDevices zwraca puste etykiety —
        // dopiero po udanym starcie kamery przeglądarka je odsłania.
        try {
          const list = await listDevices()
          if (!cancelled) setDevices(list)
        } catch {
          // Odświeżenie listy jest dodatkiem — brak etykiet nie unieważnia streamu.
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(describeError(err))
      })

    return () => {
      cancelled = true
      stopActive()
    }
  }, [enabled, deviceId, resolution, fps])

  return { stream, error, devices }
}
