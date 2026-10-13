// Czy Chromium dławi nasze okno, gdy gra zasłoni je na pełnym ekranie?
//
// Objaw zgłoszony po kilku miesiącach grania: „cudzy obraz zacina się u mnie,
// gdy aplikacja jest zasłonięta grą" (oraz „interfejs muli, gdy wracam").
//
// Mierzymy u ODBIORCY (B), bo tam objaw mieszka, i rozdzielamy trzy ścieżki:
//   1. ZEGARY — odstępy między tyknięciami setInterval(1000);
//   2. DEKODOWANIE — przyrost inbound-rtp.framesDecoded;
//   3. RYSOWANIE — przyrost getVideoPlaybackQuality().totalVideoFrames,
//      czyli klatek faktycznie wystawionych na ekran.
//
// UWAGA przy czytaniu wyniku: w praktyce DEKODOWANIE i RYSOWANIE wychodzą
// identyczne co do dziesiątej części klatki, więc najpewniej sięgają tego
// samego licznika w środku. Nie traktuj ich jako dwóch niezależnych
// potwierdzeń — to jedna obserwacja pokazana dwa razy.
//
// DLACZEGO ZASŁANIAMY, A NIE MINIMALIZUJEMY — pierwsza wersja tego pomiaru
// minimalizowała okno B i było to sprawdzanie nie tej rzeczy, co trzeba.
// Flaga `--disable-backgrounding-occluded-windows` dotyczy wyłącznie okien
// ZASŁONIĘTYCH; minimalizacja idzie w Chromium inną ścieżką i tej flagi nie
// dotyka. Przy minimalizacji pięć przebiegów dało 61%, 100%, 106%, 103%,
// 98% i 114% tempa widocznego okna — czyli szum, z którego nie wynika nic.
//
// Zasłaniamy oknem drugiej instancji przeniesionym dokładnie na prostokąt
// okna B i ustawionym nad nim. Musi pokryć je W CAŁOŚCI, bo Windows zgłasza
// zasłonięcie tylko wtedy — stąd dokładka po 8 pikseli z każdej strony na
// cień i obramowanie.
//
// To nadal nie jest gra: brakuje obciążenia procesora i karty. Jeśli pomiar
// nie wykaże dławienia, NIE znaczy to, że objaw jest nieprawdziwy — znaczy,
// że ten przyrząd go nie łapie i trzeba mierzyć w prawdziwej sesji.
//
// ŚWIADOMIE NIE podajemy flag przeciw dławieniu, które mają pozostałe
// skrypty e2e — mierzymy zachowanie produkcyjne, nie laboratoryjne.
//
// Wymaga działającego serwera sygnalizacyjnego:
//   cd signaling-server && npm start
//
// Uruchomienie: npm run build && npm run e2e:dlawienie
import { execFileSync } from 'node:child_process'
import { attach, launchApp } from './cdp.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const PHASE_MS = Number(process.env.PHASE_MS ?? 12_000)
const CHANNEL = process.env.CHANNEL ?? `dlawienie-e2e-${Date.now()}`
const PORT_A = 9401
const PORT_B = 9402

/** Nominalny odstęp sondy zegarowej. Zgodny z TICK_PROBE niżej. */
const TICK_NOMINAL_MS = 1_000

// Progi, poniżej których uznajemy okno za dławione.
//
// Porównujemy STOSUNEK, nie wartości bezwzględne: te skaczą między
// przebiegami (widziane od 27 do 57 klatek/s w tym samym układzie), bo
// zależą od tego, co akurat dzieje się na przechwytywanym ekranie.
const MAX_TICK_GAP_MS = 2 * TICK_NOMINAL_MS
const MIN_FRAME_RATIO = 0.85

function instanceArgs() {
  return [
    '--ts3-server=ts.test.pl:9987',
    `--channel=${CHANNEL}`,
    '--signaling=ws://127.0.0.1:8080',
    '--use-fake-device-for-media-stream'
  ]
}

/*
 * PowerShell wstawiony tutaj, a nie w osobnym pliku .ps1, celowo: Windows
 * PowerShell 5.1 czyta .ps1 bez BOM-u jako ANSI, więc polskie znaki
 * w komentarzach takiego pliku są miną. Tu wszystko jest po angielsku i ASCII,
 * a wyjaśnienie siedzi w komentarzach JS, które Node czyta jako UTF-8.
 */
const WINAPI = [
  '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
  '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }'
].join(' ')

function runPowerShell(lines, label) {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', lines.join('; ')],
    { encoding: 'utf8' }
  ).trim()
  if (!out.startsWith('ok')) throw new Error(`${label}: ${out || 'brak odpowiedzi'}`)
  return out
}

const PS_PREAMBLE = [
  '$ErrorActionPreference = "Stop"',
  `$sig = '${WINAPI}'`,
  // Bez -UsingNamespace: Add-Type dokłada System.Runtime.InteropServices sam,
  // a jawny duplikat jest tu traktowany jako błąd kompilacji.
  // -PassThru oddaje TABLICE typow (klasa plus zagniezdzona struktura RECT),
  // wiec trzeba wylowic klase z metodami — bez tego $api jest tablica
  // i wywolanie metody wywala sie na "does not contain a method named".
  "$api = @(Add-Type -MemberDefinition $sig -Name Occ -Namespace E2E -PassThru) | Where-Object { $_.Name -eq 'Occ' }",
  '$TOPMOST = [IntPtr](-1)',
  '$NOTOPMOST = [IntPtr](-2)'
]

