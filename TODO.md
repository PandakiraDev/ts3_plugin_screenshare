# TODO

Rzeczy odłożone świadomie, z ustaleniami potrzebnymi do podjęcia tematu.

---

## 1. Kodowanie na GPU (AV1/VP9) — niedokończone śledztwo

**Problem:** obraz koduje programowy VP8 (`libvpx`), co zjada CPU.

> **Uwaga — zdanie poniżej było nieaktualne.** Pierwotnie stało tu „przy 1080p60
> daje to 40–55 fps zamiast 60". Pomiar z 2026-08-07 (patrz ZMIERZONE niżej)
> pokazał **57 kl/s** przy `qualityLimitationReason: none`, i to przy
> jednoczesnym nadawaniu ekranu i kamery. Skąd pochodziła stara obserwacja —
> inny sprzęt czy stan sprzed wprowadzenia jawnego `maxBitrate` — nie
> sprawdziliśmy. Nie traktować „40–55 fps" jako faktu.

**Co już wiadomo:**

- GPU jest sprawne: `app.getGPUFeatureStatus()` → `video_encode = enabled`,
  RTX 4070 przez D3D11. (Uwaga: bez otwartego okna ten odczyt kłamie i pokazuje
  `disabled_software` — trzeba mierzyć z `BrowserWindow`.)
- **H.264 odpada.** `setCodecPreferences` z listy `RTCRtpSender.getCapabilities`
  rzuca `InvalidModificationError: invalid codec with name "H264"`. Electron
  potrafi H.264 dekodować, ale nie kodować.
- **Lista odbiorcza działa.** `RTCRtpReceiver.getCapabilities('video')` przechodzi
  przez `setCodecPreferences` bez wyjątku — to jest właściwa droga.
- W pętli lokalnej (dwa `RTCPeerConnection` w jednym oknie) **AV1 i VP9 negocjują
  się poprawnie** i trzymają 1920×1080 przy ~58–60 fps.

**Czego NIE wiadomo:**

- Czy AV1/VP9 trafiają na koder sprzętowy. Pętla lokalna nie wypełnia
  `encoderImplementation`, więc odpowiedzi tam nie ma.
- Dlaczego preferencja kodeka **nie zadziałała w spakowanej aplikacji** — mimo
  ustawienia AV1/VP9 nadal negocjowało się VP8 z `libvpx`. Kod eksperymentalny
  został wycofany.

**Od czego zacząć:** sprawdzić, czy funkcja ustawiająca preferencje w ogóle się
wykonuje w zbudowanej wersji (log do konsoli renderera + `read_console_messages`).
Dopiero potem mierzyć `encoderImplementation` przez `npm run e2e:fps`.

**Nagroda:** RTX 4070 ma sprzętowy koder AV1. Jeśli Chromium go użyje, obciążenie
CPU spada bez straty jakości.

**ZMIERZONE (zadanie 9) — obciążenie przy ekranie i kamerze naraz.** To była
jedyna odłożona niewiadoma, od której zależało, czy w ogóle wracać do tematu:
czy VP8/libvpx jest *realnym* wąskim gardłem, czy tylko podejrzeniem bez dowodu.

