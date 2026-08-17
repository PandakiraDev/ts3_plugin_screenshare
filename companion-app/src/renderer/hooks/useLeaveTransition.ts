import { useEffect, useRef, useState } from 'react'
import {
  LEAVE_DURATION_MS,
  advanceLeaving,
  emptyLeaveState,
  nextDeadlineAt,
  visibleItems,
  type LeaveState
} from '@shared/leaveTransition'

/**
 * Windows wystawia to pod „Efekty wizualne → Efekty animacji". Ludzie wyłączają
 * je na słabszych maszynach po to, żeby aplikacje przestały mielić — trzymanie
 * martwego elementu w DOM-ie przez 400 ms działałoby wtedy wbrew intencji.
 */
function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Zwraca listę do wyrenderowania: obecne elementy plus te, które właśnie
 * wypadły ze źródła i jeszcze dogasają.
 *
 * Stan siedzi w `useRef` i jest przeliczany W TRAKCIE renderowania, a nie
 * w efekcie: gdyby liczył się w efekcie, pierwsza klatka po zniknięciu elementu
 * pokazałaby listę już bez niego, a animacja wyjścia nie miałaby czego animować.
 * Reduktor jest idempotentny, więc podwójne renderowanie w trybie ścisłym nic
 * nie psuje.
 */
export function useLeaveTransition<T>(
  current: readonly T[],
  keyOf: (item: T) => string
): { item: T; leaving: boolean }[] {
  const stateRef = useRef<LeaveState<T>>(emptyLeaveState<T>())
  const [, bumpRender] = useState(0)

  const durationMs = reducedMotion() ? 0 : LEAVE_DURATION_MS
  stateRef.current = advanceLeaving(stateRef.current, current, keyOf, Date.now(), durationMs)
  const visible = visibleItems(stateRef.current, keyOf)

  /*
   * Gdy element dogaśnie, źródło już się nie zmieni — nikt nas nie obudzi.
   * Bez tego zegara wychodzący element zostałby w DOM-ie na zawsze, wygaszony
   * i nieklikany, ale zajmujący miejsce w siatce.
   *
   * Zależnością musi być TERMIN wybudzenia, a nie flaga „coś się wygasa". Gdyby była flaga:
   * gdy A dogaśnie i znika, a B wciąż wygasa, flaga by została na true, efekt by się nie
   * odpalił, i żaden budzik by się nie zaplanował dla B. Termin ma tę zaletę, że zmienia się
   * przy każdym wejściu/wyjściu, więc efekt się odpalił dla każdego pierwszego/ostatniego
   * elementu w grupie wychodzących.
   */
  const nextDeadline = nextDeadlineAt(stateRef.current, durationMs)
  useEffect(() => {
    if (nextDeadline === null) return
    const delayMs = Math.max(0, nextDeadline - Date.now())
    const timer = setTimeout(() => bumpRender((count) => count + 1), delayMs)
    return () => clearTimeout(timer)
  }, [nextDeadline, durationMs])

  return visible
}
