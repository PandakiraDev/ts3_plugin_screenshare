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

const KANAL = process.env.KANAL ?? `kamera-e2e-${Date.now()}`
const PORT_A = 9351
const PORT_B = 9352
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function argsInstancji(extra) {
  return [
    '--ts3-server=ts.test.pl:9987',
    `--channel=${KANAL}`,
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
const HAK_PC = `
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

async function zHakiem(cdp) {
  await cdp.call('Page.enable')
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: HAK_PC })
  await cdp.call('Page.reload')
}

const PRZYCISK_UDOSTEPNIJ = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Udostępnij ekran/.test(x.textContent))
  return b ? (b.disabled ? 'NIEAKTYWNY' : 'AKTYWNY') : 'BRAK'
})()`

/** Siatka kafelków u odbiorcy: nazwa (z dopiskiem "— ekran" dla ekranu) i czy leci obraz. */
const SIATKA = `(() => {
  const kafelki = [...document.querySelectorAll('.tile')].map(el => {
    const v = el.querySelector('.tile__video')
    return {
      nazwa: el.querySelector('.tile__name').textContent.trim(),
      obraz: v && v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : 'BRAK'
    }
  })
  return JSON.stringify({ ile: kafelki.length, kafelki })
})()`

/** framesReceived odbiornika WIDEO na zapamiętanym połączeniu ekranu (window.__screenPc). */
const KLATKI_EKRANU = `(async () => {
  const pc = window.__screenPc
  if (!pc) return null
  let klatek = null
  ;(await pc.getStats()).forEach(s => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') klatek = s.framesReceived
  })
  return klatek
})()`

/**
 * Bezpieczny próg dla porównania K4 w klatkach na sekundę. Zdrowy ekran daje
 * tu dziesiątki fps; zerwane połączenie w oknie pomiaru potrafi wciąż wnieść
 * pojedynczą zabłąkaną klatkę (np. z bufora dekodera), więc goły warunek
 * `po > przed` przechodzi nawet przy realnej regresji. Próg fps zamiast
 * progu bezwzględnego, bo okno pomiaru (sleep + polling siatki) nie ma
 * stałej długości — próg w klatkach musiałby się z nim rozjeżdżać.
 */
const MIN_FPS_EKRANU = 5

/** framesReceived + znacznik czasu z tej samej chwili — do liczenia fps okna pomiaru. */
async function odczytajKlatkiEkranu(cdp) {
  const klatek = await cdp.evaluate(KLATKI_EKRANU)
  return { klatek, czas: Date.now() }
}

/** Czeka aż lobby.state.connection === 'ready' — sygnalizowane odblokowaniem przycisku. */
async function czekajNaGotowosc(cdp, etykieta) {
  for (let i = 0; i < 40; i++) {
    if ((await cdp.evaluate(PRZYCISK_UDOSTEPNIJ)) === 'AKTYWNY') return
    await sleep(500)
  }
  throw new Error(`${etykieta}: nie doczekalem sie polaczenia z serwerem sygnalizacyjnym`)
}

/** Czeka aż siatka u odbiorcy pokaże dokładnie `ile` kafelków; zwraca ostatni odczyt. */
async function czekajNaSiatke(cdp, ile, prob = 30) {
  let stan = null
  for (let i = 0; i < prob; i++) {
    stan = JSON.parse(await cdp.evaluate(SIATKA))
    if (stan.ile === ile) return stan
    await sleep(500)
  }
  return stan
}

async function udostepnijEkran(cdp) {
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

function przyciskKamery(regex) {
  return `(() => {
    const b = [...document.querySelectorAll('button')].find(x=>${regex}.test(x.textContent))
    if (!b) return 'BRAK PRZYCISKU'
    if (b.disabled) return 'NIEAKTYWNY'
    b.click(); return 'ok'
  })()`
}
const wlaczKamere = (cdp) => cdp.evaluate(przyciskKamery('/Włącz kamerę/'))
const wylaczKamere = (cdp) => cdp.evaluate(przyciskKamery('/Wyłącz kamerę/'))

const a = launchApp(PORT_A, argsInstancji([]))
const b = launchApp(PORT_B, argsInstancji([]))

let A
let B
const bledy = []
const zle = (opis) => {
  bledy.push(opis)
  console.log('BLAD:', opis)
}

try {
  A = await attach(PORT_A)
  B = await attach(PORT_B)

  // Reload z hakiem na B (potrzebny do K4); dla A zwykłe odczekanie na start
  // wystarczy, bo jego statystyk nigdzie nie sprawdzamy.
  await zHakiem(B)
  await sleep(1000)
  await czekajNaGotowosc(A, 'A')
  await czekajNaGotowosc(B, 'B')
  console.log('K1 oboje polaczeni z kanalem', KANAL)

  // --- K2: A zaczyna od ekranu ---
  console.log('K2 A udostepnia ekran:', await udostepnijEkran(A))
  const poEkranie = await czekajNaSiatke(B, 1)
  console.log('K2 siatka u B (tylko ekran):', JSON.stringify(poEkranie))
  if (poEkranie.ile !== 1) zle(`po starcie ekranu B widzi ${poEkranie.ile} kafelkow, oczekiwano 1`)
  else if (!/ — ekran$/.test(poEkranie.kafelki[0].nazwa)) {
    zle(`kafelek ekranu bez dopisku "— ekran": "${poEkranie.kafelki[0].nazwa}"`)
  }

  // Zapamiętanie POŁĄCZENIA ekranu, zanim dojdzie drugie (kamery) — w tym
  // momencie window.__pcs u B ma dokladnie jeden wpis, wiec to jednoznaczne.
  const ilePolaczenPrzedKamera = await B.evaluate('window.__pcs.length')
  if (ilePolaczenPrzedKamera !== 1) {
    zle(`przed wlaczeniem kamery B ma ${ilePolaczenPrzedKamera} polaczen RTCPeerConnection, oczekiwano 1`)
  }
  await B.evaluate('window.__screenPc = window.__pcs[0]')

  // --- K3: A dokłada kamerę ---
  console.log('K3 A wlacza kamere:', await wlaczKamere(A))
  const poKamerze = await czekajNaSiatke(B, 2)
  console.log('K3 siatka u B (ekran + kamera):', JSON.stringify(poKamerze))
  if (poKamerze.ile !== 2) {
    zle(`po wlaczeniu kamery B widzi ${poKamerze.ile} kafelkow, oczekiwano 2`)
  } else {
    const maEkran = poKamerze.kafelki.some((k) => / — ekran$/.test(k.nazwa))
    const maKamere = poKamerze.kafelki.some((k) => !/ — ekran$/.test(k.nazwa))
    if (!maEkran || !maKamere) {
      zle(`kafelki nie roznia sie rodzajem (dopisek "— ekran"): ${JSON.stringify(poKamerze.kafelki)}`)
    }
    const bezObrazu = poKamerze.kafelki.filter((k) => k.obraz === 'BRAK')
    if (bezObrazu.length > 0) zle(`kafelek bez obrazu: ${JSON.stringify(bezObrazu)}`)
  }

  // Troche czasu, zeby na polaczeniu ekranu narosly klatki do porownania.
  await sleep(3000)
  const przed = await odczytajKlatkiEkranu(B)
  console.log('K3 framesReceived ekranu PRZED wylaczeniem kamery:', przed.klatek)

  // --- K4: SEDNO TESTU — A wylacza kamere, ekran ma nadal plynac ---
  console.log('K4 A wylacza kamere:', await wylaczKamere(A))
  const poWylaczeniu = await czekajNaSiatke(B, 1)
  console.log('K4 siatka u B (tylko ekran znow):', JSON.stringify(poWylaczeniu))
  if (poWylaczeniu.ile !== 1) {
    zle(`po wylaczeniu kamery B widzi ${poWylaczeniu.ile} kafelkow, oczekiwano 1 (sam ekran)`)
  } else if (!/ — ekran$/.test(poWylaczeniu.kafelki[0].nazwa)) {
    zle(`po wylaczeniu kamery pozostaly kafelek to nie ekran: "${poWylaczeniu.kafelki[0].nazwa}"`)
  }

  // Kolejna porcja czasu na narosniecie klatek PO sprzataniu polaczenia kamery.
  await sleep(3000)
  const po = await odczytajKlatkiEkranu(B)
  console.log('K4 framesReceived ekranu PO wylaczeniu kamery:', po.klatek)

  if (przed.klatek === null || po.klatek === null) {
    zle('nie udalo sie odczytac framesReceived z zapamietanego polaczenia ekranu')
  } else {
    const oknoSekund = Math.max((po.czas - przed.czas) / 1000, 0.001)
    const przyrost = po.klatek - przed.klatek
    const fps = przyrost / oknoSekund
    const wymaganyPrzyrost = Math.ceil(MIN_FPS_EKRANU * oknoSekund)
    if (przyrost < wymaganyPrzyrost) {
      zle(
        `REGRESJA: ekran ledwo plynie (albo w ogole nie plynie) po wylaczeniu kamery ` +
          `(framesReceived ${przed.klatek} -> ${po.klatek}, przyrost ${przyrost} klatek ` +
          `w ${oknoSekund.toFixed(1)}s = ${fps.toFixed(1)} fps, ` +
          `oczekiwano co najmniej ${wymaganyPrzyrost} klatek przy progu ${MIN_FPS_EKRANU} fps)`
      )
    } else {
      console.log(
        `K4 OK — ekran dalej plynie (${przed.klatek} -> ${po.klatek} klatek, ` +
          `${przyrost} w ${oknoSekund.toFixed(1)}s = ${fps.toFixed(1)} fps)`
      )
    }
  }
} catch (err) {
  zle(`wyjatek w trakcie scenariusza: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  A?.close()
  B?.close()
  a.kill()
  b.kill()
  await sleep(500)
}

if (bledy.length > 0) {
  console.log(`\nZLE — ${bledy.length} problem(ow):`)
  for (const b2 of bledy) console.log(' -', b2)
  process.exitCode = 1
} else {
  console.log('\nOK')
}
