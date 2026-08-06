# Companion App

Electron + React + TypeScript. Zakres: **kroki 1–3** z brief — wybór źródła
z miniaturkami, lokalny podgląd oraz przesyłanie obrazu przez WebRTC P2P
z sygnalizacją.

## Model: jedno okno, lobby

**Nie ma trybu widza ani trybu streamera.** Plugin odpala jedno okno na kanał TS3;
wchodzisz do lobby i od razu widzisz to, co ktoś udostępnia, a przycisk
„Udostępnij ekran" masz zawsze pod ręką. Rola nie jest przypisywana na starcie —
ten sam peer raz ogląda, raz nadaje, bez restartu aplikacji.

| Uruchomienie | Zachowanie |
| --- | --- |
| bez argumentów | tryb samodzielny: picker + lokalny podgląd, bez sieci |
| `--ts3-server` + `--channel` | lobby kanału |
| `--nick` (opcjonalnie) | nazwa na liście uczestników; bez niej serwer nada `Użytkownik N` |

Podanie tylko jednego z nich to **błąd**, a nie cichy powrót do trybu
samodzielnego: inaczej plugin odpalałby okno, które donikąd się nie łączy, bez
śladu dlaczego. Z tych dwóch wartości liczony jest `roomId`
(patrz [`src/shared/room.ts`](src/shared/room.ts)).

Wybór źródła to osobny ekran, pokazywany dopiero po kliknięciu „Udostępnij
ekran" — lobby zostaje czyste, bo domyślnie się ogląda, a nie wybiera.

### Panel uczestników
Po prawej lista osób w kanale, z ikoną przy tym, kto aktualnie nadaje. Da się go
zwinąć do wąskiego paska z licznikiem — obraz bywa ważniejszy niż lista, ale
panel nie powinien znikać bez śladu.

Nazwy biorą się z `--nick` (docelowo poda go plugin z TS3). Gdy go brak, **serwer**
nadaje zastępnik `Użytkownik N`. Numeruje serwer, a nie klient, bo inaczej każdy
widziałby inną listę — a tak wszyscy widzą te same nazwy.

## Jak wejść do lobby (ręcznie)

Wszystko poniżej wymaga wcześniejszego `npm run build`.

**Terminal 1** — serwer sygnalizacyjny (bez niego lobby nie wstanie):
```bash
cd ../signaling-server && npm start
```

**Terminal 2** — pierwsze okno:
```bash
npm run lobby
```

**Terminal 3** — drugie okno:
```bash
npm run lobby:2
```

Chcesz rozróżnialne nazwy w teście? Dodaj `--nick`:
```bash
npx electron . --user-data-dir=.tmp/profil-3 --ts3-server=ts.test.pl:9987 --channel=42 --signaling=ws://127.0.0.1:8080 --nick=Konrad
```

Oba trafiają do tego samego pokoju, bo mają ten sam `--ts3-server` i `--channel`
(`ts.test.pl:9987`, kanał `42`) — to z nich liczony jest `roomId`. Osobne skrypty
istnieją tylko po to, żeby każda instancja dostała **własny katalog profilu**
(`.tmp/profil-1` i `.tmp/profil-2`). Bez tego dwa Electrony biją się o ten sam
katalog danych i sypią błędami `Unable to move the cache`.

Co powinieneś zobaczyć: oba okna piszą „Nikt nie udostępnia ekranu" i mają
aktywny przycisk **Udostępnij ekran**. Kliknij go w jednym, wybierz ekran,
potwierdź — drugie okno od razu pokaże obraz, a jego przycisk zgaśnie
z podpowiedzią, że ktoś już udostępnia.

Chcesz inny kanał albo prawdziwy serwer sygnalizacyjny? Odpal bezpośrednio:
```bash
npx electron . --user-data-dir=.tmp/profil-3 --ts3-server=moj.serwer.pl:9987 --channel=7
```
Bez `--signaling` użyty zostanie adres domyślny z `src/shared/cli.ts`.

