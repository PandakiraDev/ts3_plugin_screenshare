import { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, shell } from 'electron'
import { join } from 'path'
import type { CaptureSource, SourceType } from '@shared/types'
import {
  IPC_GET_API_KEY,
  IPC_GET_LAUNCH,
  IPC_GET_SETTINGS,
  IPC_GET_SOURCES,
  IPC_LOBBY_LOG_PUSH,
  IPC_LOBBY_LOG_READ,
  IPC_SET_API_KEY,
  IPC_SET_CAPTURE_TARGET,
  IPC_SET_SETTINGS
} from '@shared/ipc'
import { settingsFromUnknown, type SettingsSnapshot } from '@shared/settings'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseLaunchArgs, type LaunchParseResult } from '@shared/cli'
import { registerAppAudio } from './audio'
import { isLogEntry } from '@shared/lobbyLog'
import { registerDiagnostics, setRecordToDisk } from './diagnosticsRecorder'
import { createLobbyLog, createLobbyLogAppender, diagnosticsDirectory } from './lobbyLog'
import { readSettings, writeSettings } from './settings'
import { registerUpdates } from './update'

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

/**
 * Klucz dostępu trzymamy w userData, a nie w paczce aplikacji: wszyscy
 * dostają ten sam instalator, a klucz jest indywidualny i wpisywany raz.
 */
function apiKeyPath(): string {
  return join(app.getPath('userData'), 'api-key.txt')
}

function readApiKey(): string {
  try {
    return readFileSync(apiKeyPath(), 'utf8').trim()
  } catch {
    return ''
  }
}

app.whenReady().then(() => {
  ipcMain.handle(IPC_GET_SOURCES, () => getCaptureSources())
  ipcMain.handle(IPC_GET_LAUNCH, () => launch)
  ipcMain.handle(IPC_SET_CAPTURE_TARGET, (_event, target: typeof captureTarget) => {
    captureTarget = target
  })
  ipcMain.handle(IPC_GET_API_KEY, () => readApiKey())
  ipcMain.handle(IPC_SET_API_KEY, (_event, key: string) => {
    writeFileSync(apiKeyPath(), String(key).trim(), 'utf8')
  })
  registerAppAudio()
  /*
   * Podgląd diagnostyki rejestruje się bezwarunkowo — pasek zużycia i panel
   * należą od 0.3.4 do każdego. Z ustawień bierzemy WYŁĄCZNIE zapis na dysk:
   * to on kosztuje miejsce i tylko on potrzebuje zgody.
   *
   * Ścieżkę `userData` podajemy tutaj, bo `main/settings.ts` celowo nie
   * importuje `app` — patrz komentarz w tamtym pliku. Odczyt jest
   * synchroniczny i jednorazowy, tak samo jak `api-key.txt` wyżej.
   */
  const userDataPath = app.getPath('userData')
  /*
   * Jeden odczyt ustawień na dwóch odbiorców zapisu (próbki i dziennik). To
   * JEDNO ustawienie, więc dwa osobne odczyty mogłyby się różnić, gdyby ktoś
   * podmienił plik akurat w tej sekundzie — a wtedy pasek pisałby na dysk,
   * dziennik nie, i nic by tego nie wyjaśniało.
   */
  const recordToDisk = readSettings(userDataPath).recordDiagnostics
  registerDiagnostics({ recordToDisk })
  /*
   * Dziennik lobby: pierścień w procesie głównym i dwa kanały, oba
   * BEZWARUNKOWE jak kanały podglądu zużycia.
   *
   * Rejestracja stoi TUTAJ, a nie w `main/lobbyLog.ts`, bo tamten plik celowo
   * nie importuje `electron` — i tylko dlatego jego bramkowanie zapisu da się
   * sprawdzić testem w gołym vitest (patrz nagłówek tamtego pliku, oraz
   * `diagnosticsRecorder.ts`, który tego wzoru nie trzyma i nie ma ani jednego
   * testu).
   *
   * Instancja zostaje w tym zasięgu, żeby obsługa zapisu ustawień mogła
   * przestawić `setRecordToDisk` na gorąco, bez restartu aplikacji.
   */
  const lobbyLog = createLobbyLog({
    appendLine: createLobbyLogAppender(userDataPath),
    recordToDisk
  })
  ipcMain.handle(IPC_LOBBY_LOG_PUSH, (_event, entries: unknown) => {
    /*
     * Wpisy przychodzą z drugiej strony granicy procesów, więc sprawdzamy je
     * tak samo, jak rejestrator próbek sprawdza `Array.isArray(streams)`. Wpis
     * nie do przyjęcia jest POMIJANY, a nie naprawiany: zgadywanie, co miało
     * tam być, wpisałoby do dziennika zdanie, którego nikt nie napisał —
     * a dziennik czyta się jak dowód.
     */
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (isLogEntry(entry)) lobbyLog.push(entry)
    }
  })
  ipcMain.handle(IPC_LOBBY_LOG_READ, () => lobbyLog.read())
  /*
   * Ustawienia. Odczyt oddaje też katalog plików diagnostyki, bo renderer nie
   * zna `userData` — patrz `SettingsSnapshot`.
   */
  ipcMain.handle(
    IPC_GET_SETTINGS,
    (): SettingsSnapshot => ({
      /*
       * Czytamy PLIK, a nie zmienną `recordToDisk` wyżej: pole wyboru ma
       * pokazywać to, co przeżyje restart. Gdyby zapis pliku padł, w pamięci
       * siedziałaby wartość włączona po kliknięciu, a w pliku stara — i panel
       * otwarty drugi raz powtarzałby to kłamstwo zamiast je pokazać.
       */
      settings: readSettings(userDataPath),
      diagnosticsPath: diagnosticsDirectory(userDataPath)
    })
  )
  ipcMain.handle(IPC_SET_SETTINGS, (_event, value: unknown): boolean => {
    /*
     * Wartość przychodzi z renderera, więc przechodzi tę samą kontrolę co treść
     * pliku (`settingsFromUnknown`) — nie przepisujemy jej do pliku na wiarę.
     */
    const settings = settingsFromUnknown(value)
    const saved = writeSettings(userDataPath, settings)
    /*
     * Przestawiamy zapis W SESJI także wtedy, gdy plik się nie zapisał:
     * człowiek poprosił o to TERAZ, a nieudany zapis odbiera tylko pamięć
     * między uruchomieniami. Odpowiedź `false` mówi rendererowi, żeby to
     * powiedział wprost przy polu wyboru.
     *
     * Obaj odbiorcy, jednym kliknięciem i w tej samej kolejności co przy
     * starcie: próbki i dziennik. Pominięcie jednego dałoby stan, w którym
     * pasek pisze na dysk, a dziennik nie — i nic by tego nie wyjaśniało.
     */
    setRecordToDisk(settings.recordDiagnostics)
    lobbyLog.setRecordToDisk(settings.recordDiagnostics)
    return saved
  })
  // Getter, a nie referencja do okna: `activate` na macOS potrafi utworzyć nowe
  // okno, a rejestracja uchwytów IPC może się odbyć tylko raz.
  registerUpdates(() => BrowserWindow.getAllWindows()[0] ?? null)

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
