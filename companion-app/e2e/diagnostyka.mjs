// Czy zapis diagnostyczny powstaje, czy pasek zużycia jest bramkowany flagą,
// czy odcisk palca lobby zgadza się między instancjami, czy próbki lecą w
// tempie, które zakładamy, i czy przy żywym strumieniu dochodzą klatki
// WYSTAWIONE widzowi.
//
// UKŁAD — trzy prawdziwe okna Electrona na tej maszynie:
//
//   A  kanał A  z --diagnostics  WIDZ. Jego zapis czytamy.
//   B  kanał A  bez flagi        NADAWCA. Udostępnia ekran (prawdziwy pulpit!).
//   C  kanał B  bez flagi        tylko do porównania odcisku palca.
//
// Role nie są wymienne. `framesPresented` powstaje z elementu <video>, czyli
// po stronie ODBIERAJĄCEJ — strumień wychodzący takich klatek nie ma — a zapis
// czytamy z A, więc to B musi nadawać.
//
// Obraz pulpitu płynie wyłącznie między B i A na tej maszynie. Ten skrypt NIE
// zapisuje żadnego obrazu: czyta DOM, liczniki i plik zapisu z liczbami.
//
// Wymaga działającego serwera sygnalizacyjnego:
//   cd signaling-server && npm start
//
// Uruchomienie (z katalogu companion-app): npm run build && npm run e2e:diagnostyka
// Zmienne: CHANNEL (nazwa kanału A), SCREEN (fragment nazwy ekranu do wyboru,
// domyślnie „Ekran").
//
// Czekanie WARUNKOWE, nie sztywne: lista źródeł pulpitu generuje miniatury
// wszystkich ekranów i okien, a sztywny sleep raz na kilka przebiegów dawał
// „BRAK KARTY" w innych skryptach tego katalogu (patrz sesja-na-zywo.mjs).
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attach, launchApp } from './cdp.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const RUN_ID = Date.now()
const CHANNEL_A = process.env.CHANNEL ?? `diag-e2e-a-${RUN_ID}`
// Nazwa kanału B NIE jest rozszerzeniem nazwy kanału A. Przy `${A}-inny`
// sprawdzenie „podpowiedź zawiera nazwę kanału A" przechodziłoby także dla
// podpowiedzi z kanału B, bo A jest jej podciągiem.
const CHANNEL_B = `diag-e2e-b-${RUN_ID}`
const SCREEN_PATTERN = process.env.SCREEN ?? 'Ekran'
const PORT_A = 9421
const PORT_B = 9422
const PORT_C = 9423

// Trzymać zgodne z src/shared/diagnostics.ts (SAMPLE_INTERVAL_MS i
// STREAMS_STALE_AFTER_MS). Ten skrypt jest .mjs i nie zaimportuje stałych z TS
// bez osobnego kroku budowania — wynik `npm run build` je zaszywa w paczce,
// a import `.ts` wymaga Node 22.18 albo nowszego (tu 22.15). Duplikat jest
// więc świadomy, tak jak FROZEN_FRACTION_POOR w jakosc-odbioru.mjs, ale
// `assertConstantsInSync` pilnuje, żeby nie rozjechał się po cichu.
const SAMPLE_INTERVAL_MS = 1_000
const STREAMS_STALE_AFTER_MS = 3 * SAMPLE_INTERVAL_MS

// Przedział mediany odstępu między próbkami. Luźny celowo: zegar Node nie jest
// dokładny, a tyknięcie dokłada do tego odczyt metryk Electrona. Zacieśnianie
// tego dałoby sprawdzian, który mruga. Mediana, a nie każdy odstęp, żeby
// pojedynczy przeciągnięty takt nie przesądzał o wyniku. (Odczyt GPU, 46,5 ms,
// nie wchodzi tu w ogóle: idzie osobnym, rzadszym zegarem i nie blokuje
// tyknięcia — patrz GPU_POLL_INTERVAL_MS.)
const MEDIAN_GAP_MIN_MS = 0.8 * SAMPLE_INTERVAL_MS
const MEDIAN_GAP_MAX_MS = 1.3 * SAMPLE_INTERVAL_MS

// Jak długo patrzymy na żywy strumień po tym, jak u widza pojawił się obraz.
// Przy 1 Hz to około ośmiu próbek: dość, żeby zobaczyć przyrost klatek, a mało,
// żeby nie trzymać przechwytywania pulpitu dłużej, niż trzeba.
const LIVE_WINDOW_MS = 8_000

