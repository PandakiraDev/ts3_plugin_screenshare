import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { LOG_FILES_KEPT, logFilesToDelete, shouldAppendLine } from '@shared/diagnostics'
import {
  LOBBY_LOG_SUFFIX,
  appendLogEntry,
  formatLogEntry,
  lobbyLogFileName,
  type LogEntry
} from '@shared/lobbyLog'

/**
 * Właściciel dziennika lobby w procesie głównym: pierścień w pamięci i zapis
 * na dysk.
 *
 * DLACZEGO PROCES GŁÓWNY. Renderer jest tym, co diagnozujemy. Gdyby on trzymał
 * pierścień, przestawałby zapisywać dokładnie w chwili, która nas interesuje —
 * a przy przeładowaniu renderera cały dziennik znikałby razem z nim. Tutaj
 * przeżywa.
 *
 * DLACZEGO TEN PLIK NIE IMPORTUJE `electron`. Zapis linii przychodzi
 * parametrem (`appendLine`), a katalog danych parametrem `userDataPath` — ten
 * sam wzór co `createUpdateLogger(userDataPath)` w `updateLogger.ts`
 * i `readSettings(userDataPath)` w `settings.ts`. To jedyny powód, dla którego
 * bramkowanie zapisu da się w tym repozytorium sprawdzić testem: vitest chodzi
 * w gołym Node, a modułu importującego `app` nie da się tam nawet wczytać
 * (dlatego `diagnosticsRecorder.ts` nie ma ani jednego testu). Rejestracja
 * kanałów IPC mieszka więc w `src/main/index.ts`, a nie tu.
 *
 * DLACZEGO WŁASNY PLIK I WŁASNA BRAMKA, A NIE DOKLEJANIE DO PLIKU PRÓBEK.
 * Decyzja świadoma, trzy powody — bez nich następna osoba skleji te pliki „dla
 * porządku":
 *
 * 1. `appendLine` w `diagnosticsRecorder.ts` jest typowane na
 *    `DiagnosticsSample`. Wpisy dziennika wymagałyby zmiany tego typu
 *    i wmieszania dwóch zupełnie różnych rodzajów rekordów w jedną funkcję,
 *    która dziś robi jedną rzecz.
 * 2. `LOG_SIZE_CEILING_BYTES` to 256 MiB wyliczone dla próbek co sekundę
 *    i liczone PER PLIK. Sklejenie znaczyłoby, że budżet próbek zależy od
 *    tego, ile zdarzeń było w lobby — dwie niezależne rzeczy zaczęłyby się
 *    o siebie bić, i to tym mocniej, im gorszy wieczór.
 * 3. Okno i tak czyta pierścień Z PAMIĘCI, więc jeden widok w kolejności czasu
 *    dostajemy w interfejsie, nie na dysku. Dwa pliki ze znacznikami czasu,
 *    w jednym katalogu, są do czytania po fakcie zupełnie wystarczające.
 *
 * Co ląduje w pliku: gotowa linia `formatLogEntry`, czyli to samo, co widzi
 * człowiek w oknie — a nie JSON jak w pliku próbek. Plik próbek jest do
 * przeliczania liczb, dziennik do czytania; `{"at":1760...}` wymagałby
 * narzędzia, żeby zobaczyć godzinę, a ten plik czyta się często komuś przez
 * telefon.
 */

/**
 * Ile plików dziennika zostaje w katalogu.
 *
 * ŚWIADOMIE ta sama liczba co dla próbek (`LOG_FILES_KEPT`), nie własna.
 * Uzasadnienie liczbą: wieczór to ~1 500 linii po 58 B, czyli plik rzędu
 * 85 kB; dwadzieścia takich to ~1,7 MB, czyli 0,6% sufitu JEDNEGO pliku
 * próbek (256 MiB). Kosztowo nie ma więc czego optymalizować — a skoro oba
 * pliki jednej sesji leżą w tym samym katalogu, to przy różnych progach
 * zostawałyby dzienniki sesji, których próbki już dawno usunięto (albo
 * odwrotnie), czyli człowiek szukający przyczyny trafiałby na połowę zapisu
 * bez powodu. Wspólna liczba znaczy „ostatnie 20 sesji" dla obu rodzajów.
 *
 * Alias, nie `LOG_FILES_KEPT` wołane wprost w kodzie niżej: gdyby kiedyś
 * dziennik miał dostać własny próg, zmienia się ta jedna linia, a nie
 * wyszukiwanie po całym pliku.
 */
export const LOBBY_LOG_FILES_KEPT = LOG_FILES_KEPT

