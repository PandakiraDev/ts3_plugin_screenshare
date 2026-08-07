// Zadanie 9 (pomiar obciazenia): domyka śledztwo z TODO.md sekcja 1.
// Pytanie: przy jednoczesnym ekranie 1080p60 i kamerze, czy VP8/libvpx
// (koder programowy) jest realnym waskim gardlem CPU, czy tylko teoretycznym
// problemem, ktory nie ma znaczenia w praktyce?
//
// Metoda: jeden nadawca (A) share'uje ekran + kamere do jednego widza (B) —
// widz jest NIEZBEDNY, bo LobbySession.callPeer (session.ts) tworzy wychodzace
// RTCPeerConnection i zaczyna kodowac dopiero, gdy jest komu wyslac ofertę.
// Bez widza `getStats()` po stronie A nie zwrocilby w ogole outbound-rtp.
//
// Ekran i kamera to DWA niezalezne RTCPeerConnection (connectionKey w
// session.ts). Rozroznienie, ktore polaczenie jest czym, NIE moze isc po
// rozdzielczosci — w wariancie kamera=1080p oba maja 1920x1080. Idzie po
// `track.contentHint`, ktory `hintContent()` w session.ts ustawia na 'detail'
// dla ekranu i 'motion' dla kamery, zanim jeszcze track trafi do sendera.
//
// CPU procesu: Menedzer Zadan nie da sie odczytac bez klikania, wiec liczymy
// przez PowerShell. `Get-Process` zwraca `.CPU` = sumaryczny czas procesora
// (sekundy) zuzyty przez proces OD JEGO STARTU, zsumowany po wszystkich
// watkach/rdzeniach. Bierzemy DELTE tej wartosci w znanym oknie czasu —
// delta(CPU-sekundy) / delta(czas-scienny) daje "rownowaznik rdzeni" (1.0 =
// jeden rdzen zajety w 100% przez cale okno), niezaleznie od tego, ile rdzeni
// ma maszyna. To odpornmiejsze niz jednorazowy odczyt %CPU z Menedzera Zadan,
// ktory oscyluje probka do probki.
//
// Ktore procesy liczymy: brief pyta wprost o CPU NADAWCY, wiec licza sie
// TYLKO procesy w drzewie instancji A (ta, ktora udostepnia ekran+kamere).
// `spawn(electronPath, ...)` w cdp.mjs zwraca ChildProcess, ktorego `.pid`
// jest PID-em GLOWNEGO procesu Electrona (main process) — bez `shell: true`
// Node exec'uje binarke bezposrednio, wiec to nie posrednik. Electron w
// modelu multi-process forkuje z niego GPU process, renderer (jeden na
// BrowserWindow) i czasem utility process — kazdy jako descendant w drzewie
// procesow Windows. Zbieramy je rekurencyjnie po ParentProcessId (WMI), bo
// `Get-Process electron` sam z siebie nie odroznia, ktora galaz drzewa nalezy
// do ktorej instancji aplikacji. Ta metoda jest tez odporniejsza niz
// dopasowanie po fragmencie wiersza polecen: dziala niezaleznie od tego, co
// jeszcze jest otwarte na maszynie, bo liczy wylacznie potomkow konkretnego
// PID-u.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { attach, launchApp } from './cdp.mjs'

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Domyslnie DEFAULT_CAMERA_SETTINGS z shared/types.ts (720p/30) — wariant 1.
// Wariant 2 (sufit bitrate kamery przy 1080p60) odpala sie z CAM_RES=1080p
// CAM_FPS=60.
const CAM_RES = process.env.CAM_RES ?? '720p'
const CAM_FPS = process.env.CAM_FPS ?? '30'
// Rozbieg: czas na ustabilizowanie sie bitrate/rozdzielczosci enkodera po
// starcie strumienia (ten sam rzad wielkosci co "rozbieg" w fps-stats.mjs).
const WARMUP_MS = Number(process.env.WARMUP_MS ?? 20000)
// Okno, w ktorym mierzymy DELTE zuzycia CPU — musi byc dosc dlugie, zeby
// szum pojedynczych probek CPU sie usrednil.
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 20000)

