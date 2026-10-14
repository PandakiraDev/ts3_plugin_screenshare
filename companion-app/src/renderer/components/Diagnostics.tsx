import { useCallback, useEffect, useState } from 'react'
import {
  SAMPLE_INTERVAL_MS,
  formatResourceBadge,
  ratesBetween,
  streamsFreshness,
  streamsIntervalMs,
  type DiagnosticsSample
} from '@shared/diagnostics'

function formatRate(value: number | null): string {
  return value === null ? '—' : value.toFixed(1)
}

/** Jak długo renderer milczy, w sekundach; wiek, który nie jest liczbą, nie ma zapisu. */
function formatSilence(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return 'nieznanego czasu'
  return `${Math.round(ageMs / 1000)} s`
}

interface StreamsSectionProps {
  shown: DiagnosticsSample
  previous: DiagnosticsSample | undefined
}

/**
 * Tabela strumieni w jednej z trzech postaci, zależnie od tego, czy liczbom
 * w tej próbce można wierzyć (`streamsFreshness`):
 *
 * - `fresh`: zwykła tabela z tempem klatek;
 * - `stale`: renderer się odezwał i zamilkł — wiersze zostają (ostatnio znane
 *   strumienie), ale liczby zastępują kreski, a nad tabelą stoi wyraźne
 *   ostrzeżenie. Nie zera: zero mówiłoby, że strumień stoi, a my nie wiemy;
 * - `never`: renderer nie odezwał się ani razu — tabeli nie ma wcale.
 */
