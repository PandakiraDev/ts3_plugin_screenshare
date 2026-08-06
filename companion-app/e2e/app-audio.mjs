// Cala droga dzwieku z wybranej aplikacji: modul natywny -> main -> renderer
// -> MediaStreamTrack -> RTCPeerConnection.
//
// Po co osobno, skoro sa testy jednostkowe: transport Electrona, WebCodecs
// i WebRTC istnieja tylko wewnatrz Electrona. Vitest w Node ich nie dotyka.
// Ta klasa bledow raz juz dala nam komplet zielonych testow i zero probek
// w aplikacji — patrz audio-native/README.md.
//
// Zrodlo: wlasne okno aplikacji. Jest ciche, ale to nie przeszkadza — strumien
// loopback chodzi zegarem silnika audio, nie aktywnoscia programu.
import { attach, launchApp } from './cdp.mjs'

const PORT_CDP = 9333

const electron = launchApp(PORT_CDP)

let cdp
try {
  cdp = await attach(PORT_CDP)

  const wynik = await cdp.evaluate(`(async () => {
    const zrodla = await window.companion.getSources()
    const okno = zrodla.find((s) => s.type === 'window')
    if (!okno) throw new Error('nie znalazlem zadnego okna do przechwycenia')

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

    const format = await window.companion.startAppAudio(okno.id)
    const port = await oczekiwanie

    const generator = new MediaStreamTrackGenerator({ kind: 'audio' })
    const writer = generator.writable.getWriter()
    let ramekWyslanych = 0
    let pakietow = 0

    port.onmessage = (e) => {
      const probki = new Float32Array(e.data)
      const ramek = probki.length / format.channels
      writer
        .write(
          new AudioData({
            format: 'f32',
            sampleRate: format.sampleRate,
            numberOfFrames: ramek,
            numberOfChannels: format.channels,
            timestamp: Math.round((ramekWyslanych / format.sampleRate) * 1e6),
            data: probki
          })
        )
        .catch(() => {})
      ramekWyslanych += ramek
      pakietow += 1
    }
    port.start()

    // Petla lokalna: dwa polaczenia w tym samym oknie.
    const pc1 = new RTCPeerConnection()
    const pc2 = new RTCPeerConnection()
    pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate)
    pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate)
    pc1.addTrack(generator, new MediaStream([generator]))

    const oferta = await pc1.createOffer()
    await pc1.setLocalDescription(oferta)
    await pc2.setRemoteDescription(oferta)
    const odpowiedz = await pc2.createAnswer()
    await pc2.setLocalDescription(odpowiedz)
    await pc1.setRemoteDescription(odpowiedz)

    await new Promise((r) => setTimeout(r, 2000))

    let we = null
    ;(await pc2.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') we = s
    })

    await window.companion.stopAppAudio()
    pc1.close()
    pc2.close()

    return {
      okno: okno.name,
      format,
      pakietow,
      ramekWyslanych,
      pakietyOdebrane: we ? we.packetsReceived : 0,
      probkiOdebrane: we ? we.totalSamplesReceived ?? 0 : 0
    }
  })()`)

  const oczekiwaneRamki = wynik.format.sampleRate * 2 * 0.7
  const pcmLeci = wynik.ramekWyslanych > oczekiwaneRamki
  const webrtcLeci = wynik.pakietyOdebrane > 0

  console.log(
    `zrodlo: ${wynik.okno}\n` +
      `format: ${wynik.format.sampleRate} Hz, ${wynik.format.channels} kanaly\n` +
      `pakiety PCM: ${wynik.pakietow}, ramek: ${wynik.ramekWyslanych}\n` +
      `przez WebRTC odebrano: ${wynik.pakietyOdebrane} pakietow RTP\n` +
      `(probki oddane do odtwarzania: ${wynik.probkiOdebrane} — zero jest tu ` +
      `normalne, bo w petli testowej nikt tego nie odtwarza)`
  )

  if (!pcmLeci) console.log('\nZLE — za malo PCM z modulu natywnego')
  else if (!webrtcLeci) console.log('\nZLE — sciezka powstala, ale nic nie przeszlo przez WebRTC')
  else console.log('\nOK — dzwiek wybranej aplikacji przechodzi przez WebRTC')

  if (!pcmLeci || !webrtcLeci) process.exitCode = 1
} catch (blad) {
  console.error(`ZLE — ${blad.message}`)
  process.exitCode = 1
} finally {
  cdp?.close()
  electron.kill()
}
