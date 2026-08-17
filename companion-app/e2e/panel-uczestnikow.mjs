// Czy panel uczestników pokazuje to, co ma pokazywać, gdy ktoś zaczyna nadawać?
//
// Sprawdzamy DOM u OBU stron, bo każda widzi co innego:
//   - u WIDZA (B): nadawca ma wylądować w sekcji „Nadają" z plakietką ekranu;
//   - u NADAWCY (A): widz ma dostać plakietkę „Ogląda".
//
// Czytamy DOM, a nie stan Reacta, i NIE robimy zrzutów ekranu — sprawdzamy
// dokładnie te klasy, na których stoi interfejs.
//
// Wymaga działającego serwera sygnalizacyjnego:
//   cd signaling-server && npm start
//
// Uruchomienie: npm run build && npm run e2e:panel
import { attach, launchApp } from './cdp.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const CHANNEL = process.env.CHANNEL ?? `panel-e2e-${Date.now()}`
const PORT_A = 9381
const PORT_B = 9382

function instanceArgs() {
  return [
    '--ts3-server=ts.test.pl:9987',
    `--channel=${CHANNEL}`,
    '--signaling=ws://127.0.0.1:8080',
    '--use-fake-device-for-media-stream',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling'
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

async function shareScreen(cdp) {
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b=>/Udostępnij ekran/.test(b.textContent)).click()`
  )
  await sleep(2_500)
  await cdp.evaluate(
    `[...document.querySelectorAll('.source-card')].find(c=>/Ekran/.test(c.textContent)).click()`
  )
  await sleep(2_500)
  return cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x=>/Rozpocznij udostępnianie/.test(x.textContent))
    if (!b) return 'BRAK PRZYCISKU'
    if (b.disabled) return 'NIEAKTYWNY'
    b.click(); return 'ok'
  })()`)
}

/** Zrzut panelu: nagłówki sekcji oraz wiersze z inicjałami i plakietkami. */
const PANEL = `(() => {
  const sections = [...document.querySelectorAll('.peers__section')].map(el => el.textContent.trim())
  const rows = [...document.querySelectorAll('.participant')].map(el => ({
    initials: el.querySelector('.participant__avatar')?.textContent ?? '',
    name: el.querySelector('.participant__name')?.textContent ?? '',
    badges: [...el.querySelectorAll('.badge')].map(b => b.className)
  }))
  return JSON.stringify({ sections, rows })
})()`

async function waitForBadge(cdp, pattern, attempts = 30) {
  let panel = null
  for (let i = 0; i < attempts; i++) {
    panel = JSON.parse(await cdp.evaluate(PANEL))
    if (panel.rows.some((row) => row.badges.some((cls) => pattern.test(cls)))) return panel
    await sleep(500)
  }
  return panel
}

const processes = []
let exitCode = 0
let A = null
let B = null

try {
  for (const port of [PORT_A, PORT_B]) processes.push(launchApp(port, instanceArgs()))

  A = await attach(PORT_A)
  B = await attach(PORT_B)

  await waitReady(A, 'A (nadawca)')
  await waitReady(B, 'B (widz)')
  console.log('Obie instancje w kanale. A zaczyna udostępniać ekran...')
  console.log('start udostępniania u A:', await shareScreen(A))

  // --- u widza: nadawca w sekcji „Nadają", z plakietką ekranu ---
  const atViewer = await waitForBadge(B, /badge--screen/)
  console.log('\n=== PANEL U WIDZA ===')
  console.log('  sekcje:', JSON.stringify(atViewer.sections))
  for (const row of atViewer.rows) {
    console.log(`  [${row.initials}] ${row.name}  ${JSON.stringify(row.badges)}`)
  }

  if (!atViewer.sections.some((text) => /Nadają/.test(text))) {
    console.error('BŁĄD: u widza nie ma sekcji „Nadają", choć ktoś nadaje.')
    exitCode = 1
  }
  if (!atViewer.rows.some((row) => row.badges.some((cls) => /badge--screen/.test(cls)))) {
    console.error('BŁĄD: u widza nie ma plakietki ekranu przy nadawcy.')
    exitCode = 1
  }
  if (atViewer.rows.some((row) => row.initials.trim() === '')) {
    console.error('BŁĄD: któryś krążek jest pusty — inicjały się nie wyliczyły.')
    exitCode = 1
  }

  // --- u nadawcy: widz z plakietką „Ogląda" ---
  const atStreamer = await waitForBadge(A, /badge--watching-/)
  console.log('\n=== PANEL U NADAWCY ===')
  console.log('  sekcje:', JSON.stringify(atStreamer.sections))
  for (const row of atStreamer.rows) {
    console.log(`  [${row.initials}] ${row.name}  ${JSON.stringify(row.badges)}`)
  }

  if (!atStreamer.rows.some((row) => row.badges.some((cls) => /badge--watching-/.test(cls)))) {
    console.error('BŁĄD: u nadawcy nie ma plakietki „Ogląda" przy widzu.')
    exitCode = 1
  }

  if (exitCode === 0) {
    console.log('\nOK: sekcje, krążki i plakietki są po obu stronach.')
  }
} catch (err) {
  console.error('\nBŁĄD sprawdzianu:', err instanceof Error ? err.message : String(err))
  exitCode = 1
} finally {
  A?.close()
  B?.close()
  for (const proc of processes) proc.kill()
  await sleep(500)
}

process.exit(exitCode)
