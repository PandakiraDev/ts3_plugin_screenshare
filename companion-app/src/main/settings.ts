import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSettings, serializeSettings, type Settings } from '@shared/settings'

/**
 * Dostęp do `<userData>/settings.json` z procesu głównego.
 *
 * Ten plik NIE importuje `electron`: ścieżka `userData` przychodzi parametrem,
 * dokładnie jak w `createUpdateLogger(userDataPath)` z `updateLogger.ts`. To
 * nie jest ozdoba — to jedyny sposób, żeby cokolwiek z procesu głównego dało
 * się w tym repozytorium sprawdzić testem, bo vitest chodzi w gołym Node,
 * a modułu importującego `app` nie da się tam nawet wczytać.
 *
 * Wywołujący podaje `app.getPath('userData')` — ten sam katalog, w którym
 * mieszka już `api-key.txt` i dziennik aktualizacji.
 */

function settingsPath(userDataPath: string): string {
  return join(userDataPath, 'settings.json')
}

/**
 * Czyta ustawienia. Każdy powód, dla którego odczyt się nie udał — brak pliku,
 * odebrane uprawnienia, katalog w miejscu pliku, uszkodzona treść — daje
 * wartości domyślne. Start aplikacji nie zależy od tego pliku.
 */
export function readSettings(userDataPath: string): Settings {
  try {
    return parseSettings(readFileSync(settingsPath(userDataPath), 'utf8'))
  } catch {
    // Nieczytelny plik jest dla nas tym samym co brak pliku. Rozróżnianie tych
    // dwóch przypadków nic by nie dało: w obu startujemy z wartościami
    // domyślnymi, bo innych nie mamy.
    return parseSettings(null)
  }
}

/**
 * Zapisuje ustawienia. Nie rzuca nigdy — pełny dysk ani odebrane uprawnienia
 * nie mają prawa przewrócić aplikacji przez przestawienie pola wyboru.
 *
 * Zwraca `true`, gdy plik faktycznie powstał. Wynik jest tu po to, żeby
 * wywołujący (obsługa IPC zapisu ustawień) mógł powiedzieć człowiekowi, że
 * ustawienie nie przeżyje restartu. Samo wypisanie na konsolę tego nie
 * załatwia: spakowana aplikacja Windows nie ma podpiętej konsoli — patrz
 * komentarz w `updateLogger.ts` — więc `console.warn` niżej widać wyłącznie
 * przy `electron-vite dev`. Bez zwróconego wyniku pole wyboru kłamałoby:
 * pokazywałoby „włączone" po nieudanym zapisie.
 */
export function writeSettings(userDataPath: string, settings: Settings): boolean {
  try {
    writeFileSync(settingsPath(userDataPath), serializeSettings(settings), 'utf8')
    return true
  } catch (error) {
    console.warn(
      '[ustawienia] zapis settings.json nie powiódł się:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}
