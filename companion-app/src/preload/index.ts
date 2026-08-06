import { contextBridge, ipcRenderer } from 'electron'
import type { CaptureSource } from '@shared/types'
import type { LaunchParseResult } from '@shared/cli'
import { IPC_GET_LAUNCH, IPC_GET_SOURCES } from '@shared/ipc'

/**
 * Jedyny most między rendererem a main. Renderer nie ma dostępu do modułu
 * `desktopCapturer` (contextIsolation), więc listę źródeł dostaje przez IPC.
 */
const api = {
  getSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke(IPC_GET_SOURCES),
  getLaunch: (): Promise<LaunchParseResult> => ipcRenderer.invoke(IPC_GET_LAUNCH)
}

export type CompanionApi = typeof api

contextBridge.exposeInMainWorld('companion', api)
