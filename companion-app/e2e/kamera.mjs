// Dwa niezależne strumienie od JEDNEJ osoby: ekran i kamera to osobne
// RTCPeerConnection (patrz webrtc/session.ts, connectionKey). Sedno tego testu
// to krok K4 — po wyłączeniu kamery ekran ma dalej płynąć. Reszta scenariusza
// przeszłaby nawet przy błędnej implementacji; dopiero porównanie framesReceived
// odbiornika ekranu sprzed i po zgaszeniu kamery wyłapie regres, w którym
// rozdzielenie połączeń jednak zrywa ekran przy sprzątaniu po kamerze.
//
// Kamera fizyczna niepotrzebna: `--use-fake-device-for-media-stream` daje
// Chromium sztuczne urządzenie (1280x720, ~20 kl/s — to ograniczenie atrapy,
// nie błąd kodera) i Electron 33 wpuszcza do niego bez okna zgody.
import { attach, launchApp } from './cdp.mjs'

const CHANNEL = process.env.KANAL ?? `kamera-e2e-${Date.now()}`
const PORT_A = 9351
const PORT_B = 9352
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function instanceArgs(extra) {
  return [
    '--ts3-server=ts.test.pl:9987',
    `--channel=${CHANNEL}`,
    '--signaling=ws://127.0.0.1:8080',
    '--use-fake-device-for-media-stream',
    ...extra
  ]
}

/**
 * Hak na RTCPeerConnection wstrzykiwany PRZED załadowaniem strony (przez
 * Page.addScriptToEvaluateOnNewDocument + reload) — bez tego nie ma jak z Node
 * sięgnąć do konkretnego połączenia po fakcie i zapytać je o getStats().
 * Tylko odbiorca (B) tego potrzebuje; nadawca (A) nie jest tu sprawdzany.
 */
const PC_HOOK = `
  (() => {
    const Original = window.RTCPeerConnection
    window.__pcs = []
    window.RTCPeerConnection = function (...args) {
      const pc = new Original(...args)
      window.__pcs.push(pc)
      return pc
    }
    window.RTCPeerConnection.prototype = Original.prototype
  })()
`

async function withHook(cdp) {
  await cdp.call('Page.enable')
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: PC_HOOK })
  await cdp.call('Page.reload')
}

