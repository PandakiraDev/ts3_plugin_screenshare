// Diagnostyka płynności: realny FPS po stronie nadawcy i odbiorcy + powód
// ograniczenia jakości prosto z getStats(). Nie zmienia kodu aplikacji —
// podmiana RTCPeerConnection jest wstrzykiwana przez CDP przed startem strony.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import electronPath from 'electron'

const FPS = process.env.FPS ?? '60'
const KANAL = `fps-diag-${FPS}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function launch(nazwa, port) {
  return spawn(electronPath, [
    '.', `--remote-debugging-port=${port}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), `ts3f-${nazwa}-`))}`,
    '--ts3-server=ts.test.pl:9987', `--channel=${KANAL}`,
    '--signaling=ws://127.0.0.1:8080'
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
}

async function attach(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      const page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
        await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
        let id = 0; const pending = new Map()
        ws.on('message', (raw) => {
          const m = JSON.parse(String(raw)); const p = pending.get(m.id)
          if (p) { pending.delete(m.id); p(m) }
        })
        const call = (method, params = {}) => {
          const myId = ++id
          const reply = new Promise((res) => pending.set(myId, res))
          ws.send(JSON.stringify({ id: myId, method, params }))
          return reply
        }
        return {
          call,
          async evaluate(expression) {
            const m = await call('Runtime.evaluate',
              { expression, awaitPromise: true, returnByValue: true })
            if (m.result?.exceptionDetails) {
              throw new Error(String(m.result.exceptionDetails.exception?.description).slice(0, 200))
            }
            return m.result?.result?.value
          },
          close: () => ws.close()
        }
      }
    } catch {}
    await sleep(500)
  }
  throw new Error(`CDP ${port} nie odpowiada`)
}

/** Rejestruje każde utworzone RTCPeerConnection, żeby dało się zapytać o statystyki. */
const SHIM = `
  (() => {
    const Original = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...args) {
      const pc = new Original(...args);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Original.prototype;
  })();
`

async function zeStatystykami(cdp) {
  await cdp.call('Page.enable')
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: SHIM })
  await cdp.call('Page.reload')
  await sleep(3500)
}

const STATY_NADAWCY = `(async () => {
  const out = [];
  for (const pc of window.__pcs || []) {
    const stats = await pc.getStats();
    const kodeki = new Map();
    stats.forEach(s => { if (s.type === 'codec') kodeki.set(s.id, s.mimeType); });
    stats.forEach(s => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') {
        s.__kodek = kodeki.get(s.codecId) || 'nieznany';
        out.push({ fpsWysylane: s.framesPerSecond, klatekWyslanych: s.framesSent,
          klatekZakodowanych: s.framesEncoded, rozmiar: s.frameWidth + 'x' + s.frameHeight,
          powodOgraniczenia: s.qualityLimitationReason,
          bitrateKbps: s.targetBitrate ? Math.round(s.targetBitrate/1000) : null,
          kodek: s.__kodek, koder: s.encoderImplementation });
      }
    });
  }
  const t = document.querySelector('.viewer__video')?.srcObject?.getVideoTracks?.()[0];
  return JSON.stringify({ nadawca: out,
    trackCapture: t ? { ...t.getSettings(), contentHint: t.contentHint } : null });
})()`

const STATY_ODBIORCY = `(async () => {
  const out = [];
  for (const pc of window.__pcs || []) {
    const stats = await pc.getStats();
    stats.forEach(s => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        out.push({ fpsOdbierane: s.framesPerSecond, klatekOdebranych: s.framesReceived,
          klatekWyswietlonych: s.framesDecoded, zgubionych: s.framesDropped,
          rozmiar: s.frameWidth + 'x' + s.frameHeight });
      }
    });
  }
  return JSON.stringify(out);
})()`

async function udostepnij(cdp) {
  await cdp.evaluate(`[...document.querySelectorAll('button')].find(b=>/Udostępnij ekran/.test(b.textContent)).click()`)
  await sleep(2500)
  await cdp.evaluate(`[...document.querySelectorAll('.source-card')].find(c=>/Ekran/.test(c.textContent)).click()`)
  await sleep(1500)
  // ustaw zadany FPS
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('.segmented__option')].find(x=>x.textContent.includes('${FPS}'));
    if (b) b.click(); return b ? 'fps ${FPS}' : 'brak przycisku fps';
  })()`)
  await sleep(2500)
  return cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x=>/Rozpocznij udostępnianie/.test(x.textContent));
    if (!b || b.disabled) return 'NIE DA SIE'; b.click(); return 'ok';
  })()`)
}

const a = launch('nadawca', 9262)
const b = launch('odbiorca', 9263)

try {
  const A = await attach(9262); const B = await attach(9263)
  await zeStatystykami(A); await zeStatystykami(B)

  console.log('FPS zadany:', FPS, '| udostepnianie:', await udostepnij(A))
  await sleep(12000)
  console.log('--- PO 12s (rozbieg) ---')
  console.log(await A.evaluate(STATY_NADAWCY))
  await sleep(20000)
  console.log('--- PO 32s (stan ustalony) ---')

  console.log('--- NADAWCA ---')
  console.log(await A.evaluate(STATY_NADAWCY))
  console.log('--- ODBIORCA ---')
  console.log(await B.evaluate(STATY_ODBIORCY))

  A.close(); B.close()
} catch (e) {
  console.log('FPS BLAD:', e.message)
} finally {
  a.kill(); b.kill(); await sleep(500); process.exit(0)
}