/**
 * Pilnuje, żeby stałe zduplikowane wyżej zgadzały się z kodem aplikacji.
 * Uruchamiane PRZED startem okien: sprawdzian z błędnymi progami nie jest wart
 * ani minuty przechwytywania pulpitu.
 */
function assertConstantsInSync() {
  const source = readFileSync(join(__dirname, '..', 'src', 'shared', 'diagnostics.ts'), 'utf8')
  const interval = /export const SAMPLE_INTERVAL_MS = ([\d_]+)/.exec(source)
  const stale = /export const STREAMS_STALE_AFTER_MS = (\d+) \* SAMPLE_INTERVAL_MS/.exec(source)
  if (!interval || !stale) {
    throw new Error(
      'nie rozpoznaję definicji SAMPLE_INTERVAL_MS / STREAMS_STALE_AFTER_MS w ' +
        'src/shared/diagnostics.ts — zaktualizuj stałe na początku e2e/diagnostyka.mjs'
    )
  }
  const sourceInterval = Number(interval[1].replaceAll('_', ''))
  const sourceStale = Number(stale[1]) * sourceInterval
  if (sourceInterval !== SAMPLE_INTERVAL_MS || sourceStale !== STREAMS_STALE_AFTER_MS) {
    throw new Error(
      `stałe w e2e/diagnostyka.mjs (${SAMPLE_INTERVAL_MS} / ${STREAMS_STALE_AFTER_MS} ms) ` +
        `rozjechały się z src/shared/diagnostics.ts (${sourceInterval} / ${sourceStale} ms)`
    )
  }
}

function instanceArgs(channel, extra = []) {
  return [
    '--ts3-server=ts.test.pl:9987',
    `--channel=${channel}`,
    '--signaling=ws://127.0.0.1:8080',
    '--use-fake-device-for-media-stream',
    // Trzy okna startują w tym samym miejscu i przykrywają się nawzajem (patrz
    // placeWindow w sesja-na-zywo.mjs), więc okno widza może być zasłonięte.
    // Te flagi mają panel-uczestnikow.mjs i jakosc-odbioru.mjs z tego samego
    // powodu. Ten sprawdzian mierzy rejestrator, a nie dławienie zasłoniętych
    // okien — to robi dlawienie.mjs — więc ten czynnik wyłączamy.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    ...extra
  ]
}

const SHARE_BUTTON = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Udostępnij ekran/.test(x.textContent))
  return b ? (b.disabled ? 'NIEAKTYWNY' : 'AKTYWNY') : 'BRAK'
})()`

async function waitReady(cdp, label) {
  for (let i = 0; i < 40; i++) {
    if ((await cdp.evaluate(SHARE_BUTTON)) === 'AKTYWNY') return
    await sleep(500)
  }
  throw new Error(`${label}: nie doczekałem się połączenia z serwerem sygnalizacyjnym`)
}

/**
 * Czeka, aż wyrażenie zwróci prawdę. Sztywny `sleep` po kliknięciu nie
 * wystarcza — patrz uwaga na górze pliku.
 */
async function waitFor(cdp, expression, label, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    if (await cdp.evaluate(expression)) return
    await sleep(500)
  }
  throw new Error(`${label}: nie doczekałem się (${attempts * 0.5} s)`)
}

// Ta sama trzykrokowa droga przez wybór źródła co w sesja-na-zywo.mjs; kończy
// się dopiero, gdy nadawca faktycznie przeszedł w stan nadawania.
async function shareScreen(cdp) {
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b=>/Udostępnij ekran/.test(b.textContent)).click()`
  )

  const matcher = `new RegExp(${JSON.stringify(SCREEN_PATTERN)}).test(c.textContent)`
  await waitFor(
    cdp,
    `[...document.querySelectorAll('.source-card')].some(c => ${matcher})`,
    'lista źródeł pulpitu'
  )
  const picked = await cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll('.source-card')].find(c => ${matcher})
    card.click()
    return card.textContent.trim()
  })()`)

  // Przycisk startu jest nieaktywny, dopóki podgląd wybranego źródła nie wstanie.
  await waitFor(
    cdp,
    `(() => {
      const b = [...document.querySelectorAll('button')].find(x=>/Rozpocznij udostępnianie/.test(x.textContent))
      return !!b && !b.disabled
    })()`,
    'przycisk rozpoczęcia udostępniania'
  )
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(x=>/Rozpocznij udostępnianie/.test(x.textContent)).click()`
  )

  // „Zakończ udostępnianie" pojawia się dopiero po udanym starcie: przy błędzie
  // wybór źródła zostaje otwarty, a bez tego kroku odcisk palca w głównym
  // widoku byłby wtedy mylnie obwiniany o to, że go nie ma.
  await waitFor(
    cdp,
    `[...document.querySelectorAll('button')].some(x => /Zakończ udostępnianie/.test(x.textContent))`,
    'przejście nadawcy w stan nadawania'
  )
  return picked
}

