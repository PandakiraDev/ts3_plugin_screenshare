/** Zgodne z czasem animacji wyjścia w styles.css. Jedno miejsce, nie dwa. */
export const LEAVE_DURATION_MS = 400

interface LeavingEntry<T> {
  item: T
  /** Kiedy element zniknął ze źródła. */
  since: number
  /**
   * Klucz elementu, który stał BEZPOŚREDNIO PRZED tym w poprzedniej WIDOCZNEJ
   * kolejności (czyli tej z `visibleItems`, nie w `state.present`) — albo `null`,
   * gdy ten element stał na początku.
   *
   * Celowo klucz, nie indeks. Indeks jest kruchy: zależy od tego, ilu innych
   * wychodzących akurat brakuje w danym takcie, a to się zmienia z każdym
   * kolejnym wyjściem. Przykład, gdzie to się rozjeżdża: `[a,b,c,d]`, `b`
   * wychodzi w takcie t=10 (indeks liczony względem `[a,b,c,d]` → 1), a `c`
   * dopiero w t=120, gdy `b` już dogasa i stoi w widocznej liście na pozycji 1
   * (indeks liczony względem `state.present` bez `b`, czyli `[a,c,d]` → 1 —
   * TA SAMA liczba co miał `b`, ale w innej przestrzeni współrzędnych). Dwa
   * elementy z tym samym zapamiętanym indeksem wstawiają się w to samo miejsce
   * i kolejność się miesza. Klucz poprzednika nie ma tego problemu — nie zależy
   * od tego, kto akurat brakuje, tylko od tego, kto faktycznie stał obok.
   */
  afterKey: string | null
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

  /*
   * Poprzednia WIDOCZNA kolejność — czyli `visibleItems(state)`, a NIE
   * `state.present`. To jest sedno naprawy: `state.present` to lista ze
   * źródła, z której wcześniejsi wychodzący już wypadli, więc poprzednik
   * liczony względem niej żyje w innej przestrzeni współrzędnych niż ta,
   * do której `visibleItems` potem wstawia — przestrzeń widoczna, gdzie
   * wcześniejsi wychodzący wciąż stoją w środku. Dokładnie ta różnica
   * przestrzeni mieszała kolejność, gdy wyjścia były rozłożone w czasie.
   */
  const previousVisible = visibleItems(state, keyOf).map((entry) => keyOf(entry.item))
  const previousIndex = new Map(previousVisible.map((key, index) => [key, index]))

  // Kto właśnie wypadł: zapamiętuje KLUCZ elementu, który stał tuż przed nim
  // w poprzedniej widocznej kolejności — nie indeks. Dzięki temu dogasa
  // dokładnie tam, gdzie faktycznie stał, niezależnie od tego, ilu innych
  // wychodzących akurat brakuje w danym takcie.
  state.present.forEach((item) => {
    if (durationMs <= 0) return
    const key = keyOf(item)
    if (currentKeys.has(key) || leaving.has(key)) return
    const index = previousIndex.get(key)
    const afterKey = index !== undefined && index > 0 ? previousVisible[index - 1] : null
    leaving.set(key, { item, since: now, afterKey })
  })

  return { present: current, leaving }
}

/**
 * Lista do wyrenderowania: obecne elementy plus dogasające, wstawione z powrotem
 * tuż za elementem, który stał przed nimi (`afterKey`), albo na początek, gdy
 * `afterKey` to `null`.
 *
 * Wstawiamy w kolejności rosnącego `since` — to konieczne, nie kosmetyczne:
 * gdy poprzednik sam wygasa, musi już stać na swoim miejscu w wynikowej liście,
 * zanim wstawimy tego, kto stoi tuż za nim, inaczej `afterKey` tego drugiego
 * nie znajdzie się jeszcze w liście.
 */
export function visibleItems<T>(
  state: LeaveState<T>,
  keyOf: (item: T) => string
): { item: T; leaving: boolean }[] {
  const result: { item: T; leaving: boolean }[] = state.present.map((item) => ({
    item,
    leaving: false
  }))
  const keys: string[] = state.present.map((item) => keyOf(item))

  const departing = [...state.leaving.entries()].sort(
    ([, left], [, right]) => left.since - right.since
  )

  for (const [key, entry] of departing) {
    // `afterKey` mógł sam wygasnąć do końca i zniknąć z listy między jednym
    // wywołaniem a drugim — to sytuacja brzegowa, nie powód, żeby wywalić
    // funkcję, więc wtedy wstawiamy po prostu na końcu.
    const afterPos = entry.afterKey === null ? -1 : keys.indexOf(entry.afterKey)
    const insertAt = entry.afterKey === null ? 0 : afterPos === -1 ? result.length : afterPos + 1

    result.splice(insertAt, 0, { item: entry.item, leaving: true })
    keys.splice(insertAt, 0, key)
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
