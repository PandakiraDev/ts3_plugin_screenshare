# Panel diagnostyczny, wskaźniki zużycia i odcisk palca lobby

Data: 2026-10-13
Wydanie docelowe: 0.3.3
Kawałek **B** z backlogu po 0.3.2 (patrz `TODO.md` § 5)

## Cel

Po kilku miesiącach używania 0.3.2 właściciel projektu zgłosił siedem rzeczy.
Trzy z nich to usterki pojawiające się „czasem": ktoś nie może wrócić do lobby,
transmisja się zacina, obraz laguje przy grze. Każda zdarza się wtedy, gdy nikt
nie patrzy na aplikację — i każda jest nie do zdiagnozowania bez zapisu.

Ten kawałek buduje **przyrząd**, nie ozdobę: zapis szeregu czasowego, który po
fakcie odpowiada na pytanie „dlaczego lagało", oraz dwa odczyty, które zamieniają
dwie z tych usterek z nieuchwytnych w rozstrzygalne.

## Lekcja, która wymusiła ten kształt

Kawałek A — lagowanie obok gry — został zamknięty **bez zmiany w kodzie**, po
ośmiu przebiegach pomiaru, które odrzuciły hipotezę. Dwie pomyłki z tamtej
roboty rządzą tym projektem:

1. **Objaw zdarza się, gdy nikt nie patrzy.** Panel pokazujący wyłącznie
   teraźniejszość byłby bezużyteczny: w chwili lagowania człowiek patrzy w grę,
   a gdy wraca do okna, widzi już spokój. Dlatego **zapis jest źródłem prawdy,
   a panel tylko jego podglądem** — z suwakiem czasu.
2. **Mierzenie obok problemu kosztuje więcej niż zbudowanie przyrządu.** Dwa
   harnessy e2e powstały w pogoni za hipotezą, której u zgłaszającego nie było.

## Zakres

**W tym wydaniu:** zapis diagnostyczny, panel-podgląd (zgłoszenie 6), wskaźniki
zużycia w rogu (zgłoszenie 7), odcisk palca lobby (dołożony przez właściciela
projektu do kawałka C, przeniesiony tutaj — uzasadnienie niżej).

**Poza tym wydaniem:** powrót do lobby i zacinanie transmisji (kawałek C),
chowanie strumieni i układ ekranów (kawałek D), lagowanie obok gry (kawałek A,
wraca po tym wydaniu z pomiarem z prawdziwej sesji).

## Kluczowe rozstrzygnięcia

### Rejestrator nie mieszka w tym, co diagnozujemy

Właścicielem zapisu jest **proces główny**. Renderer co sekundę wysyła jedną
próbkę ze statystyk WebRTC, proces główny dokłada wiersz systemowy i scala to
w jeden szereg z jednym zegarem.

Powód jest decydujący: podejrzanym jest **głodzony renderer**. Gdyby on prowadził
dziennik, przestawałby zapisywać dokładnie w chwili, która nas interesuje — albo
zapisywałby własne zacinanie jako dane o zjawisku. Proces główny jest lekko
obciążony, przeżywa przeładowanie renderera i ma naturalny dostęp do
`app.getAppMetrics()` oraz do `nvidia-smi`.

### Wszystko za flagą, z jednym wyjątkiem

Zapis, panel i wskaźniki uruchamia flaga `--diagnostics`. Przy jej braku hook się
nie montuje, zegar nie startuje, plik nie powstaje — normalny użytkownik nie
płaci za diagnostykę ani jednym cyklem.

**Odcisk palca lobby jest wyjątkiem i działa zawsze.** Identyfikator pokoju
liczy się ze skrótu adresu serwera TS3 i numeru kanału (`deriveRoomId`).
Zgłoszenie 1 — „nie widzimy się, trzeba wyjść i wejść" — najpewniej znaczy, że
dwie osoby wyliczyły **różne** pokoje. Żeby to sprawdzić, trzeba porównać dwie
wartości z dwóch maszyn. Odcisk za flagą, którą ma jedna osoba, nie rozstrzygnie
niczego: przy następnym rozdzieleniu druga strona odpowie „nie mam gdzie tego
zobaczyć". Osiem znaków w nagłówku kosztuje nic i zamienia tę usterkę
w rozstrzygalną przez telefon.

