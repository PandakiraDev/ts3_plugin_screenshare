import { contextBridge, ipcRenderer } from 'electron'
import type { CaptureSource } from '@shared/types'
import type { LaunchParseResult } from '@shared/cli'
import type { AppAudioFormat } from '@shared/audio'
import {
  IPC_AUDIO_PORT,
  IPC_AUDIO_START,
  IPC_AUDIO_STOP,
  IPC_GET_API_KEY,
  IPC_GET_LAUNCH,
  IPC_GET_SOURCES,
  IPC_SET_API_KEY,
  IPC_SET_CAPTURE_TARGET
} from '@shared/ipc'

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
  stopAppAudio: (): Promise<void> => ipcRenderer.invoke(IPC_AUDIO_STOP)
}

export type CompanionApi = typeof api

contextBridge.exposeInMainWorld('companion', api)
