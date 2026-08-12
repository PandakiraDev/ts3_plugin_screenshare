// Czy raport o zamrożeniach realnie dolatuje od widza do nadawcy?
//
// Mierzymy z dwóch stron naraz, bo każda odpowiada na inne pytanie:
//   - u WIDZA (B): sygnały jakości faktycznie wysłane przez WebSocket
//     (dokładnie to, co poleciało w sieć) oraz surowe totalFreezesDuration
//     z inbound-rtp — czy liczby są w ogóle sensowne i po której stronie
//     progu 5% wypadają;
//   - u NADAWCY (A): kropki w panelu uczestników — czy cały łańcuch działa,
//     od odczytu przez sygnalizację po wyrenderowanie.
//
// Czytamy DOM zamiast stanu Reacta celowo: kropka w interfejsie jest tym, co
// widzi użytkownik, a stan można mieć poprawny i zapomnieć go pokazać.
//
// Uruchamianie, podpięcie przez CDP i klikanie w interfejs skopiowane
// z e2e/obciazenie.mjs — ten sam układ (A nadaje, B ogląda), te same flagi
// przeciw dławieniu renderera w zasłoniętym oknie.
//
// Wymaga działającego serwera sygnalizacyjnego:
//   cd signaling-server && npm start
//
// Uruchomienie: npm run build && npm run e2e:jakosc
import { attach, launchApp } from './cdp.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Widz wysyła co 5 s, a pierwsza próbka z założenia nie daje raportu — nie ma
// z czym jej porównać (patrz komentarz przy `lastFreezeSample` w session.ts).
// Dwadzieścia parę sekund to więc około czterech okazji, z których realny
// raport daje mniej więcej trzy.
const WAIT_MS = Number(process.env.WAIT_MS ?? 25_000)
const CHANNEL = process.env.CHANNEL ?? `jakosc-e2e-${Date.now()}`
const PORT_A = 9371
const PORT_B = 9372

function instanceArgs() {
  return [
    '--ts3-server=ts.test.pl:9987',
    `--channel=${CHANNEL}`,
    '--signaling=ws://127.0.0.1:8080',
    '--use-fake-device-for-media-stream',
    // Bez tych flag Chromium dławi renderer zasłoniętego okna i mierzylibyśmy
    // dławienie zamiast rzeczywistości — patrz uwaga w obciazenie.mjs.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling'
  ]
}

/** Hak na RTCPeerConnection — u WIDZA, bo to jego getStats() nas interesuje. */
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

/**
 * Hak na WebSocket — też u WIDZA. Łapie dokładnie to, co `session.ts` wysyła
 * sygnalizacją jako raport jakości (`{ kind: 'quality', frozenMs, windowMs }`),
 * więc mierzymy nie wartość odtworzoną z osobna, tylko tę, która naprawdę
 * poleciała po sieci w stronę nadawcy.
 */
const SIGNAL_HOOK = `
  (() => {
    const Original = window.WebSocket
    window.__qualitySignals = []
    window.WebSocket = function (...args) {
      const socket = new Original(...args)
      const originalSend = socket.send.bind(socket)
      socket.send = (data) => {
        try {
          const message = JSON.parse(data)
          if (message.type === 'signal' && message.payload && message.payload.kind === 'quality') {
            window.__qualitySignals.push({
              at: Date.now(),
              frozenMs: message.payload.frozenMs,
              windowMs: message.payload.windowMs
            })
          }
        } catch (err) {
          // ramka nie jest JSON-em sygnalizacji — nic nas tu nie obchodzi
        }
        return originalSend(data)
      }
      return socket
    }
    window.WebSocket.prototype = Original.prototype
  })()
`

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

const GRID = `(() => {
  const tiles = [...document.querySelectorAll('.tile')].map(el => {
    const v = el.querySelector('.tile__video')
    return { image: v && v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : 'BRAK' }
  })
  return JSON.stringify({ count: tiles.length, tiles })
})()`

async function waitForGrid(cdp, count, attempts = 30) {
  let state = null
  for (let i = 0; i < attempts; i++) {
    state = JSON.parse(await cdp.evaluate(GRID))
    if (state.count === count) return state
    await sleep(500)
  }
  return state
}

const processes = []
function launch(port) {
  const proc = launchApp(port, instanceArgs())
  processes.push(proc)
  return proc
}

let exitCode = 0
let A = null
let B = null