### GPU nie wstrzymuje zegara, a brak odczytu to nie zero

`nvidia-smi` mierzy 47 ms na wywołanie (średnia z dziesięciu, min 43, max 54),
czyli 4,7% sekundy. Tyknięcie czyta `app.getAppMetrics()` synchronicznie — to
tanie — i **nie czeka** na GPU. Odczyt GPU ląduje w osobnym polu z **własnym
znacznikiem czasu**, gdy wróci. Dwa powody: 47 ms blokady procesu głównego co
sekundę dawałoby zacinanie interfejsu, czyli dokładnie to, czego szukamy; a
własny znacznik czasu nie pozwala udawać, że pomiar GPU i CPU są jednoczesne.

Gdy `nvidia-smi` nie istnieje, nie odpowiada albo zwraca `[N/A]`, pole GPU jest
**`null`, nigdy zero**. Zero znaczyłoby „karta nic nie robi", a to kłamstwo —
my po prostu nie wiemy. Interfejs pokazuje wtedy `GPU —`.

## Co widzi użytkownik

### Odcisk palca lobby (zawsze)

W nagłówku panelu uczestników, małym drukiem obok „Uczestnicy":

```
Uczestnicy          lobby 3f9a2c1b
```

Osiem pierwszych znaków `roomId`. Pod kursorem (atrybut `title`) pełna treść:
**adres serwera TS3 i numer kanału, z których skrót został wyliczony.**

Same wejścia są tu ważniejsze niż skrót. Skrót powie tylko „różnimy się";
wejścia powiedzą dlaczego. `deriveRoomId` normalizuje wielkość liter i spacje
(`trim().toLowerCase()`), więc główny podejrzany to adres podany raz jako nazwa
domeny, a raz jako adres IP tego samego serwera — `ts.serwer.pl:9987` i
`11.22.33.44:9987` dają dwa różne pokoje.

W trybie `standalone` nie ma pokoju, więc odcisk się nie pokazuje.

### Wskaźniki zużycia w rogu (za flagą)

Pasek w prawym dolnym rogu okna, odświeżany co sekundę:

```
CPU 23% · RAM 412 MB · GPU 99% · VRAM 10,0/12,0 GB
```

Bez odczytu GPU: `CPU 23% · RAM 412 MB · GPU —`. Przecinek dziesiętny, bo
interfejs jest polski.

### Panel diagnostyczny (za flagą, `Ctrl+Shift+D`)

Nakładka w istniejącym oknie, nie drugie okno. Zawiera **suwak czasu**:
przewijasz w tył i widzisz stan z dowolnej chwili ostatnich dziesięciu minut.

Dla każdej osoby i każdego strumienia, w tej kolejności:

| Kolumna | Znaczenie |
|---|---|
| odebrane | klatki, które dotarły z sieci |
| zdekodowane | klatki, które procesor lub karta rozpakowały |
| wystawione | klatki, które naprawdę trafiły na ekran |
| **porzucone** | klatki wyrzucone przed wystawieniem |
| bitrate | przepływ w kilobitach na sekundę |
| ograniczenie | `qualityLimitationReason`, gdy różny od `none` |

Dla własnego nadawania: zakodowane, wysłane, bitrate, ograniczenie.

Pod spodem wiersz systemowy — CPU, pamięć, GPU — w tej samej osi czasu.

**Kolejność kolumn jest treścią, nie układem.** Pierwsze ogniwo, które siada,
nazywa przyczynę: spadek na „odebranych" to sieć albo nadawca; zdrowe
„zdekodowane" przy zapadniętych „wystawionych" to karta zajęta czymś innym,
czyli zgłoszenie 2.