*Metoda* (skrypt `companion-app/e2e/obciazenie.mjs`, `npm run e2e:obciazenie`
w `companion-app`): jeden nadawca (A, ekran + kamera) i jeden odbiorca (B) w
tym samym kanale — odbiorca jest konieczny, bo `LobbySession.callPeer`
(`session.ts`) zaczyna kodować dopiero, gdy ma komu wysłać ofertę. Kamera
fizyczna niepotrzebna: `--use-fake-device-for-media-stream` (Uwaga: atrapa
oddaje ~20 kl/s niezależnie od żądanego FPS — to pułap ŹRÓDŁA, nie kodera;
`framesPerSecond` kamery w wynikach poniżej NIE świadczy o wydajności kodera).
Ekran i kamera to dwa niezależne `RTCPeerConnection` (`connectionKey`) —
rozróżnione po `track.contentHint` (`'detail'` = ekran, `'motion'` = kamera;
ustawiane w `hintContent()`), NIE po rozdzielczości, bo w wariancie 2 obie
ścieżki mają 1920×1080. Po 20 s rozbiegu, w oknie 20 s: `getStats()` na
połączeniach nadawcy (`encoderImplementation`, `framesPerSecond`,
`qualityLimitationReason`) oraz CPU przez PowerShell —
`Get-Process -Id <drzewo PID>` zsumowane po `.CPU` (sekundy procesora od
startu procesu), DELTA na końcach okna / długość okna = "rdzenie-równoważnik"
(1.0 = jeden wątek zajęty w 100% przez całe okno). Drzewo PID-ów to
rekurencja po `ParentProcessId` (WMI) zaczynająca się od PID-u głównego
procesu KONKRETNEJ instancji (`a.pid`/`b.pid` ze `spawn()`) — stąd CPU
nadawcy i odbiorcy policzone OSOBNO, nie jako jedna zlepiona liczba za całą
maszynę. Maszyna testowa: RTX 4070, 32 wątki logiczne — pułap CPU tej maszyny
jest wysoki, więc liczby bezwzględne poniżej NIE przekładają się wprost na
słabszy sprzęt użytkownika (patrz "czego nie zmierzono").

| | Wariant 1: kamera 720p30 | Wariant 2: kamera 1080p60 |
|---|---|---|
| Ekran — `encoderImplementation` | `libvpx` | `libvpx` |
| Ekran — `framesPerSecond` | 57 | 57 |
| Ekran — `qualityLimitationReason` | `none` | `none` |
| Ekran — rozmiar / bitrate docelowy | 1920×1080 / ~4,6 Mb/s | 1920×1080 / ~5,5 Mb/s |
| Kamera — `encoderImplementation` | `libvpx` | `libvpx` |
| Kamera — `framesPerSecond`* | 20 | 20 |
| Kamera — `qualityLimitationReason` | `none` (po rozbiegu) | `bandwidth` przy 20s rozbiegu → `none` przy ~41s |
| Kamera — rozmiar / bitrate docelowy | 1280×720 / 2,5 Mb/s (sufit) | 1920×1080 / 2,5 Mb/s (sufit) — **po dłuższym rozbiegu** |
| CPU NADAWCY (rdzenie-równoważnik) | **0,90** (18,98 s CPU / 21,1 s okna) | **1,38** (29,27 s CPU / 21,2 s okna) |
| CPU ODBIORCY (rdzenie-równoważnik) | 0,16 | 0,04 (odbiorca zmierzony tylko dla kontekstu, jednorazowo — duży rozrzut między przebiegami, patrz niżej) |

*\*fps kamery ograniczone przez atrapę urządzenia (~20 kl/s), nie przez koder — patrz wyżej.*

**Co to potwierdza:**

- **Obie ścieżki nadawcze kodują programowo** (`libvpx`) jednocześnie —
  odpowiedź na pytanie z tego zadania jest jednoznaczna: tak, VP8 idzie
  programowo na obu strumieniach naraz, nie ma tu żadnego sprzętowego
  przyspieszenia.
- **Koszt CPU jest realny i mierzalny**: ~0,9 rdzenia dla kamery 720p30,
  ~1,4 rdzenia dla kamery 1080p60 (+~53% za samo podniesienie rozdzielczości
  kamery, przy niezmienionym ekranie). To NIE jest szum pomiarowy — różnica
  powtarza się w oczekiwanym kierunku (więcej pikseli do zakodowania = więcej
  CPU) i jest dużo większa niż typowy rozrzut między próbkami.
  Na maszynie testowej (32 wątki) to wciąż mały ułamek całkowitej mocy —
  ale samo "programowy VP8 kosztuje ~1-1,5 wątku" to twardy fakt, nie domysł.
