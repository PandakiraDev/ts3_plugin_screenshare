# TS3 Screen Share

Dodanie screen sharingu (jakość/opcje jak w Discordzie) do TeamSpeak 3 bez ręcznego
odpalania osobnej aplikacji. Pełny kontekst i architektura: [ts3-screenshare-brief.md](ts3-screenshare-brief.md).

Rzeczy odłożone i dlaczego: [TODO.md](TODO.md).

## Wymagania
- **TeamSpeak 3.6.x** — starsze klienty odrzucają wtyczkę (patrz [plugin/README.md](plugin/README.md))
- Windows 64-bit

## Komponenty

| Folder | Co to | Status |
| --- | --- | --- |
| [`companion-app/`](companion-app/) | Electron + React + TS: lobby, source picker, capture, WebRTC | **Kroki 1–3 gotowe** (31 testów + e2e) |
| [`signaling-server/`](signaling-server/) | Node.js + WebSocket relay (pokoje = ID kanału TS3) | **Gotowy** — model lobby, nazwy uczestników (50 testów) |
| [`plugin/`](plugin/) | TS3 Client Plugin (C) — menu "Udostępnij ekran", spawn companion app | **Gotowy** — ładuje się w kliencie, odpala lobby |

## Stan
Wszystkie kroki z brief zrealizowane. Pełny przepływ działa: klik w menu kanału TS3
→ wtyczka odpala companion app z kontekstem → lobby łączy się z serwerem
sygnalizacyjnym → obraz leci P2P przez WebRTC.

Do rozdania wystarczy jeden plik: `companion-app/release/TS3-Screen-Share-Setup-*.exe`.

Czego świadomie nie ma:
- **TURN** — bez niego połączenie nie wstanie u osób za symetrycznym NAT-em.
  Warto najpierw sprawdzić na realnych użytkownikach, czy problem w ogóle występuje.
- **podpis kodu** — SmartScreen pokaże ostrzeżenie przy instalacji.
- **wielu nadających naraz** — MVP ogranicza do jednego na kanał; zdjęcie limitu
  to usunięcie jednego bloku w `signaling-server/src/server.ts`.

Sprawdzenie całości (wymaga zbudowanych obu pakietów):
```bash
cd signaling-server && npm start
```
```bash
cd companion-app && npm run e2e
```

## Szybki start (companion-app)
```bash
cd companion-app
npm install
npm run dev
```
Wymaga Node.js 18+.