**Porzucone klatki są wyróżnione**, bo to jedyna z tych liczb, która odpowiada
słowu „laguje" — w sesji pomiarowej kawałka A było ich 61 na ~240 wystawionych.

## Architektura

| Plik | Rola | Zależności |
|---|---|---|
| `src/shared/diagnostics.ts` | **Nowy.** Typy, bufor kołowy, przeliczanie tempa, parser `nvidia-smi`, format paska, skrót odcisku | `./types` (typ) |
| `src/main/metrics.ts` | **Nowy.** `app.getAppMetrics()` i uruchamianie `nvidia-smi` | electron |
| `src/main/diagnosticsRecorder.ts` | **Nowy.** Zegar 1 s, scalanie, bufor, zapis do pliku | electron |
| `src/renderer/hooks/useDiagnosticsReporter.ts` | **Nowy.** Odczyt `getStats()` i wysyłka w górę | React |
| `src/renderer/components/Diagnostics.tsx` | **Nowy.** Pasek w rogu i panel; czyta flagę z `getLaunch()` | React |
| `src/renderer/main.tsx` | Montuje `<Diagnostics />` jako rodzeństwo `<App />` | — |
| `src/renderer/components/LobbyView.tsx` | Montuje hook zbierający statystyki | — |
| `src/renderer/components/PeerPanel.tsx` | Odcisk palca w nagłówku | — |
| `src/shared/cli.ts` | Flaga `--diagnostics`, przeprowadzenie adresu i kanału | — |
| `src/shared/ipc.ts` | Trzy nowe kanały | — |
| `src/renderer/styles.css` | Styl paska i panelu | — |

### Dlaczego w dwóch miejscach, a nie w jednym

`<Diagnostics />` (pasek i panel) wisi w `main.tsx` **jako rodzeństwo `<App />`**,
bo `App.tsx` ma własne wczesne wyjścia (`Uruchamianie…`, błąd argumentów) i
wskaźniki miałyby w nich zniknąć. Rodzeństwo jest od tych rozgałęzień całkowicie
niezależne. Dane bierze z procesu głównego, więc nie potrzebuje sesji WebRTC.

`useDiagnosticsReporter` wisi w `LobbyView`, bo **tam mieszka sesja WebRTC** i
tylko stamtąd da się wywołać `getStats()`.

**Hook musi stać przed instrukcjami `return` w `LobbyView`.** Komponent wychodzi
wcześniej przy `bad-key` i przy otwartym oknie wyboru źródła; hook wywołany po
takim wyjściu łamie zasady Reacta i wywala aplikację przy pierwszym otwarciu
pickera. Ta sama pułapka wystąpiła w 0.3.2.

### Kanały IPC

```ts
export const IPC_DIAGNOSTICS_PUSH = 'diagnostics:push'
export const IPC_DIAGNOSTICS_LATEST = 'diagnostics:latest'
export const IPC_DIAGNOSTICS_READ = 'diagnostics:read'
```

**Trzy, nie cztery.** Pierwotnie był tu czwarty kanał `diagnostics:enabled`, żeby
renderer mógł zapytać o flagę — i był zbędny: flaga przychodzi już polem
`diagnostics` w `LaunchOptions`, czyli istniejącym `getLaunch()`. Czwarty kanał
dublowałby to, co aplikacja i tak wie.

Rozdzielenie `latest` i `read` jest natomiast celowe: przesyłanie sześciuset
wpisów co sekundę, żeby odmalować cztery liczby w rogu, byłoby marnotrawstwem.
`read` odpowiada tylko wtedy, gdy panel jest otwarty.

### `src/shared/diagnostics.ts`

