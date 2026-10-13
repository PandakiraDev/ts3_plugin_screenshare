// Pomiar w PRAWDZIWEJ sesji: co robi aplikacja, gdy gra zajmuje maszynę.
//
// Powstał, bo `e2e/dlawienie.mjs` nie odtworzył objawu. Osiem przebiegów na
// bezczynnej maszynie — minimalizacja i prawdziwe zasłonięcie — dało od 98%
// do 139% tempa widocznego okna. Brakującą zmienną jest obciążenie procesora
// i karty przez grę, a tego nie da się uczciwie udawać. Więc nie udajemy:
// ten skrypt zbiera dane, gdy człowiek naprawdę gra.
//
// CO MIERZYMY I PO CO ROZDZIELAMY STRONY
//
// Gra na pełnym ekranie zasłania OBA okna — nadające i odbierające. Spadek
// klatek u odbiorcy mógłby więc znaczyć dwie zupełnie różne rzeczy:
// „nadawca mniej wysłał" albo „odbiorca mniej narysował". Bez rozdzielenia
// tych dwóch przypadków wynik nie mówi nic, więc próbkujemy obie strony:
//
//   NADAWCA (A):  framesEncoded, framesSent, bytesSent, qualityLimitationReason
//   ODBIORCA (B): framesReceived, framesDecoded, totalVideoFrames (wystawione),
//                 droppedVideoFrames
//
// Łańcuch czyta się wtedy od lewej: zakodowane -> wysłane -> odebrane ->
// zdekodowane -> wystawione. Pierwsze ogniwo, które siada, jest przyczyną.
//
// Stanu okna NIE pytamy człowieka — pytamy przeglądarki. Każda próbka nosi
// `visibilityState`, `hidden` i `hasFocus`, więc os czasu sama pokazuje, kiedy
// gra zasłoniła okno. Nie trzeba niczego klikać ani pamiętać.
//
// NIE ROBIMY ZRZUTÓW EKRANU. Zbierane są wyłącznie liczniki — żadna klatka
// obrazu nie opuszcza maszyny i nic nie jest zapisywane na dysk poza plikiem
// z liczbami.
//
// Wymaga działającego serwera sygnalizacyjnego:
//   cd signaling-server && npm start
//
// Uruchomienie: npm run build && npm run e2e:sesja
// Czas trwania: DURATION_MS (domyślnie 5 minut), rozbieg: LEAD_IN_MS.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { attach, launchApp } from './cdp.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const LEAD_IN_MS = Number(process.env.LEAD_IN_MS ?? 20_000)
const DURATION_MS = Number(process.env.DURATION_MS ?? 300_000)
const SAMPLE_EVERY_MS = Number(process.env.SAMPLE_EVERY_MS ?? 1_000)
const CHANNEL = process.env.CHANNEL ?? `sesja-${Date.now()}`
const SCREEN_PATTERN = process.env.SCREEN ?? 'Ekran'
const PORT_A = 9411
const PORT_B = 9412

const LOG_PATH =
  process.env.LOG_PATH ?? join(tmpdir(), `ts3-sesja-${new Date().toISOString().slice(0, 10)}.jsonl`)

/*
 * Świadomie BEZ `--use-fake-device-for-media-stream` i bez flag przeciw
 * dławieniu: mierzymy aplikację taką, jaką dostaje użytkownik. Każda flaga
 * dodana tutaj zmieniłaby to, co badamy.
 */
function instanceArgs() {
  return ['--ts3-server=ts.test.pl:9987', `--channel=${CHANNEL}`, '--signaling=ws://127.0.0.1:8080']
}

