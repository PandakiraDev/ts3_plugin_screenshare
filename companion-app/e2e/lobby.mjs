// Walidacja modelu lobby: dwa równorzędne okna, przekazywanie nadawania,
// dołączanie w trakcie, zmiana jakości i restart transmisji.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import electronPath from 'electron'

const KANAL = process.env.KANAL ?? 'lobby-e2e'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function launch(nazwa, port) {
  return spawn(electronPath, [
    '.', `--remote-debugging-port=${port}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), `ts3l-${nazwa}-`))}`,
    '--ts3-server=ts.test.pl:9987', `--channel=${KANAL}`,
    '--signaling=ws://127.0.0.1:8080',
    ...(process.env[`NICK_${nazwa.toUpperCase()}`]
      ? [`--nick=${process.env[`NICK_${nazwa.toUpperCase()}`]}`] : [])
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
        return {
          async evaluate(expression) {
            const myId = ++id
            const reply = new Promise((res) => pending.set(myId, res))
            ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate',
              params: { expression, awaitPromise: true, returnByValue: true } }))
            const m = await reply
            if (m.result?.exceptionDetails) {
              throw new Error(String(m.result.exceptionDetails.exception?.description).slice(0, 150))
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

const naglowek = `document.querySelector('.app__stage-tag').textContent.trim()`
const panel = `(() => {
  const items = [...document.querySelectorAll('.peers__item')].map(li => ({
    tekst: li.querySelector('.peers__name').textContent.trim(),
    nadaje: li.classList.contains('peers__item--streaming')
  }));
  const zwiniety = !!document.querySelector('.peers--collapsed');
  return JSON.stringify({ zwiniety, items });
})()`
const przelaczPanel = `document.querySelector('.peers__toggle').click()`
const przyciskUdostepnij = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Udostępnij ekran/.test(x.textContent));
  return b ? (b.disabled ? 'NIEAKTYWNY' : 'AKTYWNY') : 'BRAK';
})()`

/** Ile kafelkow w siatce i czy maja sciezke audio. */
const SIATKA = `(() => {
  const kafelki = [...document.querySelectorAll('.tile')].map(el => {
    const v = el.querySelector('.tile__video');
    const s = v && v.srcObject;
    return {
      nazwa: el.querySelector('.tile__name').textContent.trim(),
      obraz: v && v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : 'BRAK',
      audio: s ? s.getAudioTracks().length : 0,
      wyciszony: v ? v.muted : null
    };
  });
  return JSON.stringify({ ile: kafelki.length, kafelki });
})()`
const OBRAZ = `(async () => {
  const v = document.querySelector('.tile__video');
  if (!v || !v.videoWidth) return JSON.stringify({ obraz: false,
    tekst: (document.querySelector('.viewer__waiting')||{}).textContent || '' });
  const c = document.createElement('canvas'); c.width=160; c.height=90;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const h = [];
  for (let i=0;i<12;i++){ ctx.drawImage(v,0,0,160,90);
    const d=ctx.getImageData(0,0,160,90).data; let x=0;
    for(let q=0;q<d.length;q+=13) x=(x*31+d[q])>>>0; h.push(x);
    await new Promise(r=>setTimeout(r,100)); }
  return JSON.stringify({ obraz: true, rozmiar: v.videoWidth+'x'+v.videoHeight,
    unikalnychKlatek: new Set(h).size });
})()`

/** Klika "Udostępnij ekran", wybiera pierwszy ekran i potwierdza. */
async function udostepnij(cdp, zDzwiekiem = false) {
  await cdp.evaluate(`[...document.querySelectorAll('button')].find(b=>/Udostępnij ekran/.test(b.textContent)).click()`)
  await sleep(2500)
  await cdp.evaluate(`[...document.querySelectorAll('.source-card')].find(c=>/Ekran/.test(c.textContent)).click()`)
  await sleep(1500)
  if (zDzwiekiem) {
    await cdp.evaluate(`(() => {
      const cb = document.getElementById('share-audio');
      if (cb && !cb.checked) cb.click();
      return cb ? cb.checked : 'brak';
    })()`)
    await sleep(2500)
  }
  await sleep(1500)
  return cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x=>/Rozpocznij udostępnianie/.test(x.textContent));
    if (!b) return 'BRAK PRZYCISKU'; if (b.disabled) return 'NIEAKTYWNY';
    b.click(); return 'ok';
  })()`)
}

const a = launch('a', 9252)
const b = launch('b', 9253)