```ts
import type { StreamKind } from './types'

export interface GpuReading {
  utilizationPercent: number
  memoryUsedMb: number
  memoryTotalMb: number
  /** Własny znacznik czasu: odczyt GPU NIE jest jednoczesny z resztą próbki. */
  at: number
}

export interface SystemStats {
  cpuPercent: number
  memoryMb: number
  gpu: GpuReading | null
}

export interface StreamStats {
  peerId: string
  kind: StreamKind
  direction: 'inbound' | 'outbound'
  /** Pola nieobecne dla danego kierunku są `null`, nie zerem. */
  framesReceived: number | null
  framesDecoded: number | null
  framesPresented: number | null
  framesDropped: number | null
  framesEncoded: number | null
  framesSent: number | null
  bytes: number
  qualityLimitationReason: string | null
}

export interface DiagnosticsSample {
  at: number
  system: SystemStats
  streams: StreamStats[]
}

export interface StreamRates {
  receivedPerS: number | null
  decodedPerS: number | null
  presentedPerS: number | null
  droppedPerS: number | null
  encodedPerS: number | null
  sentPerS: number | null
  kilobitsPerS: number | null
}

export const SAMPLE_INTERVAL_MS = 1_000
export const BUFFER_MAX_AGE_MS = 10 * 60 * 1_000
export const LOG_SIZE_CEILING_BYTES = 8 * 1024 * 1024
export const ROOM_FINGERPRINT_LENGTH = 8

export function parseNvidiaSmi(stdout: string, at: number): GpuReading | null

/** `maxAgeMs` parametrem, nie stałą w środku — inaczej test czekałby dziesięć minut. */
export function appendSample(
  buffer: readonly DiagnosticsSample[],
  sample: DiagnosticsSample,
  maxAgeMs: number
): DiagnosticsSample[]

export function ratesBetween(
  previous: StreamStats,
  next: StreamStats,
  elapsedMs: number
): StreamRates | null

export function formatResourceBadge(system: SystemStats): string

export function shortRoomFingerprint(roomId: string): string
```

**Reguła cofniętego licznika.** `ratesBetween` zwraca `null` jako **całość**
tylko wtedy, gdy `elapsedMs <= 0`. Natomiast **pojedyncze pole** jest `null`,
gdy jego licznik poszedł w tył albo gdy brakuje go po którejkolwiek stronie.
WebRTC zeruje liczniki przy przełączeniu kodeka, a bez tej reguły panel
pokazałby minus czterdzieści klatek na sekundę. To ta sama lekcja co
`freezeDelta` z 0.3.1.

### Zmiana w `LaunchOptions`

```ts
  /** Wejścia, z których wyliczono `roomId`. Oba `null` w trybie standalone. */
  ts3ServerAddress: string | null
  channelId: string | null
  /** Flaga `--diagnostics`: zapis, panel i wskaźniki. */
  diagnostics: boolean
```

Dziś `cli.ts` miele adres i numer kanału w `deriveRoomId` i **wyrzuca je**.
Odcisk palca potrzebuje ich obu, żeby pokazać, z czego skrót powstał.

### Zapis

Bufor kołowy w pamięci procesu głównego na ostatnie dziesięć minut (600 próbek
przy 1 Hz) plus dopisywanie do `userData/diagnostics/YYYY-MM-DD.jsonl`, żeby sesja
przeżyła restart i dała się przysłać jako plik.

Sufit rozmiaru `LOG_SIZE_CEILING_BYTES`; po jego przekroczeniu dopisywanie
ustaje z jedną linią adnotacji. **Każde wywołanie systemu plików w `try/catch`,
a awaria zapisu nigdy nie przewraca aplikacji** — diagnostyka jest dodatkiem,
nie funkcją. Ten sam układ co `updateLogger.ts` z 0.2.0.

## Weryfikacja

Vitest chodzi w gołym Node bez jsdom, a od 0.3.2 katalog `test/` jest objęty
sprawdzaniem typów. Co ma być sprawdzone, mieszka w `src/shared`.

`parseNvidiaSmi` — tu jest najwięcej pułapek, bo to parsowanie cudzego wyjścia:

