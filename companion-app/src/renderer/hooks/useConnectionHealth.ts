import { useEffect, useRef, useState } from 'react'
import {
  NO_UPLINK_WATCH,
  advanceUplinkWatch,
  isUplinkSlow,
  pickProblem,
  type ConnectionProblem,
  type UplinkWatch
} from '@shared/connectionHealth'
import type { Lobby } from './useLobby'

/** Jak często pytamy getStats. Rzadziej niż licznik — to droższy odczyt. */
const UPLINK_POLL_MS = 3_000
/** Jak często przeliczamy problem. Co sekundę, żeby licznik czekania szedł płynnie. */
const PROBLEM_TICK_MS = 1_000

/**
 * Dwa timery, bo mają różne zadania: próbkowanie łącza jest kosztowne i nie musi
 * być częste, a licznik „Czekam… (0:23)" musi tykać co sekundę. Jeden wspólny
 * interwał zmusiłby do wyboru: albo drogie odczyty co sekundę, albo licznik
 * skaczący co trzy.
 */
export function useConnectionHealth(
  lobby: Lobby,
  viewersStruggling: boolean
): ConnectionProblem | null {
  const [problem, setProblem] = useState<ConnectionProblem | null>(null)
  const [uplinkSlow, setUplinkSlow] = useState(false)
  const watchRef = useRef<UplinkWatch>(NO_UPLINK_WATCH)

  const { state, uplinkLimited } = lobby
  // Posortowany klucz zestawu nadawanych rodzajów: kolejność, w jakiej serwer
  // rozgłasza start/stop strumieni, nie powinna sama w sobie liczyć się jako
  // zmiana. Pusty string = nie nadajemy. ZMIANA ZESTAWU (np. dołożenie kamery
  // do trwającego udostępniania ekranu) ma się liczyć jako nowy rozbieg —
  // o tym decyduje już `advanceUplinkWatch` w connectionHealth.ts, więc hook
  // sam nic tu nie zeruje.
  const sharingKey = [...state.myStreamKinds].sort().join(',')

  useEffect(() => {
    let cancelled = false

    async function sample(): Promise<void> {
      const limited = sharingKey !== '' ? await uplinkLimited() : false
      if (cancelled) return
      const now = Date.now()
      watchRef.current = advanceUplinkWatch(watchRef.current, { sharingKey, limited, now })
      setUplinkSlow(isUplinkSlow(watchRef.current, now))
    }

    // getStats() na sesji niszczonej w trakcie próbkowania (np. ponowne
    // łączenie po zapisaniu nowego klucza API) potrafi odrzucić obietnicę.
    // Flaga `cancelled` tu nie pomaga — odrzucenie omija sprawdzenie wewnątrz
    // sample() i leciałoby dalej jako nieobsłużone odrzucenie w konsoli. Log
    // zamiast pustego catch: pusty catch zjadłby też literówkę albo wyjątek
    // z advanceUplinkWatch, nie tylko spodziewane odrzucenie getStats().
    function reportSampleFailure(err: unknown): void {
      console.debug('[diagnostyka] nieudane probkowanie lacza:', err)
    }

    void sample().catch(reportSampleFailure)
    const id = setInterval(() => void sample().catch(reportSampleFailure), UPLINK_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [sharingKey, uplinkLimited])

  useEffect(() => {
    function recompute(): void {
      const now = Date.now()
      // Osoba, której nie ma już na liście uczestników, po prostu wypada —
      // jej problem przestał istnieć razem z nią.
      const names = state.unreachablePeerIds
        .map((id) => state.peers.find((peer) => peer.peerId === id)?.displayName)
        .filter((name): name is string => Boolean(name))

      setProblem(
        pickProblem({
          connectingForMs:
            state.connection === 'connecting' && state.connectingSince !== null
              ? now - state.connectingSince
              : null,
          unreachableNames: names,
          uplinkSlow,
          viewersStruggling,
          signalingClosed: state.signalingClosed
        })
      )
    }

    recompute()
    const id = setInterval(recompute, PROBLEM_TICK_MS)
    return () => clearInterval(id)
    // `state.signalingClosed` MUSI tu być. W projekcie nie ma lintera, więc
    // `exhaustive-deps` nie jest niczym wymuszane: pominięte pole dałoby kod
    // kompletny i zielone testy, a pasek zapaliłby się dopiero przy następnej
    // niezależnej zmianie w lobby — czyli po zerwaniu gniazda najprawdopodobniej
    // nigdy, bo zerwane gniazdo przestaje przynosić zmiany. Zegar
    // `PROBLEM_TICK_MS` tego nie ratuje: `recompute` domyka starą wartość pola
    // z renderu, w którym efekt wystartował.
  }, [
    state.connection,
    state.connectingSince,
    state.unreachablePeerIds,
    state.peers,
    state.signalingClosed,
    uplinkSlow,
    viewersStruggling
  ])

  return problem
}
