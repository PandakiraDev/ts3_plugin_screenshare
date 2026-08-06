# TODO

Rzeczy odłożone świadomie, z ustaleniami potrzebnymi do podjęcia tematu.

---

## 1. Kodowanie na GPU (AV1/VP9) — niedokończone śledztwo

**Problem:** obraz koduje programowy VP8 (`libvpx`), co zjada CPU. Przy 1080p60
daje to 40–55 fps zamiast 60.

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

## 3. Drobne

- **TURN** — bez niego połączenie nie wstanie u osób za symetrycznym NAT-em.
  Warto sprawdzić na realnych użytkownikach, czy problem występuje, zanim
  zaczniemy płacić za serwer.
- **Podpis kodu** — SmartScreen ostrzega przy instalacji. Certyfikat to kilkaset
  złotych rocznie.
- **Dźwięk nie działa na Sound Blaster AE-5** (`NotReadableError`), a u innych
  osób tak. Karty Creative nie wspierają pętli zwrotnej WASAPI.
