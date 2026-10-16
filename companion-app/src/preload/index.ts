import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CaptureSource } from '@shared/types'
import type { LaunchParseResult } from '@shared/cli'
import type { AppAudioFormat } from '@shared/audio'
import type { DiagnosticsSample, StreamStats } from '@shared/diagnostics'
import type { GpuCard } from '@shared/gpuInfo'
import type { LogEntry } from '@shared/lobbyLog'
import {
  IPC_AUDIO_PORT,
  IPC_AUDIO_START,
  IPC_AUDIO_STOP,
  IPC_DIAGNOSTICS_LATEST,
  IPC_DIAGNOSTICS_PUSH,
  IPC_DIAGNOSTICS_READ,
  IPC_GET_API_KEY,
  IPC_GET_LAUNCH,
  IPC_GET_SOURCES,
  IPC_GET_UPDATE_STATE,
  IPC_GET_VERSION,
  IPC_GPU_CARD,
  IPC_LOBBY_LOG_PUSH,
  IPC_LOBBY_LOG_READ,
  IPC_SET_API_KEY,
  IPC_SET_CAPTURE_TARGET,
  IPC_UPDATE_STATE
} from '@shared/ipc'
import type { UpdateState } from '@shared/update'

/**
 * MessagePort nie przechodzi przez contextBridge, ale przechodzi przez
 * window.postMessage z listą transferowanych obiektów. To jedyna droga, żeby
 * renderer dostał prawdziwy port, a nie kopię danych przepisywaną co pakiet.
 */
ipcRenderer.on(IPC_AUDIO_PORT, (event) => {
  window.postMessage(IPC_AUDIO_PORT, '*', event.ports)
})

/**
 * Jedyny most między rendererem a main. Renderer nie ma dostępu do modułu
 * `desktopCapturer` (contextIsolation), więc listę źródeł dostaje przez IPC.
 */
const api = {
  getSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke(IPC_GET_SOURCES),
  getLaunch: (): Promise<LaunchParseResult> => ipcRenderer.invoke(IPC_GET_LAUNCH),
  setCaptureTarget: (target: { sourceId: string; withAudio: boolean }): Promise<void> =>
    ipcRenderer.invoke(IPC_SET_CAPTURE_TARGET, target),
  getApiKey: (): Promise<string> => ipcRenderer.invoke(IPC_GET_API_KEY),
  setApiKey: (key: string): Promise<void> => ipcRenderer.invoke(IPC_SET_API_KEY, key),
  startAppAudio: (sourceId: string): Promise<AppAudioFormat> =>
    ipcRenderer.invoke(IPC_AUDIO_START, sourceId),
  stopAppAudio: (): Promise<void> => ipcRenderer.invoke(IPC_AUDIO_STOP),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC_GET_VERSION),
  /** Statystyki strumieni w górę; proces główny dokłada wiersz systemowy. */
  pushDiagnostics: (streams: StreamStats[]): Promise<void> =>
    ipcRenderer.invoke(IPC_DIAGNOSTICS_PUSH, streams),
  getLatestDiagnostics: (): Promise<DiagnosticsSample | null> =>
    ipcRenderer.invoke(IPC_DIAGNOSTICS_LATEST),
  readDiagnostics: (): Promise<DiagnosticsSample[]> => ipcRenderer.invoke(IPC_DIAGNOSTICS_READ),
  /**
   * Wykryta karta graficzna; `null` znaczy „nie rozpoznano". Renderer pyta raz
   * przy montowaniu, nie zegarem — karta nie zmienia się w trakcie sesji.
   */
  getGpuCard: (): Promise<GpuCard | null> => ipcRenderer.invoke(IPC_GPU_CARD),
  /**
   * Wpisy dziennika lobby w górę. Tablica, nie jeden wpis: jedna zmiana stanu
   * daje często kilka wpisów naraz — patrz komentarz przy kanale.
   */
  pushLobbyLog: (entries: LogEntry[]): Promise<void> =>
    ipcRenderer.invoke(IPC_LOBBY_LOG_PUSH, entries),
  /**
   * Cały pierścień dziennika. Okno czyta go tylko wtedy, gdy jest otwarte —
   * zegar chodzący przy zamkniętym dokładałby pracy w aplikacji, w której
   * diagnozujemy lag.
   */
  readLobbyLog: (): Promise<LogEntry[]> => ipcRenderer.invoke(IPC_LOBBY_LOG_READ),
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke(IPC_GET_UPDATE_STATE),
  /** Zwraca funkcję odsubskrybowania — bez niej `useEffect` zostawiłby wyciek. */
  onUpdateState: (callback: (state: UpdateState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: UpdateState): void => callback(state)
    ipcRenderer.on(IPC_UPDATE_STATE, listener)
    return () => {
      ipcRenderer.off(IPC_UPDATE_STATE, listener)
    }
  }
}

export type CompanionApi = typeof api

contextBridge.exposeInMainWorld('companion', api)
