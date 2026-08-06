/** Format probek oddawanych przez `AudioCapture`. Stale pochodza z C++. */
export interface PcmFormat {
  readonly sampleRate: number
  readonly channels: number
  readonly bytesPerSample: number
  readonly encoding: 'float32'
}

export declare const FORMAT: PcmFormat

/**
 * Uchwyt okna (liczba z id `desktopCapturer`: `window:<HWND>:0`) na PID
 * właściciela.
 *
 * Zwraca `0`, gdy okna nie ma. Wywołujący **musi** to sprawdzić:
 * przechwytywanie z nieistniejącego PID-u nie daje błędu, tylko ciszę.
 *
 * @throws jeśli uchwyt nie jest liczbą
 */
export declare function pidForWindow(handle: number): number

/**
 * Przechwytywanie dzwieku z jednego procesu i jego potomkow
 * (Windows 10 2004+, Process Loopback API).
 */
export declare class AudioCapture {
  /** @throws jesli PID nie jest liczba albo taki proces nie istnieje */
  constructor(pid: number)

  /**
   * Uruchamia przechwytywanie. `onChunk` dostaje surowe PCM w formacie
   * `FORMAT` — probki przeplatane (L, R, L, R...).
   *
   * @throws jesli przechwytywanie juz trwa albo nie da sie otworzyc strumienia
   */
  start(onChunk: (chunk: Buffer) => void): void

  /** Zatrzymuje przechwytywanie. Wywolanie bez `start()` nic nie robi. */
  stop(): void
}
