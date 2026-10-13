import { app } from 'electron'
import { execFile } from 'node:child_process'
import { readGpu, type GpuReading, type SystemStats } from '@shared/diagnostics'

/*
 * Odczyt GPU trzymamy osobno od zegara próbek. `nvidia-smi` to uruchomienie
 * procesu i mierzy ~47 ms (średnia z dziesięciu, min 43, max 54), czyli 4,7%
 * sekundy. Czekanie na niego w tyknięciu zablokowałoby proces główny i dałoby
 * zacinanie interfejsu — dokładnie to, czego w tej aplikacji szukamy.
 *
 * Zamiast tego odpytujemy w tle, a tyknięcie bierze ostatni znany odczyt
 * razem z JEGO znacznikiem czasu.
 */
let lastGpu: GpuReading | null = null

/*
 * Najwyżej jedno wywołanie `nvidia-smi` naraz. Gdy poprzednie jeszcze nie
 * wróciło, tyknięcie jest pomijane, a nie uruchamiane drugi raz: przy wolnym
 * sterowniku dokładanie procesów zmieniałoby to, co mierzymy. Znacznik zdejmujemy
 * zawsze, także po błędzie, bo inaczej jedna awaria zablokowałaby odpytywanie
 * na stałe.
 */
let gpuPollInFlight = false

/*
 * Numer wywołania zamiast znacznika `at`: wynik starszego wywołania nie może
 * nadpisać nowszego. Przy blokadzie wyżej wywołania nie nakładają się, więc to
 * zwykle nie ma znaczenia, zostaje jako zabezpieczenie na wypadek zdjęcia blokady.
 * Porównujemy numery, a nie czas, bo zegar systemowy może się cofnąć i wtedy
 * porównanie znaczników zamroziłoby odczyt na czas cofnięcia. Odczyt `null`
 * też zapisujemy, jeśli jest nowszy: brak informacji zastępuje starą informację.
 */
let gpuRequestSeq = 0
let gpuStoredSeq = 0

const NVIDIA_SMI_ARGS = [
  '--query-gpu=utilization.gpu,memory.used,memory.total',
  '--format=csv,noheader,nounits'
]

function runNvidiaSmi(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('nvidia-smi', NVIDIA_SMI_ARGS, { timeout: 3_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/** Zwraca funkcję zatrzymującą odpytywanie. */
export function startGpuPolling(intervalMs: number): () => void {
  const tick = (): void => {
    if (gpuPollInFlight) return
    gpuPollInFlight = true
    const seq = ++gpuRequestSeq
    void readGpu(runNvidiaSmi, Date.now())
      .then((reading) => {
        if (seq > gpuStoredSeq) {
          gpuStoredSeq = seq
          lastGpu = reading
        }
      })
      .finally(() => {
        gpuPollInFlight = false
      })
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  return () => clearInterval(timer)
}

export function latestGpu(): GpuReading | null {
  return lastGpu
}

/**
 * Zużycie procesora i pamięci całej aplikacji — suma po wszystkich procesach
 * Electrona. Rozbicie na procesy świadomie pomijamy: suma odpowiada na pytanie
 * „czy aplikacja zjada maszynę", a to jest pytanie, które zadajemy.
 *
 * `getAppMetrics()` jest synchroniczne i tanie, więc wywołujemy je w tyknięciu.
 */
export function readSystemStats(): SystemStats {
  let cpuPercent = 0
  let memoryKb = 0
  for (const entry of app.getAppMetrics()) {
    cpuPercent += entry.cpu?.percentCPUUsage ?? 0
    memoryKb += entry.memory?.workingSetSize ?? 0
  }
  return { cpuPercent, memoryMb: memoryKb / 1024, gpu: latestGpu() }
}
