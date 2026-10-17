import { useEffect, useState } from 'react'
import type {
  CameraResolution,
  CameraSettings,
  FpsPreset,
  QualitySettings,
  ResolutionPreset
} from '@shared/types'
import { BITRATE_PRESETS_KBPS, CAMERA_DIMENSIONS } from '@shared/types'
import type { SettingsSnapshot } from '@shared/settings'

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

/**
 * Pole wyboru zapisu diagnostyki na dysk.
 *
 * DLACZEGO WŁASNY KOMPONENT, A NIE PROPS W `SettingsPanel`. Panel jest
 * rysowany z TRZECH miejsc (`App.tsx`, `SourcePicker.tsx`, `LobbyView.tsx`),
 * a to ustawienie nie ma nic wspólnego z jakością obrazu, którą tamte trzy
 * miejsca trzymają w swoim stanie: przeciągnięcie go propsami znaczyłoby tę
 * samą instalację przepisaną trzy razy, po to tylko, żeby wrócić do procesu
 * głównego, który i tak jest jego właścicielem.
 *
 * Stan czytamy przy montowaniu, a nie zegarem: plik zmienia wyłącznie to pole,
 * więc nie ma czego odpytywać. W `StrictMode` odczyt poleci dwa razy — jest
 * bezstanowy, więc to nie szkodzi.
 */
function DiagnosticsRecording(): JSX.Element {
  /** `null` do pierwszej odpowiedzi — wtedy nie wiemy jeszcze, co pokazać. */
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  /**
   * Czy OSTATNI zapis pliku się nie udał.
   *
   * Osobno od `snapshot`, bo to nie jest ustawienie, tylko wynik próby: pole
   * wyboru pokazuje wtedy stan, który działa w tej sesji i zniknie po
   * restarcie, a milczenie w tym miejscu byłoby kłamstwem interfejsu.
   */
  const [saveFailed, setSaveFailed] = useState(false)

  useEffect(() => {
    void window.companion.getSettings().then(setSnapshot)
  }, [])

  const apply = (recordDiagnostics: boolean): void => {
    if (snapshot === null) return
    const settings = { ...snapshot.settings, recordDiagnostics }
    /*
     * Pole przestawiamy od razu, nie po odpowiedzi: proces główny stosuje
     * ustawienie w tej sesji NIEZALEŻNIE od tego, czy plik się zapisał, więc
     * zaznaczenie jest prawdą w chwili kliknięcia. Nieudany zapis dokłada
     * zdanie niżej, a nie cofa zaznaczenia — cofnięcie mówiłoby „nie
     * zadziałało", co byłoby nieprawdą.
     */
    setSnapshot({ ...snapshot, settings })
    void window.companion.setSettings(settings).then((saved) => setSaveFailed(!saved))
  }

  return (
    <div className="settings__field">
      <label className="settings__label" htmlFor="record-diagnostics">
        Zapis na dysk
      </label>
      <label className="settings__checkbox">
        <input
          id="record-diagnostics"
          type="checkbox"
          checked={snapshot?.settings.recordDiagnostics ?? false}
          // Dopóki nie znamy stanu, nie pozwalamy go przestawiać: kliknięcie
          // zapisałoby wtedy wartość wziętą z pustego pola, a nie z pliku.
          disabled={snapshot === null}
          onChange={(event) => apply(event.target.checked)}
        />
        <span>Zapisuj diagnostykę na dysk</span>
      </label>
      {snapshot === null ? (
        <p className="settings__hint">Czytanie ustawień…</p>
      ) : (
        <p className="settings__hint">
          Próbki zużycia i dziennik lobby trafiają do plików w katalogu{' '}
          <span className="settings__path">{snapshot.diagnosticsPath}</span>. Podgląd w oknie —
          pasek zużycia i dziennik pod przyciskiem — działa bez tego i nic nie zapisuje.
        </p>
      )}
      {saveFailed && (
        <p className="settings__hint settings__hint--warning">
          Nie udało się zapisać pliku ustawień. Zapis działa w tej sesji, ale po ponownym
          uruchomieniu aplikacji wróci do poprzedniego stanu.
        </p>
      )}
    </div>
  )
}

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

      {/* Diagnostyka na końcu panelu, pod kamerą: to jedyne ustawienie, które
          nie dotyczy obrazu, i jedyne zapamiętywane między uruchomieniami. */}
      <div className="settings__section">
        <h2 className="settings__title">Diagnostyka</h2>
        <DiagnosticsRecording />
      </div>
    </aside>
  )
}