/**
 * Sufit rozmiaru jednego pliku dziennika.
 *
 * Nie jest to budżet wieczoru, tylko bezpiecznik przed plikiem rosnącym bez
 * końca (seria błędów, która nie ustaje) — anty-cel ze specyfikacji mówi
 * wprost, że dziennik nie może rosnąć bez ograniczenia ani w pamięci, ani na
 * dysku.
 *
 * Rachunek, zmierzony `Buffer.byteLength`: linia „22:31:05 [zdarzenie] Michał
 * zaczął udostępniać ekran" z końcem linii to 58 B w UTF-8 (polskie litery po
 * dwa bajty). 16 MiB to więc ~289 000 linii: przy najgorszym realnym tempie,
 * czyli jednym błędzie na tyknięcie sesji (1 Hz), 80 godzin nieustającej
 * awarii. Wieczór normalnego ruchu to ~1 500 linii, czyli 85 kB, pół procenta
 * tego sufitu. Szesnaście razy mniej niż sufit pliku próbek, bo linia
 * dziennika jest ~60 razy krótsza od linii próbki i nie leci co sekundę.
 */
export const LOBBY_LOG_SIZE_CEILING_BYTES = 16 * 1024 * 1024

/**
 * Zostawia w katalogu `LOBBY_LOG_FILES_KEPT` najnowszych plików DZIENNIKA.
 *
 * Decyzja którego pliku pozbyć się siedzi w `logFilesToDelete`
 * z `@shared/diagnostics` — jednej, przetestowanej funkcji, nie drugiej takiej
 * samej. Rozszerzenie podajemy jawnie, bo domyślne (`.jsonl`) należy do próbek
 * i to ono trzyma te dwie retencje osobno.
 *
 * Wołane PRZED otwarciem nowego pliku, więc nowy nie bierze udziału
 * w liczeniu. Nieudane usunięcie JEDNEGO pliku nie przerywa pozostałych ani
 * otwarcia nowego — stąd `try` wewnątrz pętli, a nie tylko wokół niej.
 */
function pruneOldLogs(directory: string): void {
  try {
    const names = readdirSync(directory)
    for (const name of logFilesToDelete(names, LOBBY_LOG_FILES_KEPT, LOBBY_LOG_SUFFIX)) {
      try {
        unlinkSync(join(directory, name))
      } catch {
        /* jeden plik został — katalog i tak się skurczy przy następnej sesji */
      }
    }
  } catch {
    /* nie dało się przeczytać katalogu: zapis jest ważniejszy niż porządki */
  }
}

/** Notka w pliku, gdy sufit został osiągnięty — patrz `createLobbyLogAppender`. */
const CEILING_NOTE = 'sufit rozmiaru dziennika osiągnięty, dalsze wpisy zostają tylko w oknie'

/**
 * Składa zapis linii do `<userData>/diagnostics/lobby-YYYY-MM-DD-HHmmss.log`.
 *
 * Plik otwiera się LENIWIE, przy pierwszej linii, a nie przy tworzeniu zapisu.
 * To rozstrzygnięcie, nie przypadek, i różni się od `openLog`
 * w `diagnosticsRecorder.ts`, które musi być wołane z `setRecordToDisk`:
 * - sesja, w której nikt nie włączył zapisu, nie tworzy ani katalogu, ani pliku;
 * - sesja z włączonym zapisem, ale bez ani jednego zdarzenia w lobby, nie
 *   zostawia pustego pliku, który wyglądałby jak zgubiony dziennik i zużywał
 *   jedno miejsce z `LOBBY_LOG_FILES_KEPT`;
 * - włączenie pola wyboru W TRAKCIE sesji nie wymaga tu żadnego dodatkowego
 *   kroku: pierwsza linia po włączeniu otwiera plik sama. W rejestratorze
 *   próbek było odwrotnie i tam trzeba było to wołać ręcznie.
 *
 * Nazwa pliku mówi, kiedy ZACZĄŁ SIĘ ZAPIS, czyli kiedy padł pierwszy wpis po
 * włączeniu — a nie kiedy wstała aplikacja.
 *
 * Najwyżej jeden plik na sesję (strażnik `opened`), także po próbie nieudanej:
 * nazwa niesie godzinę, więc druga próba dałaby drugi plik tej samej sesji,
 * a wtedy sufit liczony per plik dałoby się obejść samym czekaniem.
 *
 * Każde wywołanie systemu plików w `try/catch`: dziennik jest dodatkiem, więc
 * pełny dysk, brak uprawnień ani katalog podmieniony na plik nie mają prawa
 * przewrócić sesji. Układ jak w `updateLogger.ts`.
 *
 * @param userDataPath `app.getPath('userData')` — parametr, nie import `app`.
 * @param ceilingBytes sufit rozmiaru; parametr istnieje WYŁĄCZNIE po to, żeby
 *   dało się sprawdzić bramkę bez pisania kilkunastu mebibajtów. Produkcja
 *   bierze wartość domyślną.
 */
