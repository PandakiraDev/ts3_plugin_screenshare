// Czy osierocony ostatni kafelek stoi na ŚRODKU siatki — sprawdzone na
// prawdziwym układzie CSS, w prawdziwym oknie.
//
// Dlaczego nie w testach jednostkowych: wyśrodkowanie robią cztery kolumny
// i `grid-column: 2 / span 2` (reguła `.siatka[data-sierota]` w styles.css).
// jsdom nie liczy układu siatki CSS — `getBoundingClientRect()` zwraca tam
// zera, więc test w Node przeszedłby przy KAŻDEJ regule, także przy złej.
//
// UKŁAD — trzy prawdziwe okna Electrona na tej maszynie, jeden kanał:
//
//   A  WIDZ. Z jego DOM-u czytamy siatkę. Na koniec sam dokłada swój ekran.
//   B  NADAWCA: ekran, potem kamera.
//   C  NADAWCA: ekran, potem kamera.
//
// Jeden przebieg, narastająco, bez restartu instancji:
//
//   kafelków u A | nadaje B        | nadaje C        | nadaje A
//   -------------|-----------------|-----------------|---------
//   3            | ekran + kamera  | ekran           | nic
//   4            | ekran + kamera  | ekran + kamera  | nic
//   5            | ekran + kamera  | ekran + kamera  | ekran
//
// Sprawdzamy TRZY ORAZ PIĘĆ kafelków, nie tylko trzy: `data-ile` jest przycięte
// `Math.min(…, 4)`, więc przy pięciu kafelkach wynosi też 4. Sprawdzian tylko
// na trzech przeszedłby także dla reguły opartej na `data-ile="3"`, czyli nie
// odróżniłby poprawki pełnej od połowicznej, w której piąty kafelek zostaje
// osierocony przy lewej ściance. Cztery kafelki to przypadek odwrotny: tam
// wyśrodkowania być NIE MA, inaczej reguła zapalałaby się zawsze.
//
// Czego ten skrypt NIE sprawdza: przeciągania kafelków uchwytem. Udawanie
// przechwycenia wskaźnika przez CDP jest zawodne w drugą stronę — skrypt
// naśladujący gest potrafi przejść wtedy, gdy prawdziwy gest myszą nie działa,
// a to gorsze niż brak sprawdzianu, bo daje fałszywe poczucie bezpieczeństwa.
// Przestawianie zostaje do sprawdzenia ludzkim okiem.
//
// UWAGA: skrypt otwiera trzy prawdziwe okna aplikacji i każde z nich
// PRZECHWYTUJE PULPIT tej maszyny. Żadnego obrazu nie zapisuje — czyta tylko
// liczby z DOM-u (prostokąty kafelków) — ale obraz pulpitu faktycznie płynie
// między instancjami.
//
// Wymaga działającego serwera sygnalizacyjnego:
//   cd signaling-server && npm start
//
// Uruchomienie (z katalogu companion-app): npm run build && npm run e2e:siatka
// Zmienne: CHANNEL (nazwa kanału), SCREEN (fragment nazwy ekranu do wyboru,
// domyślnie „Ekran").
import { attach, launchApp } from './cdp.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const CHANNEL = process.env.CHANNEL ?? `siatka-e2e-${Date.now()}`
const SCREEN_PATTERN = process.env.SCREEN ?? 'Ekran'
const PORT_A = 9431
const PORT_B = 9432
const PORT_C = 9433

/**
 * Dopuszczalny rozjazd w pikselach. Matematycznie środek osieroconego kafelka
 * wypada DOKŁADNIE na środku siatki (cztery kolumny `1fr`, kafelek na drugiej
 * i trzeciej), więc te dwa piksele są tylko na zaokrąglenia subpikselowe
 * przeglądarki, nie na zapas „gdzieś koło środka".
 */
const TOLERANCE_PX = 2

