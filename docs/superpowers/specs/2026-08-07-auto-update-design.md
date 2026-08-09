# Automatyczna aktualizacja aplikacji

Data: 2026-08-07
Zadanie: TODO.md § 3.1

## Cel

Protokół sygnalizacji nie niesie zgodności wstecz — to decyzja świadoma. Skutek:
**każda** zmiana protokołu zmusza wszystkich do ręcznej instalacji nowego pliku.
Przy wdrożeniu kamery (2026-08-07) koledzy do czasu instalacji widzieli
„Ta wersja aplikacji jest za stara" (`signaling-server/src/protocol.ts`).

Po tej zmianie aplikacja sama pobiera nowe wydanie z GitHuba i instaluje je po
zamknięciu okna. Następne kliknięcie „Udostępnij ekran" w TS3 uruchamia już nową
wersję.

**Ograniczenie nie do obejścia:** autoaktualizacja działa dopiero *od* pierwszego
wydania, które ją zawiera. Przejście z wersji 0.1.0, którą wszyscy mają teraz,
na 0.2.0 trzeba wykonać raz ręcznie — stara aplikacja nie ma jak dowiedzieć się
o nowej.

## Warunki brzegowe wynikające z tego projektu

Trzy fakty o tej aplikacji, których nie ma w typowym poradniku o
`electron-updater`, a które kształtują całą resztę:

1. **Aplikacja żyje krótko.** Plugin odpala ją przez `CreateProcessW` z menu
   kanału (`launchCompanion` w `plugin/src/plugin.c`) na czas jednej sesji
   udostępniania. Nie ma trybu „działa w tle tygodniami".
2. **Argumenty startowe pochodzą od pluginu.** `--ts3-server`, `--channel`,
   `--nick` przychodzą z linii poleceń. Restart aplikacji z instalatora
   odtworzyłby ją **bez** tych argumentów, czyli w trybie samodzielnym, poza
   kanałem.
3. **Instalator robi dwie rzeczy naraz.** Kładzie aplikację w
   `%LOCALAPPDATA%\Programs` *i* wrzuca `ts3_screenshare.dll` oraz
   `ts3-screenshare.path` do `%APPDATA%\TS3Client\plugins`
   (`build/installer.nsh`).

Z (3) wynika zderzenie: podczas autoaktualizacji TeamSpeak **zawsze** działa —
bo to on uruchomił aplikację — więc DLL wtyczki jest załadowany i zablokowany.
Dzisiejszy `installer.nsh` pokazuje wtedy `MessageBox` RETRY/CANCEL, a `MessageBox`
w NSIS wyświetla się także przy `/S`. Cichy update trafiałby na ten dialog przy
każdym przebiegu.

## Decyzje i dlaczego

### Instalacja po zamknięciu okna, nie z przyciskiem „uruchom ponownie"

Wybrane: `autoInstallOnAppQuit` (domyślne `true` w `electron-updater`). Aplikacja
sprawdza aktualizację przy starcie, pobiera w tle, pokazuje pasek, a instaluje po
wyjściu użytkownika.

Odrzucone: przycisk „Zainstaluj i uruchom ponownie". Powód to warunek brzegowy (2)
— po restarcie z instalatora aplikacja wstałaby bez argumentów pluginu, czyli
w trybie samodzielnym, poza kanałem. Dałoby się je zapamiętać i odtworzyć, ale
to dodatkowy stan na dysku po to, żeby rozwiązać problem, którego przy
instalacji-po-wyjściu w ogóle nie ma.

Odrzucone: blokowanie udostępniania do czasu aktualizacji. Wywala użytkownika
z kanału na czas pobierania — gorsze niż dzisiejszy komunikat „wersja za stara".

Skutek uboczny wybranego wariantu: sesja udostępniania **w toku** nie jest
przerywana — instalacja czeka aż użytkownik sam zamknie okno.

