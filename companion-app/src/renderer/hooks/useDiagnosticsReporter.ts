import { useEffect } from 'react'
import { SAMPLE_INTERVAL_MS, emptyStreamStats, type StreamStats } from '@shared/diagnostics'
import type { Lobby } from './useLobby'

/**
 * Co sekundę odczytuje `getStats()` ze wszystkich połączeń i wysyła wynik do
 * procesu głównego, który jest właścicielem zapisu.
 *
 * Hook siedzi w rendererze, bo tylko tutaj istnieje sesja WebRTC — ale NIE
 * prowadzi dziennika. Dziennik prowadzi proces główny, bo renderer jest tym,
 * co diagnozujemy: gdyby on zapisywał, przestawałby zapisywać dokładnie
 * w chwili, która nas interesuje.
 *
 * Przy `enabled === false` nie montuje zegara wcale. To nie tylko oszczędność:
 * proces główny bez flagi `--diagnostics` nie rejestruje obsługi IPC, więc
 * każde wywołanie `pushDiagnostics` kończyłoby się odrzuconą obietnicą.
 */
export function useDiagnosticsReporter(lobby: Lobby, enabled: boolean): void {
  // Bierzemy samą funkcję, a nie cały obiekt `lobby`: ten jest nowy przy
  // każdym renderze, więc jako zależność restartowałby zegar przy każdym
  // przerysowaniu. Funkcja ma stabilną referencję (useCallback w useLobby).
  const { diagnosticConnections } = lobby

  useEffect(() => {
    if (!enabled) return

    // Efekty montują się w StrictMode dwa razy, a odczyt trwa dłużej niż tick,
    // więc każde zamontowanie ma WŁASNE flagi: odczyt zaczęty przez pierwsze
    // zamontowanie po jego sprzątnięciu niczego już nie wyśle.
    let cancelled = false
    let running = false

    const collect = async (): Promise<void> => {
      // Zagłodzony renderer to dokładnie to, czego tu szukamy; odczyty, które
      // się na siebie nakładają, tylko by go dobijały i potem wysłały serię
      // próbek naraz.
      if (running) return
      running = true
      try {
        const streams: StreamStats[] = []
        for (const { peerId, kind, direction, connection } of diagnosticConnections()) {
          let report: RTCStatsReport
          try {
            report = await connection.getStats()
          } catch {
            // Połączenie mogło się zamknąć między pobraniem listy a odczytem.
            continue
          }
          // Wszystkie liczniki startują jako `null`, bo przed odczytaniem wpisu
          // RTP nie wiemy NIC — a zero znaczyłoby „strumień stoi". Wpisu RTP
          // może nie być wcale: uzgadnianie ICE w toku albo połączenie zamknięte
          // między pobraniem listy a odczytem statystyk.
          const entry: StreamStats = emptyStreamStats(peerId, kind, direction)
          report.forEach((stat) => {
            if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
              entry.framesReceived = stat.framesReceived ?? null
              entry.framesDecoded = stat.framesDecoded ?? null
              entry.bytes = stat.bytesReceived ?? null
            }
            if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
              entry.framesEncoded = stat.framesEncoded ?? null
              entry.framesSent = stat.framesSent ?? null
              entry.bytes = stat.bytesSent ?? null
              entry.qualityLimitationReason =
                stat.qualityLimitationReason && stat.qualityLimitationReason !== 'none'
                  ? stat.qualityLimitationReason
                  : null
            }
          })
          streams.push(entry)
        }

        /*
         * Klatek WYSTAWIONYCH na ekran nie ma w getStats() — to własność
         * elementu <video>, a nie połączenia. Czytamy je z DOM-u i dopisujemy
         * do strumieni przychodzących. Bez nich nie da się odróżnić „karta nie
         * nadąża" od „strumień nie dochodzi", czyli najważniejszego
         * rozróżnienia w całej tej diagnostyce.
         *
         * Dopasowanie po peerId ORAZ rodzaju: ta sama osoba może nadawać ekran
         * i kamerę naraz, a to dwa elementy <video> i dwa strumienie. Samo
         * peerId wpisałoby klatki kamery do wpisu ekranu.
         */
        for (const video of document.querySelectorAll<HTMLVideoElement>('video.tile__video')) {
          const { peerId, streamKind } = video.dataset
          if (!peerId || !streamKind || typeof video.getVideoPlaybackQuality !== 'function') {
            continue
          }
          const target = streams.find(
            (stream) =>
              stream.peerId === peerId &&
              stream.kind === streamKind &&
              stream.direction === 'inbound'
          )
          if (!target) continue
          const quality = video.getVideoPlaybackQuality()
          target.framesPresented = quality.totalVideoFrames
          target.framesDropped = quality.droppedVideoFrames
        }

        if (!cancelled) await window.companion.pushDiagnostics(streams)
      } catch (err: unknown) {
        // Diagnostyka jest dodatkiem: jej awaria nie może wywrócić interfejsu
        // ani wywołać co sekundę nieobsłużonego odrzucenia obietnicy.
        console.debug('[diagnostyka] nieudany odczyt statystyk:', err)
      } finally {
        running = false
      }
    }

    void collect()
    const timer = setInterval(() => void collect(), SAMPLE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [diagnosticConnections, enabled])
}
