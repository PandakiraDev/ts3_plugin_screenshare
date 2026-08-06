# Kamera obok udostępniania ekranu

Data: 2026-08-06

## Cel

Uczestnik może włączyć kamerę niezależnie od udostępniania ekranu — samą
kamerę, sam ekran, albo oba naraz. Każdy strumień jest osobnym kafelkiem, tak
jak w Discordzie.

Dziś jedna osoba może nadawać dokładnie jeden strumień: `LobbySession` mapuje
`peerId → połączenie`, a callback ma sygnaturę `onRemoteStream(peerId, stream)`.
To jest miejsce, które trzeba rozciągnąć.

## Decyzje i dlaczego

### Osobne połączenie dla ekranu i dla kamery

Rozważaliśmy jedno połączenie na parę osób z dwiema ścieżkami wideo w środku.
Odrzucone: włączenie kamery w trakcie streamu wymagałoby **renegocjacji**
działającego połączenia, którym właśnie leci obraz.

Wybrane: klucz połączenia to `${peerId}:${kind}`. Włączenie kamery zestawia nowe
połączenie — dokładnie tą ścieżką, która już działa.

Powody:

- Czarny ekran przy wzajemnym streamowaniu wziął się z niejednoznaczności
  w routingu połączeń (stąd pole `owner` w sygnale). Dokładanie tam renegocjacji
  to proszenie się o powtórkę.
- Strumienie są niezależne: awaria kamery nie rusza ekranu.

Koszt: więcej połączeń. Przy czterech osobach z ekranem i kamerą to 16 połączeń
na klienta. Chromium to udźwignie; przy większych grupach trzeba będzie wrócić do
wariantu z jednym połączeniem.

### Kamera bez mikrofonu

Głos jest w TeamSpeaku. Mikrofon w streamie odtworzyłby problem z echem, który
naprawiliśmy przy dźwięku z aplikacji.

### Kamera ma własne ustawienia

Osobna sekcja: urządzenie, rozdzielczość, FPS. Dziedziczenie ustawień ekranu
odrzucone — przy 1080p60 dla ekranu kamera też szłaby 1080p60, choć twarz tego
nie potrzebuje.

Wybór urządzenia jest konieczny: kamera wirtualna (OBS) albo druga kamerka to
częsty przypadek.

## Protokół sygnalizacji

`kind: 'screen' | 'camera'` dochodzi do wiadomości o nadawaniu.

```ts
type StreamKind = 'screen' | 'camera'

// klient -> serwer
| { type: 'start-stream'; kind?: StreamKind }
| { type: 'stop-stream'; kind?: StreamKind }

// serwer -> klient
| { type: 'stream-started'; peerId: string; kind: StreamKind }
| { type: 'stream-stopped'; peerId: string; kind: StreamKind }
```

### Zgodność ze starymi klientami — wymóg, nie życzenie

Serwer jest jeden i wspólny, a koledzy mają zainstalowaną starą wersję. Zmiana
protokołu nie może im urwać działania.

- `kind` jest **opcjonalne** i domyślnie `'screen'`. Stary klient wysyła
  `{ type: 'start-stream' }` i dalej udostępnia ekran.
- W `joined` zostaje dotychczasowe pole `streamers: string[]` (same `peerId`
  nadających **ekran**) i dochodzi nowe `streams: { peerId, kind }[]`. Stary
  klient czyta pierwsze i ignoruje drugie; nowy czyta drugie.
- `stream-started` / `stream-stopped` dostają dodatkowe pole `kind`. Stary
  klient ignoruje nieznane pola.

Skutek: stara wersja widzi ekrany i nie widzi kamer, zamiast przestać działać.

Serwer trzyma `streamers: Map<roomId, Set<'peerId:kind'>>` — zmienia się klucz,
nie logika.

## Zmiany w kliencie

### LobbySession

- `outgoing` / `incoming` (oraz bufory kandydatów ICE) kluczowane przez
  `${peerId}:${kind}`.
- `onRemoteStream(peerId, kind, stream)` — `stream === null` dalej znaczy koniec
  tego konkretnego strumienia.
