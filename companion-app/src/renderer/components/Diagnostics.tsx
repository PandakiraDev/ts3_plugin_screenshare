import { useCallback, useEffect, useRef, useState } from 'react'
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
import { formatLogEntry, type LogEntry } from '@shared/lobbyLog'

function formatRate(value: number | null): string {
  return value === null ? '—' : value.toFixed(1)
}

/**
 * Jak często otwarty dziennik dociąga pierścień z procesu głównego.
 *
 * Własna stała, a nie `SAMPLE_INTERVAL_MS`, choć obie mają dziś tę samą
 * wartość: tamta jest okresem PRÓBKOWANIA zużycia i zmieni się, gdy zmieni się
 * koszt próbki, a ta jest tylko odświeżaniem widoku listy. Sklejenie ich
 * znaczyłoby, że przestawienie jednej po cichu przestawia drugą.
 *
 * Sekunda, a nie szybciej: wpisy i tak powstają z przerysowań renderera, więc
 * częstsze pytanie nie pokazałoby nic nowego, a dokładałoby przejść granicy
 * procesów w aplikacji, w której diagnozujemy lag.
 */
const LOBBY_LOG_REFRESH_MS = 1_000

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

/** Ile pikseli od dołu listy liczy się jeszcze jako „czytający jest na końcu". */
const BOTTOM_STICK_EPSILON_PX = 24

/**
 * Czy odczyt przyniósł ten sam pierścień, co poprzedni.
 *
 * Bez tego porównania dziennik byłby dokładnie tym, czego specyfikacja
 * zabrania („sama diagnostyka nie może być przyczyną zacinania"): IPC oddaje
 * przy KAŻDYM odczycie nową tablicę, więc `setLogEntries` co sekundę
 * podmieniałby referencję, React przerysowywałby całą listę (do 2 000
 * wierszy), a efekt dociągania do końca co sekundę pisałby `scrollTop`, czyli
 * wymuszał przeliczenie układu — wszystko to w sesji, w której nic się nie
 * stało.
 *
 * Porównujemy DŁUGOŚĆ i OSTATNI wpis, a nie całą zawartość: wpisy wyłącznie
 * dochodzą na koniec i wypadają z początku (`appendLogEntry`), więc przy
 * równej długości i tym samym ostatnim wpisie pierścienie mogłyby się różnić
 * tylko wtedy, gdyby między dwoma odczytami doszło ich dokładnie tyle, ile ma
 * cały pierścień. Przy najgorszym realnym tempie (jeden wpis na tyknięcie
 * sesji) to 2 000 sekund pracy upchnięte w jedną — czyli nigdy, a karą za
 * pomyłkę jest i tak tylko widok starszy o sekundę.
 */
function isSameRing(before: readonly LogEntry[], after: readonly LogEntry[]): boolean {
  if (before.length !== after.length) return false
  const last = before.at(-1)
  const fresh = after.at(-1)
  // Oba `undefined` znaczy „oba puste", czyli ten sam pierścień.
  if (last === undefined || fresh === undefined) return last === fresh
  return last.at === fresh.at && last.level === fresh.level && last.text === fresh.text
}

interface LobbyLogListProps {
  entries: readonly LogEntry[]
}

/**
 * Lista wpisów dziennika: najstarszy na górze, najnowszy na dole.
 *
 * KOLEJNOŚĆ I PRZEWIJANIE. Najnowszy na dole, jak w każdym pliku dziennika —
 * a skoro tak, to otwarty panel musi stać na końcu listy, bo inaczej czytający
 * widzi wpisy z początku sesji i musi przewijać, żeby zobaczyć to, po co
 * otworzył panel. Do końca dociągamy jednak tylko wtedy, gdy czytający tam
 * JEST: przewinięcie w górę to czynność świadoma („co się stało pięć minut
 * temu"), a wyrywanie go z powrotem na dół przy każdym nowym wpisie
 * uniemożliwiłoby czytanie dokładnie w chwili, w której coś się dzieje.
 *
 * Osobny komponent, a nie kawałek `Diagnostics`: montuje się razem
 * z otwarciem panelu, więc „czytający jest na końcu" wraca do stanu
 * początkowego samo, bez kasowania ref-a ręcznie przy każdym otwarciu.
 *
 * TEKST BIERZEMY Z `formatLogEntry`, nie składamy własnego. To ta sama linia,
 * którą proces główny zapisuje do pliku (`src/main/lobbyLog.ts`), a te dwie
 * postacie muszą być identyczne: plik dziennika czyta się często komuś przez
 * telefon, mając okno przed sobą, i rozjazd formatu znaczyłby, że dwie osoby
 * patrzą na „to samo" zapisane inaczej.
 */
