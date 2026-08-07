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

  const result = await cdp.evaluate(`(async () => {
    const sources = await window.companion.getSources()
    const win = sources.find((s) => s.type === 'window')
    if (!win) throw new Error('nie znalazlem zadnego okna do przechwycenia')

    // Nasluch MUSI ruszyc przed startAppAudio() — port przychodzi w trakcie
    // tamtego wywolania.
    const portReady = new Promise((resolve, reject) => {
      const h = (e) => {
        if (e.data !== 'audio:port') return
        window.removeEventListener('message', h)
        resolve(e.ports[0])
      }
      window.addEventListener('message', h)
      setTimeout(() => reject(new Error('port nie dotarl do renderera')), 5000)
    })

    const format = await window.companion.startAppAudio(win.id)
    const port = await portReady

    const generator = new MediaStreamTrackGenerator({ kind: 'audio' })
    const writer = generator.writable.getWriter()
    let framesSent = 0
    let packets = 0

    port.onmessage = (e) => {
      const samples = new Float32Array(e.data)
      const frames = samples.length / format.channels
      writer
        .write(
          new AudioData({
            format: 'f32',
            sampleRate: format.sampleRate,
            numberOfFrames: frames,
            numberOfChannels: format.channels,
            timestamp: Math.round((framesSent / format.sampleRate) * 1e6),
            data: samples
          })
        )
        .catch(() => {})
      framesSent += frames
      packets += 1
    }
    port.start()

    // Petla lokalna: dwa polaczenia w tym samym oknie.
    const pc1 = new RTCPeerConnection()
    const pc2 = new RTCPeerConnection()
    pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate)
    pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate)
    pc1.addTrack(generator, new MediaStream([generator]))

    const offer = await pc1.createOffer()
    await pc1.setLocalDescription(offer)
    await pc2.setRemoteDescription(offer)
    const answer = await pc2.createAnswer()
    await pc2.setLocalDescription(answer)
    await pc1.setRemoteDescription(answer)

    await new Promise((r) => setTimeout(r, 2000))

    let inbound = null
    ;(await pc2.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') inbound = s
    })

    await window.companion.stopAppAudio()
    pc1.close()
    pc2.close()

    return {
      source: win.name,
      format,
      packets,
      framesSent,
      packetsReceived: inbound ? inbound.packetsReceived : 0,
      samplesReceived: inbound ? inbound.totalSamplesReceived ?? 0 : 0
    }
  })()`)

  const expectedFrames = result.format.sampleRate * 2 * 0.7
  const pcmFlowing = result.framesSent > expectedFrames
  const webrtcFlowing = result.packetsReceived > 0

  console.log(
    `zrodlo: ${result.source}\n` +
      `format: ${result.format.sampleRate} Hz, ${result.format.channels} kanaly\n` +
      `pakiety PCM: ${result.packets}, ramek: ${result.framesSent}\n` +
      `przez WebRTC odebrano: ${result.packetsReceived} pakietow RTP\n` +
      `(probki oddane do odtwarzania: ${result.samplesReceived} — zero jest tu ` +
      `normalne, bo w petli testowej nikt tego nie odtwarza)`
  )

  if (!pcmFlowing) console.log('\nZLE — za malo PCM z modulu natywnego')
  else if (!webrtcFlowing) console.log('\nZLE — sciezka powstala, ale nic nie przeszlo przez WebRTC')
  else console.log('\nOK — dzwiek wybranej aplikacji przechodzi przez WebRTC')

  if (!pcmFlowing || !webrtcFlowing) process.exitCode = 1
} catch (err) {
  console.error(`ZLE — ${err.message}`)
  process.exitCode = 1
} finally {
  cdp?.close()
  electron.kill()
}
