/**
 * Dziennik lobby — decyzje czyste, bez dysku i bez Electrona.
 *
 * Co to jest: zapis tego, co się działo w lobby — kto wszedł, kto wyszedł, co
 * zaczął nadawać, co odbił serwer. Odpowiada na pytania „dlaczego mi zacina"
 * i „dlaczego go nie widzę", więc musi być czytelny dla człowieka, który nie
 * zna kodu.
 *
 * Dlaczego tutaj, a nie w `src/shared/diagnostics.ts`: tamten plik ma już 783
 * linie i opisuje próbki zużycia, czyli inną rzecz. Dlaczego w `src/shared/*`,
 * a nie w `src/main/*`: vitest chodzi w gołym Node bez Electrona, więc tylko
 * czyste funkcje z tego katalogu da się w tym repozytorium w ogóle sprawdzić.
 *
 * Właściciel pierścienia i zapis na dysk mieszkają w `src/main/lobbyLog.ts`.
 */

/**
 * Poziom wpisu. Dwa, nie pięć: dziennik odpowiada na pytanie „co się stało
 * i czy to awaria". Trzeci poziom pośredni („ostrzeżenie") wymagałby decyzji
 * przy każdym wpisie, a czytającemu nie dałby nic, czego nie daje tekst wpisu.
 */
export type LogLevel = 'event' | 'error'

export interface LogEntry {
  /** Zegar ścienny (`Date.now()`) — to jest znacznik czasu, nie czas trwania. */
  at: number
  level: LogLevel
  /** Tekst po polsku, zrozumiały bez znajomości kodu. */
  text: string
}

/**
 * Ile wpisów trzyma pierścień w pamięci.
 *
 * Rachunek, bo „wydaje się dość" nie jest uzasadnieniem:
 *
 * CZĘSTOŚĆ. Jedna osoba daje przy pełnym obrocie najwyżej cztery wpisy
 * (wejście, ekran, kamera, wyjście). Sześcioosobowe lobby to więc około 24
 * wpisów na pełną wymianę składu. Nawet przy wymianie co dziesięć minut —
 * a tak się nie dzieje — wychodzi ~144 wpisy na godzinę, czyli 2 000 wpisów
 * mieści ~14 godzin, więcej niż cały wieczór.
 *
 * NAJGORSZY PRZYPADEK to nie ruch w lobby, a seria błędów: gdy serwer
 * sygnalizacyjny odbija wszystko, wpisy mogą lecieć w tempie tyknięcia sesji
 * (1 Hz). Wtedy 2 000 wpisów to ostatnie ~33 minuty. Cena tego ograniczenia
 * jest realna i trzeba ją znać: przy takiej serii POCZĄTEK awarii, czyli
 * najciekawsza część, wypada z pierścienia. Pełna historia jest wtedy
 * wyłącznie w pliku na dysku (`src/main/lobbyLog.ts`), jeśli ktoś włączył
 * zapis.
 *
 * PAMIĘĆ. Zmierzone w Node: jeden wpis z polskim tekstem kosztuje 162 B na
 * stosie (obiekt + trzy pola + napis w UTF-16; `level` to współdzielony
 * literał), czyli pełny pierścień ~317 KiB. Dla porównania bufor próbek
 * trzyma 600 wpisów po ~5,7 kB przy sześciu osobach, czyli ~3,3 MiB — i to
 * już jest przyjęte. Dziennik jest o rząd wielkości tańszy od tego, co stoi
 * obok, więc podnoszenie tej liczby „na zapas" nie kupuje nic poza dłuższą
 * listą do przewinięcia.
 */
export const LOG_RING_MAX_ENTRIES = 2_000

/**
 * Dokłada wpis i obcina najstarsze, gdy pierścień jest pełny.
 *
 * Nie mutuje wejścia: pierścień jest czytany przez IPC w trakcie dopisywania,
 * a tablica podmieniana w całości nie potrafi być przeczytana w połowie
 * zmiany. Ten sam wzór co `appendSample` w `diagnostics.ts`, tylko bez filtra
 * wieku — dziennik ogranicza LICZBA wpisów, a nie ich wiek: w sesji bez
 * zdarzeń ostatni wpis ma zostać widoczny, choćby był sprzed godziny, bo
 * właśnie wtedy jest najważniejszy („nic się nie dzieje od 20:15").
 */
export function appendLogEntry(ring: readonly LogEntry[], entry: LogEntry): LogEntry[] {
  const next = [...ring, entry]
  return next.length > LOG_RING_MAX_ENTRIES
    ? next.slice(next.length - LOG_RING_MAX_ENTRIES)
    : next
}

/**
 * Znacznik poziomu w tekście.
 *
 * Błąd pisany WIELKIMI literami, nie tylko w innym nawiasie: dziennik czyta
 * się po kolorze dopiero wtedy, gdy kolor jest widoczny, a część ludzi nie
 * odróżnia czerwieni od szarości, a linia skopiowana do wiadomości traci
 * kolor w ogóle. Znacznik tekstowy działa w każdym z tych przypadków.
 */
