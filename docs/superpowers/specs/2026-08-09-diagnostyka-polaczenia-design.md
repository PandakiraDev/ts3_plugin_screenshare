# Uczciwa informacja o kłopotach z połączeniem

Data: 2026-08-09
Zadania: TODO.md § 3.2, § 3.3, § 3.4

## Cel

Trzy zadania z TODO wyglądały na osobne, ale są jednym problemem: **gdy coś
z połączeniem nie działa, użytkownik nie ma jak się dowiedzieć, co**. Widzi
rozsypany obraz, wieczny spinner albo pustkę w miejscu cudzej transmisji — i nie
wie, czy winne jest jego łącze, śpiący serwer, czy zepsuta aplikacja.

Po tej zmianie każda z tych sytuacji mówi wprost, co się dzieje i co z tym
zrobić.

## Stan zastany — co sprawdzono przed projektowaniem

TODO § 3.3 zaczynał się od „najpierw sprawdzić, co aplikacja wtedy pokazuje".
Sprawdzone:

1. **§ 3.4 jest w połowie zrobione, ale niewidoczne.** `session.ts` wykrywa
   `connectionState === 'failed'` na obu kierunkach i woła `onError`
   (`session.ts:386`, `session.ts:451`). Komunikat ląduje w `state.error`,
   a `LobbyView` renderuje `state.error` **wyłącznie** przy
   `connection === 'error'`. Przy awarii pojedynczego połączenia `connection`
   jest dalej `'ready'` — komunikat powstaje i przepada. Ta sama klasa błędu co
   znany dług „błąd nieudanego zatrzymania ekranu nie ma gdzie się pokazać".
2. **§ 3.3 wypada lepiej, niż zakładano.** Nagłówek pokazuje „Łączenie
   z kanałem…", więc to nie jest niemy spinner. Ale `SignalingClient.connect`
   (`SignalingClient.ts:72`) **nie ma limitu czasu**: przy serwerze, który nigdy
   nie odpowie, aplikacja zostaje w tym stanie bez końca.
3. **§ 3.2 nie ma nic.** `getStats()` czytamy wyłącznie w skryptach e2e.

## Decyzje i dlaczego

### Jedno miejsce zamiast trzech

Wybrane: jeden pasek pod nagłówkiem na wszystkie problemy z połączeniem.

Odrzucone: trzy osobne komunikaty w trzech miejscach interfejsu. Dawałoby to
precyzyjniejsze umiejscowienie, ale trzy niezależne mechanizmy do utrzymania —
i, jak pokazuje punkt 1 wyżej, w tym projekcie **komunikat bez przypisanego
miejsca po prostu ginie**. Jedno miejsce likwiduje tę klasę błędu raz.

### Wszystko jest stanem, nic nie jest zdarzeniem

Pasek pokazuje to, co jest nie tak **teraz**, wyliczone z bieżących warunków.
Znika sam, gdy przyczyna ustaje. Nie ma przycisku zamykania i nie ma komunikatów
wiszących po ustaniu przyczyny.

Konsekwencja dla `session.ts`: dzisiejsze `onError('… nie wstało')` to strzał
w powietrze — z jednorazowego zdarzenia nie da się dowiedzieć, że problem minął.
Zastępuje je **zbiór** nieosiągalnych peerów: `failed` dodaje, `connected`
usuwa, wyjście osoby z kanału też usuwa.

### Tylko jeden problem naraz, po priorytecie

Odrzucone: lista wszystkich aktywnych problemów. Przy trzech osobach za
symetrycznym NAT-em pasek zająłby pół okna i zasłonił to, po co ta aplikacja
istnieje.

Odrzucone: „najważniejszy + licznik pozostałych". Żeby dopisek „+2 inne" był do
czegoś przydatny, trzeba dodać sposób rozwinięcia listy — więcej interfejsu niż
wartości.

Priorytet odzwierciedla zagnieżdżenie problemów: bez serwera informacja o łączu
jest bez znaczenia.