try {
  const A = await attach(9252); const B = await attach(9253)
  await sleep(3500)

  console.log('L1 A naglowek:', await A.evaluate(naglowek))
  console.log('L1 B przycisk:', await B.evaluate(przyciskUdostepnij))

  console.log('L2 A udostepnia:', await udostepnij(A))
  await sleep(7000)
  console.log('L2 A naglowek :', await A.evaluate(naglowek))
  console.log('L2 B naglowek :', await B.evaluate(naglowek))
  console.log('L2 B przycisk :', await B.evaluate(przyciskUdostepnij))
  console.log('L2 B obraz    :', await B.evaluate(OBRAZ))
  console.log('L2 panel u A  :', await A.evaluate(panel))
  console.log('L2 panel u B  :', await B.evaluate(panel))

  // C dolacza w TRAKCIE transmisji
  const c = launch('c', 9254)
  const C = await attach(9254)
  await sleep(8000)
  console.log('L3 C (dolaczyl w trakcie):', await C.evaluate(OBRAZ))
  console.log('L3 panel u C  :', await C.evaluate(panel))
  await B.evaluate(przelaczPanel)
  await sleep(600)
  console.log('L3 panel B po zwinieciu:', await B.evaluate(panel))
  await B.evaluate(przelaczPanel)
  await sleep(600)
  console.log('L3 panel B po rozwinieciu:', await B.evaluate(panel))

  // A konczy -> wszyscy wracaja do lobby, przycisk znow aktywny
  await A.evaluate(`[...document.querySelectorAll('button')].find(x=>/Zakończ udostępnianie/.test(x.textContent)).click()`)
  await sleep(4000)
  console.log('L4 B naglowek :', await B.evaluate(naglowek))
  console.log('L4 B przycisk :', await B.evaluate(przyciskUdostepnij))

  // Teraz B przejmuje nadawanie — to jest sedno "kazdy moze byc streamerem"
  console.log('L5 B udostepnia (z dzwiekiem):', await udostepnij(B, true))
  await sleep(7000)
  console.log('L5 A naglowek :', await A.evaluate(naglowek))
  console.log('L5 A obraz    :', await A.evaluate(OBRAZ))
  console.log('L5 C obraz    :', await C.evaluate(OBRAZ))
  console.log('L5 panel u C  :', await C.evaluate(panel))

  // --- L6: DRUGI nadajacy rownoczesnie (wczesniej serwer by go odrzucil)
  console.log('L6 A dolacza jako drugi nadajacy:', await udostepnij(A))
  await sleep(9000)
  console.log('L6 siatka u C :', await C.evaluate(SIATKA))
  console.log('L6 siatka u A :', await A.evaluate(SIATKA))
  console.log('L6 panel u C  :', await C.evaluate(panel))

  // --- L6b: KAZDY kafelek musi miec obraz, nie tylko istniec.
  // To jest scenariusz zgloszony przez uzytkownikow: przy wzajemnym nadawaniu
  // kafelek drugiej osoby byl czarny, bo kandydaci ICE szli w zle polaczenie.
  const KLATKI = `(async () => {
    const out = [];
    for (const el of document.querySelectorAll('.tile')) {
      const v = el.querySelector('.tile__video');
      const nazwa = el.querySelector('.tile__name').textContent.trim();
      if (!v || !v.videoWidth) { out.push({ nazwa, obraz: 'BRAK' }); continue; }
      const c = document.createElement('canvas'); c.width=120; c.height=68;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const h = new Set();
      for (let i=0;i<8;i++) {
        ctx.drawImage(v,0,0,120,68);
        const d = ctx.getImageData(0,0,120,68).data;
        let x=0; for (let q=0;q<d.length;q+=11) x=(x*31+d[q])>>>0;
        h.add(x);
        await new Promise(r=>setTimeout(r,100));
      }
      // Czarny ekran = jedna, stala klatka o zerowej jasnosci
      let suma=0; const d=ctx.getImageData(0,0,120,68).data;
      for (let q=0;q<d.length;q+=4) suma+=d[q];
      out.push({ nazwa, obraz: v.videoWidth+'x'+v.videoHeight,
        unikalnych: h.size, czarny: suma === 0 });
    }
    return JSON.stringify(out);
  })()`
  console.log('L6b klatki u C:', await C.evaluate(KLATKI))
  console.log('L6b klatki u A:', await A.evaluate(KLATKI))
  console.log('L6b klatki u B:', await B.evaluate(KLATKI))

  // --- L7: jeden konczy, drugi ma nadawac dalej
  await A.evaluate(`[...document.querySelectorAll('button')].find(x=>/Zakończ udostępnianie/.test(x.textContent)).click()`)
  await sleep(5000)
  console.log('L7 siatka u C po zakonczeniu A:', await C.evaluate(SIATKA))

  A.close(); B.close(); C.close(); c.kill()
} catch (e) {
  console.log('L BLAD:', e.message)
} finally {
  a.kill(); b.kill(); await sleep(500); process.exit(0)
}