const CHANNEL = process.env.KANAL ?? `obciazenie-e2e-${Date.now()}`
const PORT_A = 9361
const PORT_B = 9362

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
 * BFS po ParentProcessId, zaczynajac od PID-u glownego procesu jednej
 * instancji Electrona. Zwraca liste PID-ow (stringi) calego jej drzewa.
 */
async function pidTree(rootPid) {
  const script = `
    $wszystkie = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
      Select-Object ProcessId, ParentProcessId
    $wynik = New-Object 'System.Collections.Generic.HashSet[int]'
    $kolejka = New-Object 'System.Collections.Generic.Queue[int]'
    $kolejka.Enqueue(${rootPid})
    while ($kolejka.Count -gt 0) {
      $id = $kolejka.Dequeue()
      if (-not $wynik.Add($id)) { continue }
      foreach ($p in $wszystkie) {
        if ($p.ParentProcessId -eq $id) { $kolejka.Enqueue($p.ProcessId) }
      }
    }
    ($wynik -join ',')
  `
  const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  return stdout.trim()
}

/**
 * Suma `.CPU` (sekundy procesora od startu procesu) po liscie PID-ow.
 *
 * Maszyna ma polskie ustawienia regionalne — `Write-Output $suma` dla double
 * drukuje z PRZECINKIEM dziesietnym ("12,3456"), a `parseFloat` w JS ucina
 * liczbe na pierwszym nieliczbowym znaku, czyli w praktyce ucina do samej
 * czesci calkowitej bez ostrzezenia (sprawdzone: `Get-Culture` -> pl-PL).
 * `.ToString(InvariantCulture)` wymusza kropke, niezaleznie od locale hosta.
 */
async function cpuSecondsForPids(pidCsv) {
  if (!pidCsv) return 0
  const script = `
    $suma = (Get-Process -Id ${pidCsv} -ErrorAction SilentlyContinue |
      Measure-Object -Property CPU -Sum).Sum
    if ($null -eq $suma) { Write-Output '0' } else {
      Write-Output $suma.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
  `
  const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  const value = parseFloat(stdout.trim())
  return Number.isFinite(value) ? value : 0
}

/** Ile procesow w podanym PID-csv istnieje w tej chwili — do logu diagnostycznego. */
async function pidCount(pidCsv) {
  return pidCsv ? pidCsv.split(',').length : 0
}

/** Hak na RTCPeerConnection — TYM RAZEM na nadawcy (A), bo to jego getStats() nas interesuje. */
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

const GRID = `(() => {
  const tiles = [...document.querySelectorAll('.tile')].map(el => {
    const v = el.querySelector('.tile__video')
    return { image: v && v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : 'BRAK' }
  })
  return JSON.stringify({ count: tiles.length, tiles })
})()`

async function waitReady(cdp, label) {
  for (let i = 0; i < 40; i++) {
    if ((await cdp.evaluate(SHARE_BUTTON)) === 'AKTYWNY') return
    await sleep(500)
  }
  throw new Error(`${label}: nie doczekalem sie polaczenia z serwerem sygnalizacyjnym`)
}

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

/**
 * Ustawia <select> kontrolowany przez React. Samo `el.value = x` nie
 * przechodzi — React nadpisuje setter `value` na prototypie i pilnuje, zeby
 * zmiana szla przez ten sam kanal co prawdziwa interakcja uzytkownika. Trik:
 * wywolac setter z PROTOTYPU (nie z instancji), dopiero potem wyemitowac
 * 'change'. Ten sam wzorzec dziala w testach RTL/Selenium na kontrolowanych
 * polach React.
 */
function setSelect(id, value) {
  return `(() => {
    const el = document.getElementById('${id}')
    if (!el) return 'BRAK ELEMENTU ${id}'
    const proto = Object.getPrototypeOf(el)
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, '${value}')
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return el.value
  })()`
}

