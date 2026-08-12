/** Zgodne z czasem animacji wyjścia w styles.css. Jedno miejsce, nie dwa. */
export const LEAVE_DURATION_MS = 400

interface LeavingEntry<T> {
  item: T
  /** Kiedy element zniknął ze źródła. */
  since: number
  /** Na której pozycji stał — żeby dogasał tam, gdzie był. */
  index: number
}

export interface LeaveState<T> {
  /** Elementy widziane przy ostatnim wywołaniu, w kolejności ze źródła. */
  readonly present: readonly T[]
  readonly leaving: ReadonlyMap<string, LeavingEntry<T>>
}

export function emptyLeaveState<T>(): LeaveState<T> {
  return { present: [], leaving: new Map() }
}

/**
 * Stan po jednym takcie. `durationMs` jest PARAMETREM, a nie stałą w środku:
 * przy `prefers-reduced-motion` hook podaje zero i element znika natychmiast,
 * zamiast wisieć w DOM-ie bez powodu przez czas nieistniejącej animacji.
 *
 * Funkcja jest idempotentna dla tego samego `now` i `current` — React w trybie
 * ścisłym renderuje dwa razy, więc to nie jest luksus.
 */
export function advanceLeaving<T>(
  state: LeaveState<T>,
  current: readonly T[],
  keyOf: (item: T) => string,
  now: number,
  durationMs: number
): LeaveState<T> {
  const currentKeys = new Set(current.map((item) => keyOf(item)))
  const leaving = new Map<string, LeavingEntry<T>>()

  // Kto już dogasał: zostaje, o ile nie wrócił i nie wyczerpał czasu.
  for (const [key, entry] of state.leaving) {
    if (currentKeys.has(key)) continue
    if (now - entry.since >= durationMs) continue
    leaving.set(key, entry)
  }

  // Kto właśnie wypadł: zaczyna dogasać na swojej dotychczasowej pozycji.
  state.present.forEach((item, index) => {
    if (durationMs <= 0) return
    const key = keyOf(item)
    if (currentKeys.has(key) || leaving.has(key)) return
    leaving.set(key, { item, since: now, index })
  })

  return { present: current, leaving }
}

/**
 * Lista do wyrenderowania: obecne elementy plus dogasające, wstawione z powrotem
 * na swoje dawne pozycje. Wstawiamy od najmniejszego indeksu, żeby kolejne
 * wstawienia nie przesuwały pozycji jeszcze niewstawionych elementów.
 */
export function visibleItems<T>(state: LeaveState<T>): { item: T; leaving: boolean }[] {
  const result = state.present.map((item) => ({ item, leaving: false }))
  const departing = [...state.leaving.values()].sort((left, right) => left.index - right.index)
  for (const entry of departing) {
    result.splice(Math.min(entry.index, result.length), 0, { item: entry.item, leaving: true })
  }
  return result
}

/**
 * Moment, w którym pierwszy wygasający element dogaśnie i powinien zostać usunięty
 * z DOM-u. Zwraca null, jeśli nic nie wygasa.
 *
 * Najwcześniejszy termin: gdy któryś element dogaśnie, reszta następuje w swoim czasie.
 * Jeśli zależnością efektu będzie ten moment, każde przesunięcie terminu (nowy element
 * wychodzący wcześniej/później niż poprzedni) przeplanuje budzik — to rozwiązuje regresję,
 * gdzie drugi element wychodzący utknął w DOM-ie bez zaplanowanego wybudzenia.
 */
export function nextDeadlineAt<T>(state: LeaveState<T>, durationMs: number): number | null {
  let earliest: number | null = null
  for (const entry of state.leaving.values()) {
    const deadline = entry.since + durationMs
    if (earliest === null || deadline < earliest) {
      earliest = deadline
    }
  }
  return earliest
}