// Czekamy, aż u WIDZA pojawi się kafelek z prawdziwym obrazem. Bez tego punkt 5
// mierzyłby pustkę. Zwraca rozmiar obrazu i chwilę, w której go zauważyliśmy
// (zegar ścienny, ten sam co `at` w zapisie); `null`, gdy obrazu nie ma.
async function waitForVideo(cdp, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const size = await cdp.evaluate(`(() => {
      const v = document.querySelector('.tile__video')
      return v && v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : 'BRAK'
    })()`)
    if (size !== 'BRAK') return { size, seenAt: Date.now() }
    await sleep(500)
  }
  return null
}

// Stan elementów <video> widza odczytany wprost z DOM, bez udziału
// rejestratora. Służy jako prawda odniesienia: gdy zapis mówi `null`, a tu jest
// liczba dodatnia, zepsute jest przekazywanie; gdy tu też zero, klatek nie
// było (zasłonięte okno, nieruchomy pulpit).
const VIDEO_PROBE = `(() => JSON.stringify({
  visibility: document.visibilityState,
  focus: document.hasFocus(),
  videos: [...document.querySelectorAll('video.tile__video')].map((v) => {
    const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null
    return {
      peerId: v.dataset.peerId ?? null,
      kind: v.dataset.streamKind ?? null,
      size: v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : 'BRAK',
      presented: q ? q.totalVideoFrames : null,
      dropped: q ? q.droppedVideoFrames : null
    }
  })
}))()`

const FINGERPRINT = `(() => {
  const el = document.querySelector('.peers__room')
  return el ? JSON.stringify({ text: el.textContent.trim(), title: el.getAttribute('title') }) : null
})()`

const BADGE = `(() => {
  const el = document.querySelector('.resource-badge')
  return el ? el.textContent.trim() : null
})()`

const isPresent = (value) => value !== null && value !== undefined

/**
 * Rozbiera linie pliku zapisu na próbki i notki.
 *
 * Ostatnia linia może być niedopisana, bo czytamy plik, do którego aplikacja
 * jeszcze pisze — jej nieczytelność nie jest błędem. Każda wcześniejsza jest.
 *
 * Notkę (`{ note: ... }`) rejestrator dopisuje tylko raz, po osiągnięciu sufitu
 * rozmiaru pliku (diagnosticsRecorder.ts), więc w krótkim przebiegu jej nie ma.
 * Rozpoznajemy ją po polu `note`, a nie po braku `at`: w drugim wariancie próbka
 * z uciętym polem `at` znikałaby po cichu zamiast zostać zgłoszona.
 */
function parseRecording(lines) {
  const samples = []
  const notes = []
  const brokenLines = []
  lines.forEach((line, index) => {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      if (index !== lines.length - 1) brokenLines.push(index + 1)
      return
    }
    if (entry !== null && typeof entry === 'object' && 'note' in entry) notes.push(entry)
    else samples.push(entry)
  })
  return { samples, notes, brokenLines }
}

/** Czego brakuje w próbce, żeby była pełnoprawnym wpisem zapisu. */
function sampleProblems(entry) {
  if (entry === null || typeof entry !== 'object') return ['wpis nie jest obiektem']
  const problems = []
  if (typeof entry.at !== 'number') problems.push('at nie jest liczbą')
  // Znacznik instancji musi być w KAŻDEJ linii: dwa okna z flagą piszą do
  // katalogu naraz (ta gałąź nie bierze requestSingleInstanceLock), a bez
  // znacznika przeplecionych serii nie da się rozdzielić nawet ręcznie.
  if (typeof entry.instanceId !== 'string' || entry.instanceId === '') {
    problems.push('instanceId nie jest niepustym tekstem')
  }
  if (entry.system === null || typeof entry.system !== 'object') {
    problems.push('brak system')
  } else {
    if (typeof entry.system.cpuPercent !== 'number') problems.push('system.cpuPercent nie jest liczbą')
    if (typeof entry.system.memoryMb !== 'number') problems.push('system.memoryMb nie jest liczbą')
    // `null` jest tu prawidłowe (brak nvidia-smi); brak samego pola nie.
    if (!('gpu' in entry.system)) problems.push('brak system.gpu')
  }
  if (!Array.isArray(entry.streams)) problems.push('streams nie jest tablicą')
  if (!('streamsAgeMs' in entry)) problems.push('brak streamsAgeMs')
  return problems
}

