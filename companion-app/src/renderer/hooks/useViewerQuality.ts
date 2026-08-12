import { useEffect, useState } from 'react'
import {
  QUALITY_REPORT_INTERVAL_MS,
  qualityFromReport,
  type ViewerQuality
} from '@shared/viewerQuality'
import type { Lobby } from './useLobby'

/** Jak często przeliczamy wiek raportów, żeby „brak danych" pojawiał się płynnie. */
const AGE_TICK_MS = 1_000

/**
 * Dwa timery, bo mają różne zadania: wysyłka raportów jest odczytem z
 * `getStats()` i wystarcza co 5 s, a starzenie trzeba przeliczać częściej,
 * żeby przejście w „brak danych" nie następowało skokiem co pięć sekund.
 */
export function useViewerQuality(lobby: Lobby): Map<string, ViewerQuality> {
  const [quality, setQuality] = useState<Map<string, ViewerQuality>>(new Map())
  const { state, reportQualityToStreamers } = lobby

  useEffect(() => {
    function report(): void {
      // Sesja moze zostac zniszczona pod trwajacym odczytem (rekonekt po
      // zmianie klucza API) — `getStats()` na zamknietym polaczeniu rzuca.
      void reportQualityToStreamers().catch((err: unknown) =>
        console.debug('[jakosc] nieudana wysylka raportu:', err)
      )
    }

    report()
    const id = setInterval(report, QUALITY_REPORT_INTERVAL_MS)
    return () => clearInterval(id)
  }, [reportQualityToStreamers])

  useEffect(() => {
    function recompute(): void {
      const now = Date.now()
      const next = new Map<string, ViewerQuality>()
      for (const peerId of state.viewerPeerIds) {
        const entry = state.viewerQuality.get(peerId)
        next.set(
          peerId,
          qualityFromReport(entry?.report ?? null, entry ? now - entry.receivedAt : 0)
        )
      }
      setQuality(next)
    }

    recompute()
    const id = setInterval(recompute, AGE_TICK_MS)
    return () => clearInterval(id)
  }, [state.viewerPeerIds, state.viewerQuality])

  return quality
}
