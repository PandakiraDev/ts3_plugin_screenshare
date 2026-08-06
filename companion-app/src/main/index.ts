import { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, shell } from 'electron'
import { join } from 'path'
import type { CaptureSource, SourceType } from '@shared/types'
import { IPC_GET_LAUNCH, IPC_GET_SOURCES, IPC_SET_CAPTURE_TARGET } from '@shared/ipc'
import { parseLaunchArgs, type LaunchParseResult } from '@shared/cli'

/**
 * Argumenty czytamy raz przy starcie. W trybie deweloperskim electron-vite
 * podaje ścieżkę projektu jako argument, więc parser i tak musi ignorować
 * wszystko, co nie jest naszą flagą.
 */
const launch: LaunchParseResult = parseLaunchArgs(process.argv.slice(1))

/**
 * Budżet miniaturki jest kwadratowy celowo. Electron skaluje z zachowaniem
 * proporcji, więc prostokątne 320×180 dawało pionowemu monitorowi ledwie 101px
 * szerokości — za mało, żeby wypełnić kafelek bez rozmycia. Kwadrat daje
 * porównywalną liczbę pikseli niezależnie od orientacji źródła.
 */
const THUMBNAIL_SIZE = { width: 640, height: 640 }

/** Jakość JPEG dla miniaturek — PNG ze zrzutu ekranu jest kilka razy cięższy. */
const THUMBNAIL_JPEG_QUALITY = 80

function createWindow(): void {
  const isLobby = launch.ok && launch.options.mode === 'lobby'
  const window = new BrowserWindow({
    width: isLobby ? 1280 : 1180,
    height: isLobby ? 800 : 800,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    title: 'TS3 Screen Share',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Pokazujemy okno dopiero gdy renderer ma co narysować — bez białego mignięcia.
  window.once('ready-to-show', () => window.show())

  // Linki zewnętrzne otwieramy w przeglądarce, nie w oknie aplikacji.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Electron nazywa ekrany "Ekran 1", "Entire screen" itp. — bez informacji,
 * który to fizycznie monitor. Dokładamy nazwę monitora z systemu.
 *
 * Świadomie NIE pokazujemy tu rozdzielczości. `display.size` jest w DIP-ach,
 * nie w pikselach: przy skalowaniu Windows 175% monitor 3840×2160 raportuje
 * 2195×1235, bo Chromium liczy ceil(3840/1.75). Tej operacji nie da się cofnąć —
 * sprawdzone, wszystkie warianty dają złą liczbę:
 *   size × scaleFactor      -> 3841×2161
 *   screen.dipToScreenRect  -> 3842×2162
 *   przewymiarowana miniaturka -> Electron upscaluje, nie zwraca natywnej
 * Prawdziwa rozdzielczość jest znana dopiero z aktywnego capture i pokazuje ją
 * badge w nagłówku podglądu. Nazwa monitora i tak rozróżnia ekrany lepiej —
 * dwa monitory 4K miałyby identyczną rozdzielczość.
 */
function describeScreen(sourceDisplayId: string, fallbackName: string): string {
  const display = screen.getAllDisplays().find((d) => String(d.id) === sourceDisplayId)
  if (!display) return fallbackName

  const isPrimary = display.id === screen.getPrimaryDisplay().id
  const suffix = isPrimary ? ' (główny)' : ''
  // label bywa pusty, gdy sterownik nie poda nazwy monitora.
  return display.label
    ? `${fallbackName} — ${display.label}${suffix}`
    : `${fallbackName}${suffix}`
}

async function getCaptureSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: THUMBNAIL_SIZE,
    fetchWindowIcons: true
  })

  return sources
    .filter((source) => {
      // Ekrany zostawiamy zawsze — dają się przechwycić nawet bez miniaturki.
      if (source.id.startsWith('screen')) return true
      // Puste okna to nakładki (overlaye typu Razer) i okna chronione przed
      // Windows Graphics Capture. Sprawdziliśmy, że getUserMedia dla nich
      // "udaje się", a ścieżka wideo gaśnie chwilę później — nie ma czego
      // udostępniać, więc nie pokazujemy ich w gridzie.
      return !source.thumbnail.isEmpty()
    })
    .map((source) => {
      // Electron prefiksuje id typem źródła: "screen:0:0" / "window:12345:0".
      const type: SourceType = source.id.startsWith('screen') ? 'screen' : 'window'
      const appIcon = source.appIcon
      return {
        id: source.id,
        name:
          type === 'screen' ? describeScreen(source.display_id, source.name) : source.name,
        type,
        thumbnailDataUrl: source.thumbnail.isEmpty()
          ? ''
          : `data:image/jpeg;base64,${source.thumbnail.toJPEG(THUMBNAIL_JPEG_QUALITY).toString('base64')}`,
        // Ikony zostają PNG — mają przezroczyste tło, którego JPEG nie utrzyma.
        appIconDataUrl: appIcon && !appIcon.isEmpty() ? appIcon.toDataURL() : null
      }
    })
}

/**
 * Co renderer zaraz przechwyci. Ustawiane przez IPC tuż przed getDisplayMedia,
 * bo to API nie przyjmuje identyfikatora źródła — wybór musi podać main process.
 */
let captureTarget: { sourceId: string; withAudio: boolean } = {
  sourceId: '',
  withAudio: false
}

app.whenReady().then(() => {
  ipcMain.handle(IPC_GET_SOURCES, () => getCaptureSources())
  ipcMain.handle(IPC_GET_LAUNCH, () => launch)
  ipcMain.handle(IPC_SET_CAPTURE_TARGET, (_event, target: typeof captureTarget) => {
    captureTarget = target
  })

  /*
   * Jedyna droga do dźwięku systemowego na Windows. Stare constrainty
   * `chromeMediaSource: 'desktop'` dla audio kończą się błędem
   * "NotReadableError: Could not start audio source" niezależnie od wariantu.
   *
   * `useSystemPicker: false` — mamy własny wybór źródła, systemowy byłby
   * drugim, zbędnym oknem.
   */
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void desktopCapturer
        .getSources({ types: ['screen', 'window'] })
        .then((sources) => {
          const source = sources.find((s) => s.id === captureTarget.sourceId)
          if (!source) {
            // Pusty obiekt = odmowa; renderer dostanie NotAllowedError.
            callback({})
            return
          }
          callback(
            captureTarget.withAudio
              ? { video: source, audio: 'loopback' }
              : { video: source }
          )
        })
    },
    { useSystemPicker: false }
  )

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Windows to jedyna docelowa platforma, ale zostawiamy standardowy warunek macOS.
  if (process.platform !== 'darwin') app.quit()
})