/**
 * Odstęp między pomiarami stabilizacji i liczba zgodnych pomiarów z rzędu.
 *
 * TO NIE JEST ZBĘDNE — bez tego skrypt mierzyłby kafelki W RUCHU i dawał złe
 * liczby. Dwie animacje nakładają na kafelek `transform`, a
 * `getBoundingClientRect()` zwraca prostokąt PO transformacji:
 *   - `tile-in` (400 ms, styles.css) skaluje wchodzący kafelek od 0.78 przez
 *     1.04 do 1 — w jej trakcie `lastWidth` jest po prostu inne niż docelowe;
 *   - FLIP z `useReorderAnimation.ts` (200 ms) przejeżdża kafelki
 *     transformacją po KAŻDEJ zmianie układu, a tu zmiana układu jest przy
 *     każdym kroku scenariusza: dołożenie kafelka przestawia pozostałe (własne
 *     strumienie idą w `buildTiles` na początek listy), a zapalenie
 *     `data-sierota` przebudowuje siatkę z dwóch kolumn na cztery.
 *
 * Trzy zgodne pomiary co 250 ms to 500 ms bez ruchu, czyli dłużej niż
 * najdłuższa z tych animacji. Dwa pomiary (250 ms) by nie wystarczyły: krzywa
 * `tile-in` przechodzi przez skalę 1 dwa razy (przeskakuje ponad nią i wraca),
 * więc dwa pomiary w jej trakcie mogą się zgodzić przypadkiem.
 */
const SETTLE_GAP_MS = 250
const SETTLE_SAMPLES = 3

function instanceArgs(extra = []) {
  return [
    '--ts3-server=ts.test.pl:9987',
    `--channel=${CHANNEL}`,
    '--signaling=ws://127.0.0.1:8080',
    '--use-fake-device-for-media-stream',
    // Trzy okna startują w tym samym miejscu i przykrywają się nawzajem, więc
    // okno widza może być zasłonięte. Te same flagi mają diagnostyka.mjs
    // i panel-uczestnikow.mjs. Tu są nie tylko dla tempa: zdławiony renderer
    // przerysowuje siatkę z opóźnieniem, a my czekamy właśnie na ustanie ruchu.
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

/**
 * Pomiar siatki u widza.
 *
 * Kafelki wskazujemy selektorem `:scope > [data-tile-key]`, a nie przez
 * `grid.children` — tak samo liczy je kod produkcyjny (LobbyView.tsx
 * i useReorderAnimation.ts). Dziecko siatki bez klucza nie jest kafelkiem
 * i nie ma go wliczać ani sprawdzian, ani aplikacja.
 */
const MEASURE = `(() => {
  const grid = document.querySelector('.siatka')
  if (!grid) return JSON.stringify({ error: 'brak siatki' })
  const tiles = [...grid.querySelectorAll(':scope > [data-tile-key]')]
  if (tiles.length === 0) return JSON.stringify({ error: 'brak kafelkow' })
  const last = tiles[tiles.length - 1]
  const g = grid.getBoundingClientRect()
  const l = last.getBoundingClientRect()
  const f = tiles[0].getBoundingClientRect()
  return JSON.stringify({
    count: tiles.length,
    orphan: grid.hasAttribute('data-sierota'),
    columnsAttribute: grid.getAttribute('data-ile'),
    gridCenter: g.left + g.width / 2,
    lastCenter: l.left + l.width / 2,
    lastWidth: l.width,
    firstWidth: f.width,
    keys: tiles.map((t) => t.dataset.tileKey)
  })
})()`

/** Czeka aż lobby.state.connection === 'ready' — sygnalizowane odblokowaniem przycisku. */
async function waitReady(cdp, label) {
  for (let i = 0; i < 40; i++) {
    if ((await cdp.evaluate(SHARE_BUTTON)) === 'AKTYWNY') return
    await sleep(500)
  }
  throw new Error(`${label}: nie doczekałem się połączenia z serwerem sygnalizacyjnym`)
}

/**
 * Czeka, aż wyrażenie zwróci prawdę. Czekanie WARUNKOWE, nie sztywny `sleep`:
 * lista źródeł pulpitu generuje miniatury wszystkich ekranów i okien, a sztywny
 * odstęp raz na kilka przebiegów dawał „BRAK KARTY" w innych skryptach tego
 * katalogu (patrz sesja-na-zywo.mjs).
 */
async function waitFor(cdp, expression, label, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    if (await cdp.evaluate(expression)) return
    await sleep(500)
  }
  throw new Error(`${label}: nie doczekałem się (${attempts * 0.5} s)`)
}

// Ta sama trzykrokowa droga przez wybór źródła co w diagnostyka.mjs; kończy się
// dopiero, gdy nadawca faktycznie przeszedł w stan nadawania.
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
  // wybór źródła zostaje otwarty, a wtedy u nadawcy nie ma w ogóle siatki
  // (LobbyView wychodzi wcześniej przy otwartym wyborze źródła) i mylnie
  // obwinialibyśmy o to pomiar.
  await waitFor(
    cdp,
    `[...document.querySelectorAll('button')].some(x => /Zakończ udostępnianie/.test(x.textContent))`,
    'przejście nadawcy w stan nadawania'
  )
  return picked
}

