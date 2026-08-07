import { AppAudioStream, AudioTimeline, type AppAudioFormat } from '@shared/audio'
import { IPC_AUDIO_PORT } from '@shared/ipc'

/**
 * Odbiera `MessagePort` przekazany przez preload.
 *
 * UWAGA na kolejność: port przychodzi *w trakcie* `startAppAudio()`, więc
 * nasłuch trzeba założyć wcześniej — inaczej wiadomość przepadnie i czekanie
 * nigdy się nie skończy.
 */
export function waitForAudioPort(timeoutMs = 5000): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent): void => {
      if (event.data !== IPC_AUDIO_PORT) return
      window.removeEventListener('message', handler)
      clearTimeout(timer)
      resolve(event.ports[0])
    }
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler)
      reject(new Error('Nie doczekałem się kanału dźwięku z aplikacji'))
    }, timeoutMs)
    window.addEventListener('message', handler)
  })
}

/**
 * Zamienia strumień PCM z wybranej aplikacji na `MediaStreamTrack` gotowy dla
 * WebRTC — krok 3 z punktu 2 w TODO.
 *
 * Droga przez `MediaStreamTrackGenerator`, a nie `AudioWorklet`, bo:
 * - znaczniki czasu podajemy jawnie, więc synchronizacja z obrazem jest nasza,
 *   a nie wynikiem tego, kiedy zdążyliśmy dosypać próbek do kolejki,
 * - nie ma bufora pierścieniowego: `SharedArrayBuffer` i tak jest w tym oknie
 *   niedostępny (`crossOriginIsolated: false`), więc odpadałby i tak,
 * - pakiety mają 480 ramek, a `AudioWorklet` liczy po 128 — cała ta arytmetyka
 *   znika.
 *
 * Sprawdzone w Electronie 33.4.11; gdyby API zniknęło, ścieżka zapasowa jest
 * opisana w `renderer/env.d.ts`.
 */
export interface AppAudioTrack {
  track: MediaStreamTrack
  stop: () => void
}

export function createAppAudioTrack(port: MessagePort, format: AppAudioFormat): AppAudioTrack {
  const generator = new MediaStreamTrackGenerator({ kind: 'audio' })
  const writer = generator.writable.getWriter()
  const timeline = new AudioTimeline(format.sampleRate)
  const stream = new AppAudioStream(port)

  stream.onChunk((samples) => {
    const frames = samples.length / format.channels
    const data = new AudioData({
      // 'f32' to układ przeplatany (L, R, L, R...) — dokładnie tak oddaje
      // próbki moduł natywny. Wariant '-planar' rozjechałby kanały.
      format: 'f32',
      sampleRate: format.sampleRate,
      numberOfFrames: frames,
      numberOfChannels: format.channels,
      timestamp: timeline.next(frames),
      data: samples
    })
    // Bez await: pisanie idzie w tempie realnego czasu, a czekanie tutaj
    // wstrzymywałoby odbiór kolejnych pakietów z portu. `AudioData` przechodzi
    // na własność strumienia, więc nie zamykamy go sami.
    writer.write(data).catch(() => {
      /* strumień zamknięty w trakcie — nic do zrobienia */
    })
  })

  return {
    track: generator,
    stop: () => {
      stream.close()
      writer.close().catch(() => {
        /* już zamknięty */
      })
      generator.stop()
    }
  }
}