function clickSegment(regex) {
  return `(() => {
    const b = [...document.querySelectorAll('.segmented__option')].find(x => ${regex}.test(x.textContent))
    if (!b) return 'BRAK'
    b.click(); return 'ok'
  })()`
}

/**
 * Panel ustawien (ekran + kamera) jest zawsze dostepny spod zebatki w
 * naglowku, niezaleznie od tego, czy ekran juz leci — LobbyView renderuje go
 * warunkiem `settingsOpen`, nie stanem picker'a. Ustawiamy WSZYSTKO
 * jawnie (nawet to, co juz jest domyslne) — zeby wynik pomiaru nie zalezal od
 * cichego zalozenia, ze defaulty sie nie zmienia.
 */
async function configureQuality(cdp) {
  await cdp.evaluate(`document.querySelector('button[aria-label="Ustawienia"]').click()`)
  await sleep(500)
  const screenResolutionResult = await cdp.evaluate(setSelect('resolution', '1080p'))
  const screenFpsResult = await cdp.evaluate(clickSegment('/60 FPS/'))
  const cameraResolutionResult = await cdp.evaluate(setSelect('camera-resolution', CAM_RES))
  const cameraFpsResult = await cdp.evaluate(setSelect('camera-fps', CAM_FPS))
  await sleep(300)
  return { screenResolutionResult, screenFpsResult, cameraResolutionResult, cameraFpsResult }
}

/**
 * Staty nadawcze osobno dla kazdej sciezki (ekran/kamera), rozroznione po
 * `contentHint` sendera — patrz komentarz na gorze pliku. Brak polegania na
 * frameWidth/frameHeight, bo przy kamerze=1080p oba sa identyczne.
 */
const SENDER_STATS_BY_KIND = `(async () => {
  const result = {}
  for (const pc of window.__pcs || []) {
    const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video')
    if (!videoSender) continue
    const streamKind = videoSender.track.contentHint === 'detail' ? 'screen' : 'camera'
    const stats = await pc.getStats()
    const codecs = new Map()
    stats.forEach(s => { if (s.type === 'codec') codecs.set(s.id, s.mimeType) })
    stats.forEach(s => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') {
        result[streamKind] = {
          encoderImplementation: s.encoderImplementation ?? null,
          framesPerSecond: s.framesPerSecond ?? null,
          qualityLimitationReason: s.qualityLimitationReason ?? null,
          size: (s.frameWidth ?? '?') + 'x' + (s.frameHeight ?? '?'),
          framesEncoded: s.framesEncoded ?? null,
          targetBitrateKbps: s.targetBitrate ? Math.round(s.targetBitrate / 1000) : null,
          codec: codecs.get(s.codecId) ?? null
        }
      }
    })
  }
  return JSON.stringify(result)
})()`