// Ta sama droga do kamery co w kamera.mjs: guzik w pasku akcji, atrapa
// urządzenia z `--use-fake-device-for-media-stream` (Electron 33 wpuszcza do
// niej bez okna zgody).
function cameraButton(regex) {
  return `(() => {
    const b = [...document.querySelectorAll('button')].find(x=>${regex}.test(x.textContent))
    if (!b) return 'BRAK PRZYCISKU'
    if (b.disabled) return 'NIEAKTYWNY'
    b.click(); return 'ok'
  })()`
}
const enableCamera = (cdp) => cdp.evaluate(cameraButton('/Włącz kamerę/'))

/** Odcisk pomiaru zaokrąglony do pełnych pikseli — po nim poznajemy ustanie ruchu. */
function fingerprint(measurement) {
  return [
    measurement.count,
    measurement.orphan,
    Math.round(measurement.gridCenter),
    Math.round(measurement.lastCenter),
    Math.round(measurement.lastWidth),
    Math.round(measurement.firstWidth)
  ].join('|')
}

/**
 * Czeka, aż siatka u widza ma `expected` kafelków ORAZ przestaje się ruszać,
 * i zwraca dopiero ten ostatni, nieruchomy pomiar. Oba warunki są konieczne —
 * powód przy SETTLE_GAP_MS wyżej.
 */
async function waitForSettledGrid(cdp, expected, attempts = 160) {
  let latest = null
  let previousMark = null
  let streak = 0

  for (let i = 0; i < attempts; i++) {
    latest = JSON.parse(await cdp.evaluate(MEASURE))
    if (latest.error === undefined && latest.count === expected) {
      const mark = fingerprint(latest)
      streak = mark === previousMark ? streak + 1 : 1
      previousMark = mark
      if (streak >= SETTLE_SAMPLES) return latest
    } else {
      previousMark = null
      streak = 0
    }
    await sleep(SETTLE_GAP_MS)
  }

  throw new Error(
    `nie doczekałem się nieruchomej siatki o ${expected} kafelkach ` +
      `(${((attempts * SETTLE_GAP_MS) / 1000).toFixed(0)} s); ostatni odczyt: ${JSON.stringify(latest)}`
  )
}

const errors = []
const fail = (message) => {
  errors.push(message)
  console.error('BŁĄD:', message)
}

/** Przy nieparzystej liczbie kafelków: atrybut jest, ostatni kafelek na środku. */
function checkCentered(label, m) {
  if (!m.orphan) {
    fail(
      `${label}: siatka nie ma atrybutu data-sierota, choć kafelków jest ${m.count} ` +
        `(nieparzysta liczba w układzie dwukolumnowym)`
    )
  }

  const offset = Math.abs(m.lastCenter - m.gridCenter)
  if (offset > TOLERANCE_PX) {
    fail(
      `${label}: ostatni kafelek nie stoi na środku — środek siatki ` +
        `${m.gridCenter.toFixed(1)} px, środek kafelka ${m.lastCenter.toFixed(1)} px, ` +
        `rozjazd ${offset.toFixed(1)} px (dopuszczalne ${TOLERANCE_PX} px)`
    )
  }

  // Bez tej asercji sprawdzian wyśrodkowania przeszedłby także dla reguły
  // `grid-column: 1 / -1`, czyli dla osieroconego kafelka rozciągniętego na
  // całą szerokość. Ma być TA SAMA szerokość co pozostałych, tylko wyśrodkowana.
  const widthDifference = Math.abs(m.lastWidth - m.firstWidth)
  if (widthDifference > TOLERANCE_PX) {
    fail(
      `${label}: osierocony kafelek ma inną szerokość niż pozostałe — ` +
        `${m.lastWidth.toFixed(1)} px kontra ${m.firstWidth.toFixed(1)} px ` +
        `(rozjazd ${widthDifference.toFixed(1)} px, dopuszczalne ${TOLERANCE_PX} px)`
    )
  }
}

