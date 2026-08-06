# TS3 Screen Share — Project Brief

## Cel projektu
Dodać do TeamSpeak 3 możliwość udostępniania ekranu (screen sharing) w jakości i z opcjami zbliżonymi do Discorda (wybór ekranu/okna, jakość, FPS), bez wymagania od użytkownika ręcznej instalacji/odpalania osobnej aplikacji za każdym razem. Klika "udostępnij ekran" w TS3 i wszystko dzieje się automatycznie.

## Kontekst decyzji (dlaczego taka architektura)
- TeamSpeak 3 nie ma natywnego screen sharingu (ma go dopiero TeamSpeak 6, ale to inny produkt).
- Istniejący plugin community `ts3video` (mfreiholz/ts3video) jest praktycznie martwy/nieutrzymywany, publiczny serwer relay nie działa niezawodnie, a self-hosted serwer (Qt/C++, build z 2019) nie startuje nawet po instalacji VC++ Redistributable — prawdopodobnie problem z samą binarką/zależnościami, zbyt kosztowne w naprawie.
- Deweloper (Konrad) koduje głównie w React/Next.js, nie w C++. Dlatego architektura celowo minimalizuje ilość kodu natywnego C/C++ do niezbędnego minimum (cienki plugin-shim), a cała "właściwa" aplikacja (capture, UI, kodowanie, transport) jest w Electron/React/TypeScript.
- TeamSpeak 3 Client Plugin SDK jest oficjalnie dostępny i utrzymywany: https://github.com/teamspeak/ts3client-pluginsdk (wymaga TS3 Client 3.6.0+).

## Architektura (ustalona)

```
┌─────────────────────┐
│   TeamSpeak 3        │
│   Client              │
│  ┌────────────────┐  │
│  │  Plugin (C)     │  │   <- cienka warstwa, głównie boilerplate z SDK
│  │  - menu item    │  │      "Udostępnij ekran" w kontekście kanału
│  │  - odczyt: ID    │  │
│  │    kanału, UID,  │  │
│  │    adres servera│  │
│  │  - uruchamia     │──┼──> spawnuje proces companion app
│  │    companion app │  │     (CreateProcess, headless/ukryty)
│  └────────────────┘  │
└─────────────────────┘
            │
            │ przekazanie kontekstu (channel id, uid, ts3 server addr)
            ▼
┌──────────────────────────┐        ┌──────────────────────────┐
│  Companion App (Electron)  │◄──────►│  Signaling Server (Node)  │
│  - desktopCapturer          │  WS    │  - WebSocket relay        │
│    (wybór ekranu/okna,      │        │  - łączy peery po ID      │
│    miniaturki jak w Discord)│        │    kanału TS3              │
│  - UI ustawień jakości       │        │  - lekki, tani VPS/Railway │
│    (rozdzielczość, FPS,      │        └──────────────────────────┘
│    bitrate)                  │
│  - WebRTC (getDisplayMedia   │◄──── P2P wideo (bezpośrednio) ────►  companion app widza
│    + RTCPeerConnection)      │        (fallback: TURN server jeśli P2P się nie uda)
│  - działa headless u          │
│    streamera / z oknem        │
│    podglądu u widza            │
└──────────────────────────┘
```

## Komponenty do zbudowania (w tej kolejności)

### 1. Signaling server (Node.js + WebSocket)
- Prosty serwer WS, pokojach = ID kanału TS3.
- Peer wysyła "join room <channelId>", serwer przekazuje SDP offer/answer i ICE candidates między peerami w tym samym pokoju.
- Zero logiki wideo — tylko przekazywanie wiadomości tekstowych (JSON).
- Docelowo hostowany centralnie przez nas (np. Railway/Render/mały VPS), adres wpisany na stałe w companion apce.
- Do MVP: brak persystencji, brak auth (do rozważenia później — np. token per serwer TS3).

