import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
// Import WARTOŚCI z `@shared`, nie typu — alias rozwiązuje `vitest.config.ts`,
// a nie `tsconfig.json`; import samego typu przeszedłby nawet bez aliasu, bo
// znika przy kompilacji, więc niczego by nie pilnował.
import {
  LOBBY_LOG_SUFFIX,
  LOG_RING_MAX_ENTRIES,
  appendLogEntry,
  formatLogDateHeader,
  formatLogEntry,
  formatLogOriginNote,
  isLogEntry,
  lobbyLogFileName,
  logFileTimestamp,
  type LogEntry
} from '@shared/lobbyLog'
import { LOG_FILES_KEPT, logFilesToDelete } from '@shared/diagnostics'
// Ten plik NIE importuje `electron`, bo `src/main/lobbyLog.ts` go nie importuje:
// zapis linii i katalog danych przychodzą parametrami, dokładnie jak
// `createUpdateLogger(userDataPath)` w `src/main/updateLogger.ts`. To jedyny
// powód, dla którego bramkowanie zapisu da się sprawdzić w gołym vitest.
import {
  LOBBY_LOG_FILES_KEPT,
  createLobbyLog,
  createLobbyLogAppender
} from '../src/main/lobbyLog'

test('pierścień nie rośnie powyżej swojego ograniczenia', () => {
  // Punkt 4 z Review Focus: długa sesja nie może zjeść pamięci.
  let ring: LogEntry[] = []
  for (let i = 0; i < LOG_RING_MAX_ENTRIES + 50; i++) {
    ring = appendLogEntry(ring, { at: i, level: 'event', text: `wpis ${i}` })
  }
  expect(ring).toHaveLength(LOG_RING_MAX_ENTRIES)
})

test('przy przepełnieniu wypadają NAJSTARSZE wpisy', () => {
  let ring: LogEntry[] = []
  for (let i = 0; i < LOG_RING_MAX_ENTRIES + 1; i++) {
    ring = appendLogEntry(ring, { at: i, level: 'event', text: `wpis ${i}` })
  }
  expect(ring[0]?.text).toBe('wpis 1')
  expect(ring.at(-1)?.text).toBe(`wpis ${LOG_RING_MAX_ENTRIES}`)
})

test('appendLogEntry nie zmienia tablicy wejściowej', () => {
  const ring: LogEntry[] = [{ at: 1, level: 'event', text: 'pierwszy' }]
  appendLogEntry(ring, { at: 2, level: 'error', text: 'drugi' })
  expect(ring).toHaveLength(1)
})

test('wpis błędu jest w tekście odróżnialny od zdarzenia', () => {
  // Bez tego dziennik jest ścianą tekstu, w której nie widać, co jest awarią.
  // Ten sam czas i ten sam tekst, różni się WYŁĄCZNIE poziom — więc różnica
  // w wyniku może pochodzić tylko od poziomu.
  const at = new Date(2026, 9, 16, 22, 31, 5).getTime()
  const text = 'Nieznany peer'
  expect(formatLogEntry({ at, level: 'event', text })).not.toBe(
    formatLogEntry({ at, level: 'error', text })
  )
})

test('format wpisu niesie czas lokalny z sekundami i treść', () => {
  // Sekundy, nie same minuty: wpisy lecą seriami (wejście, strumień, strumień)
  // i bez sekund cała seria wygląda na jedną chwilę.
  const at = new Date(2026, 9, 16, 22, 31, 5).getTime()
  const line = formatLogEntry({ at, level: 'event', text: 'Michał wszedł do lobby' })
  expect(line).toContain('22:31:05')
  expect(line).toContain('Michał wszedł do lobby')
})

/*
 * Dokładne napisy obu linii panelu, przepisane tu Z RĘKI, a nie zaimportowane
 * ze źródła. Import pilnowałby tylko tego, że funkcja oddaje swoją własną
 * stałą — zgodę na KAŻDĄ jej zmianę, w tym na taką, która znów zacznie mylić
 * stan ze zdarzeniem. Te dwa zdania są tu całym dostarczanym towarem, więc ich
 * treść pilnuje kopia po stronie testu.
 */
