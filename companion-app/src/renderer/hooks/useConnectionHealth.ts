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
export function useConnectionHealth(lobby: Lobby): ConnectionProblem | null {
  const [problem, setProblem] = useState<ConnectionProblem | null>(null)
  const [uplinkSlow, setUplinkSlow] = useState(false)
  const watchRef = useRef<UplinkWatch>(NO_UPLINK_WATCH)

  const { state, uplinkLimited } = lobby
  const sharing = state.myStreamKinds.length > 0

  useEffect(() => {
    let cancelled = false

    async function sample(): Promise<void> {
      const limited = sharing ? await uplinkLimited() : false
      if (cancelled) return
      const now = Date.now()
      watchRef.current = advanceUplinkWatch(watchRef.current, { sharing, limited, now })
      setUplinkSlow(isUplinkSlow(watchRef.current, now))
    }

    void sample()
    const id = setInterval(() => void sample(), UPLINK_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [sharing, uplinkLimited])

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
          uplinkSlow
        })
      )
    }

    recompute()
    const id = setInterval(recompute, PROBLEM_TICK_MS)
    return () => clearInterval(id)
  }, [
    state.connection,
    state.connectingSince,
    state.unreachablePeerIds,
    state.peers,
    uplinkSlow
  ])

  return problem
}