function LobbyLogList({ entries }: LobbyLogListProps): JSX.Element {
  const listRef = useRef<HTMLOListElement | null>(null)
  const pinnedToBottom = useRef(true)

  useEffect(() => {
    const list = listRef.current
    if (list === null || !pinnedToBottom.current) return
    list.scrollTop = list.scrollHeight
  }, [entries])

  return (
    <ol
      className="diag-log"
      ref={listRef}
      onScroll={(event) => {
        const list = event.currentTarget
        pinnedToBottom.current =
          list.scrollHeight - list.scrollTop - list.clientHeight < BOTTOM_STICK_EPSILON_PX
      }}
    >
      {entries.map((entry, index) => (
        /*
         * Klucz z indeksu, bo wpisy nie mają tożsamości: `at` powtarza się
         * (wejście i dwa strumienie tej samej osoby padają w tej samej
         * milisekundzie), a lista jest tylko tekstem do czytania — nie ma tu
         * stanu ani pola, które przy przesunięciu pierścienia mogłoby
         * wylądować w złym wierszu.
         */
        <li
          key={index}
          className={
            entry.level === 'error' ? 'diag-log__line diag-log__line--error' : 'diag-log__line'
          }
        >
          {formatLogEntry(entry)}
        </li>
      ))}
    </ol>
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
 * `Ctrl+Shift+D`, i dziennik lobby czytają bufory w pamięci, które istnieją
 * niezależnie od zapisu na dysk.
 *
 * Trzy rzeczy w jednym komponencie: pasek zużycia, panel tabeli strumieni pod
 * `Ctrl+Shift+D` i dziennik lobby pod guzikiem. Razem, bo wszystkie trzy
 * zajmują ten sam róg i tę samą warstwę nad oknem, a ich wzajemne położenie
 * (co stoi nad czym, co zamyka co) jest jedną decyzją — rozdzielone na trzy
 * komponenty, rozjechałoby się przy pierwszej zmianie któregokolwiek.
 */
export function Diagnostics(): JSX.Element {
  const [latest, setLatest] = useState<DiagnosticsSample | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [timeline, setTimeline] = useState<PanelTimeline>({ samples: [], cursor: 0 })
  const [logOpen, setLogOpen] = useState(false)
  /*
   * Wpisów NIE czyścimy przy zamknięciu panelu: przy ponownym otwarciu
   * mignąłby pusty dziennik, zanim odpowiedź z procesu głównego wróci.
   * Najgorszy przypadek to pełny pierścień, czyli ~317 KiB (rachunek przy
   * `LOG_RING_MAX_ENTRIES`) — obok bufora próbek, który ma ~3,3 MiB, to nie
   * jest koszt wart migania.
   */
  const [logEntries, setLogEntries] = useState<readonly LogEntry[]>([])
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
        // Ta sama warstwa i to samo miejsce co dziennik — patrz `toggleLog`.
        setLogOpen(false)
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

  /*
   * Dziennik dociągamy TYLKO przy otwartym panelu — zegar chodzący przy
   * zamkniętym dokładałby przejście granicy procesów co sekundę w aplikacji,
   * w której diagnozujemy lag, i to po dane, których nikt w tej chwili nie
   * patrzy. Odczyt przy otwarciu i odświeżanie to jedna sprawa, więc i jeden
   * efekt: `tick()` leci od razu, a potem z zegara.
   *
   * Pierścienia nie da się „zasubskrybować": właścicielem jest proces główny,
   * a wpychanie każdej zmiany do każdego okna znaczyłoby ruch na granicy
   * procesów także wtedy, gdy nikt dziennika nie otworzył. Pytanie raz na
   * sekundę przy otwartym panelu jest tańsze od tego i wystarcza, bo wpisy
   * powstają z przerysowań, a nie z osobnego strumienia zdarzeń.
   */
  useEffect(() => {
    if (!logOpen) return
    let cancelled = false
    const tick = (): void => {
      void window.companion
        .readLobbyLog()
        .then((entries) => {
          if (cancelled) return
          // Referencję podmieniamy tylko wtedy, gdy pierścień naprawdę się
          // zmienił — patrz `isSameRing`.
          setLogEntries((current) => (isSameRing(current, entries) ? current : entries))
        })
        .catch((err: unknown) => {
          // Jak przy pozostałych kanałach: bez tej gałęzi zostałoby
          // nieobsłużone odrzucenie obietnicy, i to raz na sekundę.
          console.debug('[dziennik] nieudany odczyt pierścienia:', err)
        })
    }
    tick()
    const timer = setInterval(tick, LOBBY_LOG_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [logOpen])

  /*
   * Oba panele zajmują to samo miejsce i tę samą warstwę, więc otwarcie
   * jednego zamyka drugi. Bez tego leżałyby jeden na drugim i wierzchni
   * (kolejność w DOM-ie, nie wybór człowieka) przykrywałby ten, który ktoś
   * właśnie otworzył.
   */
  const toggleLog = useCallback(() => {
    if (logOpen) {
      setLogOpen(false)
      return
    }
    setPanelOpen(false)
    setLogOpen(true)
  }, [logOpen])

  /*
   * `Escape` zamyka dziennik. Nasłuch tylko przy otwartym panelu — nie zostaje
   * przy zamkniętym, bo ten klawisz nie należy do tego komponentu i przyszłe
   * okno dialogowe ma prawo go dostać.
   *
   * Panel tabeli strumieni zamyka się swoim własnym skrótem i tak zostaje: on
   * nie ma guzika, więc skrót jest tam jedynym wejściem i jedynym wyjściem.
   */
  useEffect(() => {
    if (!logOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setLogOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [logOpen])

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

      {/* Guzik stoi NIŻEJ niż pasek zużycia, w samym rogu, i nie zależy od
          pierwszej próbki: pasek pojawia się dopiero, gdy proces główny coś
          zmierzy, a dziennik należy do każdego od pierwszej chwili. Dzięki temu
          guzik ani razu nie drgnie — pasek nad nim rośnie w górę, gdy dojdzie
          linia z nazwą karty. */}
      <button
        type="button"
        className="lobby-log-toggle"
        aria-expanded={logOpen}
        title="Co się działo w lobby: kto wszedł, kto wyszedł, co odbił serwer"
        onClick={toggleLog}
      >
        Dziennik
      </button>

      {logOpen && (
        /*
         * PANEL W TYM SAMYM OKNIE, NIE DRUGIE OKNO SYSTEMOWE. Drugi
         * `BrowserWindow` to drugi proces renderera, czyli własny koszt
         * procesora w aplikacji, w której diagnozujemy lag, plus drugie
         * wejście w `electron-vite`. Panel ma tu działający wzór (`.diag`).
         *
         * CENA TEJ DECYZJI jest realna i ma być zapisana, nie przemilczana:
         * dziennika nie da się czytać na drugim monitorze, patrząc
         * jednocześnie na strumienie — panel zasłania to, czego dotyczy. Jeśli
         * właściciel tego zażąda, zamiana na prawdziwe okno jest osobnym
         * zadaniem, a nie poprawką tutaj.
         */
        <div className="diag diag--log" role="dialog" aria-label="Dziennik lobby">
          <header className="diag__header">
            <strong>Dziennik lobby</strong>
            {/* Liczba wpisów bez odmiany („wpisów: 7"), bo polska liczba mnoga
                zależy od liczby i „7 wpisy" byłoby błędem w każdej innej. */}
            <span className="diag__legend">
              wpisów: {logEntries.length} · najnowszy na dole ·{' '}
              <span className="diag__legend-mark">[BŁĄD]</span> to awaria
            </span>
            <span className="diag__hint">Esc zamyka</span>
          </header>

          {logEntries.length === 0 ? (
            <p className="diag__empty">
              Dziennik jest pusty. Wpisy powstają ze zmian w lobby — ktoś wszedł, ktoś zaczął
              nadawać, połączenie zgłosiło błąd — więc przy uruchomieniu bez wtyczki (sam
              podgląd, bez pokoju) nie pojawi się tu nic.
            </p>
          ) : (
            <LobbyLogList entries={logEntries} />
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
