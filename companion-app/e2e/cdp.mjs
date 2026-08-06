// Wspolny harness: odpal aplikacje i podepnij sie do renderera przez CDP.
//
// Sprawdziany w Electronie sa tu regula, nie wyjatkiem — testy w Node nie
// widza ani MessagePortow Electrona, ani Web Audio, ani klatki pamieci V8.
// Ta klasa bledow juz raz dala nam komplet zielonych testow i zero dzwieku.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import electronPath from 'electron'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Odpala aplikacje. APP_EXE wskazuje wersje SPAKOWANA — warto ja sprawdzac,
 * bo modul natywny lezy tam w app.asar.unpacked i sciezki rozwiazuja sie
 * inaczej niz w dev.
 */
export function launchApp(port, extraArgs = []) {
  const exe = process.env.APP_EXE
  return spawn(
    exe ?? electronPath,
    [
      ...(exe ? [] : ['.']),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ts3-e2e-'))}`,
      ...extraArgs
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

export async function attach(port) {
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
          call,
          async evaluate(expression) {
            const m = await call('Runtime.evaluate', {
              expression,
              awaitPromise: true,
              returnByValue: true
            })
            const wyjatek = m.result?.exceptionDetails
            if (wyjatek) {
              throw new Error(
                String(wyjatek.exception?.description ?? wyjatek.text).slice(0, 400)
              )
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
