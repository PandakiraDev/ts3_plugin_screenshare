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
    void readGpu(runNvidiaSmi, Date.now()).then((reading) => {
      lastGpu = reading
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
