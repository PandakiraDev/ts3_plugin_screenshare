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
  // Posortowany klucz zestawu nadawanych rodzajów: kolejność, w jakiej serwer
  // rozgłasza start/stop strumieni, nie powinna sama w sobie liczyć się jako
  // zmiana. Ale ZMIANA ZESTAWU (np. dołożenie kamery do trwającego udostępniania
  // ekranu) ma się liczyć — to nowy rozbieg sterowania przepływem, inny niż
  // rozbieg samego ekranu.
  const streamKindsKey = [...state.myStreamKinds].sort().join(',')

  useEffect(() => {
    let cancelled = false

    // Nowy zestaw nadawanych rodzajów = nowy rozbieg. Bez zerowania stary
    // `sharingSince` przetrwałby np. dołożenie kamery, a dawno ubiegły rozbieg
    // ekranu maskowałby świeży rozbieg kamery — pasek oskarżyłby łącze
    // w trakcie ramp-upu sterowania przepływem, dokładnie tego, co rozbieg ma
    // tłumić (patrz komentarz przy UPLINK_WARMUP_MS w connectionHealth.ts).
    // Świadomy koszt: włączenie ALBO wyłączenie kamery w trakcie sesji ucisza
    // ostrzeżenie o łączu na kolejne 45 s, nawet jeśli łącze faktycznie jest
    // zatkane. Wybieramy chwilową ciszę zamiast fałszywego oskarżenia —
    // komunikat, który raz skłamie, przestaje być czytany.
    watchRef.current = NO_UPLINK_WATCH

    async function sample(): Promise<void> {
      const limited = sharing ? await uplinkLimited() : false
      if (cancelled) return
      const now = Date.now()
      watchRef.current = advanceUplinkWatch(watchRef.current, { sharing, limited, now })
      setUplinkSlow(isUplinkSlow(watchRef.current, now))
    }

    // getStats() na sesji niszczonej w trakcie próbkowania (np. ponowne
    // łączenie po zapisaniu nowego klucza API) potrafi odrzucić obietnicę.
    // Flaga `cancelled` tu nie pomaga — odrzucenie omija sprawdzenie wewnątrz
    // sample() i leciałoby dalej jako nieobsłużone odrzucenie w konsoli.
    void sample().catch(() => {})
    const id = setInterval(() => void sample().catch(() => {}), UPLINK_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [streamKindsKey, sharing, uplinkLimited])

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