async function main() {
  console.log(`=== Pomiar obciazenia: kamera ${CAM_RES}@${CAM_FPS}fps + ekran 1080p60 ===`)
  console.log(`kanal: ${CHANNEL}`)

  const a = launchApp(PORT_A, instanceArgs([]))
  const b = launchApp(PORT_B, instanceArgs([]))

  let A
  let B
  try {
    A = await attach(PORT_A)
    B = await attach(PORT_B)

    await withHook(A)
    await sleep(1000)
    await waitReady(A, 'A')
    await waitReady(B, 'B')
    console.log('oboje polaczeni z kanalem')

    const quality = await configureQuality(A)
    console.log('ustawienia jakosci:', JSON.stringify(quality))

    console.log('start ekranu:', await shareScreen(A))
    const afterScreen = await waitForGrid(B, 1)
    if (afterScreen.count !== 1) {
      throw new Error(`po starcie ekranu B widzi ${afterScreen.count} kafelkow, oczekiwano 1`)
    }
    console.log('B widzi ekran')

    console.log('start kamery:', await enableCamera(A))
    const afterCamera = await waitForGrid(B, 2)
    if (afterCamera.count !== 2) {
      throw new Error(`po wlaczeniu kamery B widzi ${afterCamera.count} kafelkow, oczekiwano 2`)
    }
    console.log('B widzi ekran + kamere:', JSON.stringify(afterCamera.tiles))

    console.log(`rozbieg ${WARMUP_MS}ms...`)
    await sleep(WARMUP_MS)

    // Drzewo PID-ow raz, PRZED oknem pomiaru — steady-state streamingu nie
    // powinien tworzyc/zamykac procesow w trakcie, wiec to samo drzewo
    // uzywamy do obu odczytow CPU (odejmowanie tych samych procesow od
    // samych siebie). Rozmiar drzewa logujemy na obu koncach jako kontrole.
    const treeA = await pidTree(a.pid)
    const treeB = await pidTree(b.pid)
    console.log(`drzewo procesow A (nadawca, root pid ${a.pid}): ${await pidCount(treeA)} proc.`)
    console.log(`drzewo procesow B (odbiorca, root pid ${b.pid}): ${await pidCount(treeB)} proc.`)

    const cpuABefore = await cpuSecondsForPids(treeA)
    const cpuBBefore = await cpuSecondsForPids(treeB)
    const timeBefore = Date.now()
    const statsStart = JSON.parse(await A.evaluate(SENDER_STATS_BY_KIND))
    console.log('staty na poczatku okna:', JSON.stringify(statsStart))

    console.log(`okno pomiaru CPU: ${WINDOW_MS}ms...`)
    await sleep(WINDOW_MS)

    const treeAEnd = await pidTree(a.pid)
    const cpuAAfter = await cpuSecondsForPids(treeA)
    const cpuBAfter = await cpuSecondsForPids(treeB)
    const timeAfter = Date.now()
    const statsEnd = JSON.parse(await A.evaluate(SENDER_STATS_BY_KIND))

    if (await pidCount(treeAEnd) !== await pidCount(treeA)) {
      console.log(
        `UWAGA: drzewo procesow A zmienilo rozmiar w trakcie okna ` +
          `(${await pidCount(treeA)} -> ${await pidCount(treeAEnd)}) — ` +
          `delta CPU moze nie objac procesu, ktory powstal/zniknal w trakcie.`
      )
    }

    const windowSeconds = (timeAfter - timeBefore) / 1000
    const cpuDeltaA = cpuAAfter - cpuABefore
    const cpuDeltaB = cpuBAfter - cpuBBefore
    const coresA = cpuDeltaA / windowSeconds
    const coresB = cpuDeltaB / windowSeconds

    console.log('\n=== WYNIK ===')
    console.log(`wariant: kamera ${CAM_RES}@${CAM_FPS}fps + ekran 1080p60`)
    console.log(`okno pomiaru CPU: ${windowSeconds.toFixed(1)} s`)
    console.log(
      `CPU NADAWCY (A, ekran+kamera razem, ${await pidCount(treeA)} proc.): ` +
        `${cpuABefore.toFixed(2)}s -> ${cpuAAfter.toFixed(2)}s, delta ${cpuDeltaA.toFixed(2)}s ` +
        `= ${coresA.toFixed(2)} rdzenia-rownowaznika`
    )
    console.log(
      `CPU ODBIORCY (B, dekodowanie+render obu strumieni, ${await pidCount(treeB)} proc.): ` +
        `${cpuBBefore.toFixed(2)}s -> ${cpuBAfter.toFixed(2)}s, delta ${cpuDeltaB.toFixed(2)}s ` +
        `= ${coresB.toFixed(2)} rdzenia-rownowaznika`
    )
    console.log('staty na koncu okna:', JSON.stringify(statsEnd, null, 2))
  } catch (err) {
    console.log('BLAD:', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  } finally {
    A?.close()
    B?.close()
    a.kill()
    b.kill()
    await sleep(500)
  }
}

await main()