### 2. Companion App (Electron + React + TypeScript)
- **Source picker**: `desktopCapturer.getSources({ types: ['screen', 'window'] })` — grid z miniaturkami, wybór konkretnego ekranu (przy wielu monitorach) lub konkretnego okna aplikacji.
- **Ustawienia jakości** (jak w Discordzie): rozdzielczość, FPS (30/60), bitrate (`RTCRtpSender.setParameters` → `maxBitrate`).
- **Capture**: `navigator.mediaDevices.getUserMedia` z `chromeMediaSource: 'desktop'` + wybranym `chromeMediaSourceId` ze source pickera.
- **WebRTC**: `RTCPeerConnection`, łączenie się przez signaling server, P2P transfer wideo.
- **Dwa tryby**:
  - Tryb **streamera**: uruchamiany headless/bez widocznego okna (poza ew. małym wskaźnikiem "udostępniasz ekran" / przyciskiem stop), przyjmuje argumenty startowe od pluginu (channel id, tryb=stream).
  - Tryb **widza**: uruchamiany z widocznym oknem pokazującym odbierany strumień wideo, przyjmuje argumenty (channel id, tryb=watch).
- Buduje się jako spakowana aplikacja (np. `electron-builder`), instalowana razem z pluginem (jeden installer).

### 3. TS3 Plugin (C, oparty na oficjalnym SDK)
- Bazuje na przykładowym `plugin.c` z `ts3client-pluginsdk`.
- Dodaje pozycję menu kontekstowego kanału: "Udostępnij ekran" i "Dołącz do udostępniania" (widoczne gdy ktoś w kanale streamuje).
- Odczytuje z Client API: aktualny `serverConnectionHandlerID`, ID kanału, własny UID/nick.
- Uruchamia companion app jako osobny proces (`CreateProcess` na Windows) z argumentami CLI przekazującymi kontekst + tryb (stream/watch).
- Opcjonalnie: prosty status (np. zmiana ikony w channel treeview u osób streamujących) — do rozważenia w kolejnej iteracji, nie MVP.

## Wymagania niefunkcjonalne / ustalenia
- Platforma docelowa: **Windows** (deweloper testuje na Windows, TS3 na Windows).
- Zero ręcznej instalacji/odpalania przez użytkownika końcowego — jeden installer (plugin + spakowana companion app), potem tylko klik w TS3.
- Jakość i FPS regulowane przez użytkownika w UI companion app (nie hardcoded).
- Serwer sygnalizacyjny i TURN — scentralizowane, utrzymywane przez twórcę (Konrada), nie przez użytkowników końcowych.

## Nie-cele na MVP (do pominięcia na start)
- Nagrywanie streamu.
- Wsparcie dla macOS/Linux (na start tylko Windows).
- Audio ze streamu (na start tylko obraz; TS3 i tak ma swój VoIP).
- Współdzielony ekran wielu streamerów jednocześnie w jednym kanale (na start: jeden streamer na kanał).
- Autoryzacja/limity dostępu do signaling servera.

## Stack techniczny (podsumowanie)
- **Plugin**: C, TeamSpeak 3 Client Plugin SDK (https://github.com/teamspeak/ts3client-pluginsdk)
- **Companion app**: Electron + React + TypeScript, `electron-builder` do pakowania
- **Signaling server**: Node.js + `ws` (WebSocket)
- **Transport wideo**: WebRTC (`RTCPeerConnection`, `getDisplayMedia`/`desktopCapturer`)
- **Fallback NAT traversal**: coturn (TURN server) — do dodania po walidacji podstawowego flow

## Sugerowana kolejność implementacji
1. Companion app: sam source picker + podgląd lokalnego capture (bez WebRTC, bez pluginu) — walidacja że capture + UI działa.
2. Signaling server: minimalny WS relay.
3. Companion app: połączenie dwóch instancji przez WebRTC + signaling server (uruchamiane ręcznie z CLI, dwa procesy na jednym komputerze/w sieci lokalnej) — walidacja end-to-end wideo.
4. Plugin C: szkielet z SDK, menu item, spawnowanie companion app z argumentami.
5. Integracja: plugin przekazuje prawdziwy kontekst (channel id z TS3) do companion app.
6. Polish: UI ustawień jakości, ikony statusu, obsługa wielu monitorów, error handling.
