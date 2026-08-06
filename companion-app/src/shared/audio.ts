/**
 * Przesyłanie dźwięku wybranej aplikacji z main process do renderera.
 *
 * Oba końce jednego protokołu trzymamy w jednym pliku, bo muszą się zgadzać
 * co do bajta. Sam transport to `MessagePort` (nie zwykłe IPC): pakietów jest
 * około stu na sekundę i nie mają zapychać kanału, którym lecą zwykłe
 * wywołania.
 */

/** Format próbek — pochodzi z modułu natywnego, renderer go nie zgaduje. */
export interface AppAudioFormat {
  sampleRate: number
  channels: number
}

/**
 * Kopiuje pakiet do własnego `ArrayBuffer`.
 *
 * Node alokuje małe Buffery z jednej puli, więc `chunk.buffer` to zwykle 8 KB
 * cudzych danych, a nie nasz pakiet — stąd cięcie po `byteOffset`. Bez tego do
 * renderera leciałby szum i zły rozmiar.
 *
 * Nie da się tego przekazać *transferem*: `MessagePortMain.postMessage`
 * w Electronie przyjmuje na liście transferu wyłącznie porty, nie bufory.
 * Pakiet jest więc kopiowany — przy 384 kB/s to nie jest problem, a odbiorca
 * dostaje gotowy, samodzielny bufor zamiast widoku z cudzym offsetem.
 */
export function toOwnBuffer(chunk: Uint8Array): ArrayBuffer {
  return chunk.buffer.slice(
    chunk.byteOffset,
    chunk.byteOffset + chunk.byteLength
  ) as ArrayBuffer
}

/**
 * Odbiór po stronie renderera. Zamienia surowe bajty na `Float32Array`
 * gotowy dla Web Audio.
 */
export class AppAudioStream {
  private port: MessagePort | null
  private onSamples: ((samples: Float32Array) => void) | null = null

  constructor(port: MessagePort) {
    this.port = port
    port.onmessage = (event: MessageEvent) => {
      // Po close() callback jest wyzerowany — resztki z kolejki trafiają
      // w pustkę, tak samo jak w module natywnym.
      this.onSamples?.(new Float32Array(event.data as ArrayBuffer))
    }
    port.start()
  }

  onChunk(callback: (samples: Float32Array) => void): void {
    this.onSamples = callback
  }

  close(): void {
    this.onSamples = null
    if (!this.port) return
    this.port.onmessage = null
    this.port.close()
    this.port = null
  }
}