/*
 * Ustawia okno: przesuwa je i wyciąga na wierzch.
 *
 * Bez tego obie startują w tym samym miejscu, okno odbiorcy jest W CAŁOŚCI
 * zasłonięte oknem nadawcy i Chromium zgłasza je jako `hidden` od pierwszej
 * sekundy — pomiar traci odniesienie „okno widoczne". Wystarczy przesunięcie:
 * zasłonięcie zgłaszane jest tylko przy pełnym pokryciu, więc częściowy
 * zachodzenie na siebie niczego nie psuje.
 *
 * Wyciągnięcie na wierzch jest równie konieczne: okna aplikacji startują ZA
 * tym, co użytkownik ma już otwarte, i bywają przez to zasłonięte od pierwszej
 * sekundy. Pierwsza wersja tego pomiaru zebrała przez to 19 próbek i ani
 * jednej z oknem widocznym.
 */
function placeWindow(pid, dx, dy) {
  const declarations = [
    '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);',
    '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }'
  ].join(' ')
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `$sig = '${declarations}'`,
    // -PassThru oddaje tablice typow (klasa plus RECT), wiec lowimy klase.
    "$api = @(Add-Type -MemberDefinition $sig -Name Move -Namespace E2E -PassThru) | Where-Object { $_.Name -eq 'Move' }",
    `$h = (Get-Process -Id ${pid}).MainWindowHandle`,
    'if ($h -eq 0) { Write-Output "brak uchwytu okna"; exit 1 }',
    '$r = New-Object E2E.Move+RECT',
    '$null = $api::GetWindowRect($h, [ref]$r)',
    // SWP_NOSIZE = 0x0001, SWP_NOZORDER = 0x0004
    `$null = $api::SetWindowPos($h, [IntPtr]::Zero, ($r.Left + ${dx}), ($r.Top + ${dy}), 0, 0, 0x0005)`,
    // Wyciagniecie na wierzch: TOPMOST, a zaraz potem NOTOPMOST. Podnosi okno
    // nad pozostale, ale NIE zostawia go przyklejonego nad wszystkim — inaczej
    // gra nie moglaby go zaslonic i caly pomiar bylby bez sensu.
    // SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001
    '$null = $api::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003)',
    '$null = $api::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003)',
    'Write-Output "ok"'
  ]
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', lines.join('; ')],
    { encoding: 'utf8' }
  ).trim()
  if (!out.startsWith('ok')) throw new Error(`przesuwanie okna: ${out || 'brak odpowiedzi'}`)
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

const SHARE_BUTTON = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Udostępnij ekran/.test(x.textContent))
  return b ? (b.disabled ? 'NIEAKTYWNY' : 'AKTYWNY') : 'BRAK'
})()`

async function waitReady(cdp, label) {
  for (let i = 0; i < 60; i++) {
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
  const picked = await cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll('.source-card')]
      .find(c => ${JSON.stringify(SCREEN_PATTERN)} && new RegExp(${JSON.stringify(SCREEN_PATTERN)}).test(c.textContent))
    if (!card) return 'BRAK KARTY'
    card.click()
    return card.textContent.trim()
  })()`)
  await sleep(2_500)
  const started = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x=>/Rozpocznij udostępnianie/.test(x.textContent))
    if (!b) return 'BRAK PRZYCISKU'
    if (b.disabled) return 'NIEAKTYWNY'
    b.click(); return 'ok'
  })()`)
  return { picked, started }
}

/** Próbka u NADAWCY: ile w ogóle wyprodukował i wysłał. */
const SAMPLE_SENDER = `
  (async () => {
    let encoded = 0, sent = 0, bytes = 0, limitation = null, fps = null
    for (const pc of window.__pcs ?? []) {
      let stats
      try { stats = await pc.getStats() } catch { continue }
      stats.forEach((e) => {
        if (e.type === 'outbound-rtp' && e.kind === 'video') {
          encoded += e.framesEncoded ?? 0
          sent += e.framesSent ?? 0
          bytes += e.bytesSent ?? 0
          if (e.qualityLimitationReason && e.qualityLimitationReason !== 'none') {
            limitation = e.qualityLimitationReason
          }
          if (e.framesPerSecond != null) fps = e.framesPerSecond
        }
      })
    }
    return JSON.stringify({
      at: Date.now(),
      visibility: document.visibilityState,
      hidden: document.hidden,
      focus: document.hasFocus(),
      encoded, sent, bytes, limitation, fps
    })
  })()