/** Przenosi okno `coverPid` dokładnie nad okno `targetPid` i trzyma na wierzchu. */
function occlude(targetPid, coverPid) {
  return runPowerShell(
    [
      ...PS_PREAMBLE,
      `$target = (Get-Process -Id ${targetPid}).MainWindowHandle`,
      `$cover = (Get-Process -Id ${coverPid}).MainWindowHandle`,
      'if ($target -eq 0 -or $cover -eq 0) { Write-Output "brak uchwytu okna"; exit 1 }',
      '$rect = New-Object E2E.Occ+RECT',
      '$null = $api::GetWindowRect($target, [ref]$rect)',
      '$x = $rect.Left - 8; $y = $rect.Top - 8',
      '$w = ($rect.Right - $rect.Left) + 16; $h = ($rect.Bottom - $rect.Top) + 16',
      '$null = $api::SetWindowPos($cover, $TOPMOST, $x, $y, $w, $h, 0x0040)',
      'Write-Output "ok ${w}x${h}+${x}+${y}"'
    ],
    'zasłanianie'
  )
}

/** Zdejmuje „zawsze na wierzchu" z okna zasłaniającego i wraca do celu. */
function unocclude(targetPid, coverPid) {
  return runPowerShell(
    [
      ...PS_PREAMBLE,
      `$cover = (Get-Process -Id ${coverPid}).MainWindowHandle`,
      `$target = (Get-Process -Id ${targetPid}).MainWindowHandle`,
      'if ($cover -ne 0) { $null = $api::SetWindowPos($cover, $NOTOPMOST, 0, 0, 0, 0, 0x0003) }',
      'if ($target -ne 0) { $null = $api::SetWindowPos($target, $TOPMOST, 0, 0, 0, 0, 0x0003); $null = $api::SetWindowPos($target, $NOTOPMOST, 0, 0, 0, 0, 0x0003) }',
      'Write-Output "ok restore"'
    ],
    'przywracanie'
  )
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
 * Sonda zegarowa. Zapisuje znaczniki czasu, a nie same odstępy — odstępy
 * liczymy dopiero przy odczycie, żeby dławienie nie zdążyło zafałszować
 * samego liczenia.
 */
const TICK_PROBE = `
  (() => {
    window.__ticks = []
    if (window.__tickTimer) clearInterval(window.__tickTimer)
    window.__tickTimer = setInterval(() => window.__ticks.push(Date.now()), ${TICK_NOMINAL_MS})
  })()
`

/** Odczyt trzech ścieżek naraz, żeby dotyczyły tego samego okna czasu. */
const SAMPLE = `
  (async () => {
    const video = document.querySelector('.tile__video')
    const quality =
      video && video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null
    let decoded = null
    for (const pc of window.__pcs ?? []) {
      const stats = await pc.getStats()
      stats.forEach((entry) => {
        if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
          decoded = (decoded ?? 0) + (entry.framesDecoded ?? 0)
        }
      })
    }
    return JSON.stringify({
      at: Date.now(),
      ticks: (window.__ticks ?? []).slice(),
      decoded,
      presented: quality ? quality.totalVideoFrames : null
    })
  })()
`

/** Najdłuższa przerwa między tyknięciami w podanym oknie czasu. */
function longestGap(ticks, fromAt, toAt) {
  const inWindow = ticks.filter((tick) => tick >= fromAt && tick <= toAt)
  const edges = [fromAt, ...inWindow, toAt]
  let longest = 0
  for (let i = 1; i < edges.length; i++) longest = Math.max(longest, edges[i] - edges[i - 1])
  return longest
}

function perSecond(delta, ms) {
  return ms > 0 ? (delta * 1000) / ms : 0
}

function phaseReport(before, after) {
  const ms = after.at - before.at
  return {
    tickGapMs: longestGap(after.ticks, before.at, after.at),
    decodedPerS: perSecond((after.decoded ?? 0) - (before.decoded ?? 0), ms),
    presentedPerS: perSecond((after.presented ?? 0) - (before.presented ?? 0), ms)
  }
}

const processes = []
let exitCode = 0
let A = null
let B = null
let covering = false
let procA = null
let procB = null

try {
  procA = launchApp(PORT_A, instanceArgs())
  procB = launchApp(PORT_B, instanceArgs())
  processes.push(procA, procB)

  A = await attach(PORT_A)
  B = await attach(PORT_B)

  await B.call('Page.enable')
  await B.call('Page.addScriptToEvaluateOnNewDocument', { source: PC_HOOK })
  await B.call('Page.reload')
  await sleep(3_000)

  await waitReady(A, 'A (nadawca)')
  await waitReady(B, 'B (odbiorca)')
  console.log('Obie instancje w kanale. A zaczyna udostępniać ekran...')
  console.log('start udostępniania u A:', await shareScreen(A))

  let hasImage = false
  for (let i = 0; i < 30; i++) {
    hasImage = await B.evaluate(
      `(() => {
        const v = document.querySelector('.tile__video')
        return !!v && v.videoWidth > 0
      })()`
    )
    if (hasImage) break
    await sleep(500)
  }
  if (!hasImage) throw new Error('B nie zobaczył obrazu od A — nie ma czego mierzyć')
  console.log('B odbiera obraz. Startuję sondę zegarową.')

  await B.evaluate(TICK_PROBE)
  await sleep(1_000)

  // --- faza 1: okno B WIDOCZNE (odniesienie) ---
  const beforeVisible = JSON.parse(await B.evaluate(SAMPLE))
  console.log(`Faza 1 z ${PHASE_MS / 1000} s: okno B widoczne...`)
  await sleep(PHASE_MS)
  const afterVisible = JSON.parse(await B.evaluate(SAMPLE))

  // --- faza 2: okno B ZASŁONIĘTE oknem A ---
  console.log(`Faza 2 z ${PHASE_MS / 1000} s: zasłaniam okno B oknem A...`)
  console.log('  ', occlude(procB.pid, procA.pid))
  covering = true
  // Windows potrzebuje chwili, żeby wykryć zasłonięcie i zgłosić je Chromium.
  await sleep(2_000)
  const beforeHidden = JSON.parse(await B.evaluate(SAMPLE))
  await sleep(PHASE_MS)
  const afterHidden = JSON.parse(await B.evaluate(SAMPLE))

  console.log('  ', unocclude(procB.pid, procA.pid))
  covering = false

  const visible = phaseReport(beforeVisible, afterVisible)
  const hidden = phaseReport(beforeHidden, afterHidden)

  console.log('\n=== ZEGARY (sonda setInterval 1000 ms) ===')
  console.log(`  widoczne:    najdłuższa przerwa ${visible.tickGapMs} ms`)
  console.log(`  zasłonięte:  najdłuższa przerwa ${hidden.tickGapMs} ms`)

  console.log('\n=== DEKODOWANIE (inbound-rtp.framesDecoded) ===')
  console.log(`  widoczne:    ${visible.decodedPerS.toFixed(1)} klatek/s`)
  console.log(`  zasłonięte:  ${hidden.decodedPerS.toFixed(1)} klatek/s`)

  console.log('\n=== RYSOWANIE (totalVideoFrames wystawione na ekran) ===')
  console.log(`  widoczne:    ${visible.presentedPerS.toFixed(1)} klatek/s`)
  console.log(`  zasłonięte:  ${hidden.presentedPerS.toFixed(1)} klatek/s`)

  console.log('\n=== OCENA ===')

  if (hidden.tickGapMs > MAX_TICK_GAP_MS) {
    console.error(
      `  DŁAWIONE ZEGARY: przerwa ${hidden.tickGapMs} ms ` +
        `przy nominalnych ${TICK_NOMINAL_MS} ms (próg ${MAX_TICK_GAP_MS} ms).`
    )
    console.error('  -> to jest przyczyna „interfejs muli, gdy wracam".')
    exitCode = 1
  } else {
    console.log('  zegary: w porządku')
  }

  const paths = [
    ['DEKODOWANIE', 'decodedPerS', 'strumień nie jest dekodowany w tle'],
    ['RYSOWANIE', 'presentedPerS', 'to jest przyczyna „cudzy obraz zacina się u mnie"']
  ]
  for (const [name, key, symptom] of paths) {
    if (visible[key] <= 0) {
      console.error(`  ${name}: brak odniesienia (okno widoczne dało 0) — pomiar nieważny`)
      exitCode = 1
      continue
    }
    const ratio = hidden[key] / visible[key]
    if (ratio < MIN_FRAME_RATIO) {
      console.error(
        `  DŁAWIONE ${name}: ${(ratio * 100).toFixed(0)}% tempa widocznego okna ` +
          `(próg ${MIN_FRAME_RATIO * 100}%).`
      )
      console.error(`  -> ${symptom}`)
      exitCode = 1
    } else {
      console.log(
        `  ${name.toLowerCase()}: w porządku (${(ratio * 100).toFixed(0)}% tempa widocznego)`
      )
    }
  }

  if (exitCode === 0) {
    console.log('\nOK: zasłonięte okno nie jest dławione.')
  } else {
    console.error('\nDŁAWIENIE POTWIERDZONE — patrz wyżej, która ścieżka.')
  }
} catch (err) {
  console.error('\nBŁĄD pomiaru:', err instanceof Error ? err.message : String(err))
  exitCode = 1
} finally {
  // Okna muszą wrócić także wtedy, gdy pomiar padł w fazie 2 — inaczej
  // zostawiamy użytkownikowi okno przyklejone nad wszystkim innym.
  if (covering && procA && procB) {
    try {
      unocclude(procB.pid, procA.pid)
    } catch {
      /* proces mogl juz nie zyc */
    }
  }
  A?.close()
  B?.close()
  for (const proc of processes) proc.kill()
  await sleep(500)
}

process.exit(exitCode)
