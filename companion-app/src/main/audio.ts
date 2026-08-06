import { ipcMain, MessageChannelMain } from 'electron'
import { IPC_AUDIO_PORT, IPC_AUDIO_START, IPC_AUDIO_STOP } from '@shared/ipc'
import { toOwnBuffer, type AppAudioFormat } from '@shared/audio'

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
}

let native: NativeModule | null = null

async function loadNative(): Promise<NativeModule> {
  if (native) return native
  native = (await import('ts3-screenshare-audio')) as unknown as NativeModule
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

  ipcMain.handle(IPC_AUDIO_START, async (event, pid: number): Promise<AppAudioFormat> => {
    // Drugi start bez stopu zostawiłby sierotę: wątek natywny bez odbiorcy.
    stop()

    const { AudioCapture, FORMAT } = await loadNative()
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
