/**
 * Ustawienia zapamiętywane między uruchomieniami — `<userData>/settings.json`.
 *
 * Parsowanie i składanie mieszka tutaj, a nie w `src/main/settings.ts`, bo
 * vitest chodzi w gołym Node bez Electrona: wszystko, co ma mieć test, musi
 * być czystą funkcją w `src/shared/*`. Dostęp do dysku siedzi po drugiej
 * stronie, w `src/main/settings.ts`.
 *
 * Precedens w repozytorium to `api-key.txt` (goły plik z jedną wartością), ale
 * ustawień będzie więcej niż jedno, więc JSON.
 */

export interface Settings {
  /**
   * Czy diagnostykę (próbki zużycia i dziennik lobby) zapisywać na dysk.
   *
   * Podgląd w oknie NIE zależy od tego pola — zużycie i dziennik widzi każdy.
   * To pole dotyczy wyłącznie pisania plików, bo tylko ono kosztuje dysk
   * i tylko ono potrzebuje zgody.
   */
  recordDiagnostics: boolean
}

/**
 * Stan przy pierwszym uruchomieniu i po każdym pliku, którego nie dało się
 * odczytać. Zapis na dysk domyślnie WYŁĄCZONY: nikt nie zgodził się na pliki
 * w swoim katalogu profilu tylko przez to, że zainstalował aplikację.
 */
export const DEFAULT_SETTINGS: Settings = { recordDiagnostics: false }

/**
 * Ustawienia plus to, czego renderer nie ma jak sam policzyć.
 *
 * `diagnosticsPath` jest w tej samej odpowiedzi, a nie w osobnym kanale, bo
 * czyta się je razem i w tej samej chwili: pole wyboru bez zdania „pliki lądują
 * TUTAJ" jest zgodą na coś, czego potem nikt nie znajdzie. Ścieżkę podaje proces
 * główny, bo zależy od `app.getPath('userData')`, czyli od nazwy aplikacji
 * i od tego, czy to przebieg deweloperski — wpisanie jej w renderer na sztywno
 * dałoby zdanie, które u właściciela byłoby nieprawdą.
 */
export interface SettingsSnapshot {
  settings: Settings
  /** Katalog, w którym lądują pliki próbek i dziennika. */
  diagnosticsPath: string
}

/**
 * Składa `Settings` z czegokolwiek.
 *
 * DWA wejścia, jedna decyzja o typach pól: ten sam sprawdzian obsługuje treść
 * `settings.json` (przez `parseSettings` niżej) i obiekt przysłany przez
 * renderer kanałem `IPC_SET_SETTINGS`. Oba przychodzą z zewnątrz procesu
 * głównego i oba mogą nieść cokolwiek, więc rozdzielenie ich znaczyłoby dwie
 * kopie tej samej listy pól — a wtedy nowe pole da się dopisać w jednym
 * miejscu i zapomnieć o drugim.
 */
export function settingsFromUnknown(value: unknown): Settings {
  /*
   * Świeża kopia, nie `DEFAULT_SETTINGS`: zwrócony obiekt trafia do procesu
   * głównego i jest tam przestawiany, a zwracanie stałej znaczyłoby, że
   * pierwsze takie przestawienie zmienia wartość domyślną dla całego procesu.
   */
  const settings: Settings = { ...DEFAULT_SETTINGS }

  /*
   * `typeof null === 'object'`, więc bez JAWNEGO sprawdzenia `null` odczyt pola
   * niżej wywaliłby się na pliku z samym słowem `null` (albo na `null`
   * przysłanym kanałem IPC) — i to jest jedyny powód, dla którego ten warunek
   * ma dwie części. Liczba i napis wypadają na `typeof`.
   *
   * Tablicy nie sprawdzamy osobno, choć `typeof [] === 'object'`: tablica JSON
   * nie ma jak nieść pola `recordDiagnostics`, więc wypada niżej na sprawdzeniu
   * typu pola. Osobny strażnik na nią był kodem, którego nie da się odróżnić od
   * jego braku — sprawdzone mutacją.
   */
  if (value === null || typeof value !== 'object') return settings

  const fields = value as Record<string, unknown>

  /*
   * PUŁAPKA, nie oczywistość: pole przyjmujemy TYLKO wtedy, gdy jest
   * naprawdę logiczne. Rzutowanie przez `Boolean(fields.recordDiagnostics)`
   * zamieniłoby napis „nie" na `true`, czyli ustawienie znaczyłoby dokładnie
   * odwrotność tego, co jest w pliku; `Boolean(1)` włączyłby zapis, którego
   * nikt nie włączał. Obcy typ to nie wartość do przeliczenia, to brak
   * wartości — i schodzi do wartości domyślnej.
   *
   * Nowe pola dopisuj tym samym wzorem: osobne sprawdzenie `typeof` na pole,
   * bez wspólnego rzutowania całego obiektu.
   */
  if (typeof fields.recordDiagnostics === 'boolean') {
    settings.recordDiagnostics = fields.recordDiagnostics
  }

  // Nieznane klucze są po cichu pomijane — starsza aplikacja ma czytać plik
  // nowszej. Cena jest taka, że zapis tych kluczy nie zachowuje: patrz
  // `serializeSettings`.
  return settings
}

/**
 * Czyta zawartość `settings.json`. `null` znaczy „pliku nie ma albo nie dało
 * się go przeczytać".
 *
 * Nigdy nie rzuca. Uszkodzony, obcięty, pusty albo podmieniony plik schodzi do
 * wartości domyślnych, bo plik ustawień nie ma prawa zablokować startu
 * aplikacji — a jest to plik w katalogu, do którego każdy ma dostęp i w który
 * ktoś może zaglądać edytorem.
 */
export function parseSettings(raw: string | null): Settings {
  if (raw === null) return settingsFromUnknown(null)

  try {
    return settingsFromUnknown(JSON.parse(raw))
  } catch {
    // Składnia nie do uratowania. Próba naprawiania takiego pliku byłaby
    // zgadywaniem, a wartości domyślne są zawsze poprawne. `JSON.parse('')`
    // rzuca, więc tą samą drogą idzie plik pusty i plik z samymi białymi
    // znakami, czyli to, co zostaje po przerwanym zapisie.
    return settingsFromUnknown(null)
  }
}

/**
 * Składa zawartość pliku. Wypisuje WYŁĄCZNIE znane pola — plik przepisany
 * starszą wersją aplikacji traci klucze, których ta wersja nie zna. Przy
 * jednym polu to nie ma znaczenia, ale przy dopisywaniu kolejnych pamiętaj, że
 * to jest tutaj decyzja, a nie przypadek.
 *
 * Z wcięciami i znakiem końca linii, bo ten plik czyta człowiek szukający
 * przyczyny — często czytając komuś przez telefon.
 */
export function serializeSettings(settings: Settings): string {
  return `${JSON.stringify({ recordDiagnostics: settings.recordDiagnostics }, null, 2)}\n`
}
