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
 * Czyta zawartość `settings.json`. `null` znaczy „pliku nie ma albo nie dało
 * się go przeczytać".
 *
 * Nigdy nie rzuca. Uszkodzony, obcięty, pusty albo podmieniony plik schodzi do
 * wartości domyślnych, bo plik ustawień nie ma prawa zablokować startu
 * aplikacji — a jest to plik w katalogu, do którego każdy ma dostęp i w który
 * ktoś może zaglądać edytorem.
 */
export function parseSettings(raw: string | null): Settings {
  /*
   * Świeża kopia, nie `DEFAULT_SETTINGS`: zwrócony obiekt trafia do procesu
   * głównego i jest tam przestawiany, a zwracanie stałej znaczyłoby, że
   * pierwsze takie przestawienie zmienia wartość domyślną dla całego procesu.
   */
  const settings: Settings = { ...DEFAULT_SETTINGS }
  if (raw === null) return settings

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Składnia nie do uratowania. Próba naprawiania takiego pliku byłaby
    // zgadywaniem, a wartości domyślne są zawsze poprawne.
    return settings
  }

  /*
   * `typeof null === 'object'`, więc bez JAWNEGO sprawdzenia `null` odczyt pola
   * niżej wywaliłby się na pliku z samym słowem `null` — i to jest jedyny
   * powód, dla którego ten warunek ma dwie części. Liczba i napis wypadają na
   * `typeof`.
   *
   * Tablicy nie sprawdzamy osobno, choć `typeof [] === 'object'`: tablica JSON
   * nie ma jak nieść pola `recordDiagnostics`, więc wypada niżej na sprawdzeniu
   * typu pola. Osobny strażnik na nią był kodem, którego nie da się odróżnić od
   * jego braku — sprawdzone mutacją.
   */
  if (parsed === null || typeof parsed !== 'object') return settings

  const fields = parsed as Record<string, unknown>

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