const ORIGIN_NOTE =
  'Wpisy powstają ze zmian stanu, więc wejście do lobby zapisuje cały zastany skład jako wejścia — z godziną dołączenia, nie z godziną, o której te osoby naprawdę weszły.'
const RING_FULL_NOTE =
  'Pierścień jest pełny, więc najstarsze wpisy wypadają — góra listy może już nie być początkiem sesji.'

/** Pierścień o podanej długości; treść wpisów nie ma tu znaczenia, liczba ma. */
function ringOfLength(length: number): LogEntry[] {
  return Array.from({ length }, (_, index): LogEntry => ({
    at: index,
    level: 'event',
    text: `wpis ${index}`
  }))
}

test('nagłówek daty dla wpisów z jednego dnia podaje tę jedną datę', () => {
  const morning = new Date(2026, 9, 16, 9, 2, 0).getTime()
  const evening = new Date(2026, 9, 16, 22, 31, 5).getTime()
  expect(
    formatLogDateHeader([
      { at: morning, level: 'event', text: 'Michał wszedł do lobby' },
      { at: evening, level: 'error', text: 'Michał — połączenie padło' }
    ])
  ).toBe('Wpisy z 2026-10-16')
})

test('nagłówek daty przy sesji przez północ podaje ZAKRES, a nie jedną datę', () => {
  // Wieczorne sesje grania przechodzą przez północ regularnie, a `formatLogEntry`
  // daje samą godzinę — bez tego nagłówka „00:05" w oknie jest nie do zadatowania,
  // a nagłówek z jedną datą kłamałby o połowie wpisów.
  const before = new Date(2026, 9, 16, 23, 58, 12).getTime()
  const after = new Date(2026, 9, 17, 0, 5, 3).getTime()
  expect(
    formatLogDateHeader([
      { at: before, level: 'event', text: 'Michał wszedł do lobby' },
      { at: after, level: 'event', text: 'Michał wyszedł z lobby' }
    ])
  ).toBe('Wpisy od 2026-10-16 do 2026-10-17')
})

test('nagłówek daty pustego pierścienia jest pusty, a nie dzisiejszą datą', () => {
  // Dzisiejsza data przy pustym dzienniku byłaby wymyślona: nie ma ani jednego
  // wpisu, z którego mogłaby pochodzić.
  expect(formatLogDateHeader([])).toBe('')
})

test('dzień w nagłówku liczy się LOKALNIE, nie w UTC', () => {
  // 2026-10-17 00:30 czasu lokalnego to w Polsce 2026-10-16 22:30 UTC, więc
  // `toISOString()` dałby wczorajszą datę dokładnie przy sesji przez północ,
  // czyli w jedynym przypadku, dla którego ten nagłówek powstał.
  const justAfterMidnight = new Date(2026, 9, 17, 0, 30, 0).getTime()
  expect(
    formatLogDateHeader([{ at: justAfterMidnight, level: 'event', text: 'Michał wszedł do lobby' }])
  ).toBe('Wpisy z 2026-10-17')
})

test('data w nagłówku jest zapisana tak samo jak w nazwie pliku dziennika', () => {
  // Człowiek ma okno przed sobą i szuka pliku na dysku (albo dyktuje jedno
  // i drugie komuś przez telefon), więc dwie konwencje zapisu daty w jednym
  // przyrządzie znaczyłyby, że nie da się dopasować okna do pliku.
  const at = new Date(2026, 9, 16, 22, 31, 5).getTime()
  expect(formatLogDateHeader([{ at, level: 'event', text: 'Michał wszedł do lobby' }])).toBe(
    'Wpisy z 2026-10-16'
  )
  expect(lobbyLogFileName(at)).toBe('lobby-2026-10-16-223105.log')
})

