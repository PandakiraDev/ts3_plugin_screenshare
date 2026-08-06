// Uruchamiane WEWNATRZ Electrona przez check/electron.js.
// Wynik idzie do pliku, bo stdout Electrona na Windows nie trafia do konsoli.
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const wynikPlik = process.env.AUDIO_CHECK_WYNIK

function koniec(wynik) {
  fs.writeFileSync(wynikPlik, JSON.stringify(wynik), 'utf8')
  app.quit()
}

app.whenReady().then(() => {
  try {
    const { AudioCapture, FORMAT } = require(path.join(__dirname, '..', 'index.js'))
    const capture = new AudioCapture(process.pid)
    let bajtow = 0

    capture.start((chunk) => {
      bajtow += chunk.length
    })

    setTimeout(() => {
      capture.stop()
      const ramek = bajtow / (FORMAT.channels * FORMAT.bytesPerSample)
      koniec({
        ok: ramek > FORMAT.sampleRate * 0.5,
        ramek,
        electron: process.versions.electron
      })
    }, 1000)
  } catch (blad) {
    koniec({ ok: false, blad: blad.message })
  }
})