- **Ekran nie traci FPS od dołożenia kamery**: 57 kl/s w OBU wariantach,
  `qualityLimitationReason: none` — na tej maszynie drugi strumień nie
  odbija się na płynności pierwszego. To NIE potwierdza starej obserwacji z
  góry tej sekcji ("40–55 fps zamiast 60") — możliwe, że pochodziła sprzed
  wprowadzenia jawnego `maxBitrate`/`degradationPreference` w `session.ts`,
  albo z innego sprzętu; nie sprawdzaliśmy, która to przyczyna.
- **Sufit `CAMERA_BITRATE_KBPS` przy 1080p60 rzeczywiście dusi rozdzielczość
  na starcie** — dokładnie to, co zgłosił recenzent. Przy 20 s rozbiegu
  kamera siedziała jeszcze na 1280×720 z `qualityLimitationReason: bandwidth`,
  mimo żądanych 1920×1080; dopiero koło 41 s doszła do pełnej rozdzielczości
  i `qualityLimitationReason` spadło do `none`. Efekt jest więc PRZEJŚCIOWY
  (dłuższy rozbieg niż przy 720p, nie trwałe zablokowanie), ale realny —
  i nie dotyka ekranu, bo to niezależne połączenie z niezależnym bitrate.

**Czego NIE zmierzono (nie zgadujemy, więc wprost):**

- **Słabszego sprzętu.** Cały pomiar to jedna maszyna dev (RTX 4070,
  32 wątki logiczne). "0,9–1,4 rdzenia" na tej maszynie to promil mocy; na
  2–4-rdzeniowym laptopie użytkownika końcowego byłby to duży ułamek —
  i TEGO w ogóle nie sprawdziliśmy. To jedyna naprawdę otwarta niewiadoma po
  tym zadaniu.
- **Realnej kamery fizycznej.** Atrapa (`--use-fake-device-for-media-stream`)
  ogranicza kamerę do ~20 kl/s niezależnie od ustawień, więc `framesPerSecond`
  kamery w tabeli wyżej NIE mówi nic o tym, jak zachowałby się koder przy
  prawdziwym źródle 30/60 kl/s. `encoderImplementation` i CPU kodowania per
  klatka powinny być takie same (koder nie wie, skąd klatka przyszła), ale to
  założenie, nie pomiar.
- **Powtarzalności.** Każdy wariant zmierzony JEDNORAZOWO (jeden przebieg
  20 s rozbiegu + 20 s okna). CPU odbiorcy różniło się między wariantami
  (0,16 vs 0,04) w sposób, który wygląda na szum międzyprzebiegowy, nie
  efekt ustawień — nie ma tu przedziału ufności, więc traktować liczby
  odbiorcy jako orientacyjne, nie rozstrzygające.
- **Realnego odczytu z Menedżera Zadań.** Zamiast klikania użyto
  `Get-Process`/WMI (uzasadnienie metody wyżej) — liczby to sekundy CPU per
  proces, nie procent z paska w Menedżerze Zadań, więc nie da się ich wprost
  porównać z tym, co pokazałby GUI.

**WERDYKT:** na sprzęcie testowym VP8/libvpx NIE jest wąskim gardłem w sensie
widocznej straty jakości — ekran trzyma 57 kl/s i `qualityLimitationReason:
none` niezależnie od tego, co robi kamera. Koszt CPU jest realny (~1–1,5
rdzenia) i rośnie z rozdzielczością kamery, ale na tej maszynie to margines,
nie problem. **Nie ma tu uzasadnienia, żeby WRACAĆ do tematu kodowania GPU
jako pilnego** — dotychczasowe dane (na tym sprzęcie) nie pokazują realnego
cierpienia jakości ani duszenia się CPU. Jedyny scenariusz, w którym temat
wracałby: zgłoszenia od użytkowników na słabszym sprzęcie o niskim FPS albo
wysokim zużyciu CPU przy jednoczesnym ekranie i kamerze — a tego świadomie
nie sprawdziliśmy (patrz wyżej). Do tego czasu temat zamknięty jako
zdiagnozowany, ale niepriorytetowy.

---

## 2. Dźwięk z wybranej aplikacji (jak w Discordzie)