test('nota nad listą mówi wprost, że skład zastany to stan, a nie zdarzenia', () => {
  // Punktem odniesienia różnicy stanów jest stan pusty, więc wszyscy zastani
  // w pokoju dostają wpis „wszedł do lobby" ze znacznikiem NASZEGO wejścia.
  // Bez tej noty czytający weźmie to za dowód, że ktoś wszedł o 22:31, choć
  // siedział tam od godziny.
  expect(formatLogOriginNote([{ at: 1, level: 'event', text: 'Michał wszedł do lobby' }])).toBe(
    ORIGIN_NOTE
  )
})

test('nota pustego pierścienia jest pusta', () => {
  expect(formatLogOriginNote([])).toBe('')
})

test('pełny pierścień DOKŁADA zdanie o wypadniętych wpisach, nie zastępuje nim noty', () => {
  // Po przekręceniu pierścienia góra listy przestaje być początkiem sesji
  // i trzeba to powiedzieć. Zdanie o składzie zastanym musi jednak ZOSTAĆ:
  // pełny pierścień nie znaczy, że skład zastany już z niego wypadł — przy
  // dokładnie tej długości nie wypadł jeszcze ani jeden wpis.
  expect(formatLogOriginNote(ringOfLength(LOG_RING_MAX_ENTRIES))).toBe(
    `${ORIGIN_NOTE} ${RING_FULL_NOTE}`
  )
})

test('pierścień tuż przed przepełnieniem nie straszy wypadniętymi wpisami', () => {
  // Granica po stronie prawdy: dopóki nie wypadł ani jeden wpis, góra listy
  // JEST początkiem sesji i nie wolno temu zaprzeczać.
  expect(formatLogOriginNote(ringOfLength(LOG_RING_MAX_ENTRIES - 1))).toBe(ORIGIN_NOTE)
})

test('wpis z obcego źródła jest odrzucany, zanim trafi do pierścienia', () => {
  // Wpisy przychodzą z renderera przez IPC, czyli z drugiej strony granicy
  // procesów — tak samo jak `Array.isArray(streams)` w `diagnosticsRecorder.ts`.
  expect(isLogEntry({ at: 1, level: 'event', text: 'ok' })).toBe(true)
  expect(isLogEntry({ at: 1, level: 'error', text: 'ok' })).toBe(true)
  expect(isLogEntry(null)).toBe(false)
  expect(isLogEntry('Michał wszedł')).toBe(false)
  expect(isLogEntry({ at: 1, level: 'warn', text: 'ok' })).toBe(false)
  expect(isLogEntry({ at: 1, level: 'event', text: 7 })).toBe(false)
  // NaN przeszłoby `typeof === 'number'`, a dałoby „Invalid Date" w każdej
  // linii dziennika.
  expect(isLogEntry({ at: Number.NaN, level: 'event', text: 'ok' })).toBe(false)
})

test('retencja próbek nie widzi plików dziennika, a retencja dziennika nie widzi próbek', () => {
  // To jest cały powód, dla którego dziennik ma własne rozszerzenie. Oba
  // rodzaje plików leżą w jednym katalogu, więc gdyby filtr jednej retencji
  // obejmował pliki drugiej, sprzątanie po sesjach kasowałoby obce pliki —
  // i to po cichu, bo każda z dwóch retencji wyglądałaby poprawnie osobno.
  const journal = [lobbyLogFileName(1_000), lobbyLogFileName(2_000), lobbyLogFileName(3_000)]
  const samples = ['2026-10-16-220000.jsonl', '2026-10-16-223000.jsonl']
  expect(logFilesToDelete(journal, 1)).toEqual([])
  expect(logFilesToDelete(samples, 1, LOBBY_LOG_SUFFIX)).toEqual([])
  // A każda swoje własne widzi i porządkuje po nazwie, czyli po czasie.
  expect(logFilesToDelete(journal, 1, LOBBY_LOG_SUFFIX)).toEqual([journal[0], journal[1]])
})

test('wypchnięty wpis trafia do pierścienia niezależnie od zapisu na dysk', () => {
  // Podgląd NIE zależy od ustawienia — zależy od niego wyłącznie pisanie
  // plików. Rozjazd tych dwóch spraw jest cichy: wszystko dalej wygląda
  // poprawnie, tylko znika to, po co to zrobiliśmy.
  const written: string[] = []
  const log = createLobbyLog({ appendLine: (line) => written.push(line), recordToDisk: false })
  log.push({ at: 1, level: 'event', text: 'Michał wszedł' })
  expect(log.read()).toHaveLength(1)
  expect(written).toEqual([])
})