function StreamsSection({ shown, previous }: StreamsSectionProps): JSX.Element {
  const freshness = streamsFreshness(shown.streamsAgeMs)

  if (freshness === 'never') {
    return (
      <p className="diag__notice">
        Renderer nie przysłał jeszcze żadnych statystyk strumieni. To normalne tuż po starcie
        aplikacji i bez pokoju; po dołączeniu do pokoju pojawią się tu wiersze.
      </p>
    )
  }

  const trusted = freshness === 'fresh'

  if (trusted && shown.streams.length === 0) {
    return (
      <p className="diag__notice">
        Renderer się odzywa, ale w tej chwili nie ma aktywnych strumieni.
      </p>
    )
  }

  // Odstęp liczymy od chwili zebrania statystyk, nie od tyknięcia rejestratora
  // (patrz `streamsIntervalMs`). `null` znaczy, że poprzednia próbka nie ma
  // jeszcze danych o strumieniach, więc nie ma z czym porównać.
  const interval = previous ? streamsIntervalMs(previous, shown) : null

  return (
    <>
      {!trusted && (
        <p className="diag__notice diag__notice--stale" role="status">
          Renderer milczy od {formatSilence(shown.streamsAgeMs)} — dane o strumieniach są
          przestarzałe.{' '}
          {shown.streams.length > 0
            ? 'Poniżej ostatnio znane strumienie; liczby zastąpiono kreskami, bo zera skłamałyby, że obraz stoi.'
            : 'Ostatnio znana lista strumieni była pusta.'}
        </p>
      )}

      {shown.streams.length > 0 && (
        <table className="diag__table">
          <thead>
            <tr>
              <th>osoba</th>
              <th>rodzaj</th>
              <th>kierunek</th>
              <th>odebrane</th>
              <th>zdekodowane</th>
              <th>wystawione</th>
              <th>porzucone</th>
              <th>kb/s</th>
              <th>ograniczenie</th>
            </tr>
          </thead>
          <tbody>
            {shown.streams.map((stream) => {
              const before = previous?.streams.find(
                (candidate) =>
                  candidate.peerId === stream.peerId &&
                  candidate.kind === stream.kind &&
                  candidate.direction === stream.direction
              )
              // Przy przestarzałych danych nie liczymy tempa wcale: kreski, nie zera.
              const rates =
                trusted && interval !== null ? ratesBetween(before, stream, interval) : null
              const dropped = rates?.droppedPerS ?? null
              return (
                <tr
                  key={`${stream.direction}:${stream.peerId}:${stream.kind}`}
                  className={trusted ? '' : 'diag__row--stale'}
                >
                  <td>{stream.peerId.slice(0, 8)}</td>
                  <td>{stream.kind === 'screen' ? 'ekran' : 'kamera'}</td>
                  <td>{stream.direction === 'inbound' ? 'odbiór' : 'nadawanie'}</td>
                  <td>{formatRate(rates?.receivedPerS ?? null)}</td>
                  <td>{formatRate(rates?.decodedPerS ?? null)}</td>
                  <td>{formatRate(rates?.presentedPerS ?? null)}</td>
                  <td className={dropped !== null && dropped > 0 ? 'diag__dropped' : ''}>
                    {formatRate(dropped)}
                  </td>
                  <td>{formatRate(rates?.kilobitsPerS ?? null)}</td>
                  <td>{trusted ? (stream.qualityLimitationReason ?? '—') : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </>
  )
}

/**
 * Pasek zużycia i panel diagnostyczny. Wisi w `main.tsx` jako rodzeństwo
 * `<App />`, a nie w jego środku: `App` ma własne wczesne wyjścia
 * („Uruchamianie…", błąd argumentów) i wskaźniki znikałyby w nich. Dane bierze
 * z procesu głównego, więc nie potrzebuje sesji WebRTC.
 *
 * Kanały IPC diagnostyki woła WYŁĄCZNIE po odczytaniu flagi: bez
 * `--diagnostics` proces główny nie rejestruje ich obsługi, więc każde
 * wywołanie kończyłoby się odrzuconą obietnicą („No handler registered").
 */
export function Diagnostics(): JSX.Element | null {
  const [enabled, setEnabled] = useState(false)
  const [latest, setLatest] = useState<DiagnosticsSample | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [history, setHistory] = useState<DiagnosticsSample[]>([])
  const [cursor, setCursor] = useState(0)

  useEffect(() => {
    let cancelled = false
    void window.companion.getLaunch().then((launch) => {
      if (!cancelled && launch.ok) setEnabled(launch.options.diagnostics)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Pasek w rogu potrzebuje jednej najnowszej próbki, nie całego bufora.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const tick = (): void => {
      void window.companion.getLatestDiagnostics().then((sample) => {
        if (!cancelled) setLatest(sample)
      })
    }
    tick()
    const timer = setInterval(tick, SAMPLE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [enabled])

  const openPanel = useCallback(() => {
    void window.companion.readDiagnostics().then((samples) => {
      setHistory(samples)
      // Suwak staje na końcu: najpierw pokazujemy teraźniejszość, a przewijanie
      // w tył jest czynnością świadomą.
      setCursor(Math.max(0, samples.length - 1))
      setPanelOpen(true)
    })
  }, [])

  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== 'd') return
      event.preventDefault()
      if (panelOpen) setPanelOpen(false)
      else openPanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, panelOpen, openPanel])

  if (!enabled) return null

  const shown = history[cursor] ?? null
  const previous = cursor > 0 ? history[cursor - 1] : undefined

  return (
    <>
      {/* Pasek dotyczy zużycia systemu, które mierzy proces główny, więc nie
          zależy od świeżości danych o strumieniach. */}
      {latest && <div className="resource-badge">{formatResourceBadge(latest.system)}</div>}

      {panelOpen && (
        <div className="diag" role="dialog" aria-label="Panel diagnostyczny">
          <header className="diag__header">
            <strong>Diagnostyka</strong>
            <span className="diag__hint">Ctrl+Shift+D zamyka</span>
          </header>

          {shown === null ? (
            <p className="diag__empty">Bufor jest pusty — zapis dopiero się rozkręca.</p>
          ) : (
            <>
              <div className="diag__time">
                <input
                  type="range"
                  min={0}
                  max={history.length - 1}
                  value={cursor}
                  onChange={(event) => setCursor(Number(event.target.value))}
                  aria-label="Chwila w czasie"
                />
                <span className="diag__stamp">
                  {new Date(shown.at).toLocaleTimeString('pl-PL')}
                  {' · '}
                  {cursor + 1}/{history.length}
                </span>
              </div>

              <p className="diag__system">{formatResourceBadge(shown.system)}</p>

              <StreamsSection shown={shown} previous={previous} />
            </>
          )}
        </div>
      )}
    </>
  )
}
