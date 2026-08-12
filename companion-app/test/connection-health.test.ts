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

const NIC = {
  connectingForMs: null,
  unreachableNames: [],
  uplinkSlow: false,
  viewersStruggling: false
}

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
    uplinkSlow: true,
    viewersStruggling: true
  })
  expect(problem?.kind).toBe('server-waking')
})

test('nieosiągalny peer wygrywa z zatkanym łączem', () => {
  const problem = pickProblem({
    connectingForMs: null,
    unreachableNames: ['Michał'],
    uplinkSlow: true,
    viewersStruggling: true
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

test('komunikat o nieosiągalnym peerze nie przypisuje kierunku', () => {
  // Rejestr miesza połączenia wychodzące i przychodzące (patrz komentarz przy
  // problemText w connectionHealth.ts) — zdanie nie może zakładać, że to ZAWSZE
  // "obraz OD tej osoby" nie dojdzie, bo przy awarii połączenia wychodzącego
  // to MY nie docieramy do niej.
  expect(problemText({ kind: 'peer-unreachable', names: ['Michał'] })).not.toContain(
    'od tej osoby'
  )
  const textMulti = problemText({ kind: 'peer-unreachable', names: ['Michał', 'Ala', 'Bartek'] })
  expect(textMulti).not.toContain('od tej osoby')
  expect(textMulti).not.toContain('od nich')
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
    watch = advanceUplinkWatch(watch, { sharingKey: 'screen', limited: true, now: t })
    expect(isUplinkSlow(watch, t)).toBe(false)
  }
})

test('po rozbiegu sam debounce jeszcze nie wystarcza', () => {
  let watch = NO_UPLINK_WATCH
  watch = advanceUplinkWatch(watch, { sharingKey: 'screen', limited: false, now: 0 })
  const po = UPLINK_WARMUP_MS + 1_000
  watch = advanceUplinkWatch(watch, { sharingKey: 'screen', limited: true, now: po })
  expect(isUplinkSlow(watch, po + UPLINK_DEBOUNCE_MS - 1)).toBe(false)
  expect(isUplinkSlow(watch, po + UPLINK_DEBOUNCE_MS)).toBe(true)
})

test('ustanie ograniczenia zeruje licznik', () => {
  let watch = NO_UPLINK_WATCH
  watch = advanceUplinkWatch(watch, { sharingKey: 'screen', limited: false, now: 0 })
  const po = UPLINK_WARMUP_MS + 1_000
  watch = advanceUplinkWatch(watch, { sharingKey: 'screen', limited: true, now: po })
  watch = advanceUplinkWatch(watch, { sharingKey: 'screen', limited: false, now: po + 3_000 })
  expect(isUplinkSlow(watch, po + 60_000)).toBe(false)
})

test('zatrzymanie strumienia daje następnemu świeży rozbieg', () => {
  // Bez tego drugie udostępnianie w tej samej sesji dostałoby komunikat od razu.
  let watch = NO_UPLINK_WATCH
  watch = advanceUplinkWatch(watch, { sharingKey: 'screen', limited: false, now: 0 })
  watch = advanceUplinkWatch(watch, { sharingKey: '', limited: false, now: 100_000 })
  expect(watch).toEqual(NO_UPLINK_WATCH)

  watch = advanceUplinkWatch(watch, { sharingKey: 'screen', limited: true, now: 200_000 })
  expect(isUplinkSlow(watch, 200_000 + UPLINK_DEBOUNCE_MS + 1)).toBe(false)
})

test('zmiana zestawu nadawanych strumieni zeruje rozbieg', () => {
  // Dołożenie kamery do trwającego udostępniania ekranu to inny klucz
  // ('camera,screen' zamiast 'screen') — nowy rozbieg, mimo że nadawanie
  // samo w sobie trwa nieprzerwanie od dawna.
  let watch = NO_UPLINK_WATCH
  watch = advanceUplinkWatch(watch, { sharingKey: 'screen', limited: true, now: 0 })
  const znaczniePoRozbiegu = UPLINK_WARMUP_MS * 3
  watch = advanceUplinkWatch(watch, {
    sharingKey: 'camera,screen',
    limited: true,
    now: znaczniePoRozbiegu
  })
  // Mimo że od pierwszego strumienia minęło dużo ponad 45 s, nowy klucz
  // zaczyna nowe okno rozbiegu — ograniczenie w nim jeszcze nie jest problemem.
  // Asercja jest przesunięta po debounce, aby rozróżnić wariant z regułą restartującą
  // rozbieg (limitedSince jest null → false) od wariantu bez reguły (limitedSince
  // zostaje na 0, ale czas − 0 już wymaga debounce → true jeśli debounce upłynął).
  expect(isUplinkSlow(watch, znaczniePoRozbiegu + UPLINK_DEBOUNCE_MS)).toBe(false)
})

test('ten sam klucz nie zeruje rozbiegu', () => {
  // Klucz to posortowany, złączony ciąg (odpowiedzialność hooka) — sam
  // advanceUplinkWatch dostaje już gotowy ciąg, więc test podaje ten sam ciąg
  // dwa razy (odpowiednik dwóch różnych kolejności strumieni po sortowaniu)
  // i sprawdza, że to NIE zeruje rozbiegu, w odróżnieniu od realnej zmiany klucza.
  let watch = NO_UPLINK_WATCH
  watch = advanceUplinkWatch(watch, { sharingKey: 'camera,screen', limited: false, now: 0 })
  const po = UPLINK_WARMUP_MS + 1_000
  watch = advanceUplinkWatch(watch, { sharingKey: 'camera,screen', limited: true, now: po })
  expect(isUplinkSlow(watch, po + UPLINK_DEBOUNCE_MS)).toBe(true)

  // Dla kontrastu: rzeczywista zmiana klucza w tym samym momencie zeruje rozbieg.
  const inneZmiany = advanceUplinkWatch(NO_UPLINK_WATCH, {
    sharingKey: 'screen',
    limited: false,
    now: 0
  })
  const poInnychZmianach = advanceUplinkWatch(inneZmiany, {
    sharingKey: 'camera,screen',
    limited: true,
    now: po
  })
  expect(isUplinkSlow(poInnychZmianach, po + UPLINK_DEBOUNCE_MS)).toBe(false)
})

test('zacinanie u wszystkich widzów trafia na pasek', () => {
  const problem = pickProblem({ ...NIC, viewersStruggling: true })
  expect(problem).toEqual({ kind: 'viewers-struggling' })
  expect(problemText(problem!)).toMatch(/rozdzielczo|FPS/i)
})

test('zatkane łącze wygrywa z zacinaniem u widzów', () => {
  // Obie sytuacje mają tę samą radę, ale zatkane łącze nazywa przyczynę
  // dokładniej — po co mówić o skutku, gdy znamy powód.
  const problem = pickProblem({ ...NIC, uplinkSlow: true, viewersStruggling: true })
  expect(problem?.kind).toBe('slow-uplink')
})

test('nieosiągalny peer wygrywa z zacinaniem u widzów', () => {
  const problem = pickProblem({
    ...NIC,
    unreachableNames: ['Michał'],
    viewersStruggling: true
  })
  expect(problem?.kind).toBe('peer-unreachable')
})