test('przestawienie zapisu w trakcie działa bez tworzenia dziennika od nowa', () => {
  const written: string[] = []
  const log = createLobbyLog({ appendLine: (line) => written.push(line), recordToDisk: false })
  log.push({ at: 1, level: 'event', text: 'przed włączeniem' })
  log.setRecordToDisk(true)
  log.push({ at: 2, level: 'event', text: 'po włączeniu' })
  // Pierścień ma oba wpisy, dysk tylko ten po włączeniu — zapisu nie
  // uzupełniamy wstecz, bo zgoda dotyczy chwili, w której jej udzielono.
  expect(log.read()).toHaveLength(2)
  expect(written).toHaveLength(1)
  expect(written[0]).toContain('po włączeniu')
})

test('wyłączenie zapisu w trakcie przerywa pisanie, a nie podgląd', () => {
  // Punkt 5 z Review Focus w drugą stronę: pole wyboru da się też ODHACZYĆ
  // w trakcie sesji i wtedy wpisy mają dalej być widoczne w oknie.
  const written: string[] = []
  const log = createLobbyLog({ appendLine: (line) => written.push(line), recordToDisk: true })
  log.push({ at: 1, level: 'event', text: 'przy włączonym' })
  log.setRecordToDisk(false)
  log.push({ at: 2, level: 'error', text: 'po wyłączeniu' })
  expect(log.read()).toHaveLength(2)
  expect(written).toHaveLength(1)
  expect(written[0]).toContain('przy włączonym')
})

test('pierścień właściciela też ma ograniczenie, nie tylko czysta funkcja', () => {
  // Bez tego `createLobbyLog` mogłoby dokładać wpisy zwykłym `[...ring, entry]`
  // i wszystkie pozostałe testy właściciela dalej by przechodziły.
  const log = createLobbyLog({ appendLine: () => {}, recordToDisk: false })
  for (let i = 0; i < LOG_RING_MAX_ENTRIES + 5; i++) {
    log.push({ at: i, level: 'event', text: `wpis ${i}` })
  }
  expect(log.read()).toHaveLength(LOG_RING_MAX_ENTRIES)
  expect(log.read().at(-1)?.text).toBe(`wpis ${LOG_RING_MAX_ENTRIES + 4}`)
})

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'lobby-log-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/** Katalog, w którym lądują oba rodzaje plików diagnostycznych. */
function diagnosticsDir(): string {
  return join(workDir, 'diagnostics')
}

test('zapis idzie do WŁASNEGO pliku dziennika, nie do pliku próbek', () => {
  const appendLine = createLobbyLogAppender(workDir)
  appendLine('22:31:05 [zdarzenie] Michał wszedł do lobby')

  const names = readdirSync(diagnosticsDir())
  expect(names).toHaveLength(1)
  expect(names[0]).toMatch(/^lobby-\d{4}-\d{2}-\d{2}-\d{6}\.log$/)
  expect(readFileSync(join(diagnosticsDir(), names[0]!), 'utf8')).toBe(
    '22:31:05 [zdarzenie] Michał wszedł do lobby\n'
  )
})

test('kolejne linie idą do tego samego pliku, jeden plik na sesję', () => {
  const appendLine = createLobbyLogAppender(workDir)
  appendLine('pierwsza')
  appendLine('druga')

  const names = readdirSync(diagnosticsDir())
  expect(names).toHaveLength(1)
  expect(readFileSync(join(diagnosticsDir(), names[0]!), 'utf8')).toBe('pierwsza\ndruga\n')
})

