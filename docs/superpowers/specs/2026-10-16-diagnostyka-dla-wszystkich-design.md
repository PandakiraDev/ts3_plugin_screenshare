# Diagnostyka dla wszystkich — projekt (0.3.4, część 2)

## Po co to

Dziś cała diagnostyka siedzi za flagą `--diagnostics`, której wtyczka TS3 nie
przekazuje. Właściciel nie mógł otworzyć własnego panelu bez skryptu
obchodzącego uruchamianie (`companion-app/scripts/diagnostyka.ps1`), a zwykły
użytkownik nie ma jak odpowiedzieć na pytanie „czy to u mnie zjada maszynę".

Dwie rzeczy mają z tego wyjść:

1. **Licznik zużycia w rogu okna dla KAŻDEGO** — CPU, GPU, RAM — bez flagi
   i bez ustawień. Ma odpowiadać na pytanie „czy aplikacja zjada maszynę".
2. **Dziennik lobby pod guzikiem, też dla każdego** — zdarzenia i błędy:
   kto wszedł, kto wyszedł, co się stało z połączeniem, co odbił serwer. Ma
   odpowiadać na pytanie „dlaczego mi zacina" i „dlaczego go nie widzę".

## Cele

- Licznik zużycia widoczny bez żadnego włączania.
- Dziennik lobby dostępny bez żadnego włączania, czytelny dla człowieka, który
  nie zna kodu.
- Nazwa karty graficznej i jej pamięć pokazywane niezależnie od producenta.
- Flaga `--diagnostics` zastąpiona polem wyboru w ustawieniach, zapamiętywanym
  między uruchomieniami.

## Czego NIE robimy

- Nie przenosimy zapisu diagnostycznego na dysk do domyślnego zachowania. Zapis
  zostaje za polem wyboru: to on kosztuje dysk i tylko on potrzebuje zgody.
- Nie pokazujemy zużycia GPU dla kart innych niż NVIDIA. Zmierzone: licznik
  systemowy Windows (`\GPU Engine(*)\Utilization Percentage`) kosztuje **3,9 s**
  przeciw **46,5 ms** dla `nvidia-smi` — 84 razy gorzej, czyli nie do użycia
  w pętli próbkującej. Dla pozostałych kart pokazujemy nazwę i pamięć,
  a przy zużyciu piszemy, że jest niedostępne.
- Nie robimy drugiego okna systemowego na dziennik (uzasadnienie niżej).
- Nie dodajemy rozbicia zużycia na procesy Electrona. Suma odpowiada na
  zadawane pytanie.

## Czego absolutnie nie wolno (anty-cele)

- **Licznik nie może kłamać.** Zero i kreska to dwie różne informacje: zero
  znaczy „zmierzone, nic nie zużywa", kreska „nie wiem". Zawieszony sterownik
  nie może przyklejać na pasku swoich ostatnich procentów — ten mechanizm już
  istnieje (`GPU_STALE_AFTER_MS`) i nie wolno go złamać.
- **Użytkownik nie-NVIDII nie może dostać samej kreski bez wyjaśnienia.** Dziś
  dostałby i nie odróżniłby „nie mam takiej karty" od „sterownik się zawiesił".
- **Sama diagnostyka nie może być przyczyną zacinania.** To aplikacja, w której
  diagnozujemy lag. Nic w tej części nie może dołożyć pracy w tyknięciu
  próbkowania ani w renderze siatki.
- **Dziennik nie może rosnąć bez ograniczenia** w pamięci ani na dysku.

## Ograniczenia

- Electron 33 (Chromium 130), React 18 w `StrictMode`, TypeScript, vitest
  w **gołym Node bez jsdom** — nie ma `document` ani `window` w testach, więc
  każda decyzja, która ma być przetestowana, musi mieszkać w `src/shared/*`.
- `test/**/*.ts` jest w `include` w `tsconfig.json`, więc błąd typu w teście
  wywala `npm run build`.
- Identyfikatory po angielsku; komentarze i teksty dla człowieka po polsku
  z pełnymi znakami diakrytycznymi; komunikaty commitów w czystym ASCII.
- Windows jest jedyną platformą docelową.
- `src/shared/diagnostics.ts` ma już 783 linie. Nowe rzeczy idą do nowych
  plików w `src/shared/`, nie do niego.

## Co już istnieje i czego NIE pisać od nowa

Wydanie 0.3.3 zbudowało większość maszynerii. Ta część ją **odbramkowuje
i uzupełnia**, a nie zastępuje:

- `src/main/metrics.ts` — próbkowanie CPU i RAM przez `app.getAppMetrics()`,
  odpytywanie `nvidia-smi` w tle z blokadą jednoczesności, numerowaniem
  wywołań i zerowaniem po zatrzymaniu. Zostaje bez zmian poza dodaniem
  wykrywania karty.
- `src/shared/diagnostics.ts` — `formatResourceBadge`, `formatSystemLine`,
  `GPU_STALE_AFTER_MS`, `parseNvidiaSmi`, bufor próbek i obracanie plików.
- `src/main/diagnosticsRecorder.ts` — właściciel zapisu na dysk,
  `registerDiagnostics(enabled)` jest dzisiejszą jedyną bramką.
- `src/renderer/components/Diagnostics.tsx` — pasek w rogu i panel tabeli
  strumieni pod `Ctrl+Shift+D`, oba dziś za flagą.

