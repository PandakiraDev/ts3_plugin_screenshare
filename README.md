# TS3 Screen Share

Dodanie screen sharingu (jakość/opcje jak w Discordzie) do TeamSpeak 3 bez ręcznego
odpalania osobnej aplikacji. Pełny kontekst i architektura: [ts3-screenshare-brief.md](ts3-screenshare-brief.md).

## Komponenty

| Folder | Co to | Status |
| --- | --- | --- |
| [`companion-app/`](companion-app/) | Electron + React + TS: lobby, source picker, capture, WebRTC | **Kroki 1–3 gotowe** (31 testów + e2e) |
| [`signaling-server/`](signaling-server/) | Node.js + WebSocket relay (pokoje = ID kanału TS3) | **Gotowy** — model lobby, nazwy uczestników (50 testów) |
| [`plugin/`](plugin/) | TS3 Client Plugin (C) — menu "Udostępnij ekran", spawn companion app | **Krok 4: buduje się** (x64, 12 eksportów); niesprawdzony w kliencie |

## Kolejność implementacji
Patrz sekcja "Sugerowana kolejność implementacji" w brief. Zrealizowane **kroki 1–3**:
wideo leci end-to-end przez WebRTC P2P między dwiema instancjami companion app.
Następny: krok 4 — szkielet pluginu C, menu w TS3 i spawnowanie companion app.

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