- poprawny odczyt jednej karty;
- `[N/A]` w którymkolwiek polu → `null` (niektóre karty tak zwracają);
- puste wyjście → `null`;
- śmieci → `null`;
- dwie karty w systemie → odczyt z **pierwszej linii wyjścia**, bez
  wywrócenia się (zgłaszający ma trzy adaptery, ale `nvidia-smi` wypisuje
  wyłącznie karty NVIDIA);
- **nigdy zero zamiast `null`** — osobny test pilnujący, że brak odczytu nie
  udaje bezczynnej karty.

`ratesBetween`:

- zwykły przyrost daje tempo na sekundę;
- `elapsedMs` zerowy albo ujemny → `null` jako całość;
- **licznik cofnięty → to pole `null`, pozostałe nadal policzone**;
- pole brakujące po jednej stronie → `null`, bez `NaN`.

`appendSample`:

- przycina po wieku, zachowuje kolejność;
- nie przycina tego, co się mieści;
- cofnięcie zegara systemowego w trakcie sesji nie wywraca bufora.

`formatResourceBadge`:

- `GPU —` przy `gpu: null`;
- pamięć w gigabajtach z **przecinkiem** dziesiętnym.

`shortRoomFingerprint`:

- osiem znaków z pełnego skrótu;
- wejście krótsze niż osiem znaków nie wywraca funkcji.

`parseLaunchArgs`:

- adres serwera i numer kanału **przeżywają** drogę do `LaunchOptions`, a
  wyliczony `roomId` nadal zgadza się z `deriveRoomId` z tych samych wejść —
  bez tego testu tooltip mógłby kiedyś pokazywać wartości, z których skrót nie
  został wyliczony, czyli diagnostykę gorszą niż jej brak;
- `--diagnostics` jest flagą logiczną: obecna znaczy `true`, nieobecna `false`;
- tryb `standalone` daje oba wejścia `null`.

**Sprawdzian z prawdziwym oknem:** `e2e/diagnostyka.mjs` — instancja z flagą
`--diagnostics`, po kilku sekundach plik `.jsonl` ma linie z oczekiwanymi polami,
a pasek w rogu jest w DOM-ie. Osobno: dwie instancje w **tym samym** kanale
pokazują **identyczny** odcisk palca, a w dwóch różnych kanałach — różny.
Czytamy DOM i plik, **bez zrzutów ekranu**.

**Czego nie da się sprawdzić testem:** samego panelu, suwaka czasu i wiązania
IPC. To idzie na `npm run build` i obejrzenie ręką. Mówimy to wprost, zamiast
udawać pokrycie.

## Kryterium przyjęcia

Nie jest nim „panel się otwiera". Po wydaniu, na podstawie zapisu z **jednej
prawdziwej sesji ze zdalnym nadawcą**, musimy umieć powiedzieć, **które ogniwo
łańcucha siada** przy lagowaniu z kawałka A. Jeśli po takiej sesji nadal nie
będziemy wiedzieć, ten kawałek nie spełnił zadania, choćby wyglądał dobrze.

## Poza zakresem

- **Wykresy i przebiegi** — liczby plus suwak czasu wystarczą, żeby odpowiedzieć
  na „dlaczego lagało". Wykres to kolejne wydanie, jeśli okaże się potrzebny.
- **Wysyłanie czegokolwiek na zewnątrz.** Zapis zostaje na dysku, lokalnie.
- **Drugie okno** na panel — nakładka w istniejącym wystarcza.
- **Rozbicie zużycia na poszczególne procesy Electrona** — suma wystarczy.
- **Zużycie GPU u osób bez karty NVIDIA.** Pokazujemy `GPU —`, nie szukamy
  obejść dla AMD ani Intela; właściciel projektu ma NVIDIĘ, a wskaźnik jest
  za flagą, której nikt inny nie włączy.
- **Zapis u znajomych.** Właściciel projektu wybrał flagę tylko u siebie.
  Konsekwencja jest przyjęta świadomie: zgłoszenia 1 i 3 zdarzają się między
  dwiema maszynami, a widoczna będzie jedna. Odcisk palca lobby jest częściową
  przeciwwagą, bo działa u wszystkich.