`

/** Próbka u ODBIORCY: ile dotarło, ile zdekodowano, ile wystawiono na ekran. */
const SAMPLE_RECEIVER = `
  (async () => {
    let received = 0, decoded = 0, bytes = 0, fps = null
    for (const pc of window.__pcs ?? []) {
      let stats
      try { stats = await pc.getStats() } catch { continue }
      stats.forEach((e) => {
        if (e.type === 'inbound-rtp' && e.kind === 'video') {
          received += e.framesReceived ?? 0
          decoded += e.framesDecoded ?? 0
          bytes += e.bytesReceived ?? 0
          if (e.framesPerSecond != null) fps = e.framesPerSecond
        }
      })
    }
    let presented = null, dropped = null
    const video = document.querySelector('.tile__video')
    if (video && video.getVideoPlaybackQuality) {
      const q = video.getVideoPlaybackQuality()
      presented = q.totalVideoFrames
      dropped = q.droppedVideoFrames
    }
    return JSON.stringify({
      at: Date.now(),
      visibility: document.visibilityState,
      hidden: document.hidden,
      focus: document.hasFocus(),
      received, decoded, bytes, fps, presented, dropped
    })
  })()
`

/** Tempo na sekundę między dwiema próbkami. */
function rate(prev, next, key) {
  const ms = next.at - prev.at
  if (ms <= 0) return null
  const delta = (next[key] ?? 0) - (prev[key] ?? 0)
  return (delta * 1000) / ms
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function describe(label, values) {
  const m = median(values)
  if (m === null) return `  ${label}: brak danych`
  return `  ${label}: mediana ${m.toFixed(1)}/s (próbek ${values.length})`
}

const processes = []
let exitCode = 0
let A = null
let B = null

try {
  mkdirSync(dirname(LOG_PATH), { recursive: true })

  processes.push(launchApp(PORT_A, instanceArgs()))
  processes.push(launchApp(PORT_B, instanceArgs()))

  A = await attach(PORT_A)
  B = await attach(PORT_B)

  for (const [cdp, label] of [
    [A, 'A'],
    [B, 'B']
  ]) {
    await cdp.call('Page.enable')
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: PC_HOOK })
    await cdp.call('Page.reload')
    void label
  }
  await sleep(3_000)

  await waitReady(A, 'A (nadawca)')
  await waitReady(B, 'B (odbiorca)')
  const share = await shareScreen(A)
  console.log(`Udostępnianie: źródło „${share.picked}", start: ${share.started}`)
  if (share.started !== 'ok') throw new Error('nie udało się rozpocząć udostępniania')

  let hasImage = false
  for (let i = 0; i < 40; i++) {
    hasImage = await B.evaluate(
      `(() => { const v = document.querySelector('.tile__video'); return !!v && v.videoWidth > 0 })()`
    )
    if (hasImage) break
    await sleep(500)
  }
  if (!hasImage) throw new Error('odbiorca nie zobaczył obrazu — nie ma czego mierzyć')

  // Odniesienie wymaga, żeby okno odbiorcy nie było zasłonięte oknem nadawcy.
  placeWindow(processes[0].pid, 0, 0)
  placeWindow(processes[1].pid, 160, 120)
  await sleep(1_500)
  const visibilityCheck = await B.evaluate('document.visibilityState')
  console.log(`Okna rozsunięte i wyciągnięte na wierzch. Odbiorca widzi się jako: ${visibilityCheck}`)
  if (visibilityCheck !== 'visible') {
    console.log('UWAGA: odniesienie „okno widoczne" może nie powstać — odsłoń okna ręcznie.')
  }

  console.log('\n' + '='.repeat(64))
  console.log('  OBRAZ PŁYNIE. TERAZ WŁĄCZ GRĘ NA PEŁNYM EKRANIE I GRAJ.')
  const durationLabel =
    DURATION_MS >= 60_000 ? `${(DURATION_MS / 60_000).toFixed(1)} min` : `${DURATION_MS / 1000} s`
  console.log(`  Masz ${LEAD_IN_MS / 1000} s rozbiegu, potem ${durationLabel} pomiaru.`)
  console.log('  Nie zamykaj okien aplikacji — zasłoń je grą. Wróć, gdy się skończy.')
  console.log('='.repeat(64) + '\n')

  await sleep(LEAD_IN_MS)
  console.log('Pomiar wystartował. Zbieram próbki...')

  const samplesA = []
  const samplesB = []
  const startedAt = Date.now()
  let lastLog = 0

  while (Date.now() - startedAt < DURATION_MS) {
    const [rawA, rawB] = await Promise.all([A.evaluate(SAMPLE_SENDER), B.evaluate(SAMPLE_RECEIVER)])
    const sampleA = JSON.parse(rawA)
    const sampleB = JSON.parse(rawB)
    samplesA.push(sampleA)
    samplesB.push(sampleB)
    appendFileSync(LOG_PATH, JSON.stringify({ a: sampleA, b: sampleB }) + '\n', 'utf8')

    const elapsed = Math.floor((Date.now() - startedAt) / 1000)
    if (elapsed - lastLog >= 30) {
      lastLog = elapsed
      console.log(
        `  ${elapsed}s — odbiorca: ${sampleB.visibility}, ` +
          `nadawca: ${sampleA.visibility}${sampleA.limitation ? `, limit: ${sampleA.limitation}` : ''}`
      )
    }
    await sleep(SAMPLE_EVERY_MS)
  }

  console.log('\nPomiar zakończony. Możesz wyjść z gry.')

  // --- analiza: rozdzielamy próbki po stanie okna ODBIORCY ---
  const buckets = { visible: [], hidden: [] }
  for (let i = 1; i < samplesB.length; i++) {
    const prevB = samplesB[i - 1]
    const nextB = samplesB[i]
    const prevA = samplesA[i - 1]
    const nextA = samplesA[i]
    const bucket = nextB.hidden ? 'hidden' : 'visible'
    buckets[bucket].push({
      encoded: rate(prevA, nextA, 'encoded'),
      sent: rate(prevA, nextA, 'sent'),
      received: rate(prevB, nextB, 'received'),
      decoded: rate(prevB, nextB, 'decoded'),
      presented: rate(prevB, nextB, 'presented'),
      limitation: nextA.limitation
    })
  }

  console.log('\n' + '='.repeat(64))
  console.log(`  WYNIK — zapis surowy: ${LOG_PATH}`)
  console.log('='.repeat(64))

  for (const [name, label] of [
    ['visible', 'OKNO ODBIORCY WIDOCZNE'],
    ['hidden', 'OKNO ODBIORCY UKRYTE / ZASŁONIĘTE']
  ]) {
    const rows = buckets[name]
    console.log(`\n--- ${label} (${rows.length} próbek) ---`)
    if (rows.length === 0) {
      console.log('  brak próbek w tym stanie')
      continue
    }
    console.log(describe('zakodowane u nadawcy ', rows.map((r) => r.encoded)))
    console.log(describe('wysłane u nadawcy    ', rows.map((r) => r.sent)))
    console.log(describe('odebrane u odbiorcy  ', rows.map((r) => r.received)))
    console.log(describe('zdekodowane          ', rows.map((r) => r.decoded)))
    console.log(describe('WYSTAWIONE NA EKRAN  ', rows.map((r) => r.presented)))
    const limits = [...new Set(rows.map((r) => r.limitation).filter(Boolean))]
    console.log(`  powody ograniczenia jakości: ${limits.length ? limits.join(', ') : 'brak'}`)
  }

  if (buckets.hidden.length === 0) {
    console.log('\nUWAGA: ani jedna próbka nie zastała okna ukrytego.')
    console.log('Albo gra nie zasłoniła okien, albo Chromium nie zgłasza tego jako "hidden".')
    console.log('To też jest wynik — znaczy, że przyczyny trzeba szukać poza widocznością okna.')
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