/**
 * Punkt 4: tempo próbek. Liczymy z CAŁEGO pliku, nie tylko z okna strumienia —
 * rejestrator tyka od startu aplikacji, a im więcej odstępów, tym stabilniejsza
 * mediana.
 */
function checkTempo(samples, fail) {
  const stamps = samples.filter((entry) => typeof entry?.at === 'number')
  const gaps = stamps.slice(1).map((entry, i) => entry.at - stamps[i].at)
  if (gaps.length < 4) {
    fail(`[4 tempo] za mało próbek, żeby ocenić tempo: ${stamps.length}`)
    return
  }
  const sorted = [...gaps].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  console.log(
    `  odstępy: mediana ${median} ms, min ${sorted[0]}, max ${sorted[sorted.length - 1]} ` +
      `(z ${gaps.length})`
  )
  if (median < MEDIAN_GAP_MIN_MS || median > MEDIAN_GAP_MAX_MS) {
    fail(
      `[4 tempo] mediana odstępu ${median} ms, oczekiwane ~${SAMPLE_INTERVAL_MS} ms ` +
        `(dozwolone ${MEDIAN_GAP_MIN_MS}-${MEDIAN_GAP_MAX_MS} ms)`
    )
  }
}

const sameStream = (a, b) =>
  a.peerId === b.peerId && a.kind === b.kind && a.direction === b.direction

/**
 * Punkt 5: żywy strumień. `live` to próbki zapisane od chwili, gdy u widza
 * pojawił się obraz — nie cały plik: dane z rozruchu aplikacji (przed
 * jakimkolwiek strumieniem) nie mówią nic o tym, czy renderer nadąża przy
 * strumieniu, a ich ewentualne wolne takty dawałyby fałszywe alarmy.
 */
function checkLiveStream(live, fail) {
  console.log(`  próbek z czasu strumienia: ${live.length}`)
  if (live.length === 0) {
    fail('[5 klatki] w czasie strumienia rejestrator nie zapisał żadnej próbki')
    return
  }

  // Strumień wskazujemy po (peerId, kind, direction), nie po pozycji w tablicy:
  // `diagnosticConnections` (session.ts) składa wpisy z dwóch Map w kolejności
  // wstawiania, więc ponowne nawiązanie połączenia przestawia je na koniec.
  // Wzór bierzemy z najnowszej próbki, w której widz w ogóle coś odbiera.
  let reference = null
  for (let i = live.length - 1; i >= 0 && reference === null; i--) {
    const streams = Array.isArray(live[i].streams) ? live[i].streams : []
    reference =
      streams.find((s) => s.direction === 'inbound' && s.kind === 'screen') ?? null
  }

  if (reference === null) {
    fail(
      '[5 klatki] w żadnej próbce z czasu strumienia nie ma wpisu przychodzącego ekranu, ' +
        'choć widz ma obraz — diagnosticConnections() niczego nie oddaje'
    )
  } else {
    const series = live
      .map((entry) => (Array.isArray(entry.streams) ? entry.streams : []).find((s) => sameStream(s, reference)))
      .filter(Boolean)
    const presented = series
      .map((s) => s.framesPresented)
      .filter((value) => typeof value === 'number')
    console.log(`  próbek z framesPresented: ${presented.length} z ${live.length}`)

    if (presented.length === 0) {
      fail(
        '[5 klatki] framesPresented zostaje null we wszystkich próbkach — klatki WYSTAWIONE ' +
          'widzowi nie docierają do zapisu (sprawdź dopasowanie peerId i rodzaju między ' +
          'StreamTile a diagnosticConnections w useDiagnosticsReporter.ts)'
      )
    } else if (presented.length < 2) {
      fail('[5 klatki] framesPresented było liczbą tylko w jednej próbce — nie da się ocenić przyrostu')
    } else {
      const first = presented[0]
      const final = presented[presented.length - 1]
      console.log(`  framesPresented: ${first} -> ${final}`)
      if (final === 0) {
        fail('[5 klatki] framesPresented jest zerem, choć widz ma obraz')
      } else if (!(final > first)) {
        fail(
          '[5 klatki] framesPresented nie rośnie przy żywym strumieniu ' +
            '(nieruchomy pulpit daje bardzo mało klatek — poruszaj oknem lub myszą i powtórz)'
        )
      }
    }
  }

  const ages = live.map((entry) => entry.streamsAgeMs).filter((age) => typeof age === 'number')
  if (ages.length === 0) {
    fail('[5 klatki] streamsAgeMs nigdy nie było liczbą — renderer nie przysłał nic ani razu')
  } else {
    const worstAge = Math.max(...ages)
    console.log(`  najgorszy streamsAgeMs: ${worstAge} ms (z ${ages.length} próbek)`)
    // `>=`, bo tak samo rozstrzyga `streamsFreshness`: wiek równy progowi jest
    // już przestarzały, a panel pokazałby wtedy ostrzeżenie o milczeniu.
    if (worstAge >= STREAMS_STALE_AFTER_MS) {
      fail(
        `[5 klatki] dane o strumieniach starzeją się do ${worstAge} ms ` +
          `(próg przestarzałości ${STREAMS_STALE_AFTER_MS} ms) — renderer nie nadąża`
      )
    }
  }
}

