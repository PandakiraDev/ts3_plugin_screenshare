import { expect, test } from 'vitest'
import {
  LEAVE_DURATION_MS,
  advanceLeaving,
  emptyLeaveState,
  visibleItems,
  nextDeadlineAt,
  type LeaveState
} from '../src/shared/leaveTransition'

interface Item {
  id: string
  payload: string
}

const item = (id: string, payload = id): Item => ({ id, payload })
const keyOf = (value: Item): string => value.id
const ids = (state: LeaveState<Item>): string[] =>
  visibleItems(state, keyOf).map((entry) => entry.item.id)

test('element, który wypadł, zostaje jeszcze na liście ze znacznikiem', () => {
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, 10, LEAVE_DURATION_MS)

  const visible = visibleItems(state, keyOf)
  expect(visible.map((entry) => entry.item.id)).toEqual(['a', 'b'])
  expect(visible.find((entry) => entry.item.id === 'b')?.leaving).toBe(true)
  expect(visible.find((entry) => entry.item.id === 'a')?.leaving).toBe(false)
})

test('wychodzący ze środka dogasa w środku, a nie na końcu', () => {
  // Bez tego kafelek wypadający ze środka siatki przeskakiwałby na koniec
  // i dopiero stamtąd gasł — ruch w zupełnie złą stronę.
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b'), item('c')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a'), item('c')], keyOf, 10, LEAVE_DURATION_MS)

  expect(ids(state)).toEqual(['a', 'b', 'c'])
})

test('powrót przed upływem czasu nie zostawia duplikatu', () => {
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, 10, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 20, LEAVE_DURATION_MS)

  const visible = visibleItems(state, keyOf)
  expect(visible.map((entry) => entry.item.id)).toEqual(['a', 'b'])
  expect(visible.every((entry) => !entry.leaving)).toBe(true)
})

test('po upływie czasu element znika', () => {
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, LEAVE_DURATION_MS, LEAVE_DURATION_MS)

  expect(ids(state)).toEqual(['a'])
})

test('tuż przed upływem czasu element jeszcze jest', () => {
  // Granica przybita z obu stron — inaczej test przechodziłby także wtedy,
  // gdyby element znikał od razu.
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, LEAVE_DURATION_MS - 1, LEAVE_DURATION_MS)

  expect(ids(state)).toEqual(['a', 'b'])
})

test('zerowy czas usuwa natychmiast', () => {
  // Tak działa prefers-reduced-motion: nie ma czego animować, więc nie ma
  // powodu trzymać martwego elementu w DOM-ie.
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 0, 0)
  state = advanceLeaving(state, [item('a')], keyOf, 0, 0)

  expect(ids(state)).toEqual(['a'])
})

test('wychodzący element zachowuje swój ładunek', () => {
  // To jest test pilnujący zamrożonej klatki: kafelek dogasa z tym samym
  // MediaStreamem, bo stan trzyma cały element, a nie sam klucz. Gdyby
  // trzymał klucz, gasł by czarny prostokąt.
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b', 'obraz')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, 10, LEAVE_DURATION_MS)

  const leaving = visibleItems(state, keyOf).find((entry) => entry.leaving)
  expect(leaving?.item.payload).toBe('obraz')
})

test('dwa elementy wychodzące naraz zachowują swoją kolejność', () => {
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(
    state,
    [item('a'), item('b'), item('c'), item('d')],
    keyOf,
    0,
    LEAVE_DURATION_MS
  )
  state = advanceLeaving(state, [item('a'), item('d')], keyOf, 10, LEAVE_DURATION_MS)

  expect(ids(state)).toEqual(['a', 'b', 'c', 'd'])
})

test('wyjścia w dwóch różnych taktach zachowują kolejność', () => {
  // b wychodzi w t=10, c dopiero w t=120 — osobne takty, nie jeden splat.
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(
    state,
    [item('a'), item('b'), item('c'), item('d')],
    keyOf,
    0,
    LEAVE_DURATION_MS
  )
  state = advanceLeaving(state, [item('a'), item('c'), item('d')], keyOf, 10, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a'), item('d')], keyOf, 120, LEAVE_DURATION_MS)

  expect(ids(state)).toEqual(['a', 'b', 'c', 'd'])
})

test('element, który nigdzie nie wychodzi, nie zmienia pozycji przy wyjściach rozłożonych w czasie', () => {
  // Pilnuje nieruchomości żywego kafelka: `c` nigdy nie wychodzi, więc jego
  // pozycja w widocznej liście ma zostać dokładnie tam, gdzie była — inaczej
  // żywy <video> przeskakuje w bok, mimo że nic się z nim nie dzieje.
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(
    state,
    [item('a'), item('b'), item('c'), item('d'), item('e')],
    keyOf,
    0,
    LEAVE_DURATION_MS
  )
  state = advanceLeaving(
    state,
    [item('a'), item('c'), item('d'), item('e')],
    keyOf,
    10,
    LEAVE_DURATION_MS
  )
  state = advanceLeaving(state, [item('a'), item('c'), item('e')], keyOf, 120, LEAVE_DURATION_MS)

  expect(ids(state)).toEqual(['a', 'b', 'c', 'd', 'e'])
})

test('trzy wyjścia w trzech taktach zachowują kolejność', () => {
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(
    state,
    [item('me'), item('A'), item('B'), item('C')],
    keyOf,
    0,
    LEAVE_DURATION_MS
  )
  state = advanceLeaving(state, [item('me'), item('B'), item('C')], keyOf, 10, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('me'), item('C')], keyOf, 60, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('me')], keyOf, 110, LEAVE_DURATION_MS)

  expect(ids(state)).toEqual(['me', 'A', 'B', 'C'])
})

test('nextDeadlineAt: pusty stan zwraca null', () => {
  const state = emptyLeaveState<Item>()
  expect(nextDeadlineAt(state, LEAVE_DURATION_MS)).toBe(null)
})

test('nextDeadlineAt: jeden wygasający zwraca jego termin', () => {
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 100, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, 100, LEAVE_DURATION_MS)

  // b wypadł w chwili 100, dogaśnie w 100 + 400 = 500
  expect(nextDeadlineAt(state, LEAVE_DURATION_MS)).toBe(500)
})

test('nextDeadlineAt: dwa wygasające zwracają wcześniejszy termin (regresja: wielokrotne wychodzące)', () => {
  // To jest test regresji dokładnie na błąd: gdy A dogaśnie, a B wciąż wygasa,
  // zależnością hooka musi być termin, a nie flaga, inaczej efekt się nie odpalił
  // dla B i B zostaje w DOM-ie bez zaplanowanego wybudzenia.
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b'), item('c')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a'), item('c')], keyOf, 100, LEAVE_DURATION_MS) // b wypadł w 100
  state = advanceLeaving(state, [item('a')], keyOf, 150, LEAVE_DURATION_MS) // c wypadł w 150

  // b dogaśnie w 100 + 400 = 500 (wcześniej)
  // c dogaśnie w 150 + 400 = 550 (później)
  // powinna zwrócić 500
  expect(nextDeadlineAt(state, LEAVE_DURATION_MS)).toBe(500)
})
