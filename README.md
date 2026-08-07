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
| [`audio-native/`](audio-native/) | Moduł N-API: dźwięk z **jednej** aplikacji (Windows Process Loopback) | **Gotowy** — dźwięk wybranego okna idzie w stream (11 testów + e2e przez WebRTC) |

## Stan
Wszystkie kroki z brief zrealizowane. Pełny przepływ działa: klik w menu kanału TS3
→ wtyczka odpala companion app z kontekstem → lobby łączy się z serwerem
sygnalizacyjnym → obraz leci P2P przez WebRTC.

Do rozdania wystarczy jeden plik: `companion-app/release/TS3-Screen-Share-Setup-*.exe`.

Od wersji 0.2.0 aplikacja aktualizuje się sama: przy starcie sprawdza wydania
na GitHubie, pobiera nowe w tle i instaluje po zamknięciu okna. Wtyczka TS3
wchodzi razem z nią, ale dopiero przy następnym uruchomieniu TeamSpeaka —
załadowanego DLL nie da się podmienić w locie.

Nowe wydanie: podbij `version` w `companion-app/package.json`, potem
`npm run release` w `companion-app`. Powstaje **szkic** wydania na GitHubie;
sprawdź, że są w nim `.exe` **oraz `latest.yml`**, i opublikuj ręcznie. Do czasu
publikacji nikt aktualizacji nie dostanie.

Wersję 0.1.0 trzeba raz zainstalować ręcznie — stara aplikacja nie ma skąd
wiedzieć o nowej.

Czego świadomie nie ma:
- **TURN** — bez niego połączenie nie wstanie u osób za symetrycznym NAT-em.
  Warto najpierw sprawdzić na realnych użytkownikach, czy problem w ogóle występuje.
- **podpis kodu** — SmartScreen pokaże ostrzeżenie przy instalacji.
- **dźwięk przy udostępnianiu ekranu** — ekran nie należy do żadnego procesu,
  więc idzie tam cały miks systemowy i rozmówca słyszy sam siebie. Przy
  udostępnianiu **okna** dźwięk jest już brany tylko z tej jednej aplikacji
  ([`audio-native/`](audio-native/)).

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
