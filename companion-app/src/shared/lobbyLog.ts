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
 * Dzień lokalny w zapisie `RRRR-MM-DD`.
 *
 * JEDNA konwencja zapisu daty dla OBU miejsc, w których data się w tym
 * przyrządzie w ogóle pojawia: nazwy plików (`logFileTimestamp` niżej)
 * i nagłówka panelu (`formatLogDateHeader`). Nie dla ozdoby — człowiek ma okno
 * przed sobą i szuka pliku na dysku, często dyktując jedno i drugie komuś przez
 * telefon, więc dwie konwencje znaczyłyby, że nie da się dopasować okna do
 * pliku. Od najgrubszej jednostki, bo tylko taki zapis sortuje się
 * leksykograficznie zgodnie z czasem, a na tym stoi retencja.
 *
 * Czas LOKALNY, nie UTC — uzasadnienie przy `logFileTimestamp`.
 */
function formatLocalDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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
 * Bez daty W KAŻDEJ LINII, i to jest decyzja, nie przeoczenie: data powtórzona
 * dwa tysiące razy rozdęłaby plik i okno, nie dodając w sesji ani jednego bitu
 * — a wieczorna sesja przechodzi przez północ regularnie, więc sama godzina
 * naprawdę bywa niejednoznaczna. Datę niesie więc jedno miejsce na zapis:
 * w pliku jego nazwa (`lobbyLogFileName`), w oknie nagłówek panelu
 * (`formatLogDateHeader` niżej), który przy sesji przez północ podaje zakres.
 */
export function formatLogEntry(entry: LogEntry): string {
  return `${formatClockWithSeconds(entry.at)} ${LEVEL_MARKS[entry.level]} ${entry.text}`
}

/**
 * Nagłówek daty nad listą wpisów w panelu.
 *
 * PO CO. Linie dziennika niosą samą godzinę (patrz `formatLogEntry`), a wieczór
 * grania przechodzi przez północ regularnie: wpis „00:05" w oknie otwartym
 * o pierwszej w nocy jest nie do zadatowania, a dwa wpisy — „23:58" i „00:05" —
 * wyglądają na odległe o dwadzieścia trzy godziny, choć dzieli je siedem minut.
 *
 * ZAKRES, A NIE WIERSZ ROZDZIELAJĄCY W LIŚCIE. Plan dawał tu wybór i to jest
 * rozstrzygnięcie wraz z ceną:
 *
 *  - Lista jest ściśle chronologiczna (wpisy dochodzą tylko na koniec), więc
 *    KAŻDE cofnięcie się godziny w dół listy jest granicą dnia i niczym innym.
 *    Zakres mówi, ile tych granic szukać; sama godzina w linii plus zakres
 *    wystarczają, żeby zadatować dowolny wiersz.
 *  - Wiersz rozdzielający pokazywałby to samo wprost, ale kosztowałby pracę
 *    PRZY KAŻDYM PRZERYSOWANIU listy, a ta przerysowuje się raz na sekundę
 *    razem z paskiem zużycia i ma do dwóch tysięcy wierszy. Anty-cel
 *    specyfikacji mówi wprost, że sama diagnostyka nie może dokładać pracy
 *    w aplikacji, w której diagnozujemy zacinanie.
 *  - Nagłówek wygrywa też przypadek, którego wiersz rozdzielający NIE umie:
 *    sesja zaczęta przed północą i otwarta po niej, w której wszystkie wpisy są
 *    z jednego dnia — wczorajszego. Żadna granica dnia w liście nie wypada,
 *    a mimo to „23:50" nie jest z dzisiaj.
 *
 * Pusty napis dla pustego pierścienia: data wzięta z zegara, a nie z wpisów,
 * byłaby wymyślona — nie ma ani jednego wpisu, z którego mogłaby pochodzić.
 *
 * Pierwszy i ostatni wpis, bez szukania minimum i maksimum: pierścień jest
 * chronologiczny z konstrukcji (`appendLogEntry` dokłada na koniec), a przy
 * cofnięciu zegara systemowego w trakcie sesji zakres wyjdzie odwrotny —
 * widoczna niedorzeczność zamiast cichego przekłamania.
 */
export function formatLogDateHeader(entries: readonly LogEntry[]): string {
  if (entries.length === 0) return ''
  const firstDay = formatLocalDay(entries[0].at)
  const lastDay = formatLocalDay(entries[entries.length - 1].at)
  return firstDay === lastDay ? `Wpisy z ${firstDay}` : `Wpisy od ${firstDay} do ${lastDay}`
}