**Czego chcemy:** wybierasz okno, leci dźwięk **tylko z tej aplikacji** — nie
cały miks systemowy. Dziś przy `audio: 'loopback'` do streamu trafia wszystko,
łącznie z TeamSpeakiem, więc rozmówca słyszy sam siebie.

**Dlaczego nie da się tego dzisiaj:** Electron i Chromium udostępniają wyłącznie
`loopback` — miks całego systemu. Nie ma API na pojedynczy proces.

**Jak to jest możliwe:** Windows 10 2004+ ma **Process Loopback API**
(`ActivateAudioInterfaceAsync` z `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`),
pozwalające przechwycić dźwięk konkretnego drzewa procesów bez sterownika
jądrowego. Discord robi to własnym modułem natywnym.

**Co trzeba zbudować:**

1. ~~Natywny dodatek Node (C++/N-API) z WASAPI process loopback — przyjmuje PID,
   zwraca strumień PCM.~~ **ZROBIONE** — `audio-native/`, 9 testów + sprawdzian
   w Electronie. Ten sam `.node` działa w Node i w Electronie bez przebudowy.
2. ~~Przekazanie PCM z main process do renderera.~~ **ZROBIONE** — `MessagePort`
   z `MessageChannelMain`, port wędruje do renderera przez `window.postMessage`
   z preloada. Sprawdzone w wersji dev i **spakowanej**:
   `npm run e2e:audio` → 100 pakietów, 48 000 ramek na sekundę.
3. ~~Zamiana PCM na `MediaStreamTrack`.~~ **ZROBIONE**, ale **inaczej niż tu
   planowano**: nie `AudioWorklet`, tylko `MediaStreamTrackGenerator` +
   `AudioData` (Insertable Streams). Sprawdzone sondą, że w Electronie 33.4.11
   działa. Zysk: znaczniki czasu podajemy jawnie, więc synchronizacja z obrazem
   jest nasza, a nie wynikiem tego, kiedy zdążyliśmy dosypać próbek. `AudioWorklet`
   zostaje jako droga zapasowa (opisana w `renderer/env.d.ts`), gdyby API
   zniknęło z przyszłego Chromium. `SharedArrayBuffer` i tak odpadał —
   `crossOriginIsolated` jest `false`.
4. ~~Powiązanie wybranego okna z PID.~~ **ZROBIONE** — `pidForWindow` w module
   natywnym. Id źródła z `desktopCapturer` ma postać `window:<HWND>:0`, więc ta
   liczba to gotowy uchwyt okna; PID bierze `GetWindowThreadProcessId`.

**Stan: dźwięk z wybranej aplikacji działa.** Wybranie *okna* z zaznaczonym
dźwiękiem daje ścieżkę audio z tylko tego procesu — TeamSpeak nie wchodzi już
do miksu, więc rozmówca nie słyszy sam siebie. Sprawdzone w wersji dev
i spakowanej (`npm run e2e:audio`): 264 pakiety PCM, 99 pakietów RTP po drugiej
stronie połączenia.

**Czego jeszcze nie sprawdziliśmy:**

- **Odsłuchu uchem.** E2E dowodzi, że dane płyną, nie że brzmią poprawnie.
  Trzeba raz przetestować we dwóch: czy słychać grę, czy nie ma echa z TS3
  i czy dźwięk trzyma się obrazu przez dłuższy czas.
- **Ścieżki przez interfejs.** Testy pokrywają moduły, a e2e wywołuje API
  bezpośrednio. Samo klikanie w UI (wybór okna + zaznaczenie dźwięku) sprawdza
  na razie tylko typecheck.
- **Udostępnianie ekranu** zostaje na starym miksie systemowym — ekran nie
  należy do żadnego procesu, więc echo z TS3 tam dalej będzie.

**POTWIERDZONE, ze API dziala** — patrz `audio-native/` i pomiary w jego README.
Proces grajacy: 476 032 niezerowych probek. Proces cichy w tym samym czasie: 0.
Czyli przechwytywanie jest realnie per-proces.

