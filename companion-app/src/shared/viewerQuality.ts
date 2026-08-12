/**
 * Jak widzowi dochodzi nasz obraz.
 *
 * Mierzymy OBRAZ, nie łącze. Własne FPS i bitrate mówią "czy koduję", a strata
 * pakietów mówi o łączu — tymczasem obraz potrafi zacinać się od słabego
 * procesora widza przy zerowej stracie, a część strat WebRTC nadrabia
 * retransmisją i są niewidoczne. Jedyne miejsce, w którym istnieje odpowiedź
 * na pytanie "czy się zacina", to odbiornik.
 */
export type ViewerQuality = 'ok' | 'poor' | 'unknown'

/** Ile obraz stał zamrożony w oknie o danej długości. */
export interface FreezeReport {
  frozenMs: number
  windowMs: number
}

/**
 * Przyrost zamrożeń między dwiema próbkami `totalFreezesDuration` (patrz
 * `reportQualityToStreamers` w `session.ts`, jedyne miejsce wołające tę
 * funkcję). Ta statystyka narasta od początku połączenia, nie od ostatniego
 * odczytu, więc samo odjęcie próbek nie wystarczy — trzeba osłonić dwa
 * przypadki brzegowe:
 *
 * - brak `previous` (pierwsza próbka po podłączeniu) — nie ma z czym
 *   porównać, więc zwracamy `null` zamiast raportu liczonego z całej
 *   dotychczasowej transmisji;
 * - `windowMs <= 0` (ten sam znacznik czasu albo zegar cofnięty) — dzielenie
 *   przez takie okno gdzie indziej (`qualityFromReport`) nie miałoby sensu,
 *   więc odsiewamy to już tutaj, u źródła.
 *
 * Klamra `Math.max(0, …)` na przyroście: licznik nie powinien maleć, ale
 * restart połączenia zeruje `totalFreezesDuration` po stronie przeglądarki,
 * co bez tej klamry dałoby ujemny, bezsensowny `frozenMs`.
 */
export function freezeDelta(
  previous: { totalMs: number; at: number } | undefined,
  current: { totalMs: number; at: number }
): FreezeReport | null {
  if (!previous) return null
  const windowMs = current.at - previous.at
  if (windowMs <= 0) return null
  const frozenMs = Math.max(0, current.totalMs - previous.totalMs)
  return { frozenMs, windowMs }
}

/** Co ile widz wysyła raport. */
export const QUALITY_REPORT_INTERVAL_MS = 5_000

/**
 * Po tylu milisekundach bez raportu wracamy do "nie wiadomo". Trzy przegapione
 * raporty — wcześniej byłoby to czułe na pojedynczy zgubiony pakiet.
 */
export const QUALITY_STALE_AFTER_MS = 15_000

/**
 * Powyżej tego ułamka okna wskaźnik robi się "słabo". 5% to pół sekundy na
 * dziesięć — próg dobrany tak, żeby przekładał się na odczucie ("co dwudziesta
 * sekunda stoi"), a nie zapalał się przy pojedynczym mrugnięciu.
 */
export const FROZEN_FRACTION_POOR = 0.05

export function qualityFromReport(
  report: FreezeReport | null,
  ageMs: number
): ViewerQuality {
  if (report === null) return 'unknown'
  if (ageMs >= QUALITY_STALE_AFTER_MS) return 'unknown'
  // Okno zerowe albo ujemne = raport bez sensu; lepiej przyznać się do
  // niewiedzy niż dzielić przez zero.
  if (report.windowMs <= 0) return 'unknown'
  return report.frozenMs / report.windowMs > FROZEN_FRACTION_POOR ? 'poor' : 'ok'
}

/**
 * Czy problem jest po NASZEJ stronie.
 *
 * Wymaga co najmniej dwóch widzów: przy jednym nie da się odróżnić "moje
 * łącze" od "jego komputer", więc pasek milczy, a informacja zostaje przy
 * nazwisku. Przy dwóch i więcej wspólny mianownik jesteśmy my.
 *
 * "Nie wiadomo" nie liczy się jako problem — nie krzyczymy o czymś, czego
 * nie zmierzyliśmy.
 */
export function allViewersStruggling(qualities: ViewerQuality[]): boolean {
  return qualities.length >= 2 && qualities.every((quality) => quality === 'poor')
}
