# Widać, jak im idzie — jakość odbioru u widzów

Data: 2026-08-10
Wydanie docelowe: 0.3.1

## Cel

Nadajesz ekran do dwóch osób i nie masz jak się dowiedzieć, czy do nich
dochodzi. Możesz mieć 60 kl/s i 8 Mb/s wychodzące, a druga strona i tak ogląda
pokaz slajdów — bo to jej łącze albo jej komputer nie wyrabia.

Po tej zmianie przy każdej osobie, która Cię ogląda, widać, jak jej ten obraz
dochodzi.

## Kluczowe rozstrzygnięcie: mierzymy obraz, nie łącze

Naturalne pierwsze podejście — pokazać własne statystyki nadawania (FPS,
bitrate) albo raport RTCP od odbiorcy (`remote-inbound-rtp`: strata pakietów,
jitter, ping) — **odpowiada na inne pytanie niż zadane**.

- Własne FPS i bitrate mówią „czy koduję", nie „czy oni widzą".
- Strata pakietów mówi o łączu. Część strat WebRTC nadrabia retransmisją i są
  niewidoczne, a obraz potrafi zacinać się od słabego procesora widza przy
  **zerowej** stracie pakietów.

Jedyne miejsce, w którym istnieje odpowiedź na pytanie „czy obraz się zacina",
to odbiornik. Dlatego widz sam raportuje, co widzi.

## Zgodność wstecz za darmo

Wiadomość `signal` niesie **nieprzezroczysty payload** — serwer w niego nie
zagląda, tylko przekazuje wskazanemu peerowi. Raport jakości jedzie tą samą
drogą co SDP i kandydaci ICE, więc:

- **zero zmian w protokole sygnalizacji**;
- **zero zmian w serwerze**;
- brak wymuszonej aktualizacji u wszystkich naraz.

**Payload celowo nie zawiera pola `stream`.** Sprawdzone w kodzie: starsze
klienty routują nieznany rodzaj payloadu do bufora kandydatów ICE po kluczu
`connectionKey(from, payload.stream)`. Bez pola `stream` klucz nigdy nie pasuje
i wiadomość jest po cichu ignorowana. Gdybyśmy to pole dodali, stary klient
próbowałby dodać `undefined` jako kandydata ICE.

Konsekwencja projektowa: jakość agregujemy **po osobie**, nie po strumieniu.
To i tak zgadza się z tym, gdzie ją pokazujemy — przy nazwisku.

## Przepływ danych

```
WIDZ — co 5 s, dla każdego, kogo ogląda
  getStats() na połączeniu przychodzącym → inbound-rtp (video)
  totalFreezesDuration: przyrost od poprzedniej próbki
  signal(to: nadawca, payload: { kind: 'quality', frozenMs, windowMs })
        │
        │   istniejąca droga sygnalizacji, serwer nie zagląda w payload
        ▼
NADAWCA
  mapa peerId → { ostatni raport, kiedy przyszedł }
  brak raportu przez 15 s → „brak danych"
```

### Pierwsza próbka nie daje raportu

`totalFreezesDuration` jest **narastające od początku połączenia**, nie od
ostatniego odczytu. Pierwsza próbka po podłączeniu nie ma z czym się porównać,
więc raportu z niej nie wysyłamy — inaczej pierwszy raport powiedziałby
„zamrożone 3 s w oknie 5 s", podczas gdy te 3 s uzbierały się przez minutę.

Skutek: świeżo podłączony widz przez pierwsze 5 s ma stan „brak danych". To
poprawne i uczciwe — naprawdę jeszcze nie wiadomo.

### Kto znika z listy

Wskaźnik pokazujemy wyłącznie dla osób z listy widzów (`onViewersChange`).
Osoba, która przestała nas oglądać, wypada z listy razem z kropką — nie ma
osieroconych wpisów do sprzątania. Starzenie raportu (15 s) broni przed innym
przypadkiem: widz nadal podłączony, ale jego raporty przestały przychodzić.

## Co widzi użytkownik

Kropka przy nazwisku w panelu uczestników, **tylko przy osobach, które
faktycznie nas oglądają** (czyli mają z nami połączenie wychodzące):

| Stan | Warunek |
|---|---|
| ● dobrze | obraz stał ≤ 5% czasu okna |
| ● słabo | obraz stał > 5% czasu okna |
| ○ brak danych | raport nie przyszedł od 15 s |

Stan „brak danych" jest osobno **celowo**. Bez niego cisza byłaby dwuznaczna:
„wszystko gra" czy „dane nie doszły"? Cisza nie jest dobrą wiadomością.

### Dlaczego czas zamrożenia, a nie liczba zacięć

`freezeCount` myli krótkie mrugnięcia z długim zamarciem: pięć mrugnięć po
100 ms podbije licznik bardziej niż jedno zamarcie na trzy sekundy, choć to
drugie jest gorsze. `totalFreezesDuration` przekłada się wprost na odczucie —
„co dwudziesta sekunda stoi".

Próg 5% jest wartością **do potwierdzenia pomiarem** (patrz „Weryfikacja”), nie
zgadniętą na stałe.

## Pasek diagnostyki: tylko gdy zacina się wszystkim

