import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC_GET_UPDATE_STATE, IPC_GET_VERSION, IPC_UPDATE_STATE } from '@shared/ipc'
import { NO_UPDATE, reduceUpdate, type UpdateEvent, type UpdateState } from '@shared/update'

/**
 * Jedyne miejsce w projekcie, które dotyka `electron-updater`. Granica jest tu
 * celowo: vitest chodzi w gołym Node, więc wszystko, co importuje Electrona,
 * jest poza zasięgiem testów jednostkowych. Logika siedzi w `@shared/update`.
 *
 * Instalacja dzieje się po WYJŚCIU z aplikacji, nie przez restart z instalatora.
 * Powód: argumenty `--ts3-server` / `--channel` / `--nick` przychodzą od wtyczki
 * przez CreateProcessW, a aplikacja wskrzeszona przez instalator dostałaby pustą
 * linię poleceń i wstała w trybie samodzielnym, poza kanałem.
 */
export function registerUpdates(getWindow: () => BrowserWindow | null): void {
  let state: UpdateState = NO_UPDATE

  ipcMain.handle(IPC_GET_VERSION, () => app.getVersion())
  ipcMain.handle(IPC_GET_UPDATE_STATE, () => state)

  function apply(event: UpdateEvent): void {
    state = reduceUpdate(state, event)
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC_UPDATE_STATE, state)
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => apply({ type: 'checking' }))
  autoUpdater.on('update-not-available', () => apply({ type: 'not-available' }))
  autoUpdater.on('update-downloaded', (info) => {
    apply({ type: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (error: Error) => {
    // Cicho do konsoli. Brak sieci i brak wydań to normalny stan aplikacji,
    // nie awaria — komunikat o tym byłby szumem w oknie do udostępniania ekranu.
    console.warn('[update] sprawdzenie aktualizacji nie powiodlo sie:', error.message)
    apply({ type: 'error' })
  })

  // W trybie deweloperskim electron-updater przerywa z "dev-app-update.yml not
  // found". To poprawne: aktualizować można tylko to, co zostało zainstalowane.
  // Uchwyty IPC rejestrujemy mimo to — plakietka wersji ma działać także w dev.
  if (!app.isPackaged) return

  // Świadomie NIE checkForUpdatesAndNotify: to pokazuje powiadomienie systemowe,
  // które dublowałoby nasz własny pasek.
  void autoUpdater.checkForUpdates().catch((error: unknown) => {
    console.warn('[update] sprawdzenie aktualizacji nie powiodlo sie:', error)
  })
}
