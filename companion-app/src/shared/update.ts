/**
 * Stan aktualizacji widziany przez interfejs.
 *
 * Celowo minimalny: użytkownika interesuje wyłącznie to, czy coś czeka na
 * instalację. Postęp sprawdzania i pobierania jest szumem w oknie, które służy
 * do udostępniania ekranu — dlatego nie ma go w tym typie.
 */
export interface UpdateState {
  /** Wersja gotowa do instalacji; null = nic nie czeka. */
  readyVersion: string | null
}

/** Zdarzenia z `electron-updater`, przetłumaczone na kształt niezależny od niego. */
export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'not-available' }
  | { type: 'downloaded'; version: string }
  | { type: 'error' }

export const NO_UPDATE: UpdateState = { readyVersion: null }

/**
 * Jedyna reguła nieoczywista: `error` NIE kasuje pobranej wersji. Plik leży już
 * na dysku i zainstaluje się po wyjściu z aplikacji, więc nieudane jest kolejne
 * sprawdzenie, a nie ta aktualizacja. Schowanie paska byłoby kłamstwem.
 */
export function reduceUpdate(state: UpdateState, event: UpdateEvent): UpdateState {
  if (event.type === 'downloaded') return { readyVersion: event.version }
  return state
}

/** Tekst paska, albo null gdy nie ma czego pokazywać. */
export function updateNoticeText(state: UpdateState): string | null {
  if (state.readyVersion === null) return null
  return `Pobrano wersję ${state.readyVersion} — zainstaluje się po zamknięciu tego okna.`
}