**Pułapka na krok 4:** nieistniejący PID **nie** daje błędu — Windows aktywuje
loopback i podaje ciszę w nieskończoność. Złe mapowanie okna na PID objawi się
więc niemym streamem, a nie wyjątkiem. Konstruktor `AudioCapture` sam sprawdza
proces przez `OpenProcess`, ale mapowanie i tak trzeba zweryfikować osobno.

**Pakowanie modułu natywnego** (ustalone przy kroku 2, żeby nie odkrywać tego
przy wydaniu): `file:` daje symlink poza katalog projektu, a electron-builder
odmawia pakowania czegokolwiek spoza niego. Stąd `install-links=true`
w `companion-app/.npmrc` (prawdziwa kopia) i `asarUnpack` na `**/*.node`
(bibliotek natywnych nie da się wczytać z wnętrza asara). Kopia nie odświeża
się sama po przebudowaniu modułu i `npm install --force` tego nie naprawia —
robi to `npm run sync:native`, wpięty w `package` i `installer`.

**Szacunek:** to największy pojedynczy kawałek pracy w tym projekcie — natywna
kompilacja, osobne buildy pod architektury, sporo miejsc na błędy trudne do
zdiagnozowania. Nie ma sensu zaczynać, dopóki nie działa prostsza wersja.

**Obejście na teraz:** wybór urządzenia wejściowego zamiast miksu systemowego
(Stereo Mix / VB-Cable / VoiceMeeter). Użytkownik raz konfiguruje routing w
Windows, kierując grę na wirtualny kabel, a TeamSpeaka zostawiając na
głośnikach. Po naszej stronie to tylko lista urządzeń i `deviceId` w
`getUserMedia` — kilka godzin zamiast tygodni.

---

## 3. Następne zadania (ustalone 2026-08-07)

Kolejność jest celowa — punkt 1 usuwa problem powtarzalny, reszta to pojedyncze
usprawnienia. Świadomie odrzucone przez właściciela projektu: kodowanie na GPU
(CPU zostaje), sufit bitrate kamery (jest dobrze), dźwięk (działa poprawnie).

### 3.1 Automatyczna aktualizacja aplikacji

**Po co:** protokół sygnalizacji nie niesie zgodności wstecz (decyzja świadoma),
więc **każda** zmiana protokołu zmusza wszystkich do ręcznej instalacji nowego
pliku. Przerabialiśmy to 2026-08-07 przy wdrożeniu kamery: do czasu instalacji
koledzy widzieli komunikat „Ta wersja aplikacji jest za stara". To jedyny punkt
z tej listy, który likwiduje problem wracający przy każdym wydaniu.

**Jak:** `electron-updater` + GitHub Releases. Repo jest publiczne na GitHubie,
więc provider `github` wystarczy bez tokenu po stronie użytkownika. Do
`electron-builder.yml` dochodzi sekcja `publish`, do main proces sprawdzania
i pobierania aktualizacji, do interfejsu informacja „jest nowa wersja".

**Uwaga:** aplikacja jest uruchamiana przez wtyczkę TS3 z konkretnej ścieżki
(`ts3-screenshare.path`) — instalator per-user do `%LOCALAPPDATA%\Programs`.
Sprawdzić, czy podmiana plików w trakcie działania nie psuje tego kontraktu.

### 3.2 Widoczna informacja, że łącze nie wyrabia

**Po co:** architektura to pełna siatka — nadawca wysyła osobną kopię do każdego
widza. Przy ekranie i kamerze do trzech osób to około 21 Mb/s wysyłania, a
typowe łącze domowe ma 10–20. Gdy się zatka, obraz się sypie i użytkownik nie ma
żadnej wskazówki, że to jego łącze, a nie zepsuta aplikacja.

**Jak:** dane już mamy — `qualityLimitationReason` z `getStats()` czytamy w
`companion-app/e2e/obciazenie.mjs`. Wystarczy odpytywać to cyklicznie w
rendererze i przy wartości `bandwidth` pokazać zdanie w rodzaju „Twoje łącze nie
nadąża — zmniejsz rozdzielczość albo FPS".