export function createLobbyLogAppender(
  userDataPath: string,
  ceilingBytes: number = LOBBY_LOG_SIZE_CEILING_BYTES
): (line: string) => void {
  let logPath: string | null = null
  let opened = false
  let logBytes = 0
  let ceilingReported = false

  function open(): void {
    if (opened) return
    opened = true
    try {
      const directory = join(userDataPath, 'diagnostics')
      mkdirSync(directory, { recursive: true })
      pruneOldLogs(directory)
      const path = join(directory, lobbyLogFileName(Date.now()))
      /*
       * Rozmiar istniejącego pliku doliczamy, bo nazwa NIE jest unikalna: dwa
       * okna, które zaczęły pisać w tej samej sekundzie, trafiają w ten sam
       * plik (ta gałąź świadomie nie bierze `requestSingleInstanceLock`),
       * a wtedy sufit musi obejmować to, co już tam jest.
       */
      let existing = 0
      try {
        existing = statSync(path).size
      } catch {
        /* plik jeszcze nie istnieje */
      }
      logPath = path
      logBytes = existing
    } catch {
      // Bez pliku zostaje pierścień w pamięci — okno dziennika działa, zapis
      // nie przeżyje restartu. Lepsze niż przewrócona sesja.
      logPath = null
    }
  }

  return (line: string): void => {
    open()
    if (logPath === null) return

    const text = `${line}\n`
    const lineBytes = Buffer.byteLength(text, 'utf8')

    if (!shouldAppendLine(logBytes, lineBytes, ceilingBytes)) {
      /*
       * Notka RAZ na plik, i świadomie POZA sufitem — bez niej plik kończy się
       * w losowym miejscu i czytający nie wie, czy dziennik milczy, czy się
       * skończył. Jednorazowe przekroczenie o jedną linię jest tego warte;
       * powtarzanie notki przy każdym wpisie nie byłoby, bo dopisywałoby linie
       * nic nie wnoszące dokładnie wtedy, gdy plik jest już za duży.
       */
      if (ceilingReported) return
      ceilingReported = true
      try {
        appendFileSync(logPath, `${CEILING_NOTE}\n`, 'utf8')
      } catch {
        /* nic więcej nie zrobimy */
      }
      return
    }

    try {
      appendFileSync(logPath, text, 'utf8')
      logBytes += lineBytes
    } catch {
      /* zapis padł — pierścień w pamięci działa dalej */
    }
  }
}

export interface LobbyLog {
  /** Dokłada wpis do pierścienia i — za zgodą — do pliku. */
  push(entry: LogEntry): void
  /** Cały pierścień, od najstarszego wpisu. Do odczytu kanałem IPC. */
  read(): readonly LogEntry[]
  /** Przestawia zapis na dysk W TRAKCIE sesji; woła to obsługa pola wyboru. */
  setRecordToDisk(enabled: boolean): void
}

/**
 * Tworzy dziennik: pierścień w pamięci plus opcjonalny zapis linii.
 *
 * Pierścień działa ZAWSZE, zapis tylko za zgodą — to jest cały sens
 * rozdzielenia tych dwóch spraw i jedyne miejsce, w którym da się je pomylić.
 * Rozjazd byłby cichy: wszystko dalej wygląda poprawnie, tylko znika to, po co
 * to zrobiliśmy (okno dziennika puste u każdego, kto nie włączył zapisu).
 *
 * `setRecordToDisk(true)` NIE uzupełnia pliku wstecz: zgoda dotyczy chwili,
 * w której jej udzielono, a nie całej sesji. Wyłączenie też nie wyrzuca
 * niczego z pierścienia — podgląd nie zależy od zapisu.
 */
export function createLobbyLog(options: {
  appendLine: (line: string) => void
  recordToDisk: boolean
}): LobbyLog {
  /*
   * Tablica podmieniana w całości (`appendLogEntry` zwraca nową), a nie
   * mutowana: `read()` oddaje referencję przez IPC, a referencja na tablicę,
   * którą ktoś w tym czasie przycina, dałaby się przeczytać w połowie zmiany.
   */
  let ring: LogEntry[] = []
  let recordToDisk = options.recordToDisk

  return {
    push: (entry) => {
      ring = appendLogEntry(ring, entry)
      if (recordToDisk) options.appendLine(formatLogEntry(entry))
    },
    read: () => ring,
    setRecordToDisk: (enabled) => {
      recordToDisk = enabled
    }
  }
}
