/** Typy współdzielone między main, preload i rendererem. */

/**
 * Własna kopia typu z `signaling-server` (nie import!). Renderer buduje się
 * przez vite z rootem w `src/renderer` — import spoza tego drzewa wywaliłby
 * build produkcyjny. Zgodność kształtu z serwerem pilnuje test integracyjny
 * `signaling-client.test.ts`, który startuje prawdziwy serwer.
 */
export type StreamKind = 'screen' | 'camera'

/** Jak wyżej: własna kopia, celowo bez importu z `signaling-server`. */
export interface StreamRef {
  peerId: string
  kind: StreamKind
}

export type SourceType = 'screen' | 'window'

/**
 * Źródło capture przekazywane z main do renderera.
 * Odpowiednik Electron.DesktopCapturerSource, ale z miniaturkami już
 * zserializowanymi do data URL (NativeImage nie przechodzi przez IPC).
 */
export interface CaptureSource {
  id: string
  name: string
  type: SourceType
  /** PNG data URL miniaturki; pusty string gdy Electron nie zwrócił podglądu. */
  thumbnailDataUrl: string
  /** PNG data URL ikony aplikacji (tylko okna); null dla ekranów. */
  appIconDataUrl: string | null
}

/** Presety rozdzielczości; 'source' = natywna rozdzielczość źródła (bez skalowania). */
export type ResolutionPreset = '720p' | '1080p' | '1440p' | 'source'

export type FpsPreset = 30 | 60

export interface QualitySettings {
  resolution: ResolutionPreset
  fps: FpsPreset
  /** Górny limit bitrate w kbps → `RTCRtpSender.setParameters()` → `maxBitrate`. */
  bitrateKbps: number
  /**
   * Czy wysyłać dźwięk razem z obrazem. Na Windows Electron potrafi przechwycić
   * wyłącznie dźwięk CAŁEGO systemu — nie da się wziąć audio pojedynczego okna.
   * Nawet przy udostępnianiu jednego okna leci więc miks systemowy.
   */
  shareAudio: boolean
}

/**
 * WebRTC bez jawnego `maxBitrate` ogranicza się do ~2500 kbps. Zmierzone:
 * przy 1080p60 klatki lecą wtedy poprawnie (58 fps, zero zgubionych), ale
 * obraz się rozmazuje i blokuje na ruchu — i to właśnie odbiera się jako
 * "klatkowanie". Stąd domyślnie znacznie wyżej.
 */
export const BITRATE_PRESETS_KBPS = [2500, 5000, 8000, 15000, 25000] as const

export const DEFAULT_QUALITY: QualitySettings = {
  resolution: '1080p',
  fps: 60,
  bitrateKbps: 8000,
  // Domyślnie bez dźwięku: nadający świadomie decyduje, czy dzielić się tym,
  // co słychać na jego komputerze.
  shareAudio: false
}

/** Wymiary w pikselach dla presetu; null dla 'source' (brak ograniczenia). */
export const RESOLUTION_DIMENSIONS: Record<
  ResolutionPreset,
  { width: number; height: number } | null
> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  source: null
}

/** Presety rozdzielczości kamery. Bez 'source' i '1440p' — kamery internetowe ich nie mają. */
export type CameraResolution = '480p' | '720p' | '1080p'

export const CAMERA_DIMENSIONS: Record<CameraResolution, { width: number; height: number }> = {
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 }
}

/**
 * Sufit bitrate kamery. Ustawienia kamery świadomie nie mają suwaka bitrate
 * (urządzenie, rozdzielczość, FPS — i tyle), a przepisanie na nią sufitu ekranu
 * kazałoby koderowi pompować w obraz twarzy pasmo przewidziane na czytelny
 * drobny druk. 2,5 Mb/s to tyle, ile WebRTC bierze samo z siebie — twarzy
 * w 720p30 to wystarcza.
 */
export const CAMERA_BITRATE_KBPS = 2500

export interface CameraSettings {
  /** null = urządzenie domyślne systemu. */
  deviceId: string | null
  resolution: CameraResolution
  fps: number
}

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  deviceId: null,
  resolution: '720p',
  fps: 30
}

/**
 * Kamera nigdy nie niesie dźwięku (`audio: false`): głos idzie przez
 * TeamSpeaka, a mikrofon w tym streamie odtworzyłby echo tego samego
 * rodzaju, jakie naprawialiśmy przy przechwytywaniu dźwięku aplikacji.
 */
export function cameraConstraints(settings: CameraSettings): MediaStreamConstraints {
  const rozmiar = CAMERA_DIMENSIONS[settings.resolution]
  const video: MediaTrackConstraints = {
    width: { ideal: rozmiar.width },
    height: { ideal: rozmiar.height },
    frameRate: { ideal: settings.fps, max: settings.fps }
  }
  // deviceId: null wywala getUserMedia — brak wyboru to brak pola, nie null.
  if (settings.deviceId) video.deviceId = { exact: settings.deviceId }
  return { video, audio: false }
}
