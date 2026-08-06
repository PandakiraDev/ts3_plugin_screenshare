# audio-native — dzwiek z wybranej aplikacji

Probe potwierdzajacy, ze Windows Process Loopback API dziala na docelowej
maszynie. Krok zerowy przed pisaniem pelnego modulu natywnego — zeby nie
powtorzyc sytuacji z H.264, gdzie powstal kod, ktory nie mial prawa zadzialac.

## Wynik pomiaru

Windows 11 build 26200, SDK 10.0.26100.0:

| Cel | Niezerowe probki | Szczyt |
| --- | --- | --- |
| proces grajacy ton 440 Hz | 476 032 | 0,0884 |
| proces cichy (Explorer)   | **0**   | 0,0000 |

Oba pomiary w tym samym czasie, gdy ton gral. Explorer dostal czysta cisze,
co dowodzi, ze przechwytywanie jest per-proces, a nie systemowe.

## Budowanie

Wymaga MSVC Build Tools. Z "x64 Native Tools Command Prompt" albo po vcvars64:

```bat
cl /nologo /EHsc /std:c++17 probe.cpp /Fe:probe.exe /link ole32.lib mmdevapi.lib
```

## Uzycie

```bat
probe.exe <PID> [sekundy]
```

## Co dalej (pelny modul)

1. N-API zamiast exe: przyjmuje PID, oddaje strumien PCM.
2. Przekazanie PCM z main process do renderera.
3. AudioWorklet -> MediaStreamAudioDestinationNode -> sciezka audio do WebRTC.
4. Mapowanie wybranego okna na PID — `desktopCapturer` daje id zrodla, nie PID.

Punkty 1 i 4 sa proste. Punkt 3 to najwieksze ryzyko: opoznienie i synchronizacja
z obrazem.