- `onStreamersChange(streams: { peerId, kind }[])`.
- Pole `owner` w sygnale zostaje bez zmian i dalej rozstrzyga kierunek. Do
  payloadu dochodzi `kind`, żeby odbiorca wiedział, do którego połączenia
  należy sygnał.
- `hintContent` przyjmuje rodzaj: `detail` dla ekranu (chroni czytelność tekstu),
  `motion` dla kamery (twarz to ruch, nie drobny druk).

### Przechwytywanie

Nowy hook `useCamera(ustawienia)`:

```ts
navigator.mediaDevices.getUserMedia({
  video: { deviceId, width, height, frameRate },
  audio: false
})
```

Niezależny od `useCapture`. Lista urządzeń z `enumerateDevices()`; etykiety są
puste do czasu pierwszej zgody, więc listę odświeżamy po starcie kamery.

Błędy do obsłużenia wprost, bo są częste: brak kamery (`NotFoundError`), kamera
zajęta przez inną aplikację (`NotReadableError`), odmowa dostępu
(`NotAllowedError`). Komunikat ma mówić, co się stało — nie „nie udało się".

### Interfejs

- Kafelek na **strumień**, nie na osobę. Klucz listy to `peerId:kind`.
- Podpis: `Konrad` dla kamery, `Konrad — ekran` dla ekranu.
- Przycisk kamery obok przycisku udostępniania, z widocznym stanem włączenia.
- Sekcja „Kamera" w ustawieniach: urządzenie, rozdzielczość, FPS.
- Powiększanie kliknięciem działa dla obu rodzajów bez zmian.
- Własna kamera pokazuje się we własnej siatce jak dotąd własny ekran — łatwiej
  sprawdzić, co widzą inni. Jak każdy własny kafelek jest wyciszona.
- Dźwięk zostaje po stronie ekranu: zaznaczenie „udostępnij dźwięk" dalej dotyczy
  wybranego okna. Kamera nie ma i nie będzie miała ścieżki audio, więc jej
  kafelek nie pokazuje suwaka głośności.

## Testy

Jednostkowe (vitest), tam gdzie mieszka logika:

- `parseClientMessage` przyjmuje `start-stream` bez `kind` i nadaje `'screen'`.
- Serwer trzyma ekran i kamerę tej samej osoby jako dwa niezależne wpisy;
  zatrzymanie kamery nie usuwa ekranu.
- Rozłączenie peera sprząta oba jego strumienie.
- Klucz połączenia w `LobbySession` rozróżnia rodzaje.

E2E w lobby (dwie instancje, istniejący harness `e2e/cdp.mjs`):

- Instancja A włącza ekran i kamerę; B widzi **dwa** osobne strumienie.
- B wyłącza kamerę; ekran u A leci dalej — to jest ten regres, którego się boimy.

Testów komponentów Reacta w projekcie nie ma i ten spec ich nie wprowadza;
warstwa UI jest kryta typecheckiem i e2e.

## Świadomie poza zakresem

- **Kodowanie na GPU** (punkt 1 w `TODO.md`). Najpierw kamera, potem pomiar
  obciążenia przy dwóch strumieniach naraz — dopiero liczby powiedzą, czy warto
  wracać do zmiany kodeka. Bez pomiaru nie wiadomo, czy problem jest realny.
- Mikrofon w streamie.
- Wstawka kamery w rogu obrazu ekranu (Discord tego tak nie robi).
- Limit liczby jednoczesnych kamer.

## Ryzyka

- **Liczba połączeń** rośnie kwadratowo z liczbą osób. Przy grupie powyżej
  pięciu osób z włączonymi kamerami trzeba będzie przejść na jedno połączenie
  z wieloma ścieżkami.
- **Obciążenie kodera.** Kamera to drugi równoległy enkoder na tej samej
  maszynie. To jest dokładnie ten pomiar, który zamyka temat wydajności.
- **Rozjazd wersji.** Zgodność wstecz jest zaprojektowana, ale trzeba ją
  sprawdzić realnie: stary klient i nowy w jednym kanale.