### Rozbieg 30 s przed oceną łącza

To jedyna decyzja podparta twardym pomiarem z tego projektu. TODO § 1 notuje:
przy kamerze 1080p60 `qualityLimitationReason` było `bandwidth` przez pierwsze
~40 s, po czym samo spadło do `none` — sterowanie przepływem dochodziło do
równowagi. Łącze nie miało z tym nic wspólnego.

Reakcja natychmiastowa witałaby więc użytkownika komunikatem „Twoje łącze nie
nadąża" przy **każdym** włączeniu kamery. Po dwóch takich razach nikt by go już
nie czytał — a wtedy zadanie nie ma sensu.

Wybrane: dwa niezależne bezpieczniki zamiast jednego długiego opóźnienia.

- **Rozbieg:** pierwsze 30 s każdego strumienia ignorujemy całkowicie.
- **Debounce:** po rozbiegu ograniczenie musi utrzymać się 10 s.

Odrzucone: jeden próg 60 s. Prostsze, ale minutę czekałoby się także przy
zatkaniu w połowie sesji — czyli dokładnie wtedy, gdy informacja jest najbardziej
potrzebna.

Zatrzymanie strumienia zeruje rozbieg, więc następny start dostaje świeże 30 s.

### Limit czasu w `SignalingClient.connect`

90 s, z zapasem na zimny start Rendera. Po tym czasie użytkownik dostaje uczciwe
„nie udało się" zamiast wiecznego „Łączenie z kanałem…".

Wartość jest parametrem z domyślną (`connect(url, timeoutMs = 90_000)`) — inaczej
test limitu musiałby trwać półtorej minuty.

## Co widzi użytkownik

| Priorytet | Warunek | Komunikat |
|---|---|---|
| 1 | `connection === 'connecting'` dłużej niż 5 s | „Serwer się budzi — pierwsze połączenie wieczorem trwa kilkadziesiąt sekund. Czekam… (0:23)" z licznikiem |
| 2 | zbiór nieosiągalnych peerów niepusty | „Nie udało się połączyć z **Michał** — obraz od tej osoby nie dojdzie. Zwykle winny jest restrykcyjny NAT albo firewall." |
| 3 | ograniczenie łącza po rozbiegu i debouncie | „Twoje łącze nie nadąża — zmniejsz rozdzielczość albo FPS w ustawieniach." |

Kilku nieosiągalnych peerów naraz zwija się w jedną linijkę z liczbą osób.

**Czego pasek nie przejmuje:** przypadku `connection === 'error'`. Tam lobby jest
bezużyteczne, więc zostaje dzisiejszy duży komunikat na środku. Pasek jest dla
kłopotów przy *działającym* lobby.

## Architektura

Granica jak przy autoaktualizacji: cała logika decyzyjna w czystym module bez
zależności, testowalna w vitest. Timery i odpytywanie w hooku.

| Plik | Rola | Zależności |
|---|---|---|
| `src/shared/connectionHealth.ts` | **Nowy.** Typ problemu, wybór po priorytecie, teksty, maszyna rozbiegu i debounce'u | brak |
| `src/renderer/hooks/useConnectionHealth.ts` | **Nowy.** Timery, odpytywanie co 3 s, licznik sekund | React, sesja |
| `src/renderer/components/ConnectionNotice.tsx` | **Nowy.** Pasek | — |
| `src/renderer/webrtc/session.ts` | Zbiór nieosiągalnych peerów zamiast `onError`; metoda odczytu ograniczenia łącza | — |
| `src/renderer/hooks/useLobby.ts` | Nowe pola: `unreachablePeerIds`, `connectingSince` | — |
| `src/renderer/signaling/SignalingClient.ts` | Limit czasu w `connect` | — |
| `src/renderer/components/LobbyView.tsx` | Osadzenie paska | — |

### `src/shared/connectionHealth.ts`