**Znane ograniczenie, niesprawdzone empirycznie:** instalator odpalony po
zamknięciu okna przechodzi przez `allowOnlyOneInstallerInstance.nsh`, który
przy fladze `--updated` po sekundzie ubija znaleziony proces aplikacji bez
dialogu. Aplikacja nie ma `requestSingleInstanceLock()`, a wtyczka odpala nową
instancję przy każdym kliknięciu w menu — teoretycznie użytkownik mógłby
zamknąć lobby, a chwilę później kliknąć „Udostępnij ekran" ponownie i zobaczyć
nowe okno znikające bez wyjaśnienia, bo cicha instalacja właśnie ubiła proces.
Zastrzeżenie: ta gałąź NSIS jest poprzedzona sprawdzeniem, czy rodzicem
instalatora nie jest sama aplikacja — jeśli proces rodzica jeszcze żyje, może
się w ogóle nie wykonać. **Tego nie zweryfikowano empirycznie**, więc scenariusz
zostaje jako znane ograniczenie, nie jako potwierdzony błąd.

### Podmiana wtyczki przez przemianowanie, nie przez nadpisanie

Windows nie pozwala **nadpisać** załadowanego DLL, ale pozwala go
**przemianować**. Sprawdzone empirycznie na prawdziwym `ts3_screenshare.dll`
załadowanym przez `LoadLibraryW`:

| Operacja na załadowanym DLL | Wynik |
|---|---|
| Nadpisanie zawartości | odmowa — „używany przez inny proces" |
| `Rename` na `.old` | **OK** |
| Zapis nowego pliku pod starą nazwą | **OK** |
| Usunięcie `.old` przy wciąż załadowanym module | odmowa |

Stąd sekwencja: stary DLL idzie na `ts3_screenshare.dll.old`, nowy ląduje pod
właściwą nazwą. TeamSpeak dalej trzyma stary (już pod nazwą `.old`) i przełącza
się na nowy przy następnym starcie. Rozszerzenia `.old` TS3 nie skanuje, więc nie
spróbuje go załadować.

Sprzątanie `.old` musi być odłożone — plik zwalnia się dopiero po restarcie
TeamSpeaka. Robi to `Delete` na początku kolejnej instalacji, z założeniem „jak
się uda".

Odrzucone alternatywy:

- `MoveFileEx` / `Rename /REBOOTOK` (podmiana przy restarcie systemu) — wymaga
  uprawnień administratora, a instalator jest celowo per-user (`perMachine: false`).
- Pomijanie DLL w trybie cichym — prostsze, ale przy zmianie wtyczki app i plugin
  cicho by się rozjechały.
- Samopodmiana z poziomu `plugin.c` — wymaga zmian w kodzie C i jest bardziej
  kruche niż to samo w instalatorze.

### Rozgałęzienie po faktycznej blokadzie, nie po fladze trybu