test('sesja przekraczająca sekundę pisze dalej do TEGO SAMEGO pliku', () => {
  /*
   * Nazwa pliku niesie godzinę z sekundami, więc bez strażnika „otwieramy
   * najwyżej raz" sesja rozsypałaby się na tyle plików, ile sekund trwa —
   * retencja usuwałaby własne wcześniejsze kawałki tej samej sesji, a sufit
   * rozmiaru liczony per plik dałby się obejść samym czekaniem. Jedyny sposób,
   * żeby to pokazać bez czekania w teście: podstawiony zegar. W tym
   * repozytorium nic innego go nie używa, więc przywracamy prawdziwy
   * w `finally` — zostawiony podstawiony przeciekłby na kolejne pliki testów.
   */
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date(2026, 9, 16, 22, 31, 5))
    const appendLine = createLobbyLogAppender(workDir)
    appendLine('pierwsza')
    vi.setSystemTime(new Date(2026, 9, 16, 22, 31, 9))
    appendLine('druga, cztery sekundy później')
  } finally {
    vi.useRealTimers()
  }

  const names = readdirSync(diagnosticsDir())
  expect(names).toEqual(['lobby-2026-10-16-223105.log'])
  expect(readFileSync(join(diagnosticsDir(), names[0]!), 'utf8')).toContain('druga')
})

test('retencja zostawia najnowsze dzienniki i nie rusza plików próbek', () => {
  mkdirSync(diagnosticsDir(), { recursive: true })
  const oldest = lobbyLogFileName(1_600_000_000_000)
  const newest = lobbyLogFileName(1_600_000_000_000 + (LOBBY_LOG_FILES_KEPT + 4) * 1_000)
  for (let i = 0; i <= LOBBY_LOG_FILES_KEPT + 4; i++) {
    writeFileSync(
      join(diagnosticsDir(), lobbyLogFileName(1_600_000_000_000 + i * 1_000)),
      'stary wpis\n',
      'utf8'
    )
  }
  writeFileSync(join(diagnosticsDir(), '2026-10-16-220000.jsonl'), '{}\n', 'utf8')

  createLobbyLogAppender(workDir)('nowa linia')

  const names = readdirSync(diagnosticsDir())
  // `LOBBY_LOG_FILES_KEPT` zostawionych starych plus plik tej sesji.
  expect(names.filter((name) => name.endsWith(LOBBY_LOG_SUFFIX))).toHaveLength(
    LOBBY_LOG_FILES_KEPT + 1
  )
  expect(names).toContain(newest)
  expect(names).not.toContain(oldest)
  // Pliki próbek należą do drugiej retencji i ta ich nie dotyka.
  expect(names).toContain('2026-10-16-220000.jsonl')
})

test('sufit rozmiaru zatrzymuje zapis i mówi o tym JEDNĄ notką', () => {
  // Sufit podawany parametrem wyłącznie po to, żeby sprawdzić bramkę bez
  // pisania kilkunastu mebibajtów; produkcja bierze wartość domyślną.
  const appendLine = createLobbyLogAppender(workDir, 12)
  appendLine('abcdefgh') // 9 bajtów z końcem linii, mieści się
  appendLine('xyz') // 9 + 4 > 12, już nie
  appendLine('qwerty')

  const names = readdirSync(diagnosticsDir())
  const content = readFileSync(join(diagnosticsDir(), names[0]!), 'utf8')
  expect(content).toContain('abcdefgh')
  expect(content).not.toContain('xyz')
  expect(content).not.toContain('qwerty')
  expect(content.match(/sufit/g)).toHaveLength(1)
})

test('plik zastany pod tą samą nazwą dolicza się do sufitu', () => {
  /*
   * Nazwa pliku NIE jest unikalna: dwa okna, które zaczęły pisać w tej samej
   * sekundzie, trafiają w ten sam plik (ta gałąź świadomie nie bierze
   * `requestSingleInstanceLock`). Gdyby sufit liczył się od zera, drugie okno
   * dostałoby pełny budżet na plik już zapisany przez pierwsze.
   */
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date(2026, 9, 16, 22, 31, 5))
    mkdirSync(diagnosticsDir(), { recursive: true })
    // Dokładnie 12 bajtów, czyli cały sufit podany niżej.
    writeFileSync(join(diagnosticsDir(), 'lobby-2026-10-16-223105.log'), 'juz tu jest\n', 'utf8')
    createLobbyLogAppender(workDir, 12)('nowa')
  } finally {
    vi.useRealTimers()
  }

  const content = readFileSync(join(diagnosticsDir(), 'lobby-2026-10-16-223105.log'), 'utf8')
  expect(content).toContain('juz tu jest')
  expect(content).not.toContain('nowa')
  expect(content).toContain('sufit')
})

