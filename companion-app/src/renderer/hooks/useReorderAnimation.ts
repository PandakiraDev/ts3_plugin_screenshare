import { useLayoutEffect, useRef } from 'react'
import { reducedMotion } from '../reducedMotion'

/** Krócej niż wejście i wyjście kafelka (400 ms) — przestawianie ma być żywe. */
const REORDER_DURATION_MS = 200

/**
 * Animuje zmianę miejsca kafelków techniką FLIP.
 *
 * Mierzymy położenia, po przerysowaniu liczymy różnicę i przejeżdżamy ją
 * transformacją. `transition` tu nie zadziała, bo zmiana pozycji w siatce CSS
 * NIE JEST animowalna.
 *
 * `useLayoutEffect`, nie `useEffect`: animację trzeba założyć przed malowaniem.
 * W efekcie po malowaniu przeglądarka pokazałaby jedną klatkę kafelka już na
 * nowym miejscu, zanim ten skoczyłby na stare i pojechał z powrotem.
 *
 * Bez tablicy zależności, czyli pomiar po KAŻDYM renderze. Lista `[order]`
 * byłaby pułapką: układ przesuwa się też bez zmiany kolejności — gdy ktoś
 * ukryje kafelek, gdy strumień się skończy albo zacznie, gdy zmieni się
 * osierocenie ostatniego kafelka. Przy takiej liście te ruchy nie zostałyby
 * zmierzone, a przy najbliższej zmianie kolejności kafelki wyjechałyby
 * z miejsc sprzed dwóch układów.
 *
 * Kafelki wchodzące i wychodzące są POMIJANE: `tile-in` i `tile-out` animują
 * `transform` (sprawdzone w `styles.css`), więc FLIP biłby się z nimi o tę samą
 * właściwość.
 *
 * Transformacja na elemencie z żywym wideo wymusza kompozytowanie. Trwa to
 * ułamek sekundy i tylko przy świadomym przeciąganiu, więc jest przyjęte — ale
 * dlatego czas jest krótki i nie animujemy nic poza przesunięciem.
 */
export function useReorderAnimation(containerRef: React.RefObject<HTMLElement>): void {
  const boxesRef = useRef<Map<string, DOMRect>>(new Map())

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Pomiary zapisujemy także przy wyłączonych animacjach. Inaczej pierwszy
    // ruch po ich włączeniu wyjechałby z pustego stanu.
    const skipAnimation = reducedMotion()
    const previous = boxesRef.current
    const next = new Map<string, DOMRect>()

    for (const child of container.querySelectorAll<HTMLElement>(':scope > [data-tile-key]')) {
      const key = child.dataset.tileKey
      if (key === undefined) continue // selektor to wyklucza; to tylko dla typów

      const box = child.getBoundingClientRect()
      next.set(key, box)

      // Brak poprzedniego pomiaru znaczy, że kafelek właśnie wszedł.
      const before = previous.get(key)
      if (skipAnimation || !before || child.classList.contains('tile--leaving')) continue

      const dx = before.left - box.left
      const dy = before.top - box.top
      if (dx === 0 && dy === 0) continue

      child.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: REORDER_DURATION_MS,
        easing: 'ease'
      })
    }

    /*
     * Podmieniamy całą mapę, nie scalamy jej z poprzednią — i tak ma zostać.
     * Powiększenie zostawia w siatce jeden kafelek, więc po jego włączeniu mapa
     * ma jeden wpis, a po wyjściu żaden kafelek nie ma poprzedniego pomiaru
     * i nic nie jest animowane. To jest zachowanie POŻĄDANE: scalanie trzymałoby
     * położenia sprzed powiększenia i kafelki wyjeżdżałyby z miejsc, w których
     * nikt ich nie widział.
     */
    boxesRef.current = next
  })
}
