# Układ siatki strumieni — projekt (0.3.4, część 1)

Data: 2026-10-15. Zgłoszenia 4 i 5 z sekcji 5 `TODO.md`.

Wydanie 0.3.4 zawiera **dwie** części, scalane i wydawane razem, ale
projektowane i wykonywane po kolei. Ta specyfikacja opisuje **pierwszą**:
układ siatki. Druga — diagnostyka dla wszystkich — dostanie własną.

## Po co to jest

Dwa zgłoszenia właściciela, które po rozmowie okazały się **jedną** rzeczą:
sterowaniem tym, co widzisz w swojej siatce.

> „chciałbym mieć możliwość wyłączenia swojego udostępnianego ekranu lub
> kamerki (chodzi o ekran oglądania, dalej transmituję, ale nie muszę patrzeć
> na swój ekran podczas oglądania innych)"

> „chciałbym mieć możliwość edytowania układu ekranów (na przykład chcę patrzeć
> tylko na dwa strimy, a jednego nie chcę oglądać, tak jak na discordzie)"

**Zgłoszenie 4 było wcześniej przeczytane błędnie** jako „zakończ
udostępnianie". To nieprawda i warto, żeby ta pomyłka została tu zapisana:
przycisk kończący transmisję **już istnieje** („Zakończ udostępnianie"
w `LobbyView`), więc zbudowanie go po raz drugi nie rozwiązałoby niczego.
Chodzi o **ukrycie własnego kafelka w swojej siatce przy trwającej
transmisji**.

## Zakres

Trzy rzeczy, w tej kolejności wartości dla użytkownika:

1. **Wyśrodkowanie ostatniego kafelka.** Przy trzech strumieniach trzeci ląduje
   dziś przy lewej ściance. To usterka CSS, nie brakująca funkcja.
2. **Ukrywanie kafelków** — własnego podglądu i cudzych strumieni, z **realnym
   zaprzestaniem odbioru** dla cudzych.
3. **Przesuwanie kafelków** przez przeciąganie, z animacją.

**Poza zakresem, świadomie:** wybór kształtu układu (kolumny, rzędy, jeden
główny). Właściciel rozważył i odrzucił — układ automatyczny wystarcza, gdy
ostatni kafelek jest wyśrodkowany, a kolejność da się zmienić ręcznie.

**Poza zakresem, świadomie:** zapisywanie układu między sesjami. Uzasadnienie
właściciela: „za każdym razem będą inni użytkownicy strimać i inna ilość
użytkowników". Stan żyje w pamięci okna i ginie z nim.

## Decyzje i ich uzasadnienia

### Ukrycie własnego podglądu nie dotyka sieci

Swój obraz pochodzi z lokalnego `MediaStream`, nie od nikogo z sieci — nie ma
od kogo przestać go odbierać. Ukrycie to po prostu nierysowanie kafelka.
Zgłoszenie 4 jest więc prawie darmowe, a cała praca z rozłączaniem dotyczy
wyłącznie zgłoszenia 5.

### Ukryty cudzy strumień przestaje być odbierany