Nowy rodzaj problemu w pasku z 0.3.0, z jednym warunkiem: **wszyscy widzowie
mają „słabo" i jest ich co najmniej dwóch**.

Uzasadnienie: przy jednym widzu nie da się odróżnić „mój problem" od „jego
problem", więc pasek milczy, a informacja zostaje przy nazwisku. Przy dwóch
i więcej wspólny mianownik jest po naszej stronie i rada „zmniejsz
rozdzielczość albo FPS" ma sens.

Priorytet **pod** `slow-uplink` — zatkane łącze nazywa tę samą przyczynę
dokładniej.

Tekst: „Obraz zacina się u wszystkich widzów — zmniejsz rozdzielczość albo FPS."

## Architektura

| Plik | Rola | Zależności |
|---|---|---|
| `src/shared/viewerQuality.ts` | **Nowy.** Typ stanu, próg, starzenie raportu, reguła „wszystkim się zacina" | brak |
| `src/shared/connectionHealth.ts` | Nowy rodzaj problemu `viewers-struggling` | brak |
| `src/renderer/webrtc/session.ts` | `reportQualityToStreamers()`, obsługa `kind: 'quality'`, lista widzów | — |
| `src/renderer/hooks/useLobby.ts` | Stan: kto ogląda, ostatni raport od każdego | — |
| `src/renderer/hooks/useViewerQuality.ts` | **Nowy.** Timer 5 s na wysyłkę, 1 s na starzenie | React |
| `src/renderer/components/PeerPanel.tsx` | Kropka przy nazwisku | — |
| `src/renderer/styles.css` | Style kropki | — |

### `src/shared/viewerQuality.ts`

```ts
export type ViewerQuality = 'ok' | 'poor' | 'unknown'

export interface FreezeReport {
  /** Ile milisekund obraz stał zamrożony w oknie. */
  frozenMs: number
  /** Długość okna, którego dotyczy raport. */
  windowMs: number
}

export const QUALITY_REPORT_INTERVAL_MS = 5_000
export const QUALITY_STALE_AFTER_MS = 15_000
export const FROZEN_FRACTION_POOR = 0.05

export function qualityFromReport(
  report: FreezeReport | null,
  ageMs: number
): ViewerQuality

/** Prawda tylko gdy widzów jest co najmniej dwóch i KAŻDY ma „słabo". */
export function allViewersStruggling(qualities: ViewerQuality[]): boolean
```

### Zmiana w istniejącym kodzie

Sesja zgłasza dziś `onViewerCountChange(liczba)`. Potrzebna jest **lista**
widzów, nie liczba — inaczej nie wiadomo, przy kim postawić kropkę. Callback
zmienia się na `onViewersChange(peerIds: string[])`, a licznik w nagłówku
wylicza się z długości listy.

Jedno źródło prawdy zamiast dwóch. Nagłówek zachowuje dotychczasowe zachowanie.

### Pułapka w routingu sygnałów

Obsługa `kind: 'quality'` musi trafić w `onSignal` **przed** gałęzią ICE.
Dzisiejszy kod traktuje wszystko, co nie jest ofertą ani odpowiedzią, jako
kandydata ICE. To ta sama właściwość, która daje nam zgodność wstecz — tylko
widziana z drugiej strony.

## Weryfikacja

Testy jednostkowe czystych modułów (vitest w gołym Node):

- próg dokładnie na 5%: poniżej, równo, powyżej — granica przybita, jak przy
  debouncie łącza w 0.3.0;
- raport starszy niż 15 s daje „brak danych", nie ostatnią znaną wartość;
- brak raportu w ogóle → „brak danych", nie „dobrze";
- `allViewersStruggling` wymaga co najmniej dwóch widzów — jeden z problemem
  daje `false`;
- jeden „słabo" plus jeden „dobrze" → `false`;
- dwóch z „brak danych" → `false`;
- priorytet w pasku: `slow-uplink` wygrywa z `viewers-struggling`, a ten
  wygrywa z brakiem problemu;
- pierwsza próbka nie produkuje raportu (brak poprzedniej wartości do
  odjęcia) — to zabezpieczenie przed policzeniem całej historii zamrożeń jako
  jednego okna.

**Krok pomiarowy przed wydaniem** — osobne zadanie w planie. Dwie instancje
w jednym kanale przez harness w stylu `e2e/obciazenie.mjs`: sprawdzić, że
raport faktycznie dolatuje do nadawcy, niesie sensowne liczby, i że próg 5%
odpowiada temu, co widać okiem. Bez tego kroku próg jest zgadnięty.

## Poza zakresem

- **`framesDropped` i `jitter`** — jedna miara wystarczy; dwie wymagają dwóch
  progów i dwóch uzasadnień.
- **Historia jakości w czasie** (wykres, przebieg) — wskaźnik odpowiada na
  pytanie „jak jest teraz".
- **Wskaźnik u widza o jego własnym odbiorze** — widz patrzy na obraz.
- **Zmiany w serwerze i protokole sygnalizacji.**
- **Automatyczne obniżanie jakości** przy zacinaniu. Najpierw informacja,
  potem ewentualnie decyzja za użytkownika.
