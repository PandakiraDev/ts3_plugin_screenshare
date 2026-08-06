/// <reference types="vite/client" />

import type { CompanionApi } from '../preload'

declare global {
  interface Window {
    companion: CompanionApi
  }

  /**
   * Insertable Streams — nie ma tego w typach DOM, bo API jest wciąż
   * eksperymentalne. Sprawdzone w Electronie 33.4.11 (Chromium 130): klasa
   * istnieje i realnie tworzy ścieżkę audio.
   *
   * Gdyby zniknęła z przyszłego Chromium, drogą zapasową jest `AudioWorklet`
   * + `MediaStreamAudioDestinationNode` — więcej kodu i bez jawnych
   * znaczników czasu, więc gorsza synchronizacja z obrazem.
   */
  class MediaStreamTrackGenerator extends MediaStreamTrack {
    constructor(init: { kind: 'audio' | 'video' })
    readonly writable: WritableStream<AudioData>
  }
}

export {}
