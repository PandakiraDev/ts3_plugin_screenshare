# Signaling Server

Minimalny WebSocket relay: **pokój = kanał TS3**. Serwer nie wie nic o WebRTC —
przekazuje wiadomości między peerami w tym samym pokoju i pilnuje, kto nadaje.

Model jest „lobby": peer **nie ma przypisanej roli**. Wchodzi do pokoju jako
równy pozostałym, a nadawanie to osobne, odwoływalne zgłoszenie. Dzięki temu
każdy może zacząć udostępniać bez restartu aplikacji, a koniec transmisji jest
zwykłym stanem pokoju, nie błędem po stronie oglądających.

## Uruchomienie
```bash
npm install
```
```bash
npm run dev
```

Inne skrypty: `npm test` (vitest), `npm run build` (do `dist/`), `npm start`
(zbudowana wersja), `npm run typecheck`.

Port: `PORT` z ENV, domyślnie **8080**. Pusty lub niepoprawny `PORT` nie wywala
startu — serwer wraca do domyślnego (hostingi potrafią wstrzyknąć pusty string).

Zajęty port kończy się jedną linijką i kodem wyjścia 1, bez stack trace'u:

```
Port 8080 jest zajęty — prawdopodobnie serwer sygnalizacyjny już działa.
Zamknij tamten proces albo ustaw inny port zmienną PORT.
```

Znalezienie i ubicie zaległego procesu (Windows, PowerShell):

```powershell
Get-NetTCPConnection -State Listen -LocalPort 8080 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

## Protokół

Wszystko to JSON po WebSocket. `payload` w `signal` jest dla serwera
**nieprzezroczysty** — trafia tam SDP offer/answer i ICE candidates, ale serwer
ich nie parsuje. Dzięki temu krok 3 (WebRTC) nie wymaga ruszania serwera.

### Klient → serwer

| Wiadomość | Znaczenie |
| --- | --- |
| `{ type: 'join', roomId, displayName? }` | Wejście do pokoju. `displayName` = nick z TS3 |
| `{ type: 'start-stream' }` | Zgłoszenie nadawania; odmowa, gdy ktoś już nadaje |
| `{ type: 'stop-stream' }` | Koniec nadawania; tylko nadający |
| `{ type: 'signal', to, payload }` | Przekaż `payload` do peera `to` w moim pokoju |

### Serwer → klient

| Wiadomość | Kiedy |
| --- | --- |
| `{ type: 'joined', peerId, displayName, peers, streamerId }` | Odpowiedź na `join`. `peers` to `{peerId, displayName}[]`, `streamerId` = kto nadaje (albo `null`) |
| `{ type: 'peer-joined', peerId, displayName }` | Ktoś dołączył do mojego pokoju |
| `{ type: 'peer-left', peerId }` | Ktoś się rozłączył |
| `{ type: 'stream-started', peerId }` | Ktoś zaczął nadawać. Dla zgłaszającego to potwierdzenie |
| `{ type: 'stream-stopped', peerId }` | Nadawanie się skończyło (albo nadający się rozłączył) |
| `{ type: 'signal', from, payload }` | Sygnał od peera `from` |
| `{ type: 'error', message }` | Coś było nie tak; połączenie zostaje otwarte |

`streamerId` w odpowiedzi na `join` jest kluczowy: bez niego dołączający w
trakcie transmisji czekałby na `stream-started`, które dawno przeszło, i wszedłby
do pustego lobby mimo trwającego streamu.

`peerId` to UUID nadawany przez serwer przy `join`.

### Nazwy uczestników
`displayName` jest opcjonalny. Gdy go brak (albo jest pusty), **serwer** nadaje
`Użytkownik N` — kolejny numer w obrębie pokoju. Numeruje serwer, a nie klient,
bo inaczej każdy widziałby inną listę uczestników. Licznik celowo nie maleje przy
wyjściu, żeby dwie osoby nie dostały tego samego numeru. Zbyt długi nick jest
przycinany do 64 znaków, a nie odrzucany — lepiej wpuścić do kanału.

### `roomId` — dlaczego skrót, nie ID kanału

`roomId` to **SHA-256 (64 znaki hex, małe litery)** liczony po stronie klienta
z adresu serwera TS3 i ID kanału — patrz `deriveRoomId` w
[companion-app](../companion-app/src/shared/room.ts). Serwer wymusza ten format
i odrzuca wszystko inne.

Powód: ID kanału TS3 to mała liczba (`1`, `42`). Serwer jest publiczny i wspólny
dla wszystkich użytkowników, więc gdyby przyjmował surowe ID, ktokolwiek mógłby
przelecieć numery od 1 w górę i trafić na cudzy udostępniany ekran. Po zahaszowaniu
z adresem serwera trzeba znać konkretny serwer TS3, żeby wyliczyć klucz.

Wymuszanie formatu chroni też przed naszym własnym błędem — klient, który zapomni
zahaszować, dostanie błąd zamiast po cichu otworzyć zgadywalny pokój.

To **nie jest autoryzacja**: kto zna adres serwera i numer kanału, ten wejdzie.
Odcina enumerację, nie podsłuch przez kogoś z tego samego serwera TS3. Właściwy
auth (token per serwer TS3) zostaje na później, zgodnie z brief.

Serwer nigdy nie poznaje adresu serwera TS3 ani numeru kanału — dostaje wyłącznie
gotowy klucz.

### Zasady

- Pokój jest granicą widoczności. Sygnał do peera z innego pokoju dostaje ten sam
  błąd co peer nieistniejący — nie zdradzamy, że taki peer w ogóle jest.
- Sygnał idzie **tylko** do adresata, nigdy rozgłoszeniowo.
- **Jeden nadający na pokój** (MVP). Drugi `start-stream` dostaje `error`
  z komunikatem, ale **zostaje w pokoju i dalej ogląda** — to nie wyrzuca go
  z lobby. Egzekwowane na serwerze, nie w UI, bo dwie osoby mogą kliknąć
  „udostępnij" w tej samej chwili. Wielu naraz = usunięcie tego jednego bloku
  w `server.ts`.
- `stop-stream` od kogoś, kto nie nadaje, jest odrzucane — inaczej dowolny widz
  mógłby zrzucić cudzą transmisję.
- Rozłączenie nadającego zwalnia miejsce. Bez tego zamknięcie okna blokowałoby
  kanał na zawsze.
- Liczba oglądających nie jest limitowana.
- Żadna zła ramka nie zrywa połączenia ani nie wywraca serwera — zawsze wraca `error`.
- Brak persystencji i brak auth (świadomie, zgodnie z brief).

## Testy

50 testów, pisane test-first (`test/`). Używają prawdziwego serwera na porcie
efemerycznym i prawdziwych klientów WebSocket — bez mocków.

```bash
npm test
```

Pokrycie zachowań: dołączanie, lista peerów i `streamerId` przy wejściu, izolacja
pokojów, zgłaszanie i zwalnianie nadawania (także przez rozłączenie), przejęcie
nadawania przez kogoś innego, przekazywanie sygnałów bez wycieku do pozostałych,
rozłączenia, walidacja wejścia (zły JSON, złe typy, brakujące pola, `null`,
tablica) oraz format `roomId`.

## Czego tu nie ma
TURN/coturn dojdzie osobno — i to tam,
a nie w sygnalizacji, pojawi się realny koszt pasma.