```ts
export type ConnectionProblem =
  | { kind: 'server-waking'; secondsWaiting: number }
  | { kind: 'peer-unreachable'; names: string[] }
  | { kind: 'slow-uplink' }

/** Ile trzeba czekać na serwer, zanim powiemy, że się budzi. */
export const SERVER_WAKING_AFTER_MS = 5_000
/** Ile pierwszych sekund strumienia ignorujemy przy ocenie łącza. */
export const UPLINK_WARMUP_MS = 30_000
/** Jak długo ograniczenie musi się utrzymać po rozbiegu. */
export const UPLINK_DEBOUNCE_MS = 10_000

export function pickProblem(input: {
  connectingForMs: number | null
  unreachableNames: string[]
  uplinkSlow: boolean
}): ConnectionProblem | null

export function problemText(problem: ConnectionProblem): string

/** Stan obserwacji łącza; trzymany przez hook, przesuwany tą funkcją. */
export interface UplinkWatch {
  sharingSince: number | null
  limitedSince: number | null
}

export const NO_UPLINK_WATCH: UplinkWatch

export function advanceUplinkWatch(
  watch: UplinkWatch,
  sample: { sharing: boolean; limited: boolean; now: number }
): UplinkWatch

export function isUplinkSlow(watch: UplinkWatch, now: number): boolean
```

Dwa doprecyzowania do wejść:

- **`unreachableNames`** to nazwy wyświetlane, nie identyfikatory. Sesja zna
  wyłącznie `peerId`, więc zamiany na nick dokonuje hook, korzystając z listy
  `peers`, którą `useLobby` już trzyma. Peer, którego nie ma na liście (właśnie
  wyszedł), po prostu wypada — i o to chodzi, bo jego problem przestał istnieć.
- **`limited`** jest prawdziwe, gdy **którykolwiek** z wychodzących nadajników
  raportuje `qualityLimitationReason === 'bandwidth'`. Ekran i kamera to osobne
  połączenia z osobnymi limitami, ale rada dla użytkownika jest ta sama, więc
  rozróżnianie ich w komunikacie nic by nie wniosło.

### Dlaczego odpytywanie w hooku, a nie w sesji

`LobbySession` nie ma dziś ani jednego timera. Dołożenie mu pętli 3-sekundowej
zmieszałoby własność połączeń z rytmem interfejsu. Sesja dostaje więc metodę
czytającą stan **na żądanie**, a decyzję „jak często" podejmuje warstwa UI.

## Weryfikacja

`test/connection-health.test.ts` na czystym module:

- priorytet: budzenie serwera > nieosiągalny peer > zatkane łącze;
- brak problemów → `null`;
- rozbieg: ograniczenie w pierwszych 30 s **nie** daje komunikatu — to jest ten
  fałszywy alarm z pomiaru w TODO § 1;
- debounce: po rozbiegu 5 s ograniczenia to za mało, 10 s wystarcza;
- samoczynne gaśnięcie: ustanie ograniczenia zeruje licznik;
- zatrzymanie strumienia zeruje rozbieg — następny start dostaje świeże 30 s;
- jedna osoba vs trzy: tekst przechodzi w formę zbiorczą.

`test/signaling-client.test.ts` (plik istnieje) — dodatkowy przypadek: goły
serwer TCP, który przyjmuje połączenie i milczy; `connect(url, 200)` ma odrzucić
po limicie zamiast wisieć.

## Poza zakresem

- **`qualityLimitationReason: 'cpu'`** — inny problem i inna rada; TODO o to nie
  prosi.
- **TURN** — TODO § 3.4 mówi wprost: rozważyć dopiero, gdy okaże się, że problem
  realnie u kogoś występuje. Ta zmiana ma właśnie dostarczyć tej informacji.
- **Przycisk zamykania paska** — niepotrzebny, skoro pasek gaśnie sam.
- **Zmiany w protokole sygnalizacji, serwerze i wtyczce.**