### 3.3 Zachowanie przy zaśnięciu serwera

**Po co:** darmowy plan Rendera usypia usługę po 15 minutach bezczynności, a
pierwsze połączenie po przebudzeniu trwa kilkadziesiąt sekund. Dotyczy to
**codziennego** pierwszego wejścia wieczorem.

**Czego nie wiadomo:** co aplikacja wtedy pokazuje. Jeśli nic, wygląda to jak
zawieszenie. **Najpierw sprawdzić**, potem ewentualnie dodać komunikat
„łączę się, serwer się budzi…" z licznikiem.

### 3.4 Uczciwa diagnoza nieudanego połączenia (i ewentualnie TURN)

**Po co:** mamy tylko STUN. Jeśli któryś użytkownik siedzi za symetrycznym
NAT-em, połączenie nie wstanie **nigdy**, a on zobaczy wieczny spinner bez
żadnego wyjaśnienia.

**Jak, po kolei:** najpierw wykryć `iceConnectionState === 'failed'` i powiedzieć
wprost, że nie udało się zestawić połączenia bezpośredniego — to godzina roboty
i koniec zgadywania. Dopiero gdy okaże się, że problem realnie występuje u
kogoś, rozważyć płatny TURN.

## 4. Drobne

- **TURN** — bez niego połączenie nie wstanie u osób za symetrycznym NAT-em.
  Warto sprawdzić na realnych użytkownikach, czy problem występuje, zanim
  zaczniemy płacić za serwer.
- **Podpis kodu** — SmartScreen ostrzega przy instalacji. Certyfikat to kilkaset
  złotych rocznie.
- **Dźwięk nie działa na Sound Blaster AE-5** (`NotReadableError`), a u innych
  osób tak. Karty Creative nie wspierają pętli zwrotnej WASAPI.

### Długi z przeglądów kodu (kamera, 2026-08-07)

Znalezione przy przeglądach, świadomie odłożone jako drobne. Każdy na
kilkanaście minut:

- **Sekcja „Kamera" w trybie samodzielnym nic nie robi.** `App.tsx` woła
  `useCamera(false, …)`, a tryb bez wtyczki i tak nic nie nadaje — ustawienia
  lądują w stanie i giną przy zamknięciu okna.
- **Błąd nieudanego zatrzymania ekranu nie ma gdzie się pokazać.** `startError`
  renderuje się tylko wewnątrz `SourcePicker`, więc w głównym widoku lobby
  komunikat przepada.
- **`takeOldestPending` w `SignalingClient` może odrzucić niewłaściwą
  obietnicę.** Wiadomość `error` z serwera nie niesie pola `kind`, więc przy
  zbiegu okoliczności (np. zaległy kandydat ICE do peera, który wyszedł)
  użytkownik zobaczy mrugnięcie kamery i komunikat bez związku. Pełna naprawa
  wymaga dodania `kind` do wiadomości `error` w protokole.
- **Test `lobby-kafelki.test.ts` buduje oczekiwanie tą samą funkcją, której
  używa implementacja** — w izolacji sprawdza sam siebie. Rozróżnialność ratuje
  osobny `session-keys.test.ts`, więc luki w pokryciu nie ma.
- **Pomiar obciążenia: wariant 1080p60 mierzył głównie rozbieg.** Okno pomiaru
  (20–40 s) pokrywało się z dochodzeniem kamery do pełnej rozdzielczości
  (~41 s), więc „+53% CPU" nie jest liczbą stanu ustabilizowanego. Do tego każdy
  wariant zmierzono jednorazowo — nie ma przedziału ufności.
- **Uwaga dla każdego, kto wróci do mierzenia wydajności:** przy dłuższych
  pomiarach Chromium dławi renderer zasłoniętego okna i FPS spada do 5–33, co
  wygląda jak limit kodera, a nim nie jest. Trzeba dodać flagi
  `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`
  i `--disable-background-timer-throttling`.
