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

1. Natywny dodatek Node (C++/N-API) z WASAPI process loopback — przyjmuje PID,
   zwraca strumień PCM.
2. Przekazanie PCM z main process do renderera.
3. Zamiana PCM na `MediaStreamTrack`: `AudioWorklet` →
   `MediaStreamAudioDestinationNode` → ścieżka audio do WebRTC.
4. Powiązanie wybranego okna z PID — `desktopCapturer` daje id źródła, nie PID,
   więc potrzebne dodatkowe mapowanie przez WinAPI.

**POTWIERDZONE, ze API dziala** — patrz `audio-native/` i pomiar w jego README.
Proces grajacy: 476 032 niezerowych probek. Proces cichy w tym samym czasie: 0.
Czyli przechwytywanie jest realnie per-proces.

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
