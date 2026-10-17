import { useEffect, useState } from 'react'
import {
  SAMPLE_INTERVAL_MS,
  formatResourceBadge,
  type DiagnosticsSample
} from '@shared/diagnostics'
import { formatGpuCard, type GpuCard } from '@shared/gpuInfo'

/**
 * Licznik zużycia CPU/GPU/RAM jako WŁASNY WIERSZ nad siatką kafelków.
 *
 * Do 0.3.4 był nakładką `position: fixed` w prawym dolnym rogu okna. Dopóki
 * siedział za flagą `--diagnostics`, widział go wyłącznie deweloper i kolizja
 * z paskiem sterowania prawego dolnego kafelka była jego własnym kłopotem.
 * Od chwili, w której licznik widzi KAŻDY i ZAWSZE, ta sama kolizja jest
 * kłopotem każdego: nakładka przykrywała pasek kafelka na kilkadziesiąt
 * pikseli przy rozwiniętej liście uczestników i na kilkaset przy zwiniętej
 * (szerokość nakładki minus szerokość listy, do której i tak sięgała).
 * Kliknięcia przechodziły (`pointer-events: none`), więc guzik powiększenia
 * i suwak głośności DZIAŁAŁY — tylko ich nie było widać pod tłem nakładki,
 * a guzika, którego nie widać, nikt nie szuka.
 *
 * Decyzja właściciela: wiersz nad siatką, świadomie za cenę wysokości, którą
 * siatka traci NA STAŁE (rachunek przy `.resource-badge` w `styles.css`).
 * Wiersz jest JEDEN, a nie dwa: w rogu liczby musiały stać nad nazwą karty,
 * bo nakładka miała ograniczoną szerokość i rosła w lewo, w kafelki. Wiersz
 * biegnie przez całą szerokość sceny, więc mieści oba napisy obok siebie
 * i kosztuje siatkę o jedną wysokość wiersza mniej.
 *
 * OSOBNY KOMPONENT, a nie kawałek `Diagnostics`: tamten trzyma razem trzy
 * rzeczy, bo zajmują ten sam róg i tę samą warstwę nad oknem, i to WSPÓLNE
 * MIEJSCE jest całym powodem, dla którego są razem. Licznik z tego rogu się
 * wyprowadził, więc przestał mieć z nimi wspólną sprawę, a dostał własnego
 * właściciela układu (`.viewer` w `LobbyView`), który o rogu okna nic nie wie.
 *
 * CENA WYPROWADZKI, zapisana, nie przemilczana: `Diagnostics` wisi w
 * `main.tsx` jako rodzeństwo `<App />`, więc licznik był widoczny także na
 * ekranach wczesnych wyjść `App` („Uruchamianie…", błąd argumentów wywołania).
 * Teraz rysuje go ten, kto rysuje układ, więc na tych dwóch ekranach go nie
 * ma. Na pierwszym nie było go i przedtem: pierwsza próbka przychodzi po
 * sekundzie, a `getLaunch()` rozstrzyga się w milisekundach. Drugi jest
 * ślepym zaułkiem, w którym nic nie nadaje i nic nie dekoduje.
 * Tryb samodzielny to inna sprawa: tam licznik ZOSTAJE, bo ten tryb
 * przechwytuje ekran, czyli naprawdę zjada maszynę. Dlatego ten komponent
 * wołają DWA miejsca — `LobbyView` i `StandaloneApp` — a nie jedno.
 */
