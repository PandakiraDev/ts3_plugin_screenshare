import type { FpsPreset, QualitySettings, ResolutionPreset } from '@shared/types'
import { BITRATE_PRESETS_KBPS } from '@shared/types'

const RESOLUTION_OPTIONS: { value: ResolutionPreset; label: string }[] = [
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: '1440p', label: '1440p' },
  { value: 'source', label: 'Źródło (natywna)' }
]

const FPS_OPTIONS: FpsPreset[] = [30, 60]

interface SettingsPanelProps {
  quality: QualitySettings
  onChange: (quality: QualitySettings) => void
}

export function SettingsPanel({ quality, onChange }: SettingsPanelProps): JSX.Element {
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
    </aside>
  )
}
