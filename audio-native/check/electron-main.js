// Uruchamiane WEWNATRZ Electrona przez check/electron.js.
// Wynik idzie do pliku, bo stdout Electrona na Windows nie trafia do konsoli.
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const resultFile = process.env.AUDIO_CHECK_RESULT

function finish(result) {
  fs.writeFileSync(resultFile, JSON.stringify(result), 'utf8')
  app.quit()
}

app.whenReady().then(() => {
  try {
    const { AudioCapture, FORMAT } = require(path.join(__dirname, '..', 'index.js'))
    const capture = new AudioCapture(process.pid)
    let bytes = 0

    capture.start((chunk) => {
      bytes += chunk.length
    })

    setTimeout(() => {
      capture.stop()
      const frames = bytes / (FORMAT.channels * FORMAT.bytesPerSample)
      finish({
        ok: frames > FORMAT.sampleRate * 0.5,
        frames,
        electron: process.versions.electron
      })
    }, 1000)
  } catch (err) {
    finish({ ok: false, error: err.message })
  }
})
