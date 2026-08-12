# Panel uczestników i animacje transmisji

Data: 2026-08-12
Wydanie docelowe: 0.3.2

## Cel

Panel uczestników wygląda dziś jak lista nazwisk z kropką — i tyle o niej
wiadomo. Aplikacja zna znacznie więcej: kto nadaje ekran, kto kamerę, kto nas
ogląda, jak mu ten obraz dochodzi i z kim w ogóle nie udało się zestawić
połączenia. Nic z tego nie jest widoczne albo jest zaszyfrowane w 13-pikselowym
emoji.

Po tej zmianie panel mówi to wprost, a start i koniec transmisji widać kątem
oka, zamiast zauważać po fakcie, że kafelków jest inaczej niż przed chwilą.

Wygląd wybrany z makiet (wariant „plakietki"): krążek z inicjałami, stan jako
kolorowe pigułki pod nazwiskiem, podział listy na sekcje. Ruch wybrany
z makiet (wariant „efektowne"): 400 ms, kafelek z przeskokiem ponad docelowy
rozmiar, podwójny puls krążka.

## Zakres

**W tym wydaniu:** panel uczestników i warstwa animacji.

**Poza tym wydaniem, świadomie:** panel ustawień (szufladka nad obrazem zamiast
trzeciej kolumny, karty, segmenty zamiast list rozwijanych, suwak bitrate) idzie
do 0.3.3. Powiadomienia w rogu przy wejściu i wyjściu osoby — do 0.3.4.
Rozdzielenie ich daje mniejsze wydania i mniejszy kawałek do sprawdzenia naraz.

## Co widzi użytkownik

### Krążek z inicjałami

Dwie litery zamiast dzisiejszego emoji w kolumnie 34 px.

Reguła: nazwa dzielona na słowa po znakach niebędących literami; inicjały to
pierwsze litery dwóch pierwszych słów, a przy jednym słowie — jego dwie pierwsze
litery. Gdy w nazwie nie ma ani jednej litery (nick z samych ozdobników w rodzaju
`⭐⭐⭐`), zostaje `?`.

Kolor liczony z **nazwy**, nie z `peerId`. `peerId` zmienia się między sesjami,
więc kolor skakałby po każdym ponownym wejściu do kanału; nazwa jest stała, więc
ta sama osoba ma zawsze ten sam kolor. Paleta ośmiu barw dobranych pod tło
`#2b2d31`.

### Plakietki

| Plakietka | Warunek | Kolor |
|---|---|---|
| `🖥 Ekran` | osoba nadaje ekran | akcent |
| `📷 Kamera` | osoba nadaje kamerę | akcent |
| `👁 Ogląda · płynnie` | jest w `viewerPeerIds`, jakość `ok` | zielony |
| `👁 Ogląda · zacina` | jest w `viewerPeerIds`, jakość `poor` | żółty |
| `👁 Ogląda` | jest w `viewerPeerIds`, jakość `unknown` | szary |
| `⚠ Brak połączenia` | jest w `unreachablePeerIds` | czerwony |

Kolejność jest stała: ekran, kamera, oglądanie, brak połączenia.

**„Ogląda" bez dopisku nie znaczy „płynnie".** To ten sam stan, co dzisiejsza
pusta kropka — „jeszcze nie wiadomo". Reguła z 0.3.1 zostaje w mocy: cisza nie
jest dobrą wiadomością, więc brak odpowiedzi nie może wyglądać jak dobra
odpowiedź.

### Osobna kropka jakości znika

Informacja przenosi się do plakietki „Ogląda". Dwa wskaźniki tej samej rzeczy
w jednym wierszu to szum, a plakietka mówi to słowami — nie trzeba się uczyć,
co znaczy kolor. To przeprowadzka funkcji z 0.3.1, nie jej wycofanie.

### Sekcje

`NADAJĄ n` — każdy z co najmniej jednym strumieniem, my również, jeśli nadajemy.
`W KANALE n` — reszta. Gdy nikt nie nadaje, sekcja „Nadają" nie pokazuje nawet
nagłówka i lista wygląda jak dotychczas.

Liczniki w nagłówkach dotyczą **swoich sekcji**, nie całości: przy trzech
osobach, z których jedna nadaje, będzie `NADAJĄ 1` i `W KANALE 2`. Licznik na
zwiniętym pasku pozostaje **łączny**, bo tam nie ma podziału na sekcje.

### Wymiary

Panel rośnie z 240 do 280 px. Zwinięty zostaje bez zmian — 52 px z licznikiem.
Osoba, która naraz nadaje ekran, kamerę i nas ogląda, ma trzy plakietki
zawijające się do drugiej linii; wiersz jest wtedy wyższy i tak ma być.

### Czego świadomie nie ma

Licznika widzów na naszym własnym wierszu. Pasek tytułowy mówi już „Ty:
2 widzów", a drugie to samo w tym samym oknie niczego nie dodaje.

## Ruch

| Zdarzenie | Ruch | Czas |
|---|---|---|
| Kafelek wchodzi | `scale(.78) translateY(16px)` → przeskok `1.04` → `1`, `opacity` 0→1 | 400 ms |
| Kafelek wychodzi | → `scale(.84) translateY(12px)`, `opacity`→0, z zamrożoną ostatnią klatką | 400 ms |
| Plakietka wskakuje | `scale(.5)` → `1.15` → `1` | 300 ms |
| Krążek pulsuje | pierścień `box-shadow`, dwa razy, tylko przy rozpoczęciu nadawania | 900 ms |
| Wiersz wchodzi/wychodzi | `opacity` plus przesunięcie w pionie | 400 ms |

Krzywa `cubic-bezier(.22, 1.4, .36, 1)` — to ona daje przeskok ponad docelowy
rozmiar.

`prefers-reduced-motion: reduce` wyłącza wszystkie te ruchy **i skraca opóźnione
odmontowanie do zera**. Windows wystawia to pod „Efekty wizualne → Efekty
animacji", a ludzie wyłączają je na słabszych maszynach po to, żeby aplikacje
przestały mielić — trzymanie martwego kafelka w DOM-ie przez 400 ms działałoby
wtedy wbrew intencji.

## Architektura

| Plik | Rola | Zależności |
|---|---|---|
| `src/shared/participants.ts` | **Nowy.** Inicjały, kolor, plakietki, model wiersza, podział na sekcje | `./types`, `./viewerQuality` (typy) |
| `src/shared/leaveTransition.ts` | **Nowy.** Kto jeszcze dogasa i na której pozycji | brak |
| `src/renderer/hooks/useLeaveTransition.ts` | **Nowy.** Zegar, odczyt `prefers-reduced-motion` | React |
| `src/renderer/components/ParticipantRow.tsx` | **Nowy.** Jeden wiersz: krążek, nazwisko, plakietki | — |
| `src/renderer/components/PeerPanel.tsx` | Sekcje i pętla po wierszach; chudnie | — |
| `src/renderer/components/LobbyView.tsx` | Podaje `unreachablePeerIds`, owija kafelki hookiem | — |
| `src/renderer/styles.css` | Style wiersza, plakietek, klatki kluczowe | — |
| `vitest.config.ts` | **Nowy.** Alias `@shared` w testach | — |

Granica ta sama, co w 0.3.0 i 0.3.1: **decyzje w bezimportowych modułach
`src/shared`, zegary w hookach, komponenty tylko rysują.**

### `src/shared/participants.ts`

```ts
export type ParticipantBadge =
  | { kind: 'screen' }
  | { kind: 'camera' }
  | { kind: 'watching'; quality: ViewerQuality }
  | { kind: 'unreachable' }

export interface ParticipantView {
  peerId: string
  displayName: string
  isMe: boolean
  initials: string
  color: string
  isStreaming: boolean
  badges: ParticipantBadge[]
}

export interface BadgeInput {
  hasScreen: boolean
  hasCamera: boolean
  /** Nas nie ma na tej liście, więc własny wiersz nigdy nie dostaje „Ogląda". */
  isWatchingUs: boolean
  quality: ViewerQuality
  isUnreachable: boolean
}

export interface ParticipantsInput {
  me: { peerId: string; displayName: string } | null
  peers: readonly { peerId: string; displayName: string }[]
  streams: readonly { peerId: string; kind: StreamKind }[]
  viewerPeerIds: readonly string[]
  viewerQuality: ReadonlyMap<string, ViewerQuality>
  unreachablePeerIds: readonly string[]
}

export const AVATAR_COLORS: readonly string[]

export function initialsFrom(displayName: string): string
export function avatarColorFrom(displayName: string): string
export function badgesFor(input: BadgeInput): ParticipantBadge[]

/** Płaska lista w kolejności wyświetlania: my, potem pozostali. */
export function buildParticipants(input: ParticipantsInput): ParticipantView[]

/**
 * Rozdzielenie na sekcje — osobno, bo działa dopiero PO przejściu wyjścia.
 * Generyczne, bo do tego czasu wiersz jest już opakowany w znacznik `leaving`
 * i nie jest gołym `ParticipantView`.
 */
export function splitByStreaming<T>(
  items: readonly T[],
  isStreaming: (item: T) => boolean
): { streaming: T[]; others: T[] }
```

`buildParticipants` zwraca listę **płaską**, a nie od razu podzieloną na sekcje.
Powód jest w następnym akapicie.

### `src/shared/leaveTransition.ts`

```ts
export const LEAVE_DURATION_MS = 400

export interface LeaveState<T> {
  /** Elementy widziane przy ostatnim wywołaniu, w kolejności ze źródła. */
  readonly present: readonly T[]
  /** Element → moment zniknięcia i pozycja, na której stał. */
  readonly leaving: ReadonlyMap<string, { item: T; since: number; index: number }>
}

export function advanceLeaving<T>(
  state: LeaveState<T>,
  current: readonly T[],
  keyOf: (item: T) => string,
  now: number,
  durationMs: number
): LeaveState<T>

export function visibleItems<T>(state: LeaveState<T>): { item: T; leaving: boolean }[]
```

**Reduktor jest generyczny po elemencie, nie po kluczu, i to nie jest ozdobnik.**
Gdy ktoś kończy transmisję, jego `MediaStream` przestaje istnieć. Gdyby stan
trzymał sam klucz, kafelek dogasałby jako czarny prostokąt. Trzymając cały
element, zostawiamy ten sam `<video>` z tym samym `srcObject` — kafelek odjeżdża
z zamrożoną ostatnią klatką. To różnica między „obraz się skończył" a „coś
zgasło".

`durationMs` jest **parametrem, nie stałą w środku**: przy
`prefers-reduced-motion` hook podaje zero i element znika natychmiast. Przy
okazji reguła daje się przetestować bez czekania na zegar.

`visibleItems` oddaje wychodzące elementy **na ich dawnych pozycjach**. Bez tego
kafelek wypadający ze środka siatki przeskakiwałby na koniec i dopiero stamtąd
gasł.

### Jak uruchamiają się animacje wejścia — bez ani jednego nowego zegara

Animacja CSS gra raz, przy zamontowaniu elementu. Wystarczy więc dobrać `key`
tak, żeby React montował element dokładnie wtedy, kiedy ruch ma się odbyć.
Żadnego pamiętania poprzedniego stanu, żadnego `useEffect` z porównaniem.

**Puls krążka przy rozpoczęciu nadawania:** `key` awatara zawiera `isStreaming`,
a klasa z pulsem jest nakładana tylko przy `isStreaming === true`. Przejście
`false → true` montuje element z klasą — puls gra. Przejście `true → false`
montuje go bez klasy — nie dzieje się nic, i o to chodzi: koniec transmisji ma
być spokojny.

**Plakietka wskakuje:** `key` plakietki to jej `kind`, **celowo bez `quality`**.
Dzięki temu plakietka „Ogląda" wskakuje raz, gdy ktoś zaczyna nas oglądać,
a nie podskakuje co pięć sekund przy każdej zmianie jakości odbioru. Zmiana
`płynnie` ↔ `zacina` to przemalowanie istniejącej plakietki, nie nowa plakietka.

### Pułapka: jedna lista, potem podział

Przejście wyjścia obejmuje **całą listę uczestników**, a rozdzielenie na sekcje
idzie dopiero na jego wyniku. Odwrotna kolejność — osobne przejście w każdej
sekcji — pokazywałaby osobę kończącą transmisję przez 400 ms **dwa razy naraz**:
dogasającą w „Nadają" i już wstawioną do „W kanale".

Skutek uboczny jest pożądany: `isStreaming` osoby wychodzącej z kanału zostaje
zamrożone na ostatniej wartości, więc dogasa w tej sekcji, w której stała.

### Czego ta architektura nie potrafi

Przejazd wiersza między sekcjami przy rozpoczęciu i zakończeniu nadawania jest
**natychmiastowy**. Płynne przeniesienie między dwoma kontenerami wymaga FLIP-a
albo View Transitions.

View Transitions rozważone i odrzucone: Electron 33 to Chromium 130, więc
`document.startViewTransition()` jest dostępne i załatwiłoby także ten przejazd,
ale przejście robi migawkę całego dokumentu — a na dokumencie są żywe `<video>`.
Migawka żywego wideo potrafi mrugnąć czarną klatką albo zamrozić obraz na czas
przejścia, czyli zepsuć dokładnie to, co w tej aplikacji jest najważniejsze.
Do tego nie da się tego przetestować bez przeglądarki.

Ruch przy zmianie stanu niesie zamiast tego plakietka i puls krążka.

## Weryfikacja

Testy jednostkowe w gołym Node. Vitest chodzi tu **bez jsdom i bez
konfiguracji**, więc testów komponentów nie ma i w tym wydaniu nie będzie —
cała logika, która ma być sprawdzona, musi zamieszkać w `src/shared`.

`participants.ts`:

- `"Jan Kowalski"` → `JK`; `"Marek"` → `MA`; `"⭐⭐⭐"` → `?`;
- `"Łukasz Żak"` → `ŁŻ` — polskie litery mają wyjść wielkie, a nie zniknąć;
- ta sama nazwa zawsze ten sam kolor, a `peerId` nie jest argumentem żadnej
  z funkcji koloru, więc nie może na niego wpłynąć;
- kolejność plakietek: ekran, kamera, oglądanie, brak połączenia;
- plakietka „Ogląda" **wyłącznie** dla osób z `viewerPeerIds`;
- jakość `unknown` daje plakietkę **bez dopisku**, a nie „płynnie";
- `unreachable` daje plakietkę także osobie, która nic nie nadaje;
- nasz własny wiersz nie dostaje ani „Ogląda", ani „Brak połączenia". Nie
  łączymy się sami ze sobą, więc nas na tych listach być nie powinno — ale
  `buildParticipants` ma to **wymuszać**, a nie zakładać, inaczej test byłby
  pusty: karmimy go listami zawierającymi nas i sprawdzamy, że i tak nie
  wychodzi z tego „sam siebie oglądam";
- `splitByStreaming` wstawia nas po stronie nadających, gdy nadajemy, i liczy
  obie sekcje osobno.

`leaveTransition.ts`:

- klucz wypada ze źródła → zostaje na liście ze znacznikiem `leaving`;
- **wraca przed upływem czasu → wraca jako zwykły, bez duplikatu**;
- po `durationMs` znika;
- **wychodzący ze środka listy dogasa w środku, nie na końcu**;
- `durationMs: 0` usuwa natychmiast;
- element zachowuje swój ładunek po zniknięciu ze źródła — to jest test
  pilnujący zamrożonej klatki.

**Sprawdzian z prawdziwym oknem:** `e2e/panel-uczestnikow.mjs` w stylu
`e2e/jakosc-odbioru.mjs` — dwie instancje w jednym kanale, jedna zaczyna
nadawać, druga potwierdza w DOM-ie obecność plakietek i podział na sekcje.
**Bez zrzutów ekranu**: sprawdzane jest `document.querySelectorAll`, nie obrazek.

Ruch sprawdzany okiem w działającej aplikacji — tego nie da się przetestować
jednostkowo i nie ma sensu udawać, że się da.

## Dług spłacany przy okazji

`vitest.config.ts` z aliasem `@shared`. Dziś ten alias w testach nie działa;
uratowało nas tylko to, że wszystkie importy z `src/shared` w kodzie sięgalnym
z testów były importami typów, znikającymi przy kompilacji. Pierwszy import
wartości złamał to w 0.3.1 i został obejściem — ścieżką względną — a nie
naprawą. Skoro dokładamy dwa moduły do `src/shared`, dokładamy też dwie linijki
konfiguracji.

## Poza zakresem

- **Panel ustawień** — 0.3.3.
- **Powiadomienia w rogu przy wejściu i wyjściu osoby** — 0.3.4.
- **Awatary z obrazków** — TeamSpeak ma ikony użytkowników, ale wtyczka ich dziś
  nie przekazuje, a dokładanie tego do protokołu nie jest zmianą kosmetyczną.
- **Zmiana kolejności osób na liście** (sortowanie po aktywności, po nazwie) —
  kolejność zostaje taka jak dziś.
- **Animowany przejazd wiersza między sekcjami** — patrz „Czego ta architektura
  nie potrafi".
