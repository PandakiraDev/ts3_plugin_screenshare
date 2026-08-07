import { useState } from 'react'

interface ApiKeyPromptProps {
  /** Komunikat z serwera, gdy klucz został odrzucony. */
  error: string | null
  onSave: (key: string) => void
}

/**
 * Ekran wpisania klucza. Klucz jest indywidualny, a instalator wszyscy dostają
 * ten sam — dlatego wpisuje się go raz w aplikacji, a nie wkompilowuje w paczkę.
 */
export function ApiKeyPrompt({ error, onSave }: ApiKeyPromptProps): JSX.Element {
  const [key, setKey] = useState('')
  const validShape = /^[0-9a-f]{64}$/.test(key.trim())

  return (
    <div className="app">
      <header className="app__titlebar">
        <h1 className="app__title">TS3 Screen Share</h1>
        <span className="app__stage-tag">klucz dostępu</span>
      </header>

      <div className="app__main">
        <div className="klucz">
          <h2 className="klucz__tytul">Wpisz klucz dostępu</h2>
          <p className="settings__hint">
            Klucz dostajesz od osoby, która udostępnia serwer. Wpisujesz go raz —
            aplikacja zapamięta go na tym komputerze.
          </p>

          {error && (
            <div className="notice notice--error">
              <span>{error}</span>
            </div>
          )}

          <input
            type="text"
            className="settings__input klucz__input"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && validShape) onSave(key.trim())
            }}
            placeholder="64 znaki, np. 3f9a1c…"
            spellCheck={false}
            autoFocus
          />

          {key.trim().length > 0 && !validShape && (
            <p className="settings__hint">
              Klucz ma 64 znaki (cyfry i litery a–f). Sprawdź, czy skopiowałeś całość.
            </p>
          )}

          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onSave(key.trim())}
            disabled={!validShape}
          >
            Zapisz i połącz
          </button>
        </div>
      </div>
    </div>
  )
}