try {
  launch(PORT_A)
  launch(PORT_B)

  A = await attach(PORT_A)
  B = await attach(PORT_B)

  // Haki muszą wejść PRZED pierwszym połączeniem widza z sygnalizacją, więc
  // dokładamy je przez addScriptToEvaluateOnNewDocument i odświeżamy stronę —
  // dokładnie jak w obciazenie.mjs.
  await B.call('Page.enable')
  await B.call('Page.addScriptToEvaluateOnNewDocument', { source: PC_HOOK })
  await B.call('Page.addScriptToEvaluateOnNewDocument', { source: SIGNAL_HOOK })
  await B.call('Page.reload')
  await sleep(3_000)

  await waitReady(A, 'A (nadawca)')
  await waitReady(B, 'B (widz)')
  console.log('Obie instancje w kanale. A zaczyna udostępniać ekran...')

  console.log('start udostępniania u A:', await shareScreen(A))

  const grid = await waitForGrid(B, 1)
  if (grid.count !== 1) {
    throw new Error(`B nie zobaczył obrazu od A w rozsądnym czasie (kafelków: ${grid.count})`)
  }
  console.log('B odbiera obraz od A:', JSON.stringify(grid.tiles))

  console.log(`Czekam ${WAIT_MS / 1000} s na raporty (widz wysyła co 5 s)...`)
  await sleep(WAIT_MS)

  // --- strona widza: sygnały faktycznie wysłane sygnalizacją ---
  const signals = JSON.parse(await B.evaluate(`JSON.stringify(window.__qualitySignals ?? [])`))

  // --- strona widza: surowe liczby z inbound-rtp ---
  const rawStats = JSON.parse(
    await B.evaluate(`(async () => {
      const results = []
      for (const pc of window.__pcs ?? []) {
        const stats = await pc.getStats()
        stats.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            results.push({
              totalFreezesDuration: s.totalFreezesDuration ?? null,
              freezeCount: s.freezeCount ?? null,
              framesDecoded: s.framesDecoded ?? null
            })
          }
        })
      }
      return JSON.stringify(results)
    })()`)
  )

  // --- strona nadawcy: co widać w interfejsie ---
  const dots = JSON.parse(
    await A.evaluate(`
      JSON.stringify([...document.querySelectorAll('.peers__quality')].map((el) => ({
        className: el.className,
        description: el.getAttribute('title')
      })))
    `)
  )

  console.log('\n=== SYGNAŁY FAKTYCZNIE WYSŁANE PRZEZ WIDZA (WebSocket) ===')
  if (signals.length === 0) {
    console.log('  brak — widz w ogóle nie wysłał żadnego raportu jakości')
  }
  for (const signal of signals) {
    const fraction = signal.windowMs > 0 ? signal.frozenMs / signal.windowMs : null
    console.log(
      `  windowMs=${signal.windowMs} frozenMs=${signal.frozenMs}` +
        (fraction === null ? '' : ` (${(fraction * 100).toFixed(2)}%)`)
    )
  }

  console.log('\n=== U WIDZA (surowe inbound-rtp) ===')
  if (rawStats.length === 0) {
    console.log('  brak strumieni przychodzących — widz niczego nie odbiera')
  }
  for (const stat of rawStats) {
    const frozenMsTotal = (stat.totalFreezesDuration ?? 0) * 1000
    const fraction = frozenMsTotal / WAIT_MS
    console.log(
      `  zamrożone łącznie ${frozenMsTotal.toFixed(0)} ms z ${WAIT_MS} ms ` +
        `(${(fraction * 100).toFixed(2)}%) | zacięć: ${stat.freezeCount} | klatek: ${stat.framesDecoded}`
    )
    console.log(`  -> próg 5%: ${fraction > 0.05 ? 'PRZEKROCZONY (słabo)' : 'nieprzekroczony (dobrze)'}`)
  }

  console.log('\n=== U NADAWCY (kropki w panelu) ===')
  if (dots.length === 0) {
    console.error('  BRAK KROPEK — łańcuch nie działa albo nikt nie ogląda')
    exitCode = 1
  }
  for (const dot of dots) {
    console.log(`  ${dot.className}  "${dot.description}"`)
  }

  const allUnknown = dots.length > 0 && dots.every((dot) => dot.className.includes('--unknown'))
  if (allUnknown) {
    console.error(`\nBŁĄD: po ${WAIT_MS / 1000} s wszystkie kropki nadal pokazują "brak danych".`)
    console.error('Raporty nie dolatują — wróć do diagnozy zamiast dopisywać kod.')
    exitCode = 1
  }

  if (signals.length === 0) {
    console.error('\nBŁĄD: żaden raport jakości nie poleciał przez sygnalizację (WebSocket u widza).')
    exitCode = 1
  }

  if (exitCode === 0) {
    console.log('\nOK: raporty dolatują, kropki mają stan inny niż "brak danych".')
  }
} catch (err) {
  console.error('\nBŁĄD pomiaru:', err instanceof Error ? err.message : String(err))
  exitCode = 1
} finally {
  A?.close()
  B?.close()
  for (const proc of processes) proc.kill()
  await sleep(500)
}

process.exit(exitCode)
