import { ipcMain, MessageChannelMain } from 'electron'
import { IPC_AUDIO_PORT, IPC_AUDIO_START, IPC_AUDIO_STOP } from '@shared/ipc'
import { toOwnBuffer, windowHandleFromSourceId, type AppAudioFormat } from '@shared/audio'

/**
 * Dźwięk wybranej aplikacji — krok 2 z punktu 2 w TODO.
 *
 * Moduł natywny ładujemy dopiero przy pierwszym starcie i w try/catch: bez
 * zbudowanego `.node` aplikacja ma dalej działać z samym obrazem, a nie paść
 * przy uruchomieniu.
 */

type NativeCapture = {
  start: (onChunk: (chunk: Buffer) => void) => void
  stop: () => void
}

type NativeModule = {
  AudioCapture: new (pid: number) => NativeCapture
  FORMAT: AppAudioFormat
  pidForWindow: (handle: number) => number
}

let native: NativeModule | null = null

async function loadNative(): Promise<NativeModule> {
  if (native) return native

  /*
   * Bierzemy `default`, a nie nazwane eksporty. Moduł jest CommonJS, więc przy
   * `import()` Node zgaduje jego nazwane eksporty statycznym lekserem — i robi
   * to niekompletnie: z trójki AudioCapture / FORMAT / pidForWindow rozpoznał
   * dwa pierwsze, a trzeci zostawił tylko w `default`. Efekt był taki, że
   * połowa modułu działała, a `pidForWindow` był `undefined` dopiero
   * w działającej aplikacji.
   */
  const modul = await import('ts3-screenshare-audio')
  const namespace = modul as unknown as { default?: NativeModule }
  native = namespace.default ?? (modul as unknown as NativeModule)
  return native
}

export function registerAppAudio(): void {
  let capture: NativeCapture | null = null
  let port: Electron.MessagePortMain | null = null

  function stop(): void {
    capture?.stop()
    capture = null
    port?.close()
    port = null
  }

  ipcMain.handle(IPC_AUDIO_START, async (event, sourceId: string): Promise<AppAudioFormat> => {
    // Drugi start bez stopu zostawiłby sierotę: wątek natywny bez odbiorcy.
    stop()

    const { AudioCapture, FORMAT, pidForWindow } = await loadNative()

    // Renderer podaje id źródła, nie PID — mapowanie jest sprawą systemu.
    const uchwyt = windowHandleFromSourceId(sourceId)
    if (uchwyt === null) {
      throw new Error('Dźwięk z jednej aplikacji działa dla okna, nie dla całego ekranu')
    }
    const pid = pidForWindow(uchwyt)
    // Zero znaczy "nie ma takiego okna". Nie wolno tego przepuścić: loopback
    // dla nieistniejącego PID-u nie zgłasza błędu, tylko podaje ciszę.
    if (pid === 0) {
      throw new Error('Nie znalazłem procesu tego okna — mogło się zamknąć')
    }
    const kanal = new MessageChannelMain()
    port = kanal.port1

    // Port wędruje do renderera ZANIM ruszy przechwytywanie. Pakiety wysłane
    // przed podpięciem odbiorcy i tak czekają w kolejce portu.
    event.sender.postMessage(IPC_AUDIO_PORT, null, [kanal.port2])

    const nowy = new AudioCapture(pid)
    nowy.start((chunk) => {
      // Bez listy transferu — Electron przenosi tą drogą tylko porty.
      port?.postMessage(toOwnBuffer(chunk))
    })
    capture = nowy

    return { sampleRate: FORMAT.sampleRate, channels: FORMAT.channels }
  })

  ipcMain.handle(IPC_AUDIO_STOP, () => stop())
}
