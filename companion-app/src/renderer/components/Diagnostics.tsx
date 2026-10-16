import { useCallback, useEffect, useState } from 'react'
import {
  SAMPLE_INTERVAL_MS,
  advancePanelTimeline,
  columnAppliesTo,
  formatLimitation,
  formatResourceBadge,
  formatSilence,
  formatSystemLine,
  ratesBetween,
  streamsFreshness,
  streamsIntervalMs,
  type DiagnosticsSample,
  type PanelTimeline,
  type StreamColumn,
  type StreamDirection
} from '@shared/diagnostics'
import { formatGpuCard, type GpuCard } from '@shared/gpuInfo'

function formatRate(value: number | null): string {
  return value === null ? '—' : value.toFixed(1)
}

interface StreamCellProps {
  column: StreamColumn
  direction: StreamDirection
  className?: string
  children: string
}

/**
 * Komórka tabeli, która rozdziela dwa zupełnie różne braki liczby.
 *
 * `·` znaczy „ta kolumna nie dotyczy tego kierunku": pola nie ma
 * strukturalnie i nie będzie go nigdy (reguła w `columnAppliesTo`). Kreska
 * `—` z `formatRate` znaczy „pole dotyczy, ale nie ręczę za liczbę":
 * przestarzałe dane, brak poprzedniej próbki, cofnięty licznik.
 *
 * Dawniej oba stany dawały kreskę, więc wiersz nadawania pokazywał cztery
 * kreski z sześciu kolumn liczbowych i czytał się jako martwy przyrząd, a nie
 * jako wiersz opisany z drugiej strony łańcucha.
 */
function StreamCell({ column, direction, className, children }: StreamCellProps): JSX.Element {
  if (!columnAppliesTo(column, direction)) {
    return (
      <td className="diag__na" title="Ta kolumna nie dotyczy tego kierunku">
        ·
      </td>
    )
  }
  return <td className={className}>{children}</td>
}

interface StreamsSectionProps {
  shown: DiagnosticsSample
  previous: DiagnosticsSample | undefined
}

