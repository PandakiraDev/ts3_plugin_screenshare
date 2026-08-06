# audio-native — dzwiek z wybranej aplikacji

Modul N-API przechwytujacy dzwiek **jednego procesu** (i jego potomkow) przez
Windows Process Loopback API. To krok 1 z punktu 2 w `../TODO.md`.

Wymaga Windows 10 2004+ i architektury x64.

## Uzycie

```js
const { AudioCapture, FORMAT } = require('ts3-screenshare-audio')

const capture = new AudioCapture(pidAplikacji)
capture.start((chunk) => {
  // chunk: Buffer z przeplatanym PCM wg FORMAT (L, R, L, R...)
})
// ...
capture.stop()
```

`FORMAT` to `{ sampleRate: 48000, channels: 2, bytesPerSample: 4, encoding: 'float32' }`.
Pochodzi z C++, zeby renderer nie zgadywal czestotliwosci przy budowaniu
`AudioBuffer`.

## Budowanie i sprawdzanie

```bash
npm install && npm run build && npm test && npm run check:electron
```

`npm test` (vitest, 8 testow) sprawdza logike w Node. **`npm run check:electron`
jest osobno i nie jest formalnoscia** — patrz nizej.

## Co ustalilismy pomiarem

### Przechwytywanie jest naprawde per-proces

Probe (`probe.cpp`, Windows 11 build 26200, SDK 10.0.26100.0):

| Cel | Niezerowe probki | Szczyt |
| --- | --- | --- |
| proces grajacy ton 440 Hz | 476 032 | 0,0884 |
| proces cichy (Explorer)   | **0**   | 0,0000 |

Oba pomiary w tym samym czasie, gdy ton gral. Explorer dostal czysta cisze.

### Cichy proces mimo wszystko oddaje ramki

Strumien loopback chodzi zegarem silnika audio, nie aktywnoscia aplikacji.
`powershell.exe`, ktory nic nie gra, dal 95 520 ramek w 2 s (~48 kHz).
Dzieki temu testy nie potrzebuja niczego grajacego w tle.

### Nieistniejacy PID NIE daje bledu

Windows aktywuje loopback dla PID-u 999999 bez mrugniecia i podaje cisze
w nieskonczonosc (48 000 ramek, same zera). Cicha awaria jest gorsza od
glosnej, wiec konstruktor sam sprawdza proces przez `OpenProcess` i rzuca.

Kod `ERROR_ACCESS_DENIED` traktujemy jako "proces istnieje" — oznacza tylko,
ze nalezy do kogos innego, a loopback i tak zadziala.

**To bedzie wazne przy kroku 4** (mapowanie okna na PID): zle mapowanie nie
objawi sie bledem, tylko cisza.

### Electron odrzuca zewnetrzne bufory

Pierwsza wersja oddawala probki przez `Napi::Buffer::New` ze wskaznikiem
zewnetrznym — bez kopii, wiec szybciej. **Przechodzila wszystkie testy w Node
i oddawala ZERO probek w Electronie**: klatka pamieci V8 odrzuca takie bufory
komunikatem `External buffers are not allowed`, a callback rzucal wyjatek okolo
sto razy na sekunde.

Dlatego jest `Napi::Buffer::Copy` i dlatego istnieje `check/electron.js`.
Testy w Node tej klasy bledow nie widza.

### `stop()` musi gasic tez kolejke

Warstwa natywna zatrzymuje przechwytywanie i czeka na swoj watek, ale pakiety
juz zakolejkowane w `ThreadSafeFunction` dojezdzaja **po** powrocie z `stop()`
— test lapal jeden pakiet za duzo (30 zamiast 29). Dlatego `index.js` gasi
flage przed zatrzymaniem i resztki z kolejki trafiaja w pustke.

Bez tego konsument dostawalby dzwiek po wylaczeniu udostepniania.

### N-API nie wymaga przebudowy pod Electrona

Ten sam `.node` zbudowany dla Node 22 laduje sie w Electronie 33.4.11
(Node 20.18.3) i dziala. Zadnego `electron-rebuild`.

## Co dalej

Kroki 2-4 z `../TODO.md`: przekazanie PCM do renderera, zamiana na
`MediaStreamTrack` (najwieksze ryzyko — opoznienie i synchronizacja z obrazem)
oraz mapowanie wybranego okna na PID.

`probe.cpp` zostaje jako dowod i najprostsze narzedzie diagnostyczne:

```bat
cl /nologo /EHsc /std:c++17 probe.cpp /Fe:probe.exe /link ole32.lib mmdevapi.lib
probe.exe <PID> [sekundy]
```
