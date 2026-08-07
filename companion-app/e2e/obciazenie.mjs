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

const KANAL = process.env.KANAL ?? `obciazenie-e2e-${Date.now()}`
const PORT_A = 9361
const PORT_B = 9362

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
 * BFS po ParentProcessId, zaczynajac od PID-u glownego procesu jednej
 * instancji Electrona. Zwraca liste PID-ow (stringi) calego jej drzewa.
 */
async function drzewoPid(rootPid) {
  const skrypt = `
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
  const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', skrypt])
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
async function cpuSekundDlaPidow(pidCsv) {
  if (!pidCsv) return 0
  const skrypt = `
    $suma = (Get-Process -Id ${pidCsv} -ErrorAction SilentlyContinue |
      Measure-Object -Property CPU -Sum).Sum
    if ($null -eq $suma) { Write-Output '0' } else {
      Write-Output $suma.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
  `
  const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', skrypt])
  const wartosc = parseFloat(stdout.trim())
  return Number.isFinite(wartosc) ? wartosc : 0
}

/** Ile procesow w podanym PID-csv istnieje w tej chwili — do logu diagnostycznego. */
async function liczbaPidow(pidCsv) {
  return pidCsv ? pidCsv.split(',').length : 0
}

/** Hak na RTCPeerConnection — TYM RAZEM na nadawcy (A), bo to jego getStats() nas interesuje. */
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

const SIATKA = `(() => {
  const kafelki = [...document.querySelectorAll('.tile')].map(el => {
    const v = el.querySelector('.tile__video')
    return { obraz: v && v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : 'BRAK' }
  })
  return JSON.stringify({ ile: kafelki.length, kafelki })
})()`

async function czekajNaGotowosc(cdp, etykieta) {
  for (let i = 0; i < 40; i++) {
    if ((await cdp.evaluate(PRZYCISK_UDOSTEPNIJ)) === 'AKTYWNY') return
    await sleep(500)
  }
  throw new Error(`${etykieta}: nie doczekalem sie polaczenia z serwerem sygnalizacyjnym`)
}

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

/**
 * Ustawia <select> kontrolowany przez React. Samo `el.value = x` nie
 * przechodzi — React nadpisuje setter `value` na prototypie i pilnuje, zeby
 * zmiana szla przez ten sam kanal co prawdziwa interakcja uzytkownika. Trik:
 * wywolac setter z PROTOTYPU (nie z instancji), dopiero potem wyemitowac
 * 'change'. Ten sam wzorzec dziala w testach RTL/Selenium na kontrolowanych
 * polach React.
 */
function ustawSelect(id, wartosc) {
  return `(() => {
    const el = document.getElementById('${id}')
    if (!el) return 'BRAK ELEMENTU ${id}'
    const proto = Object.getPrototypeOf(el)
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, '${wartosc}')
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return el.value
  })()`
}

function klikSegmentu(regex) {
  return `(() => {
    const b = [...document.querySelectorAll('.segmented__option')].find(x => ${regex}.test(x.textContent))
    if (!b) return 'BRAK'
    b.click(); return 'ok'
  })()`
}

/**
 * Panel ustawien (ekran + kamera) jest zawsze dostepny spod zebatki w
 * naglowku, niezaleznie od tego, czy ekran juz leci — LobbyView renderuje go
 * warunkiem `ustawieniaOtwarte`, nie stanem picker'a. Ustawiamy WSZYSTKO
 * jawnie (nawet to, co juz jest domyslne) — zeby wynik pomiaru nie zalezal od
 * cichego zalozenia, ze defaulty sie nie zmienia.
 */
async function skonfigurujJakosc(cdp) {
  await cdp.evaluate(`document.querySelector('button[aria-label="Ustawienia"]').click()`)
  await sleep(500)
  const wynikRozEkranu = await cdp.evaluate(ustawSelect('resolution', '1080p'))
  const wynikFpsEkranu = await cdp.evaluate(klikSegmentu('/60 FPS/'))
  const wynikRozKamery = await cdp.evaluate(ustawSelect('camera-resolution', CAM_RES))
  const wynikFpsKamery = await cdp.evaluate(ustawSelect('camera-fps', CAM_FPS))
  await sleep(300)
  return { wynikRozEkranu, wynikFpsEkranu, wynikRozKamery, wynikFpsKamery }
}

/**
 * Staty nadawcze osobno dla kazdej sciezki (ekran/kamera), rozroznione po
 * `contentHint` sendera — patrz komentarz na gorze pliku. Brak polegania na
 * frameWidth/frameHeight, bo przy kamerze=1080p oba sa identyczne.
 */
const STATY_NADAWCY_WG_RODZAJU = `(async () => {
  const wynik = {}
  for (const pc of window.__pcs || []) {
    const senderWideo = pc.getSenders().find(s => s.track && s.track.kind === 'video')
    if (!senderWideo) continue
    const rodzaj = senderWideo.track.contentHint === 'detail' ? 'ekran' : 'kamera'
    const stats = await pc.getStats()
    const kodeki = new Map()
    stats.forEach(s => { if (s.type === 'codec') kodeki.set(s.id, s.mimeType) })
    stats.forEach(s => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') {
        wynik[rodzaj] = {
          encoderImplementation: s.encoderImplementation ?? null,
          framesPerSecond: s.framesPerSecond ?? null,
          qualityLimitationReason: s.qualityLimitationReason ?? null,
          rozmiar: (s.frameWidth ?? '?') + 'x' + (s.frameHeight ?? '?'),
          framesEncoded: s.framesEncoded ?? null,
          targetBitrateKbps: s.targetBitrate ? Math.round(s.targetBitrate / 1000) : null,
          kodek: kodeki.get(s.codecId) ?? null
        }
      }
    })
  }
  return JSON.stringify(wynik)
})()`

async function main() {
  console.log(`=== Pomiar obciazenia: kamera ${CAM_RES}@${CAM_FPS}fps + ekran 1080p60 ===`)
  console.log(`kanal: ${KANAL}`)

  const a = launchApp(PORT_A, argsInstancji([]))
  const b = launchApp(PORT_B, argsInstancji([]))

  let A
  let B
  try {
    A = await attach(PORT_A)
    B = await attach(PORT_B)

    await zHakiem(A)
    await sleep(1000)
    await czekajNaGotowosc(A, 'A')
    await czekajNaGotowosc(B, 'B')
    console.log('oboje polaczeni z kanalem')

    const jakosc = await skonfigurujJakosc(A)
    console.log('ustawienia jakosci:', JSON.stringify(jakosc))

    console.log('start ekranu:', await udostepnijEkran(A))
    const poEkranie = await czekajNaSiatke(B, 1)
    if (poEkranie.ile !== 1) {
      throw new Error(`po starcie ekranu B widzi ${poEkranie.ile} kafelkow, oczekiwano 1`)
    }
    console.log('B widzi ekran')

    console.log('start kamery:', await wlaczKamere(A))
    const poKamerze = await czekajNaSiatke(B, 2)
    if (poKamerze.ile !== 2) {
      throw new Error(`po wlaczeniu kamery B widzi ${poKamerze.ile} kafelkow, oczekiwano 2`)
    }
    console.log('B widzi ekran + kamere:', JSON.stringify(poKamerze.kafelki))

    console.log(`rozbieg ${WARMUP_MS}ms...`)
    await sleep(WARMUP_MS)

    // Drzewo PID-ow raz, PRZED oknem pomiaru — steady-state streamingu nie
    // powinien tworzyc/zamykac procesow w trakcie, wiec to samo drzewo
    // uzywamy do obu odczytow CPU (odejmowanie tych samych procesow od
    // samych siebie). Rozmiar drzewa logujemy na obu koncach jako kontrole.
    const drzewoA = await drzewoPid(a.pid)
    const drzewoB = await drzewoPid(b.pid)
    console.log(`drzewo procesow A (nadawca, root pid ${a.pid}): ${await liczbaPidow(drzewoA)} proc.`)
    console.log(`drzewo procesow B (odbiorca, root pid ${b.pid}): ${await liczbaPidow(drzewoB)} proc.`)

    const cpuAPrzed = await cpuSekundDlaPidow(drzewoA)
    const cpuBPrzed = await cpuSekundDlaPidow(drzewoB)
    const czasPrzed = Date.now()
    const statyPoczatkowe = JSON.parse(await A.evaluate(STATY_NADAWCY_WG_RODZAJU))
    console.log('staty na poczatku okna:', JSON.stringify(statyPoczatkowe))

    console.log(`okno pomiaru CPU: ${WINDOW_MS}ms...`)
    await sleep(WINDOW_MS)

    const drzewoAKoniec = await drzewoPid(a.pid)
    const cpuAPo = await cpuSekundDlaPidow(drzewoA)
    const cpuBPo = await cpuSekundDlaPidow(drzewoB)
    const czasPo = Date.now()
    const statyKoncowe = JSON.parse(await A.evaluate(STATY_NADAWCY_WG_RODZAJU))

    if (await liczbaPidow(drzewoAKoniec) !== await liczbaPidow(drzewoA)) {
      console.log(
        `UWAGA: drzewo procesow A zmienilo rozmiar w trakcie okna ` +
          `(${await liczbaPidow(drzewoA)} -> ${await liczbaPidow(drzewoAKoniec)}) — ` +
          `delta CPU moze nie objac procesu, ktory powstal/zniknal w trakcie.`
      )
    }

    const oknoSekund = (czasPo - czasPrzed) / 1000
    const deltaCpuA = cpuAPo - cpuAPrzed
    const deltaCpuB = cpuBPo - cpuBPrzed
    const rdzenieA = deltaCpuA / oknoSekund
    const rdzenieB = deltaCpuB / oknoSekund

    console.log('\n=== WYNIK ===')
    console.log(`wariant: kamera ${CAM_RES}@${CAM_FPS}fps + ekran 1080p60`)
    console.log(`okno pomiaru CPU: ${oknoSekund.toFixed(1)} s`)
    console.log(
      `CPU NADAWCY (A, ekran+kamera razem, ${await liczbaPidow(drzewoA)} proc.): ` +
        `${cpuAPrzed.toFixed(2)}s -> ${cpuAPo.toFixed(2)}s, delta ${deltaCpuA.toFixed(2)}s ` +
        `= ${rdzenieA.toFixed(2)} rdzenia-rownowaznika`
    )
    console.log(
      `CPU ODBIORCY (B, dekodowanie+render obu strumieni, ${await liczbaPidow(drzewoB)} proc.): ` +
        `${cpuBPrzed.toFixed(2)}s -> ${cpuBPo.toFixed(2)}s, delta ${deltaCpuB.toFixed(2)}s ` +
        `= ${rdzenieB.toFixed(2)} rdzenia-rownowaznika`
    )
    console.log('staty na koncu okna:', JSON.stringify(statyKoncowe, null, 2))
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