/**
 * Tabela strumieni w jednej z trzech postaci, zależnie od tego, czy liczbom
 * w tej próbce można wierzyć (`streamsFreshness`):
 *
 * - `fresh`: zwykła tabela z tempem klatek; jeśli poprzednia próbka była
 *   przestarzała, z notką, że tempo jest średnią z okresu milczenia;
 * - `stale`: renderer się odezwał i zamilkł — wiersze zostają (ostatnio znane
 *   strumienie), ale liczby zastępują kreski, a nad tabelą stoi wyraźne
 *   ostrzeżenie. Nie zera: zero mówiłoby, że strumień stoi, a my nie wiemy;
 * - `never`: renderer nie odezwał się ani razu — tabeli nie ma wcale.
 *
 * Jedna tabela na oba kierunki, a nie dwie obok siebie: główne pytanie tego
 * panelu brzmi „czy nie wyrabia mój koder, czy cudzy dekoder", więc oba
 * kierunki muszą stać w jednej siatce, porównywalne wiersz w wiersz.
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

  // Odstęp liczymy od chwili odebrania statystyk przez proces główny, nie od
  // tyknięcia rejestratora (patrz `streamsIntervalMs`). `null` znaczy, że nie
  // da się uczciwie policzyć tempa: nie ma z czym porównać (poprzednia próbka
  // bez danych o strumieniach), to ten sam push widziany po raz drugi albo to
  // dwa RÓŻNE pushe bliższe niż próg (zmienny czas `collect()` w rendererze).
  // W każdym z trzech przypadków kreski, nie zera. Trzeci jest rzadki i
  // jednorazowy, ale kreska obejmuje także jego.
  const interval = previous ? streamsIntervalMs(previous, shown) : null

  // Pierwsza świeża próbka po ciszy niesie tempo uśrednione z całego okresu
  // milczenia. Tej liczby NIE zastępujemy kreskami — mówi, czy obraz leciał,
  // gdy renderer stał — ale nie wolno jej mylić z wartością chwilową.
  const silenceSpanS =
    trusted && interval !== null && previous && streamsFreshness(previous.streamsAgeMs) === 'stale'
      ? Math.round(interval / 1000)
      : null

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

      {silenceSpanS !== null && (
        <p className="diag__notice">
          Poprzednia próbka miała przestarzałe dane, więc tempo w tej próbce jest średnią
          z okresu milczenia renderera (ok. {silenceSpanS} s), a nie wartością chwilową.
        </p>
      )}

      {shown.streams.length > 0 && (
        <table className="diag__table">
          <thead>
            <tr>
              <th>osoba</th>
              <th>rodzaj</th>
              <th>kierunek</th>
              {/* Kolejność kolumn idzie łańcuchem: najpierw cztery etapy
                  odbioru, potem dwa nadawania. Puste pola każdego wiersza
                  wychodzą wtedy jednym blokiem, a nie w szachownicę. */}
              <th>odebrane</th>
              <th>zdekodowane</th>
              <th>wystawione</th>
              <th>porzucone</th>
              <th>zakodowane</th>
              <th>wysłane</th>
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
              const direction = stream.direction
              return (
                <tr
                  key={`${stream.direction}:${stream.peerId}:${stream.kind}`}
                  className={trusted ? '' : 'diag__row--stale'}
                >
                  <td>{stream.peerId.slice(0, 8)}</td>
                  <td>{stream.kind === 'screen' ? 'ekran' : 'kamera'}</td>
                  <td>{direction === 'inbound' ? 'odbiór' : 'nadawanie'}</td>
                  <StreamCell column="receivedPerS" direction={direction}>
                    {formatRate(rates?.receivedPerS ?? null)}
                  </StreamCell>
                  <StreamCell column="decodedPerS" direction={direction}>
                    {formatRate(rates?.decodedPerS ?? null)}
                  </StreamCell>
                  <StreamCell column="presentedPerS" direction={direction}>
                    {formatRate(rates?.presentedPerS ?? null)}
                  </StreamCell>
                  <StreamCell
                    column="droppedPerS"
                    direction={direction}
                    className={dropped !== null && dropped > 0 ? 'diag__dropped' : undefined}
                  >
                    {formatRate(dropped)}
                  </StreamCell>
                  <StreamCell column="encodedPerS" direction={direction}>
                    {formatRate(rates?.encodedPerS ?? null)}
                  </StreamCell>
                  <StreamCell column="sentPerS" direction={direction}>
                    {formatRate(rates?.sentPerS ?? null)}
                  </StreamCell>
                  <StreamCell column="kilobitsPerS" direction={direction}>
                    {formatRate(rates?.kilobitsPerS ?? null)}
                  </StreamCell>
                  <StreamCell column="qualityLimitationReason" direction={direction}>
                    {trusted ? formatLimitation(stream.qualityLimitationReason) : '—'}
                  </StreamCell>
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
 * Bez żadnego włączania. Proces główny rejestruje obsługę kanałów podglądu
 * bezwarunkowo, więc nie ma już flagi do odczytania ani stanu, w którym
 * wywołanie kanału kończyłoby się odrzuconą obietnicą („No handler
 * registered"). Pole wyboru z ustawień dotyczy WYŁĄCZNIE zapisu plików
 * w procesie głównym i tego komponentu nie dotyczy: i pasek, i panel pod
 * `Ctrl+Shift+D` czytają bufor w pamięci, który istnieje niezależnie od
 * zapisu na dysk.
 */
export function Diagnostics(): JSX.Element {
  const [latest, setLatest] = useState<DiagnosticsSample | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [timeline, setTimeline] = useState<PanelTimeline>({ samples: [], cursor: 0 })
  /*
   * `undefined` znaczy „jeszcze nie zapytaliśmy", `null` — „zapytaliśmy
   * i karty nie rozpoznano". Bez tego rozróżnienia pasek pisałby „nie
   * rozpoznano" w pierwszej chwili każdej sesji, czyli mówiłby nieprawdę,
   * zanim zdąży się dowiedzieć.
   */
  const [card, setCard] = useState<GpuCard | null | undefined>(undefined)

  // Raz przy montowaniu, nie zegarem: karta nie zmienia się w trakcie sesji,
  // a proces główny wykrywa ją jednorazowo przy starcie.
  useEffect(() => {
    let cancelled = false
    void window.companion
      .getGpuCard()
      .then((detected) => {
        if (!cancelled) setCard(detected)
      })
      .catch((err: unknown) => {
        // Jedno wywołanie na sesję, więc konsoli nie zasypie — ale bez tej
        // gałęzi zostawiłoby nieobsłużone odrzucenie obietnicy.
        console.debug('[diagnostyka] nieudany odczyt karty graficznej:', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Pasek w rogu potrzebuje jednej najnowszej próbki, nie całego bufora. Ta
  // sama próbka trafia potem do historii panelu (efekt niżej), więc panel
  // nadąża bez drugiego, grubego kanału.
  useEffect(() => {
    let cancelled = false
    const tick = (): void => {
      void window.companion
        .getLatestDiagnostics()
        .then((sample) => {
          if (!cancelled) setLatest(sample)
        })
        .catch((err: unknown) => {
          // Bronimy się przed nieobsłużonym odrzuceniem obietnicy CO SEKUNDĘ.
          // Ten kanał jest rejestrowany bezwarunkowo, więc nie ma dziś powodu
          // odrzucać. Gdyby jednak kiedykolwiek przestał być rejestrowany, ten
          // zegar — jedyny chodzący z częstotliwością 1 Hz — zasypie konsolę
          // napisem „No handler registered" raz na sekundę i zagłuszy objaw,
          // którego w tej konsoli szukamy.
          console.debug('[diagnostyka] nieudany odczyt najnowszej próbki:', err)
        })
    }
    tick()
    const timer = setInterval(tick, SAMPLE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const openPanel = useCallback(() => {
    void window.companion
      .readDiagnostics()
      .then((samples) => {
        // Suwak staje na końcu: najpierw pokazujemy teraźniejszość, a przewijanie
        // w tył jest czynnością świadomą.
        setTimeline({ samples, cursor: Math.max(0, samples.length - 1) })
        setPanelOpen(true)
      })
      .catch((err: unknown) => {
        // Bronimy się przed skrótem, który wygląda na niedziałający: bez tego
        // odrzucenie tego jednego wywołania zostawia panel zamknięty bez
        // śladu w konsoli poza nieobsłużonym odrzuceniem obietnicy.
        console.debug('[diagnostyka] nieudany odczyt bufora próbek:', err)
      })
  }, [])

  // Panel nadąża za teraźniejszością, dopóki suwak stoi na końcu; po
  // przewinięciu w tył stoi na tej samej próbce (patrz `advancePanelTimeline`).
  // Dopisujemy próbkę, którą zegar paska i tak już pobrał — `readDiagnostics()`
  // co sekundę to 3,09 MB i 13,6 ms serializacji na każdy takt.
  //
  // Funkcja zwraca ten sam obiekt, gdy nie ma czego dopisać, więc React pomija
  // przerysowanie, a podwójne wykonanie efektu w `StrictMode` nie dokłada
  // duplikatu.
  useEffect(() => {
    if (!panelOpen || latest === null) return
    setTimeline((current) => advancePanelTimeline(current, latest))
  }, [panelOpen, latest])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== 'd') return
      event.preventDefault()
      // Przytrzymanie skrótu powtarza zdarzenie; bez tego panel migałby.
      if (event.repeat) return
      if (panelOpen) setPanelOpen(false)
      else openPanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panelOpen, openPanel])

  const { samples, cursor } = timeline
  const shown = samples[cursor] ?? null
  const previous = cursor > 0 ? samples[cursor - 1] : undefined

  return (
    <>
      {/* Pasek dotyczy zużycia systemu, które mierzy proces główny, więc nie
          zależy od świeżości danych o strumieniach. */}
      {latest && (
        <div className="resource-badge">
          <div>{formatResourceBadge(latest.system, latest.at)}</div>
          {/* Druga linia, a nie kolejny człon pierwszej: tekst o karcie jest
              długi i przez całą sesję ten sam, a linia wyżej zmienia się co
              sekundę. Stoi tu, bo samo „GPU —" nie mówi, czy zużycia tej karty
              nie umiemy zmierzyć, czy sterownik zamarł — punkt 2 z Review
              Focus. Rozróżnienie niesie TREŚĆ, nie wygląd: zamarły sterownik
              daje kreskę z godziną odczytu, a ta linia nazywa kartę i mówi
              wprost, czego o niej nie wiemy. */}
          {card !== undefined && (
            <div className="resource-badge__card">{formatGpuCard(card)}</div>
          )}
        </div>
      )}

      {panelOpen && (
        <div className="diag" role="dialog" aria-label="Panel diagnostyczny">
          <header className="diag__header">
            <strong>Diagnostyka</strong>
            {/* Legenda, bo kreska i kropka w tabeli znaczą zupełnie co innego,
                a różnicy nie da się odgadnąć z samego wyglądu. */}
            <span className="diag__legend">
              <span className="diag__legend-mark">—</span> nie wiem,{' '}
              <span className="diag__legend-mark">·</span> nie dotyczy tego kierunku
            </span>
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
                  max={samples.length - 1}
                  value={cursor}
                  onChange={(event) => {
                    // Wartość zdejmujemy ze zdarzenia PRZED wywołaniem
                    // ustawiacza: funkcja aktualizująca wykonuje się później
                    // (a w StrictMode dwa razy) i ma zależeć tylko od liczby.
                    const moved = Number(event.target.value)
                    setTimeline((current) => ({ ...current, cursor: moved }))
                  }}
                  aria-label="Chwila w czasie"
                />
                <span className="diag__stamp">
                  {new Date(shown.at).toLocaleTimeString('pl-PL')}
                  {' · '}
                  {cursor + 1}/{samples.length}
                </span>
              </div>

              {/* Linia panelu, nie pasek: tu godzina odczytu GPU jest widoczna
                  zawsze, bo rzadsze odpytywanie karty powtarza te same liczby
                  w pięciu kolejnych próbkach. */}
              <p className="diag__system">{formatSystemLine(shown.system, shown.at)}</p>

              <StreamsSection shown={shown} previous={previous} />
            </>
          )}
        </div>
      )}
    </>
  )
}