const SHARE_BUTTON = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Udostępnij ekran/.test(x.textContent))
  return b ? (b.disabled ? 'NIEAKTYWNY' : 'AKTYWNY') : 'BRAK'
})()`

/** Siatka kafelków u odbiorcy: nazwa (z dopiskiem "— ekran" dla ekranu) i czy leci obraz. */
const GRID = `(() => {
  const tiles = [...document.querySelectorAll('.tile')].map(el => {
    const v = el.querySelector('.tile__video')
    return {
      name: el.querySelector('.tile__name').textContent.trim(),
      image: v && v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : 'BRAK'
    }
  })
  return JSON.stringify({ count: tiles.length, tiles })
})()`

/** framesReceived odbiornika WIDEO na zapamiętanym połączeniu ekranu (window.__screenPc). */
const SCREEN_FRAMES = `(async () => {
  const pc = window.__screenPc
  if (!pc) return null
  let frames = null
  ;(await pc.getStats()).forEach(s => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') frames = s.framesReceived
  })
  return frames
})()`

/**
 * Bezpieczny próg dla porównania K4 w klatkach na sekundę. Zdrowy ekran daje
 * tu dziesiątki fps; zerwane połączenie w oknie pomiaru potrafi wciąż wnieść
 * pojedynczą zabłąkaną klatkę (np. z bufora dekodera), więc goły warunek
 * `po > przed` przechodzi nawet przy realnej regresji. Próg fps zamiast
 * progu bezwzględnego, bo okno pomiaru (sleep + polling siatki) nie ma
 * stałej długości — próg w klatkach musiałby się z nim rozjeżdżać.
 */
const MIN_SCREEN_FPS = 5

/** framesReceived + znacznik czasu z tej samej chwili — do liczenia fps okna pomiaru. */
async function readScreenFrames(cdp) {
  const frames = await cdp.evaluate(SCREEN_FRAMES)
  return { frames, time: Date.now() }
}

/** Czeka aż lobby.state.connection === 'ready' — sygnalizowane odblokowaniem przycisku. */
async function waitReady(cdp, label) {
  for (let i = 0; i < 40; i++) {
    if ((await cdp.evaluate(SHARE_BUTTON)) === 'AKTYWNY') return
    await sleep(500)
  }
  throw new Error(`${label}: nie doczekalem sie polaczenia z serwerem sygnalizacyjnym`)
}

/** Czeka aż siatka u odbiorcy pokaże dokładnie `count` kafelków; zwraca ostatni odczyt. */
async function waitForGrid(cdp, count, attempts = 30) {
  let state = null
  for (let i = 0; i < attempts; i++) {
    state = JSON.parse(await cdp.evaluate(GRID))
    if (state.count === count) return state
    await sleep(500)
  }
  return state
}

async function shareScreen(cdp) {
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b=>/Udostępnij ekran/.test(b.textContent)).click()`
  )
  await sleep(2500)
  await cdp.evaluate(
    `[...document.querySelectorAll('.source-card')].find(c=>/Ekran/.test(c.textContent)).click()`
  )
  await sleep(2500)
  return cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x=>/Rozpocznij udostępnianie/.test(x.textContent))
    if (!b) return 'BRAK PRZYCISKU'
    if (b.disabled) return 'NIEAKTYWNY'
    b.click(); return 'ok'
  })()`)
}

function cameraButton(regex) {
  return `(() => {
    const b = [...document.querySelectorAll('button')].find(x=>${regex}.test(x.textContent))
    if (!b) return 'BRAK PRZYCISKU'
    if (b.disabled) return 'NIEAKTYWNY'
    b.click(); return 'ok'
  })()`
}
const enableCamera = (cdp) => cdp.evaluate(cameraButton('/Włącz kamerę/'))
const disableCamera = (cdp) => cdp.evaluate(cameraButton('/Wyłącz kamerę/'))

const a = launchApp(PORT_A, instanceArgs([]))
const b = launchApp(PORT_B, instanceArgs([]))

let A
let B
const errors = []
const fail = (message) => {
  errors.push(message)
  console.log('BLAD:', message)
}

try {
  A = await attach(PORT_A)
  B = await attach(PORT_B)

  // Reload z hakiem na B (potrzebny do K4); dla A zwykłe odczekanie na start
  // wystarczy, bo jego statystyk nigdzie nie sprawdzamy.
  await withHook(B)
  await sleep(1000)
  await waitReady(A, 'A')
  await waitReady(B, 'B')
  console.log('K1 oboje polaczeni z kanalem', CHANNEL)

  // --- K2: A zaczyna od ekranu ---
  console.log('K2 A udostepnia ekran:', await shareScreen(A))
  const afterScreen = await waitForGrid(B, 1)
  console.log('K2 siatka u B (tylko ekran):', JSON.stringify(afterScreen))
  if (afterScreen.count !== 1) fail(`po starcie ekranu B widzi ${afterScreen.count} kafelkow, oczekiwano 1`)
  else if (!/ — ekran$/.test(afterScreen.tiles[0].name)) {
    fail(`kafelek ekranu bez dopisku "— ekran": "${afterScreen.tiles[0].name}"`)
  }

  // Zapamiętanie POŁĄCZENIA ekranu, zanim dojdzie drugie (kamery) — w tym
  // momencie window.__pcs u B ma dokladnie jeden wpis, wiec to jednoznaczne.
  const connectionsBeforeCamera = await B.evaluate('window.__pcs.length')
  if (connectionsBeforeCamera !== 1) {
    fail(`przed wlaczeniem kamery B ma ${connectionsBeforeCamera} polaczen RTCPeerConnection, oczekiwano 1`)
  }
  await B.evaluate('window.__screenPc = window.__pcs[0]')

  // --- K3: A dokłada kamerę ---
  console.log('K3 A wlacza kamere:', await enableCamera(A))
  const afterCamera = await waitForGrid(B, 2)
  console.log('K3 siatka u B (ekran + kamera):', JSON.stringify(afterCamera))
  if (afterCamera.count !== 2) {
    fail(`po wlaczeniu kamery B widzi ${afterCamera.count} kafelkow, oczekiwano 2`)
  } else {
    const hasScreen = afterCamera.tiles.some((t) => / — ekran$/.test(t.name))
    const hasCamera = afterCamera.tiles.some((t) => !/ — ekran$/.test(t.name))
    if (!hasScreen || !hasCamera) {
      fail(`kafelki nie roznia sie rodzajem (dopisek "— ekran"): ${JSON.stringify(afterCamera.tiles)}`)
    }
    const withoutImage = afterCamera.tiles.filter((t) => t.image === 'BRAK')
    if (withoutImage.length > 0) fail(`kafelek bez obrazu: ${JSON.stringify(withoutImage)}`)
  }

  // Troche czasu, zeby na polaczeniu ekranu narosly klatki do porownania.
  await sleep(3000)
  const before = await readScreenFrames(B)
  console.log('K3 framesReceived ekranu PRZED wylaczeniem kamery:', before.frames)

  // --- K4: SEDNO TESTU — A wylacza kamere, ekran ma nadal plynac ---
  console.log('K4 A wylacza kamere:', await disableCamera(A))
  const afterDisable = await waitForGrid(B, 1)
  console.log('K4 siatka u B (tylko ekran znow):', JSON.stringify(afterDisable))
  if (afterDisable.count !== 1) {
    fail(`po wylaczeniu kamery B widzi ${afterDisable.count} kafelkow, oczekiwano 1 (sam ekran)`)
  } else if (!/ — ekran$/.test(afterDisable.tiles[0].name)) {
    fail(`po wylaczeniu kamery pozostaly kafelek to nie ekran: "${afterDisable.tiles[0].name}"`)
  }

  // Kolejna porcja czasu na narosniecie klatek PO sprzataniu polaczenia kamery.
  await sleep(3000)
  const after = await readScreenFrames(B)
  console.log('K4 framesReceived ekranu PO wylaczeniu kamery:', after.frames)

  if (before.frames === null || after.frames === null) {
    fail('nie udalo sie odczytac framesReceived z zapamietanego polaczenia ekranu')
  } else {
    const windowSeconds = Math.max((after.time - before.time) / 1000, 0.001)
    const increase = after.frames - before.frames
    const fps = increase / windowSeconds
    const requiredIncrease = Math.ceil(MIN_SCREEN_FPS * windowSeconds)
    if (increase < requiredIncrease) {
      fail(
        `REGRESJA: ekran ledwo plynie (albo w ogole nie plynie) po wylaczeniu kamery ` +
          `(framesReceived ${before.frames} -> ${after.frames}, przyrost ${increase} klatek ` +
          `w ${windowSeconds.toFixed(1)}s = ${fps.toFixed(1)} fps, ` +
          `oczekiwano co najmniej ${requiredIncrease} klatek przy progu ${MIN_SCREEN_FPS} fps)`
      )
    } else {
      console.log(
        `K4 OK — ekran dalej plynie (${before.frames} -> ${after.frames} klatek, ` +
          `${increase} w ${windowSeconds.toFixed(1)}s = ${fps.toFixed(1)} fps)`
      )
    }
  }
} catch (err) {
  fail(`wyjatek w trakcie scenariusza: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  A?.close()
  B?.close()
  a.kill()
  b.kill()
  await sleep(500)
}

if (errors.length > 0) {
  console.log(`\nZLE — ${errors.length} problem(ow):`)
  for (const message of errors) console.log(' -', message)
  process.exitCode = 1
} else {
  console.log('\nOK')
}
