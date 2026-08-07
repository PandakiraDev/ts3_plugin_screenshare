// Wrapper na modul natywny. Osobny plik, zeby reszta projektu nie znala
// sciezki do zbudowanego .node — a przy okazji zeby brak buildu dawal
// czytelny komunikat zamiast "Cannot find module".
const path = require('node:path')

const binary = path.join(__dirname, 'build', 'Release', 'audio_capture.node')

let native
try {
  native = require(binary)
} catch (cause) {
  throw new Error(
    `Modul natywny audio nie jest zbudowany (${binary}). Uruchom: npm run build`,
    { cause }
  )
}

/**
 * Przechwytywanie dzwieku z jednego procesu i jego potomkow.
 *
 * Cienka nakladka na klase natywna. Jedyne, co dokłada, to gwarancja ciszy po
 * stop(): warstwa natywna zatrzymuje przechwytywanie i czeka na swoj watek,
 * ale pakiety juz zakolejkowane w ThreadSafeFunction dojezdzaja pozniej na
 * petli zdarzen. Bez tej flagi konsument dostawalby dzwiek po wylaczeniu.
 */
class AudioCapture {
  #native
  #active = false

  constructor(pid) {
    this.#native = new native.AudioCapture(pid)
  }

  start(onChunk) {
    this.#native.start((chunk) => {
      if (this.#active) onChunk(chunk)
    })
    // Dopiero po udanym start(): jesli aktywacja rzuci, stan sie nie zmienia.
    // Kolejka nie ruszy wczesniej, bo watek JS stoi w start().
    this.#active = true
  }

  stop() {
    // Kolejnosc jest istotna — flaga gasnie PRZED zatrzymaniem, zeby resztki
    // z kolejki trafily w pustke.
    this.#active = false
    this.#native.stop()
  }
}

module.exports = {
  AudioCapture,
  FORMAT: native.FORMAT,
  pidForWindow: native.pidForWindow
}