`installer.nsh` sprawdza, czy plik da się otworzyć do zapisu, i dopiero wtedy
wybiera drogę. To ta sama zasada, którą stosuje już istniejące makro `SprawdzTS3`
(„sprawdzamy to, co faktycznie blokuje", a nie nazwę procesu).

Skutek: instalacja interaktywna przy zamkniętym TS3 działa dokładnie jak dziś
(zwykłe nadpisanie, wtyczka aktywna od razu), a ścieżka z przemianowaniem włącza
się sama tam, gdzie jest potrzebna — przy cichym update.

Odrzucone: `IfSilent` jako warunek podmiany. Wtedy o wyborze decydowałby tryb
uruchomienia instalatora, a nie stan pliku — czyli dokładnie to, przed czym
ostrzega komentarz przy `SprawdzTS3`.

`IfSilent` zostaje użyte w **dwóch** miejscach: do wyciszenia nagu „zamknij
TeamSpeaka" w `customInit` i w `customUnInit` (patrz sekcja „Instalator" niżej —
bez drugiego miejsca cała reszta jest bezużyteczna, patrz „Dlaczego punkt 4 jest
konieczny"). Autoaktualizacja nie ma prawa pokazać żadnego dialogu.

### Cisza przy niepowodzeniu

Brak sieci, brak wydań, błąd pobierania → `console.warn` i nic w interfejsie.
Okno służy do udostępniania ekranu; komunikat o nieudanym sprawdzeniu
aktualizacji jest w nim szumem. Pasek pojawia się **wyłącznie** wtedy, gdy plik
jest już na dysku i naprawdę się zainstaluje.

### Numer wersji na stałe w nagłówku

Przy pytaniu „jaką masz wersję?" nikt nie musi zgadywać ani szukać w
Panelu sterowania.

## Architektura

Granica przebiega w jednym miejscu: **wszystko, co dotyka `electron-updater`,
siedzi w jednym cienkim pliku, którego nie da się zaimportować w teście.** Cała
reszta jest czysta i testowalna w vitest (testy w tym projekcie importują
`../src/...` bez Electrona — patrz `test/cli.test.ts`).

| Plik | Rola | Zależności |
|---|---|---|
| `src/shared/update.ts` | typ `UpdateState`, reduktor zdarzeń, tekst paska | brak |
| `src/main/update.ts` | `registerUpdates(window)` — `electron-updater`, wysyłka stanu | electron, electron-updater |
| `src/renderer/hooks/useAppUpdate.ts` | subskrypcja stanu + numer wersji | preload |
| `src/renderer/components/UpdateNotice.tsx` | pasek `notice` + `<AppVersion>` | — |

### `src/shared/update.ts`

```ts
export interface UpdateState {
  /** Wersja gotowa do instalacji; null = nic nie czeka. */
  readyVersion: string | null
}

export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'not-available' }
  | { type: 'downloaded'; version: string }
  | { type: 'error' }

export const NO_UPDATE: UpdateState

export function reduceUpdate(state: UpdateState, event: UpdateEvent): UpdateState
export function updateNoticeText(state: UpdateState): string | null
```

Reguła nieoczywista, którą pilnuje test: **`error` nie kasuje już pobranej
wersji.** Plik leży na dysku i tak się zainstaluje po wyjściu z aplikacji;
skasowanie stanu skłamałoby użytkownikowi.

### Przepływ

```
start aplikacji
  └─ app.isPackaged? ──nie──> nic
       │  (w dev electron-updater rzuca "dev-app-update.yml not found")
       └─tak─> autoUpdater.checkForUpdates()   [autoDownload domyślnie true]
                 │  NIE checkForUpdatesAndNotify — powiadomienie systemowe
                 │  dublowałoby nasz pasek
                 ├─ brak sieci / brak wydań / błąd ──> console.warn, UI bez zmian
                 └─ 'update-downloaded' ──IPC──> renderer: pasek "Pobrano wersję X…"
zamknięcie okna
  └─ autoInstallOnAppQuit ──> cichy NSIS /S ──> podmiana aplikacji i wtyczki
następne "Udostępnij ekran" w TS3 ──> nowa wersja aplikacji
następny start TeamSpeaka ──> nowa wersja wtyczki
```

### IPC

Dwa kanały, wzorzec jak istniejące w `src/shared/ipc.ts`:

- `IPC_GET_VERSION` (`invoke`) → `app.getVersion()`
- `IPC_UPDATE_STATE` (push main → renderer, jak `IPC_AUDIO_PORT`)

W preloadzie: `getAppVersion(): Promise<string>` oraz
`onUpdateState(cb): () => void` (zwraca funkcję odsubskrybowania).

### Interfejs

- Numer wersji: mały `<span className="app__version">` przy `app__title`. Trzy
  nagłówki w kodzie: lobby (`LobbyView.tsx`), samodzielny i błąd argumentów
  (oba w `App.tsx`).
- Pasek: `notice` nad `.lobby` / `.app__body`, obok istniejącego paska błędu
  kamery.

Zero zmian w `useLobby`, `session.ts`, `SignalingClient` i w protokole
sygnalizacji.

## Instalator — `build/installer.nsh`

Cztery zmiany. **Uwaga: pierwotna wersja tego specu wymieniała trzy i była
błędna** — patrz punkt 4, wykryty dopiero przy przeglądzie zadania 6.

1. **`customInit`** — nag „zamknij TeamSpeaka" tylko gdy nie `IfSilent`.
2. **`customInstall`** — `Delete "${TS3_DLL}.old"` (sprzątanie po poprzedniej
   podmianie), potem:

```nsis
IfFileExists "${TS3_DLL}" 0 wpisz_dll
  ClearErrors
  FileOpen $0 "${TS3_DLL}" a      ; da sie zapisac?
  IfErrors odsun_stary 0
    FileClose $0
    Goto wpisz_dll                ; TS3 zamkniety — zwykle nadpisanie
  odsun_stary:
    Rename "${TS3_DLL}" "${TS3_DLL}.old"
wpisz_dll:
```

3. **`customUnInstall`** — kasuje też `${TS3_DLL}.old`.
4. **`customUnInit`** — to samo wyciszenie co w punkcie 1, tylko dla
   deinstalatora. **Bez tego cała reszta jest bezużyteczna.**

Rejestr `$0` jest współdzielony z electron-builderem, więc obowiązuje `Push`/`Pop`
jak w istniejącym makrze — i musi obejmować **oba** użycia w `customInstall`,
także zapis pliku ze ścieżką, który dziś jest niezabezpieczony.

### Dlaczego punkt 4 jest konieczny — pułapka, której spec nie przewidział

Wyciszenie samego `customInit` **nie zatrzymuje dialogu**. Przy każdej instalacji
electron-builder uruchamia deinstalator poprzedniej wersji i **czeka na niego**:

```
installSection.nsh:52   !insertmacro uninstallOldVersion    (bezwarunkowo)
installUtil.nsh:224     ExecWait '"$uninstallerFileNameTemp" /S ...'
uninstaller.nsh:26-27   !insertmacro customUnInit           (w un.onInit)
```

Stary deinstalator leci pod `/S`, wchodzi w `customUnInit`, tam napotyka
`SprawdzTS3` z `MessageBox` bez `/SD` — i dialog wyskakuje mimo `/S`, a instalator
rodzic wisi w `ExecWait` w nieskończoność. Do `customInstall` nigdy nie dochodzi.

Że to znana pułapka, widać po samym electron-builderze: swój własny `MessageBox`
w sąsiedniej linii (`installUtil.nsh:219`) zabezpiecza przez `/SD IDCANCEL`.

Wariant `/SD IDCANCEL` u nas odrzucony: daje niezerowy kod wyjścia deinstalatora
i pętlę pięciu ponowień (`installUtil.nsh:215-239`). `IfSilent` jest u nas
bezpieczne, bo `SetSilent silent` z `uninstaller.nsh:20` siedzi w `!ifdef
ONE_CLICK`, a mamy `oneClick: false` — ręczna deinstalacja pozostaje niecicha
i nag dalej się pokazuje.

**Konsekwencja, o której trzeba wiedzieć:** poprawka chroni tylko deinstalatory
zbudowane po niej. Cicha aktualizacja *z* wersji sprzed poprawki uruchomiłaby
stary, niezabezpieczony deinstalator. Nas to nie dotyczy — 0.1.0 nie ma
`electron-updatera`, więc pierwsza autoaktualizacja to dopiero 0.2.0 → 0.3.0.

**Podwójny cichy update bez restartu TS3 jest bezpieczny.** Po pierwszej
podmianie `ts3_screenshare.dll` to nowy plik, którego nikt nie trzyma — drugi
przebieg przechodzi zwykłym nadpisaniem i nie próbuje przemianować na zajętą
nazwę `.old`.

## Wydania

Do `electron-builder.yml`:

```yaml
publish:
  provider: github
  owner: PandakiraDev
  repo: ts3_plugin_screenshare
```

Repozytorium jest publiczne, więc użytkownik nie potrzebuje żadnego tokenu.

`npm run release` → `scripts/publish.mjs`: bierze token z `gh auth token`, robi
`sync:native` + `build` + `electron-builder --win --publish always`.

electron-builder tworzy **szkic** wydania (zachowanie domyślne). Publikujesz go
ręcznie na GitHubie. `electron-updater` szkiców nie widzi, więc nikt nie dostanie
aktualizacji przed tym kliknięciem.

Podbicie wersji w `package.json` zostaje ręczne. Pierwsze wydanie z
autoaktualizacją to **0.2.0** — musi być wyższe niż 0.1.0, którą mają dziś
wszyscy, choć i tak nikt nie zaktualizuje się do niej automatycznie (patrz
„Ograniczenie nie do obejścia" w Celu). Dopiero przejście 0.2.0 → 0.3.0 będzie
pierwszym prawdziwym sprawdzianem mechanizmu.

## Weryfikacja

Kolejność TDD — test przed kodem, który ma go zaspokoić.

1. **`test/update.test.ts`** (vitest) na `src/shared/update.ts`:
   - `NO_UPDATE` → `updateNoticeText` zwraca `null`
   - `downloaded` → tekst zawiera numer wersji
   - `error` **po** `downloaded` → wersja zostaje (reguła z sekcji wyżej)
   - `not-available` / `checking` → brak paska

2. **`e2e/dll-swap.mjs`** — pisany **przed** zmianą w `installer.nsh`. Proces
   pomocniczy trzyma kopię DLL przez `LoadLibraryW`, skrypt odtwarza sekwencję
   instalatora i sprawdza:
   - nadpisanie załadowanego pliku → odmowa
   - `Rename` na `.old` → sukces
   - zapis nowego pliku pod starą nazwą → sukces
   - `.old` bajt w bajt równy staremu DLL

3. **`e2e/silent-install.mjs`** — uruchamia **zbudowany** instalator z `/S`, gdy
   proces pomocniczy trzyma DLL, i sprawdza: instalator kończy się bez zawieszenia
   na dialogu (limit czasu), `ts3_screenshare.dll.old` zawiera stare bajty,
   `ts3_screenshare.dll` nowe.

   **Ten skrypt dotyka prawdziwego `%APPDATA%\TS3Client\plugins` i zainstalowanej
   aplikacji — to instalacja, nie test.** Powstaje jako część zadania, ale nie
   jest uruchamiany bez wyraźnej zgody właściciela projektu i nie wchodzi do
   `npm test`. Blokadę DLL symuluje proces pomocniczy z `LoadLibraryW`, więc
   uruchomiony TeamSpeak nie jest potrzebny.

4. **Po `npm run release`** — w szkicu wydania muszą być **dwa** pliki:
   `TS3-Screen-Share-Setup-X.exe` **i `latest.yml`**. Bez tego drugiego
   `electron-updater` niczego nie znajdzie.

## Poza zakresem

- Podpis kodu (TODO.md § 4) — SmartScreen dalej ostrzega.
- Kanały wydań (beta/stable), aktualizacje różnicowe, wycofywanie wydania.
- Wersjonowanie wtyczki i sprawdzanie zgodności app ↔ plugin. Wtyczka zmienia się
  rzadko, a przy tej podmianie nie może się rozjechać z aplikacją: obie części
  jadą w jednym instalatorze.
- Zmiany w `plugin/src/plugin.c` — cała podmiana dzieje się w instalatorze.

## Nazewnictwo

Nowe pliki po angielsku (`update.ts`, `dll-swap.mjs`, `silent-install.mjs`,
`publish.mjs`), zgodnie z kierunkiem ostatnich commitów. Komentarze i komunikaty
dla użytkownika po polsku.