export function ResourceBadge(): JSX.Element | null {
  const [latest, setLatest] = useState<DiagnosticsSample | null>(null)
  /*
   * `undefined` znaczy „jeszcze nie zapytaliśmy", `null` — „zapytaliśmy
   * i karty nie rozpoznano". Bez tego rozróżnienia wiersz pisałby „nie
   * rozpoznano" w pierwszej chwili każdej sesji, czyli mówiłby nieprawdę,
   * zanim zdąży się dowiedzieć.
   */
  const [card, setCard] = useState<GpuCard | null | undefined>(undefined)

  // Raz przy montowaniu, nie zegarem: karta nie zmienia się w trakcie sesji,
  // a proces główny wykrywa ją jednorazowo przy starcie.
  useEffect(() => {
    let cancelled = false
    void window.companion
      .getGpuCard()
      .then((detected) => {
        if (!cancelled) setCard(detected)
      })
      .catch((err: unknown) => {
        // Jedno wywołanie na sesję, więc konsoli nie zasypie — ale bez tej
        // gałęzi zostawiłoby nieobsłużone odrzucenie obietnicy.
        console.debug('[diagnostyka] nieudany odczyt karty graficznej:', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Wiersz potrzebuje jednej najnowszej próbki, nie całego bufora.
  // `readDiagnostics()` co sekundę to 3,09 MB i 13,6 ms serializacji na takt.
  useEffect(() => {
    let cancelled = false
    const tick = (): void => {
      void window.companion
        .getLatestDiagnostics()
        .then((sample) => {
          if (!cancelled) setLatest(sample)
        })
        .catch((err: unknown) => {
          // Bronimy się przed nieobsłużonym odrzuceniem obietnicy CO SEKUNDĘ.
          // Ten kanał jest rejestrowany bezwarunkowo, więc nie ma dziś powodu
          // odrzucać. Gdyby jednak kiedykolwiek przestał być rejestrowany, ten
          // zegar — chodzący z częstotliwością 1 Hz — zasypie konsolę napisem
          // „No handler registered" raz na sekundę i zagłuszy objaw, którego
          // w tej konsoli szukamy.
          console.debug('[diagnostyka] nieudany odczyt najnowszej próbki:', err)
        })
    }
    tick()
    const timer = setInterval(tick, SAMPLE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  /*
   * Bez próbki nie ma wiersza — i to jest cały mechanizm „siatka nie traci
   * wysokości na nic". Wiersz pojawia się razem z pierwszą liczbą, czyli
   * sekundę po wejściu, i wtedy siatka raz drgnie w pionie. Animacja
   * przestawiania tego nie zobaczy: `useReorderAnimation` mierzy
   * `offsetLeft`/`offsetTop`, czyli współrzędne WEWNĄTRZ `.siatka`, a te się
   * nie zmieniają, gdy przesuwa się cała siatka. Nośna jest tam jedna linia
   * CSS — `position: relative` na `.siatka` — i jej nie wolno ruszyć.
   *
   * Wiersz zostaje widoczny TAKŻE przy powiększeniu (`.siatka--zoom`): stoi
   * poza siatką, więc nie trzeba o to nic robić, i właśnie dlatego warto
   * powiedzieć, że to decyzja, a nie przeoczenie. Powiększenie oddaje jeden
   * kafelek na całą scenę i jest trybem, w którym jeden obraz skaluje się
   * najmocniej, czyli tym, o który pytanie „czy to zjada maszynę" pada
   * najczęściej. Ukrycie wiersza akurat tam zabierałoby odpowiedź tam, gdzie
   * jest najbardziej potrzebna, a oddawało powiększonemu obrazowi jeden
   * wiersz tekstu na kilkaset pikseli wysokości sceny.
   */
  if (latest === null) return null

  return (
    <div className="resource-badge">
      <div>{formatResourceBadge(latest.system, latest.at)}</div>
      {/* Obok liczb, a nie pod nimi: tekst o karcie jest długi i przez całą
          sesję ten sam, a napis obok zmienia się co sekundę. Stoi tu, bo samo
          „GPU —" nie mówi, czy zużycia tej karty nie umiemy zmierzyć, czy
          sterownik zamarł — punkt 2 z Review Focus. Rozróżnienie niesie TREŚĆ,
          nie wygląd: zamarły sterownik daje kreskę z godziną odczytu, a ten
          napis nazywa kartę i mówi wprost, czego o niej nie wiemy. */}
      {card !== undefined && (
        <div className="resource-badge__card">{formatGpuCard(card)}</div>
      )}
    </div>
  )
}