Wybór właściciela, postawiony wprost przeciw wariantowi „tylko nie rysuj".
Powód: oszczędza pasmo **i** dekodowanie, czyli realnie zdejmuje obciążenie —
a obciążenie jest przedmiotem osobnego, otwartego zgłoszenia 2 („laguje, gdy
gram"). Koszt: odkrycie wymaga ponownego uzgodnienia, więc obraz wraca po
chwili, a nie natychmiast.

Rozważano i odrzucono wariant „nie rysuj, połączenie zostaw": jest
natychmiastowy i prostszy, ale oszczędza tylko rysowanie. Nie zmierzono, ile
dokładnie oszczędza — właściciel wolał wariant pewny niż pomiar.

### Rezygnacja jedzie w istniejącym przekaźniku, serwer bez zmian

Serwer sygnalizacyjny jest głupim przekaźnikiem: wszystko, co nie jest `join`,
`start-stream` ani `stop-stream`, a ma pole `to`, leci dalej jako `signal`
z nietkniętym `payload` (`signaling-server/src/server.ts`, okolice linii 295).
Nowa wiadomość jedzie w środku i **nie wymaga ani jednej zmiany w serwerze**.

Treść:

```ts
{ kind: 'unsubscribe' | 'subscribe', streamKind: StreamKind }
```

### Pole nazywa się `streamKind`, a NIE `stream` — zasada domu, nie wynalazek

**Ten wzorzec już istnieje w kodzie.** Wariant `quality` w `SignalPayload`
(`session.ts`, okolice linii 98-107) nosi komentarz: „CELOWO bez pola `stream`
— i to jest warunek zgodności wstecz, nie przeoczenie. (…) Z polem `stream`
stary klient próbowałby dodać `undefined` jako kandydata ICE." Rezygnacja
z odbioru idzie więc tą samą drogą co raport jakości z 0.3.1 — naśladujemy
istniejącą zasadę, a nie wymyślamy nową.

Poniżej pełne rozumowanie, bo wykonawca musi je znać, żeby nie „poprawić" nazwy.

`SignalPayload` w `session.ts` nie ma gałęzi „nieznany rodzaj": wszystko, co nie
jest `quality`, `offer` ani `answer`, spada na ścieżkę kandydata ICE. Klient
0.3.3, który dostanie tę wiadomość, wykona:

```js
const kind = payload.stream             // undefined
const key = connectionKey(from, kind)   // "peer:undefined"
// ... quality? nie. offer? nie. answer? nie. owner === my? nie.
await this.incomingBuffers.get(key)?.add(payload.candidate)   // get() → undefined → no-op
```

Przy nazwie `streamKind` klucz nie pasuje do żadnego bufora, `?.` wycisza
wywołanie i **stary klient ignoruje wiadomość dowodnie**. Gdyby pole nazywało
się `stream`, klucz trafiłby w prawdziwy bufor i wywołał
`addIceCandidate(undefined)`, co w WebRTC znaczy „koniec kandydatów" — w środku
uzgadniania mogłoby to zepsuć zestawianie połączenia.

Skutek dla mieszanego lobby: nowy widz zawsze oszczędza dekodowanie (zamyka
swoją stronę), a pasmo oszczędza tylko wtedy, gdy nadawca też ma 0.3.4.
Degradacja łagodna i przewidywalna.

### Ukrycie jest widoczne dla nadawcy — przyjęte świadomie

Plakietka „👁 Ogląda" i licznik widzów biorą się z `viewerPeerIds`, które
nadawca wylicza ze swoich połączeń wychodzących. Zerwanie połączenia jest więc
u niego widoczne: ukrywając czyjś strumień, przestajesz figurować jako widz.

Właściciel przyjął to wprost, odrzucając wariant „pokazuj mnie dalej jako
widza". Powód: ten wariant wymagałby kłamania w interfejsie nadawcy, a reguła
całego wydania 0.3.3 brzmiała „interfejs nie udaje czegoś, czego nie ma".

### Zakończony strumień zapomina o sobie wszystko

Wybór właściciela: „widzisz go, bo to nowy strimek". Z tego wynika **jedna**
reguła zamiast dwóch wyjątków — przy zakończeniu transmisji klucz kafelka
wypada i ze zbioru ukrytych, i z kolejności. Gdy strumień wróci, jest nowym
kafelkiem: widocznym i na końcu.

Zysk poza prostotą: nie ma marnowanej oferty, którą widz natychmiast odrzuca,
ani sekundy, w której nadawca widzi widza, który zaraz zniknie.

### Przycinamy względem sygnalizacji, nie względem stanu WebRTC

`forgetMissingTiles` dostaje listę kluczy **zarejestrowanych jako nadawane**
(prawda z sygnalizacji), a nie listę istniejących elementów `<video>` ani
otwartych połączeń.

To nie jest kosmetyka, ale uzasadnienie wymaga precyzji, bo pierwsza wersja tego
akapitu miała je odwrócone.

Kafelek **wisi w DOM-ie 400 ms PO** zakończeniu strumienia (`LEAVE_DURATION_MS`,
przez `useLeaveTransition`) — nie znika na 400 ms, a zostaje dłużej, niż
istnieje jego strumień. Stan DOM-u jest więc opóźniony względem prawdy
i przycinanie po nim działałoby o 400 ms za późno.

Ważniejszy jest jednak stan **połączeń WebRTC**: on potrafi mignąć w obie
strony przy ponownym uzgadnianiu, a każde mignięcie zdjęłoby ukrycie. Prawda
z sygnalizacji (`streamerRefs`) zmienia się wyłącznie na `start-stream`,
`stream-stopped` i `peer-left` — czyli dokładnie wtedy, kiedy chcemy
zapominać, i nigdy przy zadyszce sieci.

### Sterowanie w dwóch miejscach, bo jedno nie wystarcza

Ukryty kafelek znika z siatki, więc **nie ma czego najechać, żeby go
przywrócić**. Stąd:

- **na kafelku** (widoczne po najechaniu): uchwyt przeciągania po lewej,
  krzyżyk ukrycia po prawej — ukrywasz tam, gdzie patrzysz;
- **w liście uczestników**: oczko przy nazwie włącza i wyłącza strumień. Lista
  pokazuje też tych, których nie widzisz, więc to jedyne miejsce, w którym da
  się odkryć ukryty strumień.

Przeciąganie zostaje wyłącznie na kafelkach, bo to czynność przestrzenna.

### Uchwyt, nie całe kafelek

`.tile__stage` ma już kliknięcie — powiększa i zmniejsza kafelek. Przeciąganie
startujące z dowolnego miejsca kolidowałoby z tym kliknięciem przy każdym
drgnięciu myszy.

### Zdarzenia wskaźnika, nie HTML5 drag-and-drop

HTML5 DnD rysuje własny obraz przeciąganego elementu, czego przy kafelku
z żywym wideo nie da się porządnie opanować; nie działa sensownie z dotykiem;
nie pozwala animować tak, jak trzeba. `pointerdown` plus `setPointerCapture`
daje pełną kontrolę bez żadnej nowej zależności.

### Animacja techniką FLIP

Zmiana pozycji w siatce CSS **nie jest animowalna** przez `transition` — nie ma
tu wyboru. Mierzymy położenie przed i po, różnicę przejeżdżamy transformacją
przez `element.animate()`, bez zależności.

Dwa ograniczenia: czas krótszy od wejścia i wyjścia (~200 ms wobec 400 ms)
i pomijanie kafelków, które właśnie wchodzą albo wychodzą — inaczej animacje
biłyby się o ten sam element. Transformacja na elemencie z wideo wymusza
kompozytowanie; trwa to ułamek sekundy i tylko przy świadomym przeciąganiu,
więc jest przyjęte.

## Architektura

### Stan

W `LobbyView`, bez zapisywania na dysk:

- `hidden: Set<string>` — klucze ukrytych kafelków,
- `order: string[]` — kolejność kafelków.

Oba kluczowane istniejącym `tileKey`, czyli `connectionKey(peerId, kind)`.

### Kolejność działań w potoku — rozstrzygnięta

Dziś jest `tiles = buildTiles(…)`, a potem
`tileRows = useLeaveTransition(tiles, (tile) => tile.tileKey)`. Nowe kroki
wchodzą po obu stronach przejścia, i to nie jest dowolne:

```
buildTiles(…) → visibleTiles(_, hidden) → useLeaveTransition → applyTileOrder(rows, order, keyOf) → render
```

- **Odsiewanie ukrytych PRZED przejściem**: wtedy ukrycie wygląda jak każde
  inne zniknięcie strumienia, czyli dostaje darmową animację wyjścia, a
  odkrycie animację wejścia. Po przejściu ukrycie byłoby nagłym zniknięciem.
- **Kolejność PO przejściu**: `useLeaveTransition` ma własną kolejność
  (`visibleItems`), a my chcemy, żeby decydowała nasza. Gasnący kafelek
  zachowuje swój klucz, więc zachowuje też miejsce — nie przeskakuje w trakcie
  zanikania.

Dlatego `applyTileOrder` jest **generyczna i bierze `keyOf`**, tak samo jak
`useLeaveTransition`: wołana jest **raz**, ale na wierszach
`{ item, leaving }`, a nie na `Tile` — klucz siedzi wtedy o jeden poziom
głębiej (`row.item.tileKey`). Bez generyczności trzeba by albo rozpakowywać
wiersze i składać je z powrotem, albo napisać drugą, prawie identyczną funkcję.

### Nowy plik: `src/shared/tileLayout.ts`

Cała logika decyzyjna, zero importów poza typami — testowalna w gołym vitest.

```ts
/** Odsiewa ukryte kafelki. */
export function visibleTiles(tiles: readonly Tile[], hidden: ReadonlySet<string>): Tile[]

/**
 * Układa kafelki według zapamiętanej kolejności.
 *
 * Kafelek NIEOBECNY w `order` idzie na KONIEC, nie w środek: nowy strumień nie
 * ma prawa wskoczyć w ułożenie, które właśnie zrobiłeś. Klucz z `order`,
 * którego nie ma już wśród kafelków, jest pomijany i nie zostawia dziury.
 */
export function applyTileOrder<T>(
  items: readonly T[],
  order: readonly string[],
  keyOf: (item: T) => string
): T[]

/** Nowa kolejność po przeciągnięciu kafelka na pozycję `toIndex`. */
export function moveTile(order: readonly string[], fromKey: string, toIndex: number): string[]

/* UWAGA: `applyTileOrder` jest generyczna i bierze `keyOf` — patrz „Kolejność
   działań w potoku". Wołana RAZ, ale na wierszach `{ item, leaving }`
   z przejścia wyjścia, więc klucz siedzi o poziom głębiej. */

/**
 * Przycina ukryte i kolejność do kafelków, które nadal są nadawane.
 *
 * `presentKeys` to prawda z SYGNALIZACJI, nie stan połączeń ani DOM-u —
 * patrz uzasadnienie w sekcji decyzji. Konkretnie: klucze z
 * `lobby.state.streams`, które pochodzą z `streamerRefs` w `session.ts`
 * (`Map<connectionKey, StreamRef>`, linia ~213) — a ta mapa jest kluczowana
 * DOKŁADNIE tym samym `connectionKey(peerId, kind)` co `tileKey`, więc nie ma
 * tu żadnego przeliczania kluczy ani miejsca na pomyłkę.
 */
export function forgetMissingTiles(
  hidden: ReadonlySet<string>,
  order: readonly string[],
  presentKeys: ReadonlySet<string>
): { hidden: Set<string>; order: string[] }
```

### Zmiany w istniejących plikach

| Plik | Co |
|---|---|
| `src/renderer/components/LobbyView.tsx` | stan `hidden` i `order`, złożenie z `buildTiles`, przekazanie uchwytów |
| `src/renderer/components/StreamTile.tsx` | uchwyt przeciągania, krzyżyk ukrycia, obsługa wskaźnika |
| `src/renderer/components/PeerPanel.tsx` | przekazanie stanu ukrycia do wierszy |
| `src/renderer/components/ParticipantRow.tsx` | oczko włączające i wyłączające strumień |
| `src/renderer/webrtc/session.ts` | `unsubscribe`/`subscribe`: wysyłanie, odbiór, `dropOutgoing`/`createOutgoing` |
| `src/renderer/hooks/useLobby.ts` | wystawienie nowych metod, pominięcie rezygnacji w `unreachablePeerIds` |
| `src/renderer/styles.css` | wyśrodkowanie ostatniego kafelka, uchwyt, krzyżyk, oczko |

### Wyśrodkowanie — konkret, i usterka jest szersza niż zgłoszenie

Zgłoszenie mówi o trzech kafelkach, ale przeczytanie kodu pokazuje, że dotyczy
**każdej nieparzystej liczby**. Dziś jest `data-ile={Math.min(tileRows.length, 4)}`,
a CSS daje dwie kolumny dla `2`, `3` i `4`. Przy pięciu kafelkach `data-ile`
wynosi **też 4** (przez `Math.min`), więc układ ma dwie kolumny, a piąty kafelek
jest osierocony przy lewej ściance — ta sama usterka, tylko nie zauważona, bo
rzadziej się zdarza. Reguła oparta na `data-ile="3"` naprawiłaby jeden przypadek
i zostawiła drugi.

Dlatego warunek liczymy w JSX i wystawiamy osobnym atrybutem:

```tsx
// Osierocony ostatni kafelek: nieparzysta liczba przy układzie dwukolumnowym.
data-sierota={tileRows.length >= 3 && tileRows.length % 2 === 1 ? '' : undefined}
```

```css
/* Cztery kolumny, każdy kafelek zajmuje dwie, ostatni startuje od drugiej.
   Wychodzi ta sama szerokość co pozostałe, tylko na środku. Działa dla
   trzech, pięciu, siedmiu — nie tylko dla trzech. */
.siatka[data-sierota] {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
.siatka[data-sierota] > * { grid-column: span 2; }
.siatka[data-sierota] > :last-child { grid-column: 2 / span 2; }
```

Dwie rzeczy rozstrzygnięte, nie zostawione wykonawcy:

**`:last-child` jest pozycyjny**, więc po przeciągnięciu wyśrodkowany jest ten
kafelek, który faktycznie stoi na końcu. To jest pożądane.

**Kafelek wychodzący wlicza się do parzystości na 400 ms.** `tileRows` pochodzi
z przejścia wyjścia, więc element z klasą `--leaving` siedzi w DOM-ie i jest
liczony. Skutki, oba przyjęte: przy przejściu z czterech kafelków na trzy
wyśrodkowanie pojawia się **po** animacji, a nie w jej trakcie; przy przejściu
z trzech na dwa wyśrodkowany jest przez te 400 ms kafelek, który właśnie gaśnie,
co jest niewidoczne, bo i tak zanika. Nie dodajemy nic, żeby to obejść —
alternatywą byłoby liczenie parzystości bez wychodzących, a wtedy układ
przeskakiwałby **w trakcie** animacji, co jest gorsze.

## Obsługa błędów

- **Pusta siatka przy ukrytych wszystkich strumieniach musi mówić prawdę.**
  Dziś przy `tileRows.length === 0` widok pokazuje „Odbieranie obrazu…" albo
  „Nikt nie nadaje obrazu. Możesz zacząć jako pierwszy". To drugie **skłamałoby**,
  gdy ludzie nadają, a Ty ukryłeś wszystkich. Potrzebny jest trzeci komunikat —
  „Wszystkie strumienie są ukryte" wraz ze wskazaniem, że odkrywa się je oczkiem
  w liście uczestników. Bez tego najłatwiejszy sposób zablokowania sobie obrazu
  wygląda jak awaria i nie podpowiada wyjścia.
- **Powiększenie wskazujące ukryty kafelek.** Stan `zoomed` trzyma `tileKey`
  (`useState<string | null>`). Ukrycie powiększonego kafelka zostawiłoby
  powiększenie na kluczu, którego nie ma w siatce. Ukrycie musi zdjąć
  powiększenie, gdy dotyczy właśnie tego klucza.
- **Rezygnacja z własnej woli nie jest awarią.** `unreachablePeerIds`
  i `useConnectionHealth` muszą pomijać pary, z których widz zrezygnował —
  inaczej każde ukrycie zapalałoby ostrzeżenie „Brak połączenia".
- **`subscribe` do kogoś, kto nic nie nadaje**, jest pomijany bez błędu:
  stan nadawania jest prawdą nadawcy, nie widza.
- **Nieudane ponowne uzgodnienie po odkryciu** kończy się jak każde inne
  nieudane uzgodnienie, istniejącą ścieżką — nie dokładamy nowej obsługi.

## Testy

**Jednostkowe, w gołym vitest, z mutacjami:**

- `visibleTiles` — ukryty nie wychodzi, nieukryty wychodzi;
- `applyTileOrder` — kolejność zachowana; **kafelek nieobecny w `order` idzie
  na koniec**; klucz nieistniejący pomijany bez dziury; obie reguły naraz;
- `moveTile` — przeciągnięcie trzeciego na początek; na koniec; na własne
  miejsce (bez zmiany); indeks poza zakresem;
- `forgetMissingTiles` — klucz nieobecny wypada z obu zbiorów; obecny zostaje
  w obu; pusty zbiór obecnych czyści wszystko.

**Test zgodności wiadomości:** treść rezygnacji ma `streamKind` i **nie ma**
`stream`, z powodem w komentarzu. Bez tego ktoś „posprząta" nazwę na krótszą
i cicho zepsuje zgodność ze starszymi wersjami — objawi się to dopiero u ludzi,
u których połączenie przestanie się zestawiać, i nikt nie powiąże tego z tą
zmianą.

**W `e2e/`:** środek osieroconego kafelka zgadza się ze środkiem kontenera.
Skrypty czytają DOM przez CDP, więc to realny sprawdzian usterki, od której ta
część się zaczęła. **Sprawdzane przy trzech ORAZ przy pięciu kafelkach** —
sprawdzian tylko na trzech przeszedłby także dla reguły opartej na
`data-ile="3"`, czyli nie odróżniłby poprawki pełnej od połowicznej, a to jest
dokładnie ta różnica, którą wykryliśmy przy czytaniu kodu.

**Czego nie da się przetestować:** obsługa wskaźnika i animacja FLIP. Czysty
DOM, a repozytorium nie ma jsdom — testów komponentów nie ma tu w ogóle.

## Czego ta część nie rozwiązuje

Nie jest odpowiedzią na zgłoszenie 2 („laguje, gdy gram"), choć go dotyka:
ukrycie strumienia zdejmuje obciążenie, ale nie wiadomo ile i nie było to
mierzone. Zgłoszenie 2 zostaje otwarte i wraca z pomiarem z prawdziwej sesji.