const LEVEL_MARKS: Record<LogLevel, string> = {
  event: '[zdarzenie]',
  error: '[BŁĄD]'
}

/** Godzina HH:MM:SS z lokalnych getterów — ten sam zwyczaj co nazwa pliku. */
function formatClockWithSeconds(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Jedna linia dziennika: czas lokalny z sekundami, znacznik poziomu, treść.
 *
 * Sekundy, nie same minuty jak na pasku zużycia (`formatClock`
 * w `diagnostics.ts`): wpisy lecą seriami — wejście i dwa strumienie tej samej
 * osoby padają w tej samej sekundzie — a bez sekund cała seria wygląda na
 * jedną chwilę i nie da się odtworzyć kolejności.
 *
 * Czas LOKALNY, nie UTC: człowiek porównuje ten zapis z własnym „zaczęło
 * lagować po dwudziestej drugiej", a nie z zegarem w Greenwich.
 *
 * Bez daty: w oknie wszystkie wpisy są z tej sesji, a w pliku datę niesie jego
 * nazwa (`lobbyLogFileName`).
 */
export function formatLogEntry(entry: LogEntry): string {
  return `${formatClockWithSeconds(entry.at)} ${LEVEL_MARKS[entry.level]} ${entry.text}`
}

/**
 * Czy to naprawdę wpis dziennika.
 *
 * Wpisy przychodzą z renderera przez IPC, czyli z drugiej strony granicy
 * procesów — ta sama ostrożność co `Array.isArray(streams)`
 * w `diagnosticsRecorder.ts`. Sprawdzamy też skończoność `at`: `NaN` przechodzi
 * `typeof === 'number'`, a dałby „Invalid Date" w każdej linii, i to dopiero na
 * dysku, gdzie nikt już tego nie naprawi.
 */
export function isLogEntry(value: unknown): value is LogEntry {
  if (value === null || typeof value !== 'object') return false
  const fields = value as Record<string, unknown>
  return (
    typeof fields.at === 'number' &&
    Number.isFinite(fields.at) &&
    (fields.level === 'event' || fields.level === 'error') &&
    typeof fields.text === 'string'
  )
}

/**
 * Rozszerzenie plików dziennika.
 *
 * MUSI być inne niż `.jsonl` plików próbek i to jest cała jego rola. Oba
 * rodzaje leżą w tym samym katalogu `<userData>/diagnostics` (człowiek szukający
 * przyczyny ma znaleźć jedno miejsce, nie dwa), a retencja
 * `logFilesToDelete` filtruje właśnie po rozszerzeniu — więc wspólne
 * rozszerzenie znaczyłoby, że sprzątanie po próbkach kasuje dzienniki
 * i odwrotnie. Zwykły `.log`, bo to zwykły tekst do czytania, a nie JSON.
 */
export const LOBBY_LOG_SUFFIX = '.log'

/**
 * Znacznik czasu w nazwie pliku: `YYYY-MM-DD-HHmmss`.
 *
 * JEDNA konwencja dla OBU rodzajów plików w `<userData>/diagnostics` — nazwy
 * dziennika (`lobbyLogFileName` niżej) i nazwy pliku próbek
 * (`openLog` w `src/main/diagnosticsRecorder.ts`). Do 0.3.4 te pięć linii
 * stało w obu plikach osobno; tutaj jest ta kopia, która ma test, a tamta
 * została wycięta. Dwie konwencje nazw w jednym katalogu to nie kosmetyka:
 * retencja (`logFilesToDelete`) sortuje PO NAZWIE i rozjazd formatu znaczyłby,
 * że usuwa nie to, co najstarsze.
 *
 * Czas LOKALNY, nie UTC: `toISOString()` dałby w Polsce między północą
 * a 1:00 (zimą) lub 2:00 (latem) wczorajszą datę, a człowiek szuka
 * „dzisiejszego" pliku właśnie wtedy, gdy wieczorem coś lagowało. Składany
 * z getterów, a nie przez `toLocaleString`, bo jego format zależy od ustawień
 * regionalnych — a ta nazwa musi sortować się leksykograficznie zgodnie
 * z czasem.
 */
export function logFileTimestamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${day}-${time}`
}

/**
 * Nazwa pliku dziennika dla podanej chwili: `lobby-YYYY-MM-DD-HHmmss.log`.
 *
 * Przedrostek `lobby-` jest dla człowieka: w jednym katalogu leżą dwa rodzaje
 * plików i bez niego trzeba by otwierać, żeby wiedzieć który jest który. Sam
 * znacznik czasu jest wspólny — patrz `logFileTimestamp`.
 *
 * Funkcja jest tutaj, a nie w `src/main/lobbyLog.ts`, bo to czysta decyzja
 * i tylko tu da się ją przetestować.
 */
export function lobbyLogFileName(at: number): string {
  return `lobby-${logFileTimestamp(at)}${LOBBY_LOG_SUFFIX}`
}