/** Przy parzystej liczbie kafelków: atrybutu nie ma, ostatni kafelek przy prawej. */
function checkNotCentered(label, m) {
  if (m.orphan) {
    fail(
      `${label}: siatka ma atrybut data-sierota przy ${m.count} kafelkach — ` +
        `reguła zapala się zawsze, nie tylko przy nieparzystej liczbie`
    )
  }

  // Ostatni z czterech kafelków stoi w prawej kolumnie, czyli jego środek jest
  // o pół kolumny (czyli o pół szerokości kafelka) od środka siatki. Próg to
  // czwarta część szerokości, nie te same dwa piksele co wyżej: rozjazd rzędu
  // trzech pikseli formalnie przeszedłby warunek „nie na środku", a w istocie
  // znaczyłby, że kafelek jest wyśrodkowany byle jak — czyli też usterkę.
  const offset = Math.abs(m.lastCenter - m.gridCenter)
  const minimumOffset = m.lastWidth / 4
  if (offset < minimumOffset) {
    fail(
      `${label}: ostatni z ${m.count} kafelków jest (prawie) wyśrodkowany — ` +
        `rozjazd ${offset.toFixed(1)} px przy szerokości kafelka ${m.lastWidth.toFixed(1)} px, ` +
        `oczekiwano co najmniej ${minimumOffset.toFixed(1)} px`
    )
  }
}

function report(label, m) {
  console.log(
    `\n=== ${label} ===\n` +
      `  kafelków: ${m.count}, data-sierota: ${m.orphan}, data-ile: ${m.columnsAttribute}\n` +
      `  środek siatki: ${m.gridCenter.toFixed(1)} px, środek ostatniego: ${m.lastCenter.toFixed(1)} px, ` +
      `rozjazd: ${Math.abs(m.lastCenter - m.gridCenter).toFixed(1)} px\n` +
      `  szerokość: ostatni ${m.lastWidth.toFixed(1)} px, pierwszy ${m.firstWidth.toFixed(1)} px\n` +
      `  klucze: ${JSON.stringify(m.keys)}`
  )
}

const processes = []
const attached = []

// Wszystkie trzy instancje przechwytują pulpit tej maszyny. Przerwanie skryptu
// (Ctrl+C) przed blokiem `finally` mogłoby zostawić osierocone okna Electrona
// z działającym przechwytywaniem, więc sprzątamy także przy wyjściu i na sygnały.
const killAll = () => {
  for (const proc of processes) proc.kill()
}
process.on('exit', killAll)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130))

try {
  for (const port of [PORT_A, PORT_B, PORT_C]) processes.push(launchApp(port, instanceArgs()))

  const A = await attach(PORT_A)
  attached.push(A)
  const B = await attach(PORT_B)
  attached.push(B)
  const C = await attach(PORT_C)
  attached.push(C)

  await waitReady(A, 'A (widz)')
  await waitReady(B, 'B (nadawca)')
  await waitReady(C, 'C (nadawca)')
  console.log(`Trzy instancje w kanale ${CHANNEL}.`)

  // --- trzy kafelki u A: ekran i kamera od B, ekran od C ---
  console.log(`B nadaje: „${await shareScreen(B)}"`)
  console.log('B włącza kamerę:', await enableCamera(B))
  console.log(`C nadaje: „${await shareScreen(C)}"`)

  const three = await waitForSettledGrid(A, 3)
  report('TRZY KAFELKI', three)
  checkCentered('trzy kafelki', three)

  // --- cztery kafelki: C dokłada kamerę, wyśrodkowania ma NIE być ---
  console.log('\nC włącza kamerę:', await enableCamera(C))

  const four = await waitForSettledGrid(A, 4)
  report('CZTERY KAFELKI', four)
  checkNotCentered('cztery kafelki', four)

  // --- pięć kafelków: A dokłada swój ekran (własny podgląd z lokalnego capture) ---
  console.log(`\nA nadaje własny ekran: „${await shareScreen(A)}"`)

  const five = await waitForSettledGrid(A, 5)
  report('PIĘĆ KAFELKÓW', five)
  checkCentered('pięć kafelków', five)
} catch (err) {
  fail(`wyjątek w trakcie scenariusza: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  for (const cdp of attached) cdp.close()
  killAll()
  await sleep(500)
}

if (errors.length > 0) {
  console.log(`\nZŁE — ${errors.length} problem(ów):`)
  for (const message of errors) console.log(' -', message)
  process.exit(1)
}

console.log('\nOK: osierocony kafelek stoi na środku przy trzech i przy pięciu,')
console.log('    a przy czterech wyśrodkowania nie ma i szerokości się zgadzają.')
process.exit(0)
