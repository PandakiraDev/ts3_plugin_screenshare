/**
 * Czy system prosi o ograniczenie animacji. Windows wystawia to pod
 * „Efekty wizualne → Efekty animacji".
 *
 * Osobny moduł, bo czytają to dwa hooki (`useLeaveTransition`
 * i `useReorderAnimation`), a to samo zapytanie w dwóch miejscach to dwa
 * źródła jednej prawdy: rozjazd nie wywaliłby niczego głośno, tylko jedna
 * animacja przestałaby słuchać ustawienia.
 *
 * W `shared/` temu miejsca nie ma — `window` nie istnieje w testach, które
 * chodzą w czystym Node bez jsdom.
 */
export function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
