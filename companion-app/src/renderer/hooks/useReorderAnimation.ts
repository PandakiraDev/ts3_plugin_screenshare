import { useLayoutEffect, useRef } from 'react'
import { reducedMotion } from '../reducedMotion'

/** Krócej niż wejście i wyjście kafelka (400 ms) — przestawianie ma być żywe. */
const REORDER_DURATION_MS = 200

/** Położenie kafelka w UKŁADZIE, bez wpływu transformacji. */
interface Spot {
  left: number
  top: number
}

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
 * Mierzymy `offsetLeft`/`offsetTop`, a NIE `getBoundingClientRect()`, i to jest
 * istotne, nie kosmetyczne: prostokąt z `getBoundingClientRect()` jest liczony
 * PO transformacji, a `.tile` dostaje `animation: tile-in 400ms` bezwarunkowo
 * (skala 0.78 → 1.04 → 1). Każdy render w ciągu tych 400 ms zapisywałby więc
 * położenie przeskalowanego kafelka i przy następnym wychodziła z tego różnica
 * kilkudziesięciu pikseli — przesunięcie, którego w układzie nie było.
 * `offsetLeft`/`offsetTop` transformacji nie widzą. Dodatkowa korzyść: gdy
 * przesunie się cała siatka (np. pojawi się pasek ostrzeżenia nad nią),
 * współrzędne względem rodzica się nie zmieniają, więc nie animujemy
 * wszystkich kafelków za jednym zamachem.
 *
 * Kafelki z TRWAJĄCĄ animacją CSS są pomijane. To jedno sprawdzenie zamiast
 * wyliczania klas `tile--leaving` i czasu wejścia: `tile-in` i `tile-out`
 * animują `transform`, a animacje tworzone skryptem mają w kaskadzie wyższy
 * priorytet niż animacje CSS — FLIP nadpisałby je na swoje 200 ms, po czym
 * CSS odzyskałby kontrolę w swojej bieżącej klatce i kafelek skoczyłby dwa
 * razy. Sprawdzenie samego mechanizmu, a nie nazw klas, samo nadąża za CSS-em:
 * nowa animacja na kafelku nie zacznie po cichu bić się z FLIP-em.
 *
 * Transformacja na elemencie z żywym wideo wymusza kompozytowanie. Trwa to
 * ułamek sekundy i tylko przy świadomym przeciąganiu, więc jest przyjęte — ale
 * dlatego czas jest krótki i nie animujemy nic poza przesunięciem.
 */
export function useReorderAnimation(containerRef: React.RefObject<HTMLElement>): void {
  const spotsRef = useRef<Map<string, Spot>>(new Map())

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Pomiary zapisujemy także przy wyłączonych animacjach. Inaczej pierwszy
    // ruch po ich włączeniu wyjechałby z pustego stanu.
    const skipAnimation = reducedMotion()
    const previous = spotsRef.current
    const next = new Map<string, Spot>()

    for (const child of container.querySelectorAll<HTMLElement>(':scope > [data-tile-key]')) {
      const key = child.dataset.tileKey
      if (key === undefined) continue // selektor to wyklucza; to tylko dla typów

      const spot: Spot = { left: child.offsetLeft, top: child.offsetTop }
      next.set(key, spot)

      // Brak poprzedniego pomiaru znaczy, że kafelek właśnie wszedł.
      const before = previous.get(key)
      if (skipAnimation || !before) continue
      if (child.getAnimations().some((a) => a instanceof CSSAnimation && a.playState === 'running')) {
        continue
      }

      const dx = before.left - spot.left
      const dy = before.top - spot.top
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
    spotsRef.current = next
  })
}
