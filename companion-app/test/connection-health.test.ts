import { expect, test } from 'vitest'
import {
  NO_UPLINK_WATCH,
  UPLINK_DEBOUNCE_MS,
  UPLINK_WARMUP_MS,
  advanceUplinkWatch,
  isUplinkSlow,
  pickProblem,
  problemText
} from '../src/shared/connectionHealth'

const NIC = { connectingForMs: null, unreachableNames: [], uplinkSlow: false }

test('brak problemów daje null', () => {
  expect(pickProblem(NIC)).toBeNull()
})

test('krótkie łączenie jeszcze nie jest problemem', () => {
  // Zwykłe połączenie wstaje w ułamku sekundy — dopiero czekanie dłuższe niż
  // kilka sekund znaczy, że serwer się budzi.
  expect(pickProblem({ ...NIC, connectingForMs: 1_000 })).toBeNull()
})

test('długie łączenie zgłasza budzenie serwera z licznikiem', () => {
  const problem = pickProblem({ ...NIC, connectingForMs: 23_400 })
  expect(problem).toEqual({ kind: 'server-waking', secondsWaiting: 23 })
  expect(problemText(problem!)).toContain('0:23')
})

test('budzenie serwera wygrywa z pozostałymi problemami', () => {
  // Priorytet odzwierciedla zagnieżdżenie: bez serwera informacja o łączu
  // jest bez znaczenia.
  const problem = pickProblem({
    connectingForMs: 10_000,
    unreachableNames: ['Michał'],
    uplinkSlow: true
  })
  expect(problem?.kind).toBe('server-waking')
})

test('nieosiągalny peer wygrywa z zatkanym łączem', () => {
  const problem = pickProblem({
    connectingForMs: null,
    unreachableNames: ['Michał'],
    uplinkSlow: true
  })
  expect(problem?.kind).toBe('peer-unreachable')
})

test('jedna osoba jest wymieniona z nazwy', () => {
  expect(problemText({ kind: 'peer-unreachable', names: ['Michał'] })).toContain('Michał')
})

test('kilka osób zwija się w liczbę zamiast listy nazwisk', () => {
  const text = problemText({ kind: 'peer-unreachable', names: ['Michał', 'Ala', 'Bartek'] })
  expect(text).toContain('3 osobami')
  expect(text).not.toContain('Michał')
})

test('zatkane łącze ma radę, co zrobić', () => {
  const text = problemText({ kind: 'slow-uplink' })
  expect(text).toMatch(/rozdzielczo|FPS/i)
})

test('ograniczenie w czasie rozbiegu NIE jest zgłaszane', () => {
  // To jest ten fałszywy alarm z pomiaru w TODO § 1: przy kamerze 1080p60
  // qualityLimitationReason było 'bandwidth' przez pierwsze ~40 s, bez
  // żadnego związku z łączem.
  let watch = NO_UPLINK_WATCH
  for (let t = 0; t < UPLINK_WARMUP_MS; t += 3_000) {
    watch = advanceUplinkWatch(watch, { sharing: true, limited: true, now: t })
    expect(isUplinkSlow(watch, t)).toBe(false)
  }
})

test('po rozbiegu sam debounce jeszcze nie wystarcza', () => {
  let watch = NO_UPLINK_WATCH
  watch = advanceUplinkWatch(watch, { sharing: true, limited: false, now: 0 })
  const po = UPLINK_WARMUP_MS + 1_000
  watch = advanceUplinkWatch(watch, { sharing: true, limited: true, now: po })
  expect(isUplinkSlow(watch, po + UPLINK_DEBOUNCE_MS - 1)).toBe(false)
  expect(isUplinkSlow(watch, po + UPLINK_DEBOUNCE_MS)).toBe(true)
})

test('ustanie ograniczenia zeruje licznik', () => {
  let watch = NO_UPLINK_WATCH
  watch = advanceUplinkWatch(watch, { sharing: true, limited: false, now: 0 })
  const po = UPLINK_WARMUP_MS + 1_000
  watch = advanceUplinkWatch(watch, { sharing: true, limited: true, now: po })
  watch = advanceUplinkWatch(watch, { sharing: true, limited: false, now: po + 3_000 })
  expect(isUplinkSlow(watch, po + 60_000)).toBe(false)
})

test('zatrzymanie strumienia daje następnemu świeży rozbieg', () => {
  // Bez tego drugie udostępnianie w tej samej sesji dostałoby komunikat od razu.
  let watch = NO_UPLINK_WATCH
  watch = advanceUplinkWatch(watch, { sharing: true, limited: false, now: 0 })
  watch = advanceUplinkWatch(watch, { sharing: false, limited: false, now: 100_000 })
  expect(watch).toEqual(NO_UPLINK_WATCH)

  watch = advanceUplinkWatch(watch, { sharing: true, limited: true, now: 200_000 })
  expect(isUplinkSlow(watch, 200_000 + UPLINK_DEBOUNCE_MS + 1)).toBe(false)
})