/**
 * Nota nad listą: dziennik nie może udawać, że stan zastany to zdarzenia.
 *
 * Wpisy powstają z RÓŻNICY dwóch kolejnych stanów lobby, a punktem odniesienia
 * pierwszej różnicy jest stan pusty — więc wszyscy, którzy siedzieli w pokoju,
 * zanim weszliśmy, dostają wpis „wszedł do lobby" ze znacznikiem chwili
 * NASZEGO wejścia. Czytający weźmie to za dowód, że ktoś wszedł o 22:31, choć
 * siedział tam od godziny, i poprowadzi diagnozę w złą stronę. To jest dokładnie
 * ta szkoda, której ten przyrząd ma zapobiegać, więc nota kosztuje swoje
 * ~30 px stałej wysokości panelu i jest tego warta.
 */
const LOG_ORIGIN_NOTE =
  'Wpisy powstają ze zmian stanu, więc wejście do lobby zapisuje cały zastany skład jako wejścia — z godziną dołączenia, nie z godziną, o której te osoby naprawdę weszły.'

/**
 * Drugie zdanie noty, dokładane po przekręceniu pierścienia.
 *
 * „Wypadają" i „może już nie być", a nie „wypadły" i „nie jest": pierścień
 * oddaje przez IPC samą tablicę, bez licznika usuniętych wpisów, więc przy
 * DOKŁADNIE `LOG_RING_MAX_ENTRIES` wpisach nie wypadł jeszcze ani jeden i zdanie
 * w czasie przeszłym byłoby nieprawdą. Czas teraźniejszy jest prawdziwy w obu
 * tych stanach. Dokładna liczba wymagałaby licznika w `src/main/lobbyLog.ts`
 * i w ładunku kanału odczytu — osobna sprawa, nie poprawka przy tej nocie.
 */
const LOG_RING_FULL_NOTE =
  'Pierścień jest pełny, więc najstarsze wpisy wypadają — góra listy może już nie być początkiem sesji.'

/**
 * Składa notę dla pierścienia, który panel właśnie pokazuje.
 *
 * Zdanie o składzie zastanym mówi REGUŁĘ, a nie „pierwsze wpisy na liście to
 * skład zastany" — i to jest świadome, z dwóch sprawdzonych powodów:
 *
 *  - Po przepełnieniu pierścienia najstarsze wpisy wypadają, więc skład zastany
 *    przestaje otwierać listę i tamto zdanie przestaje opisywać to, co człowiek
 *    widzi na górze.
 *  - Panel otwiera się PRZEWINIĘTY NA KONIEC (`LobbyLogList`
 *    w `renderer/components/Diagnostics.tsx`), bo czytający przychodzi po to,
 *    co się właśnie stało. Pierwszych wpisów więc w ogóle nie widzi — zdanie
 *    o nich wskazywałoby wiersze poza ekranem, a reguła daje się przyłożyć do
 *    dowolnego miejsca listy, także tego, w którym czytający stoi.
 *
 * Regułę czytający sprawdzi na samym dzienniku: grupa wejść z jedną wspólną
 * sekundą to stan, nie seria zdarzeń.
 *
 * Dlatego zdanie o pełnym pierścieniu jest DOKŁADANE, a nie podstawiane
 * w miejsce pierwszego. Pełny pierścień NIE znaczy, że skład zastany już
 * wypadł: przy dokładnie `LOG_RING_MAX_ENTRIES` wpisach nie wypadł jeszcze ani
 * jeden, a dalej zostaje w pierścieniu, dopóki się z niego nie wykręci.
 * Zabranie wtedy pierwszego zdania odebrałoby ostrzeżenie dokładnie temu, kto
 * ma najmniej danych, żeby sam to ocenić.
 */
export function formatLogOriginNote(entries: readonly LogEntry[]): string {
  if (entries.length === 0) return ''
  return entries.length >= LOG_RING_MAX_ENTRIES
    ? `${LOG_ORIGIN_NOTE} ${LOG_RING_FULL_NOTE}`
    : LOG_ORIGIN_NOTE
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
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  // Dzień z `formatLocalDay`, nie składany tu po raz drugi: ta sama data stoi
  // od 0.3.4 także w nagłówku panelu i rozjazd obu zapisów znaczyłby, że okna
  // nie da się dopasować do pliku na dysku.
  return `${formatLocalDay(at)}-${time}`
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