## Testy end-to-end

**Uwaga: sam otwiera i zamyka okna** (trzy) i sam nimi steruje, więc nie klikaj
w nie w trakcie. Wymaga działającego serwera sygnalizacyjnego:

```bash
npm run e2e
```

Sprawdza pełny scenariusz lobby: dwa równorzędne okna, rozpoczęcie nadawania,
blokadę przycisku u pozostałych, dołączenie trzeciego okna w trakcie transmisji,
zakończenie i powrót wszystkich do lobby, a na końcu **przejęcie nadawania przez
inne okno**.

Diagnostyka płynności — FPS, bitrate, kodek i powód ograniczenia po obu stronach:
```bash
npm run e2e:fps
```

## Uruchomienie
```bash
npm install
```
```bash
npm run dev
```

Inne skrypty: `npm run build` (typecheck + bundle do `out/`), `npm run typecheck`,
`npm start` (podgląd zbudowanej wersji).

## Jak to działa
- `src/main/index.ts` — okno + IPC `sources:get`, jedyne miejsce z `desktopCapturer`.
  Miniaturki idą do renderera jako PNG data URL (NativeImage nie przechodzi przez IPC).
- `src/preload/index.ts` — `contextBridge` wystawia `window.companion.getSources()`.
  `contextIsolation: true`, `nodeIntegration: false`.
- `src/renderer/hooks/useCapture.ts` — `getUserMedia` z `chromeMediaSource: 'desktop'`
  i wybranym `chromeMediaSourceId`. Zmiana źródła lub jakości restartuje stream,
  stare tracki są zawsze zatrzymywane.
- `src/shared/` — typy i nazwy kanałów IPC wspólne dla wszystkich trzech warstw.

## Które okna trafiają do gridu
Okna bez miniaturki są odfiltrowane. To nakładki (np. `RzMonitorForegroundWindow`
od Razera) i okna chronione przed Windows Graphics Capture. Sprawdzone probe'em:
dla takiego źródła `getUserMedia` **rozwiązuje się poprawnie**, a ścieżka wideo gaśnie
dopiero chwilę później — nie ma czego udostępniać, więc nie ma po co ich pokazywać.
Ekrany zostają zawsze.

Ekrany są podpisane nazwą monitora z systemu (`display.label`), np.
`Ekran 1 — Odyssey G81SF (główny)`. Bez rozdzielczości, i to celowo: `display.size`
jest w DIP-ach, więc przy skalowaniu Windows 175% monitor 3840×2160 raportuje
2195×1235 (`ceil(3840/1.75)`). Tego zaokrąglenia nie da się cofnąć — `size × scaleFactor`
daje 3841×2161, `dipToScreenRect` 3842×2162, a przewymiarowana miniaturka jest
upscalowana. Prawdziwą rozdzielczość widać w badge'u nagłówka podglądu, bo tam
pochodzi z aktywnej ścieżki wideo. Nazwa monitora rozróżnia ekrany i tak lepiej —
dwa monitory 4K miałyby identyczną rozdzielczość.

Miniaturki są pobierane w budżecie kwadratowym (640×640) i kodowane do JPEG.
Kwadrat, bo Electron skaluje z zachowaniem proporcji — przy 320×180 pionowy monitor
dostawał 101 px szerokości i nie dało się nim wypełnić kafelka. JPEG, bo cały komplet
miniaturek waży wtedy ~490 KB zamiast ~1,3 MB w PNG.

## Ustawienia
- **Rozdzielczość**: 720p / 1080p / 1440p / natywna źródła.
- **FPS**: 30 / 60.
- **Bitrate**: 2,5 / 5 / 8 / 15 / 25 Mb/s (domyślnie 8). Idzie do
  `RTCRtpSender.setParameters()` → `maxBitrate`, działa też w trakcie nadawania.