const processes = []
const attached = []
let exitCode = 0

const fail = (message) => {
  console.error(`BŁĄD: ${message}`)
  exitCode = 1
}

// B przechwytuje pulpit tej maszyny. Przerwanie skryptu (Ctrl+C) przed blokiem
// `finally` mogłoby zostawić osierocone okna Electrona z działającym
// przechwytywaniem, więc sprzątamy także przy wyjściu i na sygnały.
const killAll = () => {
  for (const proc of processes) proc.kill()
}
process.on('exit', killAll)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130))

/** Własny katalog danych instancji A, żeby wiedzieć, gdzie szukać zapisu. */
const dataDirA = mkdtempSync(join(tmpdir(), 'ts3-diag-e2e-'))

try {
  assertConstantsInSync()

  processes.push(launchApp(PORT_A, instanceArgs(CHANNEL_A, ['--diagnostics']), dataDirA))
  processes.push(launchApp(PORT_B, instanceArgs(CHANNEL_A)))
  processes.push(launchApp(PORT_C, instanceArgs(CHANNEL_B)))

  const A = await attach(PORT_A)
  attached.push(A)
  const B = await attach(PORT_B)
  attached.push(B)
  const C = await attach(PORT_C)
  attached.push(C)

  await waitReady(A, 'A (widz, z diagnostyką)')
  await waitReady(B, 'B (nadawca, bez flagi)')
  await waitReady(C, 'C (inny kanał)')

  console.log('Trzy instancje gotowe. B zaczyna udostępniać...')
  let streamSeenAt = null
  try {
    const picked = await shareScreen(B)
    console.log(`B nadaje: „${picked}"`)
    const video = await waitForVideo(A)
    if (video === null) {
      fail('[5 klatki] u widza nie pojawił się obraz — punkt 5 nie ma czego mierzyć')
    } else {
      console.log(`Obraz u widza: ${video.size}`)
      streamSeenAt = video.seenAt
    }
  } catch (err) {
    fail(
      `[przygotowanie] B nie zaczęło udostępniać, punkt 5 nie ma czego mierzyć: ` +
        `${err instanceof Error ? err.message : String(err)}`
    )
  }

  if (streamSeenAt !== null) {
    await sleep(LIVE_WINDOW_MS)
    console.log('\n=== WIDZ (wprost z DOM, bez udziału rejestratora) ===')
    console.log(' ', await A.evaluate(VIDEO_PROBE))
  }

  // --- 1. plik zapisu ---
  // Katalog userData NIE jest tu domyślnym APPDATA: podajemy aplikacji własny
  // --user-data-dir, żeby przebiegi się nie mieszały, i czytamy z niego wprost.
  // Nazwa pliku to data i godzina startu sesji (`YYYY-MM-DD-HHmmss.jsonl`),
  // nie sama data: każda sesja dostaje własny plik, żeby mieć własny
  // budżet sufitu rozmiaru. Wzorzec jest ścisły, bo to on pilnuje układu nazwy,
  // na którym opiera się retencja (sortowanie leksykograficzne = sortowanie po
  // czasie). Sort zostaje: dwa okna odpalone w tej samej sekundzie trafiają
  // w jeden plik, a przy różnych sekundach plików jest kilka.
  const base = join(dataDirA, 'diagnostics')
  const files = existsSync(base)
    ? readdirSync(base)
        .filter((name) => /^\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/.test(name))
        .sort()
    : []
  const lines = files.flatMap((name) =>
    readFileSync(join(base, name), 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
  )
  console.log(`\n=== ZAPIS === pliki: ${files.join(', ') || 'brak'}, linii: ${lines.length}`)

  if (files.length === 0) {
    fail('[1 zapis] w userData/diagnostics nie powstał plik YYYY-MM-DD-HHmmss.jsonl')
  } else if (lines.length === 0) {
    fail('[1 zapis] plik zapisu jest pusty')
  } else {
    const { samples, notes, brokenLines } = parseRecording(lines)
    console.log(`  próbek: ${samples.length}, notek: ${notes.length}`)
    if (brokenLines.length > 0) {
      fail(`[1 zapis] linie nie są poprawnym JSON-em: ${brokenLines.join(', ')}`)
    }
    if (samples.length === 0) {
      fail('[1 zapis] w pliku nie ma ani jednej próbki')
    } else {
      const withProblems = samples
        .map((entry) => ({ entry, problems: sampleProblems(entry) }))
        .filter((item) => item.problems.length > 0)
      if (withProblems.length > 0) {
        fail(
          `[1 zapis] ${withProblems.length} z ${samples.length} próbek ma wadliwe pola, ` +
            `np. ${withProblems[0].problems.join('; ')}`
        )
      }
      console.log('  ostatnia próbka, system:', JSON.stringify(samples[samples.length - 1]?.system))

      // --- 4. tempo próbek ---
      checkTempo(samples, fail)

      // --- 5. klatki wystawione i wiek danych ---
      if (streamSeenAt !== null) {
        const live = samples.filter(
          (entry) => typeof entry?.at === 'number' && entry.at >= streamSeenAt
        )
        checkLiveStream(live, fail)
      }
    }
  }

  // --- 2. pasek zużycia ---
  const badgeA = await A.evaluate(BADGE)
  const badgeB = await B.evaluate(BADGE)
  console.log(`\n=== PASEK === z flagą: ${badgeA} | bez flagi: ${badgeB}`)
  if (!isPresent(badgeA)) fail('[2 pasek] brak paska zużycia w instancji z flagą')
  if (isPresent(badgeB)) {
    fail('[2 pasek] pasek pokazał się BEZ flagi — diagnostyka nie jest bramkowana')
  }

  // --- 3. odcisk palca ---
  const fpA = JSON.parse((await A.evaluate(FINGERPRINT)) ?? 'null')
  const fpB = JSON.parse((await B.evaluate(FINGERPRINT)) ?? 'null')
  const fpC = JSON.parse((await C.evaluate(FINGERPRINT)) ?? 'null')
  console.log('\n=== ODCISK PALCA ===')
  console.log('  A:', JSON.stringify(fpA))
  console.log('  B:', JSON.stringify(fpB))
  console.log('  C:', JSON.stringify(fpC))

  if (!fpA || !fpB || !fpC) {
    fail(
      '[3 odcisk] odcisk palca nie jest widoczny we wszystkich instancjach ' +
        '(ma działać BEZ flagi — to jego cały sens)'
    )
  } else {
    if (fpA.text !== fpB.text) {
      fail(`[3 odcisk] ten sam kanał dał różne odciski: ${fpA.text} kontra ${fpB.text}`)
    }
    if (fpA.text === fpC.text) fail('[3 odcisk] różne kanały dały ten sam odcisk')
    // Dymek ma nazywać OBA wejścia. Numer kanału jest tą jedną wartością,
    // która realnie różni się między osobami z jednego serwera TS3.
    if (!fpA.title?.includes(CHANNEL_A)) fail('[3 odcisk] podpowiedź A nie zawiera numeru kanału')
    if (!fpC.title?.includes(CHANNEL_B)) fail('[3 odcisk] podpowiedź C nie zawiera numeru kanału')
    if (!fpA.title?.includes('ts.test.pl:9987')) {
      fail('[3 odcisk] podpowiedź nie zawiera identyfikatora serwera')
    }
  }

  if (exitCode === 0) {
    console.log('\nOK: zapis powstaje, tempo się trzyma, klatki wystawione rosną,')
    console.log('    pasek jest bramkowany, odcisk się zgadza.')
  }
} catch (err) {
  console.error('\nBŁĄD sprawdzianu:', err instanceof Error ? err.message : String(err))
  exitCode = 1
} finally {
  for (const cdp of attached) cdp.close()
  killAll()
  await sleep(500)
}

process.exit(exitCode)
