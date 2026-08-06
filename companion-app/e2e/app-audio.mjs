// Czy PCM z modulu natywnego realnie dociera do RENDERERA.
//
// Po co osobno, skoro sa testy jednostkowe: caly transport (MessageChannelMain,
// przekazanie portu przez preload, klonowanie bufora) istnieje tylko wewnatrz
// Electrona. Vitest w Node tego nie dotyka. Przy module natywnym ta klasa
// bledow juz raz kosztowala nas komplet zielonych testow i zero probek
// w aplikacji — patrz audio-native/README.md.
//
// Cel przechwytywania: PID tego skryptu. Cichy proces tez oddaje ramki, wiec
// nie trzeba niczego odtwarzac w tle.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import electronPath from 'electron'

const PORT_CDP = 9333
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function attach(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      const page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => {
          ws.once('open', res)
          ws.once('error', rej)
        })
        let id = 0
        const pending = new Map()
        ws.on('message', (raw) => {
          const m = JSON.parse(String(raw))
          const p = pending.get(m.id)
          if (p) {
            pending.delete(m.id)
            p(m)
          }
        })
        const call = (method, params = {}) => {
          const myId = ++id
          const reply = new Promise((res) => pending.set(myId, res))
          ws.send(JSON.stringify({ id: myId, method, params }))
          return reply
        }
        return {
          async evaluate(expression) {
            const m = await call('Runtime.evaluate', {
              expression,
              awaitPromise: true,
              returnByValue: true
            })
            const wyjatek = m.result?.exceptionDetails
            if (wyjatek) {
              throw new Error(String(wyjatek.exception?.description ?? wyjatek.text).slice(0, 400))
            }
            return m.result?.result?.value
          },
          close: () => ws.close()
        }
      }
    } catch {
      /* jeszcze nie wstal */
    }
    await sleep(250)
  }
  throw new Error('Nie udalo sie podpiac do Electrona przez CDP')
}

// APP_EXE=release/win-unpacked/"TS3 Screen Share.exe" sprawdza wersje
// SPAKOWANA. Warto, bo tam modul natywny lezy w app.asar.unpacked i sciezka
// do niego rozwiazuje sie inaczej niz w dev.
const exe = process.env.APP_EXE
const args = exe ? [] : ['.']

const electron = spawn(
  exe ?? electronPath,
  [
    ...args,
    `--remote-debugging-port=${PORT_CDP}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ts3-audio-'))}`
  ],
  { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
)

let cdp
try {
  cdp = await attach(PORT_CDP)

  const wynik = await cdp.evaluate(`(async () => {
    // Nasluch MUSI ruszyc przed startAppAudio() — port przychodzi w trakcie
    // tamtego wywolania.
    const oczekiwanie = new Promise((resolve, reject) => {
      const h = (e) => {
        if (e.data !== 'audio:port') return
        window.removeEventListener('message', h)
        resolve(e.ports[0])
      }
      window.addEventListener('message', h)
      setTimeout(() => reject(new Error('port nie dotarl do renderera')), 5000)
    })

    const format = await window.companion.startAppAudio(${process.pid})
    const port = await oczekiwanie

    let bajtow = 0
    let pakietow = 0
    port.onmessage = (e) => {
      bajtow += e.data.byteLength
      pakietow += 1
    }
    port.start()

    await new Promise((r) => setTimeout(r, 1000))
    await window.companion.stopAppAudio()

    return { format, pakietow, ramek: bajtow / (format.channels * 4) }
  })()`)

  const oczekiwane = wynik.format.sampleRate
  const ok = wynik.ramek > oczekiwane * 0.7

  console.log(
    `format: ${wynik.format.sampleRate} Hz, ${wynik.format.channels} kanaly\n` +
      `pakiety: ${wynik.pakietow}\n` +
      `ramki w 1 s: ${wynik.ramek} (oczekiwane ~${oczekiwane})`
  )
  console.log(ok ? '\nOK — PCM dociera do renderera' : '\nZLE — za malo probek')
  if (!ok) process.exitCode = 1
} catch (blad) {
  console.error(`ZLE — ${blad.message}`)
  process.exitCode = 1
} finally {
  cdp?.close()
  electron.kill()
}