test('nieudane otwarcie dziennika nie rzuca i nie przewraca aplikacji', () => {
  // Plik w miejscu katalogu: `mkdirSync` pada, a dziennik jest dodatkiem —
  // pełny dysk ani odebrane uprawnienia nie mają prawa przewrócić sesji.
  writeFileSync(diagnosticsDir(), 'to nie katalog', 'utf8')
  const appendLine = createLobbyLogAppender(workDir)
  expect(() => appendLine('linia')).not.toThrow()
})

test('nieudane otwarcie nie jest ponawiane w tej samej sesji', () => {
  // Nieudane otwarcie zostaje nieudane do restartu: ponawianie przy każdej
  // linii znaczyłoby, że po zniknięciu przeszkody sesja zakłada plik ze
  // ZNACZNIKIEM Z PÓŹNIEJSZEJ GODZINY i dzieli się na dwa dzienniki, których
  // nazwy kłamią o tym, kiedy się zaczęły.
  writeFileSync(diagnosticsDir(), 'to nie katalog', 'utf8')
  const appendLine = createLobbyLogAppender(workDir)
  appendLine('pierwsza, otwarcie padło')
  rmSync(diagnosticsDir())
  appendLine('druga, przeszkoda już zniknęła')
  expect(existsSync(diagnosticsDir())).toBe(false)
})

test('nazwa pliku dziennika sortuje się leksykograficznie zgodnie z czasem', () => {
  // Na tym opiera się retencja wyżej: `logFilesToDelete` sortuje PO NAZWIE.
  const earlier = lobbyLogFileName(new Date(2026, 9, 16, 22, 31, 5).getTime())
  const later = lobbyLogFileName(new Date(2026, 9, 16, 22, 31, 6).getTime())
  expect(earlier).toBe('lobby-2026-10-16-223105.log')
  expect(earlier < later).toBe(true)
  // Rozszerzenie MUSI być inne niż `.jsonl` plików próbek — patrz test retencji.
  expect(LOBBY_LOG_SUFFIX).not.toBe('.jsonl')
  expect(LOBBY_LOG_FILES_KEPT).toBe(LOG_FILES_KEPT)
})

test('znacznik czasu w nazwie pliku jest JEDEN dla dziennika i dla próbek', () => {
  // `logFileTimestamp` obsługuje od 0.3.4 OBA rodzaje plików w katalogu
  // `diagnostics`: dziennik (`lobby-RRRR-MM-DD-GGmmss.log`) i próbki
  // (`RRRR-MM-DD-GGmmss.jsonl`, składane w `openLog`
  // z `src/main/diagnosticsRecorder.ts`, którego nie da się
  // wczytać w gołym vitest, bo importuje `app`). Ten test jest więc jedynym
  // miejscem, które pilnuje układu nazwy pliku PRÓBEK — a na tym układzie
  // opiera się retencja, bo `logFilesToDelete` sortuje po nazwie.
  const at = new Date(2026, 9, 16, 22, 31, 5).getTime()
  expect(logFileTimestamp(at)).toBe('2026-10-16-223105')
  // Jedna chwila, jeden znacznik: nazwa dziennika to ten sam napis
  // z przedrostkiem i innym rozszerzeniem, a nie druga konwencja.
  expect(lobbyLogFileName(at)).toBe(`lobby-${logFileTimestamp(at)}${LOBBY_LOG_SUFFIX}`)
  // Jednocyfrowe miesiąc, dzień i godzina muszą dostać zero wiodące, inaczej
  // sortowanie leksykograficzne przestaje się zgadzać z czasem.
  expect(logFileTimestamp(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('2026-01-02-030405')
})