## Decyzje właściciela

- Licznik i dziennik **dla wszystkich**, bez flagi: „niech będzie dla
  wszystkim, będzie łatwiej i prościej", „to dla wszystkich niech będzie".
- Flaga zamieniona na **pole wyboru** zapamiętywane w `userData`.
- GPU: wykryć, jaką kartę ma użytkownik, i raportować na tej podstawie.
- Scalenie i wydanie **razem z częścią pierwszą**, nie osobno.

## Decyzje podjęte przeze mnie (do sprawdzenia przy czytaniu)

**Jedna flaga rozpada się na dwie niezależne sprawy.** To jest sedno tej
części:

| sprawa | kto widzi | czym sterowane |
|---|---|---|
| zużycie systemu (CPU/GPU/RAM) + pasek | każdy | niczym, zawsze włączone |
| dziennik lobby w pamięci + okno | każdy | niczym, zawsze włączone |
| zapis na dysk (próbki i dziennik) | każdy, kto włączy | pole wyboru |
| tabela strumieni (`Ctrl+Shift+D`) | każdy | niczym, zawsze włączone |

Z tego wynika, że obsługa IPC dla zużycia i dziennika musi być rejestrowana
**bezwarunkowo**. Dzisiejsze bramkowanie `registerDiagnostics(enabled)` zostaje
tylko dla zapisu na dysk. Dzisiejsze komentarze w `Diagnostics.tsx`
i `useDiagnosticsReporter.ts` ostrzegają, że wołanie kanałów bez flagi kończy
się odrzuconą obietnicą („No handler registered") — po tej zmianie to
ostrzeżenie przestaje być prawdą i musi zniknąć razem z bramką.

**Dziennik to okno w aplikacji, nie drugie okno systemowe.** Drugi
`BrowserWindow` to drugi proces renderera, czyli własny koszt procesora
w aplikacji, w której diagnozujemy lag, plus drugie wejście w `electron-vite`.
Panel w tym samym oknie ma już działający wzór (`.diag`). Koszt tej decyzji
jest realny i wart zapisania: przy panelu nie da się czytać dziennika na
drugim monitorze, patrząc jednocześnie na strumienie. Jeśli właściciel tego
zażąda, zamiana na prawdziwe okno jest osobnym zadaniem.

**Dziennik żyje w procesie głównym.** Tak samo jak próbki i z tego samego
powodu: renderer jest tym, co diagnozujemy, więc gdyby on był właścicielem
zapisu, przestawałby zapisywać dokładnie w chwili, która nas interesuje.
Renderer wypycha wpisy, proces główny trzyma pierścień i ewentualnie pisze na
dysk. Pierścień przeżywa przeładowanie renderera.

**Wykrywanie karty raz, przy starcie, nie przy próbce.** Odczyt rejestru
(`HardwareInformation.qwMemorySize`) zmierzony na **24 ms** end-to-end, przy dwóch
równoległych zapytaniach o konkretne wartości, ale karta nie zmienia się
w trakcie sesji. (Pierwsza wersja tej specyfikacji podawała 6 ms — nieprawda:
sam klucz klasy odpowiada w 11,5 ms, ale NIE zawiera danych o kartach, te leżą
w podkluczach; zapytanie rekurencyjne po całej klasie przekracza trzysekundowy
limit i dawałoby kartę `null` na stałe u każdego. Zmierzone przy wykonaniu.)
Obok poprawnej wartości leży `HardwareInformation.MemorySize` typu `REG_DWORD`
z DOKŁADNIE tym samym przepełnieniem — 4095 MB dla karty 12 GB — więc nie wolno
jej użyć nawet jako źródła zapasowego. `Win32_VideoController.AdapterRAM` jest bezużyteczne:
raportuje 4095 MB dla karty 12 GB (przepełnienie uint32) — zmierzone.

**Plik ustawień to `<userData>/settings.json`.** Jeden klucz na teraz,
`recordDiagnostics`. Precedens w repozytorium to `api-key.txt` (goły plik),
ale ustawień będzie więcej niż jedno, więc JSON. Plik nieczytelny albo
uszkodzony ma dać wartości domyślne, a nie wywalić start aplikacji.

**Flaga `--diagnostics` znika całkowicie**, razem z polem
`LaunchOptions.diagnostics`. Konsekwencja do wykonania, nie do pominięcia:
`companion-app/scripts/diagnostyka.ps1` istnieje wyłącznie po to, żeby tę
flagę podstawić, więc traci rację bytu i ma zostać usunięty.

**Źródła wpisów do dziennika** to istniejące callbacki sesji, nic nowego:
`onError`, `onPeersChange`, `onStreamersChange`, `onUnreachableChange`,
`onViewerQualityChange`, `onRemoteStream`. Wpis ma nieść czas, poziom
(zdarzenie albo błąd) i tekst po polsku, zrozumiały bez znajomości kodu.

## Co zostaje wykonawcy

- Dobór dokładnych napisów na pasku i w dzienniku, poza tymi, które ta
  specyfikacja podaje wprost.
- Rozmiar pierścienia dziennika, byle był ograniczony i uzasadniony liczbą.
- Sposób czytania rejestru (`reg query` kontra moduł) — byle był zmierzony
  i nie blokował procesu głównego na dłużej niż dziesiątki milisekund.
- Wygląd okna dziennika w granicach istniejącego wzoru `.diag`.