### Dlaczego bitrate jest ważniejszy niż się wydaje
WebRTC bez jawnego `maxBitrate` trzyma się **2500 kbps**. Zmierzone przy 1080p60
(`npm run e2e:fps`): klatki szły poprawnie — 58 fps wysyłane, 57 odbierane, zero
zgubionych — ale obraz rozmywał się i blokował na ruchu. To wygląda jak
klatkowanie, choć nim nie jest.

### Płynność: co zmierzono
| Ustawienie | Wynik |
| --- | --- |
| domyślne WebRTC (2,5 Mb/s) | 1080p, 58 fps, ale mocna kompresja |
| `maintain-framerate` + hint `motion` | 60 fps, ale obraz zbity do **480×270** |
| `maintain-resolution` + hint `detail` (wybrane) | 1080p, 40–55 fps, bitrate do limitu |

Sufit płynności stawia koder: Chromium negocjuje **VP8 kodowany programowo**
(`libvpx`), co przy 1080p zjada CPU. Wymuszanie H.264 przez `setCodecPreferences`
zostało sprawdzone i **nie działa** — ten build Electrona nie ma enkodera H.264,
negocjacja i tak wraca do VP8 (potwierdzone w statystykach: `kodek: video/VP8`).

Praktycznie: jeśli zależy Ci na płynności bardziej niż na ostrości, zejdź na
720p — wtedy koder programowy spokojnie wyrabia 60 fps.

Badge w nagłówku podglądu pokazuje realnie wynegocjowane wymiary i FPS ścieżki wideo,
więc widać czy constrainty faktycznie zadziałały.

## WebRTC

Jedna klasa `LobbySession` obsługuje oba kierunki, bo w lobby rola nie jest
przypisana. Kierunek negocjacji: **inicjuje nadający**. O pozostałych dowiaduje
się z listy `peers` w odpowiedzi na `join` oraz ze zdarzeń `peer-joined`, więc
kolejność dołączania nie ma znaczenia.

Dołączający dostaje `streamerId` już w odpowiedzi na `join` — inaczej musiałby
czekać na `stream-started`, które dawno przeszło, i wszedłby do pustego lobby
mimo trwającej transmisji.

Kandydaci ICE potrafią dotrzeć zanim ustawimy zdalny opis sesji, więc są
kolejkowane (`CandidateBuffer` w [`webrtc/session.ts`](src/renderer/webrtc/session.ts))
i dosypywane po `setRemoteDescription`.

Jeden streamer obsługuje wielu widzów — po jednym `RTCPeerConnection` na widza.
Na razie tylko STUN; TURN dojdzie osobno i to on będzie kosztować pasmo.

## Testy

```bash
npm test
```

27 testów jednostkowych: wyliczanie `roomId`, parsowanie argumentów CLI oraz
klient sygnalizacji. Ten ostatni gada z **prawdziwym serwerem** z sąsiedniego
pakietu — celowo. Protokół jest opisany po obu stronach osobno (nie ma wspólnego
workspace'a, a companion-app nie może importować kodu serwera w produkcji), więc
to jedyna rzecz, która wyłapie ich rozjechanie się.

WebRTC nie da się sensownie testować w Node, więc pokrywa je `e2e/lobby.mjs`.

Zmiana rozdzielczości albo FPS w trakcie nadawania podmienia ścieżkę przez
`RTCRtpSender.replaceTrack` (bez renegocjacji). Wcześniej kończyła transmisję,
bo `useCapture` na moment ustawia strumień na `null` przy restarcie capture,
a kod sprzątający brał to za koniec źródła.

## Czego tu jeszcze nie ma
Integracja z pluginem (krok 4–5), TURN, pakowanie instalatora.
`electron-builder.yml` to placeholder. Bitrate w ustawieniach nadal nieaktywny —
dojdzie razem z `RTCRtpSender.setParameters`.
