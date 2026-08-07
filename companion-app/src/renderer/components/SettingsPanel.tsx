import type {
  CameraResolution,
  CameraSettings,
  FpsPreset,
  QualitySettings,
  ResolutionPreset
} from '@shared/types'
import { BITRATE_PRESETS_KBPS, CAMERA_DIMENSIONS } from '@shared/types'

const RESOLUTION_OPTIONS: { value: ResolutionPreset; label: string }[] = [
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: '1440p', label: '1440p' },
  { value: 'source', label: 'Źródło (natywna)' }
]

const FPS_OPTIONS: FpsPreset[] = [30, 60]

// Klucze CAMERA_DIMENSIONS zamiast osobnej listy literałów — jedno źródło
// prawdy o tym, jakie rozdzielczości kamera w ogóle obsługuje.
const CAMERA_RESOLUTION_OPTIONS = Object.keys(CAMERA_DIMENSIONS) as CameraResolution[]

const CAMERA_FPS_OPTIONS = [15, 30, 60]

interface SettingsPanelProps {
  quality: QualitySettings
  onChange: (quality: QualitySettings) => void
  /**
   * Wymagane, choć panel dałoby się wyrenderować z wartościami domyślnymi.
   * Domyślne wartości znaczyłyby tu tyle, że zmiany użytkownika lecą w próżnię,
   * a sekcja „Kamera" wygląda na sprawną — i nic nie zaświeciłoby się na
   * czerwono. Brak propsa ma być błędem kompilacji.
   */
  cameraSettings: CameraSettings
  onCameraSettingsChange: (settings: CameraSettings) => void
  cameraDevices: { deviceId: string; label: string }[]
}

export function SettingsPanel({
  quality,
  onChange,
  cameraSettings,
  onCameraSettingsChange,
  cameraDevices
}: SettingsPanelProps): JSX.Element {
  return (
    <aside className="settings">
      <h2 className="settings__title">Jakość</h2>

      <div className="settings__field">
        <label className="settings__label" htmlFor="resolution">
          Rozdzielczość
        </label>
        <select
          id="resolution"
          className="settings__select"
          value={quality.resolution}
          onChange={(event) =>
            onChange({ ...quality, resolution: event.target.value as ResolutionPreset })
          }
        >
          {RESOLUTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="settings__field">
        <span className="settings__label">Liczba klatek</span>
        <div className="segmented" role="group" aria-label="Liczba klatek">
          {FPS_OPTIONS.map((fps) => (
            <button
              key={fps}
              type="button"
              className={`segmented__option${quality.fps === fps ? ' segmented__option--active' : ''}`}
              onClick={() => onChange({ ...quality, fps })}
              aria-pressed={quality.fps === fps}
            >
              {fps} FPS
            </button>
          ))}
        </div>
      </div>

      <div className="settings__field">
        <label className="settings__label" htmlFor="share-audio">
          Dźwięk
        </label>
        <label className="settings__checkbox">
          <input
            id="share-audio"
            type="checkbox"
            checked={quality.shareAudio}
            onChange={(event) =>
              onChange({ ...quality, shareAudio: event.target.checked })
            }
          />
          <span>Udostępnij też dźwięk</span>
        </label>
        <p className="settings__hint">
          Przy udostępnianiu <strong>okna</strong> idzie dźwięk tylko tej
          aplikacji — TeamSpeak nie trafia do streamu, więc rozmówca nie usłyszy
          sam siebie. Przy udostępnianiu <strong>ekranu</strong> Windows daje
          wyłącznie miks całego systemu, więc słychać wszystko, co gra na
          komputerze.
        </p>
      </div>

      <div className="settings__field">
        <label className="settings__label" htmlFor="bitrate">
          Bitrate
        </label>
        <select
          id="bitrate"
          className="settings__select"
          value={quality.bitrateKbps}
          onChange={(event) =>
            onChange({ ...quality, bitrateKbps: Number(event.target.value) })
          }
        >
          {BITRATE_PRESETS_KBPS.map((kbps) => (
            <option key={kbps} value={kbps}>
              {(kbps / 1000).toFixed(kbps % 1000 === 0 ? 0 : 1)} Mb/s
              {kbps === 2500 ? ' (domyślne WebRTC)' : ''}
            </option>
          ))}
        </select>
        <p className="settings__hint">
          Bez tego WebRTC trzyma się 2,5 Mb/s — przy 1080p60 obraz się rozmazuje
          na ruchu, co wygląda jak klatkowanie. Wyżej = ostrzej, ale więcej łącza.
        </p>
      </div>

      <p className="settings__note">
        Zmiana ustawień restartuje podgląd z nowymi parametrami.
      </p>

      <div className="settings__section">
        <h2 className="settings__title">Kamera</h2>

        <div className="settings__field">
          <label className="settings__label" htmlFor="camera-device">
            Urządzenie
          </label>
          {cameraDevices.length > 0 ? (
            <select
              id="camera-device"
              className="settings__select"
              value={cameraSettings.deviceId ?? ''}
              onChange={(event) =>
                onCameraSettingsChange({
                  ...cameraSettings,
                  // Pusta wartość = "Domyślna" → deviceId: null, nie pusty string.
                  deviceId: event.target.value || null
                })
              }
            >
              <option value="">Domyślna</option>
              {cameraDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          ) : (
            // Etykiety urządzeń są puste, dopóki użytkownik nie zgodzi się na
            // dostęp do kamery — pusty <select> wyglądałby wtedy jak błąd.
            <p className="settings__hint">
              Lista urządzeń pojawi się po pierwszym włączeniu kamery
            </p>
          )}
        </div>

        <div className="settings__field">
          <label className="settings__label" htmlFor="camera-resolution">
            Rozdzielczość
          </label>
          <select
            id="camera-resolution"
            className="settings__select"
            value={cameraSettings.resolution}
            onChange={(event) =>
              onCameraSettingsChange({
                ...cameraSettings,
                resolution: event.target.value as CameraResolution
              })
            }
          >
            {CAMERA_RESOLUTION_OPTIONS.map((resolution) => (
              <option key={resolution} value={resolution}>
                {resolution}
              </option>
            ))}
          </select>
        </div>

        <div className="settings__field">
          <label className="settings__label" htmlFor="camera-fps">
            Liczba klatek
          </label>
          <select
            id="camera-fps"
            className="settings__select"
            value={cameraSettings.fps}
            onChange={(event) =>
              onCameraSettingsChange({
                ...cameraSettings,
                fps: Number(event.target.value)
              })
            }
          >
            {CAMERA_FPS_OPTIONS.map((fps) => (
              <option key={fps} value={fps}>
                {fps} FPS
              </option>
            ))}
          </select>
        </div>
      </div>
    </aside>
  )
}
