import { expect, test } from 'vitest'
import {
  LEAVE_DURATION_MS,
  advanceLeaving,
  emptyLeaveState,
  visibleItems,
  type LeaveState
} from '../src/shared/leaveTransition'

interface Item {
  id: string
  payload: string
}

const item = (id: string, payload = id): Item => ({ id, payload })
const keyOf = (value: Item): string => value.id
const ids = (state: LeaveState<Item>): string[] =>
  visibleItems(state).map((entry) => entry.item.id)

test('element, który wypadł, zostaje jeszcze na liście ze znacznikiem', () => {
  let state = emptyLeaveState<Item>()
  state = advanceLeaving(state, [item('a'), item('b')], keyOf, 0, LEAVE_DURATION_MS)
  state = advanceLeaving(state, [item('a')], keyOf, 10, LEAVE_DURATION_MS)

  const visible = visibleItems(state)
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

  const visible = visibleItems(state)
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

  const leaving = visibleItems(state).find((entry) => entry.leaving)
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
