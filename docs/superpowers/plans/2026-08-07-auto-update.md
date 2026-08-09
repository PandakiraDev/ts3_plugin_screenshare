# Automatyczna aktualizacja aplikacji — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplikacja sama pobiera nowe wydanie z GitHuba i instaluje je po zamknięciu okna — razem z wtyczką TS3, mimo że TeamSpeak trzyma jej DLL załadowany.

**Architecture:** `electron-updater` żyje w jednym cienkim pliku `src/main/update.ts`; cała logika stanu jest czysta i testowalna w `src/shared/update.ts`. Instalacja odbywa się po wyjściu z aplikacji (`autoInstallOnAppQuit`), a zablokowany DLL wtyczki jest **przemianowywany** na `.old` zamiast nadpisywany — to jedyna operacja, na którą Windows pozwala przy załadowanym module.

**Tech Stack:** Electron 33, electron-vite, electron-builder 25 (NSIS), electron-updater 6, React 18, vitest, PowerShell (blokada DLL w testach e2e).

**Spec:** `docs/superpowers/specs/2026-08-07-auto-update-design.md`

## Global Constraints

- **Identyfikatory w kodzie po angielsku; komentarze i komunikaty dla użytkownika po polsku.** Dotyczy też nazw nowych plików.
- **`build/installer.nsh` bez polskich znaków diakrytycznych** — tak jak dziś („dzialajacym", nie „działającym"). NSIS ma z nimi problemy z kodowaniem. Myślnik `—` w komentarzach jest w porządku, występuje w pliku dziś.
- **W NSIS nie używaj skoków względnych (`+2`) przed `!insertmacro`.** Makro rozwija się do wielu instrukcji, więc skok wylądowałby w jego środku. Zawsze etykieta.
- **Wyjątek od reguły angielskich identyfikatorów: etykiety i makra w `build/installer.nsh` zostają po polsku** (`wpisz_dll`, `odsun_stary`, `pomin_sprawdzenie_ts3`), spójnie z tym, co w pliku już jest (`sprawdz_`, `zablokowany_`, `koniec_`, makro `SprawdzTS3`). Ustalone 2026-08-07: mieszanka dwóch konwencji w jednym 60-liniowym pliku czyta się gorzej niż konsekwentna jedna. **To nie jest usterka do zgłoszenia w przeglądzie.**
- **Testy jednostkowe (`test/*.test.ts`) nie mogą importować `electron` ani `electron-updater`.** Vitest chodzi w gołym Node, bez konfiguracji — patrz `test/cli.test.ts`, importy są względne (`../src/...`).
- **Zero zmian w protokole sygnalizacji**, `src/renderer/hooks/useLobby.ts`, `src/renderer/webrtc/session.ts`, `src/renderer/signaling/SignalingClient.ts`, `signaling-server/`, `plugin/src/plugin.c`.
- **Rejestr `$0` w NSIS jest współdzielony z electron-builderem** — każde użycie w `Push`/`Pop`.
- Platforma docelowa: **wyłącznie Windows**.
- `electron-updater` w wersji **^6.8.9**, jako `dependencies` (nie `devDependencies`) — jest importowany przez main process w czasie działania.
- Wersja pierwszego wydania z autoaktualizacją: **0.2.0**.
- Repozytorium GitHub: **`PandakiraDev/ts3_plugin_screenshare`** (publiczne).
- Komunikaty commitów po polsku, konwencja `typ: opis` jak w historii repo.
- Wszystkie polecenia uruchamiane z katalogu `companion-app/`.

## File Structure

| Plik | Odpowiedzialność | Zadanie |
|---|---|---|
| `src/shared/update.ts` | **Nowy.** Typ stanu, reduktor zdarzeń, tekst paska. Zero zależności. | 1 |
| `test/update.test.ts` | **Nowy.** Testy jednostkowe powyższego. | 1 |
| `src/shared/ipc.ts` | Modyfikacja: trzy nowe stałe kanałów. | 2 |
| `src/main/update.ts` | **Nowy.** Jedyne miejsce dotykające `electron-updater`. | 2 |
| `src/main/index.ts` | Modyfikacja: wywołanie `registerUpdates`. | 2 |
| `src/preload/index.ts` | Modyfikacja: trzy metody w moście. | 2 |
| `src/renderer/hooks/useAppUpdate.ts` | **Nowy.** Subskrypcja stanu + numer wersji. | 3 |
| `src/renderer/components/UpdateNotice.tsx` | **Nowy.** Pasek + plakietka wersji. | 3 |
| `src/renderer/App.tsx` | Modyfikacja: hook, przekazanie props, plakietka. | 3 |
| `src/renderer/components/LobbyView.tsx` | Modyfikacja: props, plakietka, pasek. | 3 |
| `src/renderer/styles.css` | Modyfikacja: `.app__version`, `.app__update`. | 3 |
| `e2e/dll-lock.mjs` | **Nowy.** Blokada DLL przez proces pomocniczy — wspólna dla obu sprawdzianów. | 4 |
| `e2e/dll-swap.mjs` | **Nowy.** Charakteryzacja zachowania Windows przy załadowanym DLL. | 4 |
| `e2e/silent-install.mjs` | **Nowy.** Cichy instalator na zablokowanym DLL. | 5 |
| `build/installer.nsh` | Modyfikacja: wyciszenie nagu + podmiana przez `.old`. | 6 |
| `electron-builder.yml` | Modyfikacja: sekcja `publish`. | 7 |
| `scripts/publish.mjs` | **Nowy.** Wydanie jednym poleceniem. | 7 |
| `package.json` | Modyfikacja: zależność, skrypty, wersja. | 2, 7, 8 |
| `README.md`, `TODO.md` | Modyfikacja: opis wydawania i zamknięcie zadania 3.1. | 8 |

---

### Task 1: Czysta logika stanu aktualizacji

Cały „mózg" tej funkcji w jednym pliku bez zależności. Wszystko, co poniżej, jest tylko okablowaniem.

**Files:**
- Create: `companion-app/src/shared/update.ts`
- Test: `companion-app/test/update.test.ts`

**Interfaces:**
- Consumes: nic.
- Produces:
  - `interface UpdateState { readyVersion: string | null }`
  - `type UpdateEvent = { type: 'checking' } | { type: 'not-available' } | { type: 'downloaded'; version: string } | { type: 'error' }`
  - `const NO_UPDATE: UpdateState`
  - `function reduceUpdate(state: UpdateState, event: UpdateEvent): UpdateState`
  - `function updateNoticeText(state: UpdateState): string | null`

- [ ] **Step 1: Napisz test, który ma nie przejść**

Utwórz `companion-app/test/update.test.ts`:

```ts
import { expect, test } from 'vitest'
import { NO_UPDATE, reduceUpdate, updateNoticeText } from '../src/shared/update'

test('bez pobranej aktualizacji pasek się nie pokazuje', () => {
  expect(updateNoticeText(NO_UPDATE)).toBeNull()
})

test('pobrana wersja trafia do tekstu paska', () => {
  const state = reduceUpdate(NO_UPDATE, { type: 'downloaded', version: '0.3.0' })
  expect(state.readyVersion).toBe('0.3.0')
  expect(updateNoticeText(state)).toContain('0.3.0')
})

test('błąd sprawdzania nie kasuje już pobranej wersji', () => {
  // Reguła nieoczywista i jedyny prawdziwy powód, żeby ten reduktor istniał.
  // Plik leży już na dysku i zainstaluje się po wyjściu z aplikacji. Nieudane
  // jest KOLEJNE sprawdzenie, nie ta aktualizacja — schowanie paska
  // okłamałoby użytkownika.
  const downloaded = reduceUpdate(NO_UPDATE, { type: 'downloaded', version: '0.3.0' })
  const afterError = reduceUpdate(downloaded, { type: 'error' })
  expect(afterError.readyVersion).toBe('0.3.0')
})

test('sprawdzanie i brak nowej wersji nie pokazują niczego', () => {
  expect(updateNoticeText(reduceUpdate(NO_UPDATE, { type: 'checking' }))).toBeNull()
  expect(updateNoticeText(reduceUpdate(NO_UPDATE, { type: 'not-available' }))).toBeNull()
})

test('błąd bez wcześniejszego pobrania nie wyczarowuje paska', () => {
  expect(updateNoticeText(reduceUpdate(NO_UPDATE, { type: 'error' }))).toBeNull()
})
```

- [ ] **Step 2: Uruchom test i potwierdź, że nie przechodzi**

```bash
cd companion-app && npx vitest run test/update.test.ts
```

Oczekiwane: FAIL — `Failed to resolve import "../src/shared/update"`.

- [ ] **Step 3: Napisz minimalną implementację**

Utwórz `companion-app/src/shared/update.ts`:

```ts
/**
 * Stan aktualizacji widziany przez interfejs.
 *
 * Celowo minimalny: użytkownika interesuje wyłącznie to, czy coś czeka na
 * instalację. Postęp sprawdzania i pobierania jest szumem w oknie, które służy
 * do udostępniania ekranu — dlatego nie ma go w tym typie.
 */
export interface UpdateState {
  /** Wersja gotowa do instalacji; null = nic nie czeka. */
  readyVersion: string | null
}

/** Zdarzenia z `electron-updater`, przetłumaczone na kształt niezależny od niego. */
export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'not-available' }
  | { type: 'downloaded'; version: string }
  | { type: 'error' }

export const NO_UPDATE: UpdateState = { readyVersion: null }

/**
 * Jedyna reguła nieoczywista: `error` NIE kasuje pobranej wersji. Plik leży już
 * na dysku i zainstaluje się po wyjściu z aplikacji, więc nieudane jest kolejne
 * sprawdzenie, a nie ta aktualizacja. Schowanie paska byłoby kłamstwem.
 */
export function reduceUpdate(state: UpdateState, event: UpdateEvent): UpdateState {
  if (event.type === 'downloaded') return { readyVersion: event.version }
  return state
}

/** Tekst paska, albo null gdy nie ma czego pokazywać. */
export function updateNoticeText(state: UpdateState): string | null {
  if (state.readyVersion === null) return null
  return `Pobrano wersję ${state.readyVersion} — zainstaluje się po zamknięciu tego okna.`
}
```

- [ ] **Step 4: Uruchom testy i potwierdź, że przechodzą**

```bash
cd companion-app && npm test
```

Oczekiwane: PASS — wszystkie pliki testowe, w tym pięć nowych przypadków.

- [ ] **Step 5: Commit**

```bash
git add companion-app/src/shared/update.ts companion-app/test/update.test.ts
git commit -m "feat(update): stan aktualizacji jako czysty reduktor"
```

---

### Task 2: Okablowanie main process i mostu do renderera

**Files:**
- Modify: `companion-app/package.json` (dodanie zależności)
- Modify: `companion-app/src/shared/ipc.ts` (dopisanie na końcu)
- Create: `companion-app/src/main/update.ts`
- Modify: `companion-app/src/main/index.ts:155-201` (blok `app.whenReady`)
- Modify: `companion-app/src/preload/index.ts`

**Interfaces:**
- Consumes: `NO_UPDATE`, `reduceUpdate`, `UpdateEvent`, `UpdateState` z Zadania 1.
- Produces:
  - `function registerUpdates(getWindow: () => BrowserWindow | null): void`
  - stałe `IPC_GET_VERSION`, `IPC_GET_UPDATE_STATE`, `IPC_UPDATE_STATE`
  - w `window.companion`: `getAppVersion(): Promise<string>`, `getUpdateState(): Promise<UpdateState>`, `onUpdateState(callback: (state: UpdateState) => void): () => void`

- [ ] **Step 1: Zainstaluj electron-updater**

```bash
cd companion-app && npm install --save --no-audit --no-fund electron-updater@^6.8.9
```

Sprawdź, że wpis wylądował w `dependencies`, a nie `devDependencies` — main process importuje go w czasie działania. electron-builder pakuje zależności produkcyjne automatycznie, więc w `electron-builder.yml` nic nie trzeba dopisywać.

- [ ] **Step 2: Dopisz stałe kanałów IPC**

Na końcu `companion-app/src/shared/ipc.ts`:

```ts
/** Numer wersji aplikacji — do plakietki w nagłówku. */
export const IPC_GET_VERSION = 'app:version'

/**
 * Stan aktualizacji. Dwa kanały, bo renderer montuje się później niż main:
 * zdarzenie `update-downloaded` może przyjść, zanim ktokolwiek słucha, więc
 * `IPC_GET_UPDATE_STATE` pozwala dociągnąć stan raz na starcie, a
 * `IPC_UPDATE_STATE` niesie każdą kolejną zmianę.
 */
export const IPC_GET_UPDATE_STATE = 'update:get'
export const IPC_UPDATE_STATE = 'update:state'
```

- [ ] **Step 3: Napisz moduł aktualizacji w main process**

Utwórz `companion-app/src/main/update.ts`:

```ts
import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC_GET_UPDATE_STATE, IPC_GET_VERSION, IPC_UPDATE_STATE } from '@shared/ipc'
import { NO_UPDATE, reduceUpdate, type UpdateEvent, type UpdateState } from '@shared/update'

/**
 * Jedyne miejsce w projekcie, które dotyka `electron-updater`. Granica jest tu
 * celowo: vitest chodzi w gołym Node, więc wszystko, co importuje Electrona,
 * jest poza zasięgiem testów jednostkowych. Logika siedzi w `@shared/update`.
 *
 * Instalacja dzieje się po WYJŚCIU z aplikacji, nie przez restart z instalatora.
 * Powód: argumenty `--ts3-server` / `--channel` / `--nick` przychodzą od wtyczki
 * przez CreateProcessW, a aplikacja wskrzeszona przez instalator dostałaby pustą
 * linię poleceń i wstała w trybie samodzielnym, poza kanałem.
 */
export function registerUpdates(getWindow: () => BrowserWindow | null): void {
  let state: UpdateState = NO_UPDATE

  ipcMain.handle(IPC_GET_VERSION, () => app.getVersion())
  ipcMain.handle(IPC_GET_UPDATE_STATE, () => state)

  function apply(event: UpdateEvent): void {
    state = reduceUpdate(state, event)
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC_UPDATE_STATE, state)
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => apply({ type: 'checking' }))
  autoUpdater.on('update-not-available', () => apply({ type: 'not-available' }))
  autoUpdater.on('update-downloaded', (info) => {
    apply({ type: 'downloaded', version: info.version })
  })
  // JEDYNE miejsce, w którym logujemy awarie. electron-updater przy nieudanym
  // sprawdzeniu robi `emit("error", …)` ORAZ `throw` (AppUpdater.js), więc
  // logowanie także w `.catch()` niżej dawałoby dwie linie na jedną awarię.
  // Ten handler jest szerszy: lapie tez bledy, ktorych tamta obietnica nie
  // widzi — np. nieudane pobieranie, ktore rusza samo po udanym sprawdzeniu.
  autoUpdater.on('error', (error: Error) => {
    // Cicho do konsoli. Brak sieci i brak wydań to normalny stan aplikacji,
    // nie awaria — komunikat o tym byłby szumem w oknie do udostępniania ekranu.
    console.warn('[update] sprawdzenie aktualizacji nie powiodlo sie:', error.message)
    apply({ type: 'error' })
  })

  // W trybie deweloperskim electron-updater przerywa z "dev-app-update.yml not
  // found". To poprawne: aktualizować można tylko to, co zostało zainstalowane.
  // Uchwyty IPC rejestrujemy mimo to — plakietka wersji ma działać także w dev.
  if (!app.isPackaged) return

  // Świadomie NIE checkForUpdatesAndNotify: to pokazuje powiadomienie systemowe,
  // które dublowałoby nasz własny pasek.
  // `.catch` jest tu WYLACZNIE po to, zeby odrzucona obietnica nie wyszla jako
  // nieobsluzona. Celowo milczy: to nie jest polkniety blad — ta sama awaria
  // przeszla juz przez handler `on('error')` wyzej, ktory ja zalogowal.
  void autoUpdater.checkForUpdates().catch(() => {})
}
```

- [ ] **Step 4: Podłącz to w main process**

W `companion-app/src/main/index.ts` dopisz import obok istniejącego `registerAppAudio` (linia 13):

```ts
import { registerUpdates } from './update'
```

W bloku `app.whenReady()`, bezpośrednio pod `registerAppAudio()` (linia 165):

```ts
  registerAppAudio()
  // Getter, a nie referencja do okna: `activate` na macOS potrafi utworzyć nowe
  // okno, a rejestracja uchwytów IPC może się odbyć tylko raz.
  registerUpdates(() => BrowserWindow.getAllWindows()[0] ?? null)
```

- [ ] **Step 5: Rozszerz most w preloadzie**

W `companion-app/src/preload/index.ts` dopisz do importu z `electron` typ zdarzenia oraz nowe stałe:

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
```

```ts
import {
  IPC_AUDIO_PORT,
  IPC_AUDIO_START,
  IPC_AUDIO_STOP,
  IPC_GET_API_KEY,
  IPC_GET_LAUNCH,
  IPC_GET_SOURCES,
  IPC_GET_UPDATE_STATE,
  IPC_GET_VERSION,
  IPC_SET_API_KEY,
  IPC_SET_CAPTURE_TARGET,
  IPC_UPDATE_STATE
} from '@shared/ipc'
import type { UpdateState } from '@shared/update'
```

Do obiektu `api`, po `stopAppAudio`:

```ts
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC_GET_VERSION),
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke(IPC_GET_UPDATE_STATE),
  /** Zwraca funkcję odsubskrybowania — bez niej `useEffect` zostawiłby wyciek. */
  onUpdateState: (callback: (state: UpdateState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: UpdateState): void => callback(state)
    ipcRenderer.on(IPC_UPDATE_STATE, listener)
    return () => {
      ipcRenderer.off(IPC_UPDATE_STATE, listener)
    }
  }
```

- [ ] **Step 6: Sprawdź typy i budowę**

```bash
cd companion-app && npm run build
```

Oczekiwane: `tsc --noEmit` bez błędów, a `electron-vite build` kończy się sukcesem dla `main`, `preload` i `renderer`.

- [ ] **Step 7: Sprawdź, że testy jednostkowe dalej przechodzą**

```bash
cd companion-app && npm test
```

Oczekiwane: PASS. Gdyby vitest próbował rozwiązać `electron`, znaczyłoby to, że któryś plik testowy sięgnął po `src/main/` — granica z Global Constraints została naruszona.

- [ ] **Step 8: Commit**

```bash
git add companion-app/package.json companion-app/package-lock.json companion-app/src/shared/ipc.ts companion-app/src/main/update.ts companion-app/src/main/index.ts companion-app/src/preload/index.ts
git commit -m "feat(update): sprawdzanie i pobieranie aktualizacji w main process"
```

---

### Task 3: Pasek aktualizacji i numer wersji w interfejsie

**Files:**
- Create: `companion-app/src/renderer/hooks/useAppUpdate.ts`
- Create: `companion-app/src/renderer/components/UpdateNotice.tsx`
- Modify: `companion-app/src/renderer/App.tsx`
- Modify: `companion-app/src/renderer/components/LobbyView.tsx:14-24, 183-190, 242-251`
- Modify: `companion-app/src/renderer/styles.css`

**Interfaces:**
- Consumes: `updateNoticeText`, `NO_UPDATE`, `UpdateState` (Zadanie 1); `getAppVersion`, `getUpdateState`, `onUpdateState` (Zadanie 2).
- Produces:
  - `function useAppUpdate(): { version: string; update: UpdateState }`
  - `function AppVersion({ version }: { version: string }): JSX.Element | null`
  - `function UpdateNotice({ update }: { update: UpdateState }): JSX.Element | null`
  - `LobbyView` przyjmuje dodatkowo `version: string` i `update: UpdateState`

- [ ] **Step 1: Napisz hook**

Utwórz `companion-app/src/renderer/hooks/useAppUpdate.ts`:

```ts
import { useEffect, useState } from 'react'
import { NO_UPDATE, type UpdateState } from '@shared/update'

/**
 * Numer wersji i stan aktualizacji. Wołany raz, w `App` — stan schodzi niżej
 * propsami, żeby nie mnożyć subskrypcji tego samego kanału IPC.
 */
export function useAppUpdate(): { version: string; update: UpdateState } {
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateState>(NO_UPDATE)

  useEffect(() => {
    void window.companion.getAppVersion().then(setVersion)
    // Stan dociągamy raz na starcie, bo main mógł już dostać `update-downloaded`
    // zanim ten komponent się zamontował — sama subskrypcja by to przegapiła.
    void window.companion.getUpdateState().then(setUpdate)
    return window.companion.onUpdateState(setUpdate)
  }, [])

  return { version, update }
}
```

- [ ] **Step 2: Napisz komponenty**

Utwórz `companion-app/src/renderer/components/UpdateNotice.tsx`:

```tsx
import { updateNoticeText, type UpdateState } from '@shared/update'

/** Plakietka w nagłówku — żeby przy pytaniu "jaką masz wersję?" nikt nie zgadywał. */
export function AppVersion({ version }: { version: string }): JSX.Element | null {
  if (!version) return null
  return <span className="app__version">v{version}</span>
}

/**
 * Pasek pojawia się WYŁĄCZNIE wtedy, gdy plik jest już na dysku i naprawdę się
 * zainstaluje. Sprawdzanie, pobieranie i błędy idą do konsoli — patrz
 * `src/main/update.ts`.
 */
export function UpdateNotice({ update }: { update: UpdateState }): JSX.Element | null {
  const text = updateNoticeText(update)
  if (!text) return null
  return <div className="app__update">{text}</div>
}
```

- [ ] **Step 3: Dodaj style**

W `companion-app/src/renderer/styles.css`, zaraz po regule `.app__stage-tag` (linia 65-68):

```css
.app__version {
  font-size: 11px;
  color: var(--text-muted);
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

/* Pasek aktualizacji: informacja, nie błąd — stąd stonowane tło paska
   udostępniania zamiast czerwieni z .notice--error. */
.app__update {
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
  background: #232428;
  color: var(--text-muted);
  font-size: 13px;
  flex-shrink: 0;
}
```

- [ ] **Step 4: Podłącz w App.tsx**

W `companion-app/src/renderer/App.tsx` dopisz importy:

```tsx
import type { UpdateState } from '@shared/update'
import { useAppUpdate } from './hooks/useAppUpdate'
import { AppVersion, UpdateNotice } from './components/UpdateNotice'
```

W `App()`, zaraz pod `const [launch, setLaunch] = useState<LaunchParseResult | null>(null)`:

```tsx
  const { version, update } = useAppUpdate()
```

W gałęzi błędu argumentów (nagłówek w linii 32-34) zamień na:

```tsx
        <header className="app__titlebar">
          <h1 className="app__title">TS3 Screen Share</h1>
          <AppVersion version={version} />
        </header>
```

Zamień dwie linie rozgałęzienia (45-46):

```tsx
  if (launch.options.mode === 'lobby') {
    return <LobbyView options={launch.options} version={version} update={update} />
  }
  return <StandaloneApp version={version} update={update} />
```

Zmień sygnaturę `StandaloneApp` i jej nagłówek:

```tsx
function StandaloneApp({
  version,
  update
}: {
  version: string
  update: UpdateState
}): JSX.Element {
```

```tsx
      <header className="app__titlebar">
        <h1 className="app__title">TS3 Screen Share</h1>
        <AppVersion version={version} />
        <span className="app__stage-tag">tryb samodzielny · lokalny podgląd</span>
      </header>

      <UpdateNotice update={update} />
```

- [ ] **Step 5: Podłącz w LobbyView.tsx**

Dopisz importy:

```tsx
import type { UpdateState } from '@shared/update'
import { AppVersion, UpdateNotice } from './UpdateNotice'
```

Rozszerz propsy (linie 14-16) i sygnaturę (linia 24):

```tsx
interface LobbyViewProps {
  options: LaunchOptions
  version: string
  update: UpdateState
}
```

```tsx
export function LobbyView({ options, version, update }: LobbyViewProps): JSX.Element {
```

W nagłówku, pod `<h1 className="app__title">TS3 Screen Share</h1>` (linia 186):

```tsx
        <AppVersion version={version} />
```

Bezpośrednio nad blokiem `{cameraErrorText && (` (linia 242):

```tsx
      <UpdateNotice update={update} />
```

- [ ] **Step 6: Sprawdź typy i budowę**

```bash
cd companion-app && npm run build
```

Oczekiwane: brak błędów. `noUnusedLocals` i `noUnusedParameters` są włączone, więc każdy niewykorzystany import to błąd kompilacji.

- [ ] **Step 7: Sprawdź na oko w działającej aplikacji**

```bash
cd companion-app && npm run dev
```

Oczekiwane: plakietka `v0.1.0` obok tytułu; **brak** paska aktualizacji; w konsoli main **brak** wywalonego wyjątku o `dev-app-update.yml` (bo `app.isPackaged` jest `false` i sprawdzanie w ogóle nie rusza).

- [ ] **Step 8: Commit**

```bash
git add companion-app/src/renderer/hooks/useAppUpdate.ts companion-app/src/renderer/components/UpdateNotice.tsx companion-app/src/renderer/App.tsx companion-app/src/renderer/components/LobbyView.tsx companion-app/src/renderer/styles.css
git commit -m "feat(update): pasek o gotowej aktualizacji i numer wersji w naglowku"
```

---

### Task 4: Sprawdzian założenia o przemianowaniu załadowanego DLL

Cała podmiana wtyczki stoi na jednym zachowaniu Windows: **załadowanego DLL nie da się nadpisać, ale da się przemianować.** Ten skrypt to przypina do ziemi, żeby zmiana w Windows albo blokada antywirusa nie zepsuła autoaktualizacji po cichu.

Uczciwie: **ten sprawdzian przechodzi od pierwszego uruchomienia** — nie jest cyklem RED→GREEN, bo bada zachowanie systemu, a nie nasz kod. Jego wartość jest regresyjna. Prawdziwy RED→GREEN dla instalatora jest w Zadaniach 5 i 6.

**Files:**
- Create: `companion-app/e2e/dll-lock.mjs`
- Create: `companion-app/e2e/dll-swap.mjs`
- Modify: `companion-app/package.json` (skrypt `e2e:dll-swap`)

**Interfaces:**
- Consumes: `companion-app/build/ts3_screenshare.dll` (plik istnieje w repo).
- Produces:
  - `async function lockDll(dllPath: string): Promise<{ release: () => void }>` w `e2e/dll-lock.mjs` — **Zadanie 5 też z tego korzysta**
  - `npm run e2e:dll-swap`

- [ ] **Step 1: Napisz wspólny moduł blokady**

Utwórz `companion-app/e2e/dll-lock.mjs`:

```js
// Blokada DLL na potrzeby sprawdzianow autoaktualizacji.
//
// Windows blokuje plik DLL dopiero wtedy, gdy jest ZALADOWANY jako obraz
// (LoadLibrary) — zwykle otwarcie do odczytu nie wystarczy. Node tego nie
// potrafi: process.dlopen przyjmuje wylacznie dodatki N-API, a plugin TS3 nim
// nie jest. Stad proces pomocniczy w PowerShellu.
//
// Wspolny modul, bo blokady potrzebuja dwa sprawdziany: dll-swap.mjs (sam
// mechanizm) i silent-install.mjs (caly instalator). Ten sam wzorzec co
// e2e/cdp.mjs, ktory jest wspolnym harnessem dla sprawdzianow w Electronie.
import { spawn } from 'node:child_process'

const LOAD_TIMEOUT_MS = 30_000

/**
 * Laduje DLL w osobnym procesie i trzyma go, dopoki nie zawolasz release().
 *
 * Rzuca, gdy LoadLibraryW odmowi — sprawdzian bez PRAWDZIWEJ blokady niczego
 * nie dowodzi, wiec lepiej przerwac niz zaraportowac falszywy sukces.
 */
export async function lockDll(dllPath) {
  // Apostrofy w sciezce podwajamy — PowerShell tak escapuje w napisach
  // pojedynczo cytowanych.
  const script = `
Add-Type -Name N -Namespace W -MemberDefinition '[DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibraryW(string p);'
$h = [W.N]::LoadLibraryW('${dllPath.replace(/'/g, "''")}')
if ($h -eq [IntPtr]::Zero) { Write-Output 'LOAD-FAILED'; exit 1 }
Write-Output 'LOADED'
while ($true) { Start-Sleep -Seconds 3600 }
`

  const holder = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      holder.kill()
      reject(new Error(`proces pomocniczy nie zaladowal DLL w ${LOAD_TIMEOUT_MS / 1000} s`))
    }, LOAD_TIMEOUT_MS)

    holder.stdout.on('data', (chunk) => {
      const text = String(chunk)
      if (text.includes('LOADED')) {
        clearTimeout(timer)
        resolve()
      }
      if (text.includes('LOAD-FAILED')) {
        clearTimeout(timer)
        holder.kill()
        reject(new Error('LoadLibraryW odmowil zaladowania DLL — sprawdzian bylby bezwartosciowy'))
      }
    })
  })

  return { release: () => holder.kill() }
}
```

- [ ] **Step 2: Napisz skrypt sprawdzianu**

Utwórz `companion-app/e2e/dll-swap.mjs`:

```js
// Sprawdzian założenia, na którym stoi cicha aktualizacja wtyczki.
//
// Podczas autoaktualizacji TeamSpeak ZAWSZE działa — to on uruchomił aplikację
// przez CreateProcessW — więc ts3_screenshare.dll jest załadowany i zablokowany.
// Instalator nie może go nadpisać, ale MOŻE go przemianować. Na tym opiera się
// cała podmiana wtyczki (patrz build/installer.nsh i spec zadania 3.1).
//
// Ten skrypt bada zachowanie Windows, nie nasz kod, więc przechodzi od pierwszego
// uruchomienia. Jest po to, żeby zmiana w systemie albo blokada antywirusa nie
// zepsuła autoaktualizacji po cichu.
//
// Blokadę trzyma proces pomocniczy z LoadLibraryW (e2e/dll-lock.mjs) —
// uruchomiony TeamSpeak nie jest potrzebny. Pracujemy na KOPII w katalogu
// tymczasowym, nigdy na pliku zainstalowanym w %APPDATA%.
//
// Uruchomienie: npm run e2e:dll-swap
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockDll } from './dll-lock.mjs'

const SOURCE_DLL = join(import.meta.dirname, '..', 'build', 'ts3_screenshare.dll')

const workDir = mkdtempSync(join(tmpdir(), 'dll-swap-'))
const dllPath = join(workDir, 'ts3_screenshare.dll')
const oldPath = `${dllPath}.old`

copyFileSync(SOURCE_DLL, dllPath)
const originalBytes = readFileSync(dllPath)

const failures = []
function check(name, condition, detail) {
  if (condition) {
    console.log(`  OK   ${name}`)
  } else {
    console.log(`  BLAD ${name} — ${detail}`)
    failures.push(name)
  }
}

const lock = await lockDll(dllPath)

try {
  console.log('DLL zaladowany przez proces pomocniczy — zaczynam sprawdzian.\n')

  // 1. Nadpisanie MUSI się nie udać. Gdyby się udało, cała ostrożność
  //    instalatora byłaby zbędna — ale i tak nieszkodliwa.
  let overwriteRefused = false
  try {
    writeFileSync(dllPath, Buffer.from([1, 2, 3]))
  } catch {
    overwriteRefused = true
  }
  check('nadpisanie zaladowanego DLL odrzucone', overwriteRefused, 'zapis sie udal')

  // 2. Przemianowanie MUSI się udać — to jest sedno mechanizmu.
  let renamed = false
  let renameError = ''
  try {
    renameSync(dllPath, oldPath)
    renamed = true
  } catch (err) {
    renameError = String(err)
  }
  check('przemianowanie zaladowanego DLL na .old', renamed, renameError)

  // 3. Nowy plik pod starą nazwą — to robi instalator zaraz po przemianowaniu.
  const newBytes = Buffer.from([9, 9, 9])
  let wroteNew = false
  try {
    writeFileSync(dllPath, newBytes)
    wroteNew = true
  } catch (err) {
    check('zapis nowego DLL pod stara nazwa', false, String(err))
  }
  if (wroteNew) {
    check('zapis nowego DLL pod stara nazwa', true)
    check(
      'nowy plik ma nowa tresc',
      readFileSync(dllPath).equals(newBytes),
      'tresc sie nie zgadza'
    )
  }

  // 4. Stary plik nietkniety — TeamSpeak dalej go wykonuje aż do restartu.
  if (renamed) {
    check(
      'stary DLL zachowany bajt w bajt pod .old',
      readFileSync(oldPath).equals(originalBytes),
      'tresc .old rozni sie od oryginalu'
    )
  }
} finally {
  lock.release()
  // Ubicie procesu jest asynchroniczne — Windows moze jeszcze przez chwile
  // trzymac zamapowany obraz, wiec kasowanie z ponowieniami. Zaleglosc
  // w katalogu tymczasowym jest nieszkodliwa, wiec bledu tu nie eskalujemy.
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    console.warn(`Nie udalo sie posprzatac ${workDir} — mozna skasowac recznie.`)
  }
}

if (failures.length > 0) {
  console.error(`\nNIEUDANE: ${failures.length} — autoaktualizacja wtyczki nie ma sie na czym oprzec.`)
  process.exit(1)
}
console.log('\nWszystko przeszlo. Mechanizm podmiany wtyczki ma podstawy.')
```

- [ ] **Step 3: Dodaj skrypt npm**

W `companion-app/package.json`, w `scripts`, po `"e2e:audio"`:

```json
    "e2e:dll-swap": "node e2e/dll-swap.mjs",
```

- [ ] **Step 4: Uruchom i potwierdź, że przechodzi**

```bash
cd companion-app && npm run e2e:dll-swap
```

Oczekiwane: cztery-pięć linii `OK`, kod wyjścia 0, katalog tymczasowy posprzątany.

Gdyby `LoadLibraryW` odmówił załadowania — skrypt kończy się błędem zamiast udawać sukces. To celowe: sprawdzian bez prawdziwej blokady niczego nie dowodzi.

- [ ] **Step 5: Commit**

```bash
git add companion-app/e2e/dll-lock.mjs companion-app/e2e/dll-swap.mjs companion-app/package.json
git commit -m "test(update): sprawdzian przemianowania zaladowanego DLL wtyczki"
```

---

### Task 5: Sprawdzian cichego instalatora — stan RED

> **BRAMKA UPRAWNIEŃ.** Kroki 3-4 **naprawdę uruchamiają instalator** i dotykają `%APPDATA%\TS3Client\plugins` oraz `%LOCALAPPDATA%\Programs`. Nie wykonuj ich bez wyraźnej zgody właściciela projektu. Kroki 1-2 (napisanie skryptu) są bezpieczne i wykonuje się je zawsze.
>
> Uruchomienie RED jest bezpieczniejsze, niż wygląda: dzisiejszy `MessageBox` siedzi w `.onInit`, czyli **zanim** instalator cokolwiek zapisze. Ubicie procesu po przekroczeniu limitu czasu zostawia istniejącą instalację nietkniętą.

**Files:**
- Create: `companion-app/e2e/silent-install.mjs`
- Modify: `companion-app/package.json` (skrypt `e2e:silent-install`)

**Interfaces:**
- Consumes: `lockDll(dllPath)` z `e2e/dll-lock.mjs` (Zadanie 4) — zwraca `{ release: () => void }`; zbudowany `companion-app/release/TS3-Screen-Share-Setup-*.exe`.
- Produces: `npm run e2e:silent-install`.

- [ ] **Step 1: Napisz skrypt**

Utwórz `companion-app/e2e/silent-install.mjs`:

```js
// Cichy instalator na ZABLOKOWANYM DLL wtyczki — dokładnie sytuacja każdej
// autoaktualizacji: TeamSpeak działa, więc ts3_screenshare.dll jest załadowany.
//
// UWAGA: TEN SKRYPT NAPRAWDĘ INSTALUJE APLIKACJĘ. Dotyka
// %LOCALAPPDATA%\Programs i %APPDATA%\TS3Client\plugins. Nie wchodzi do
// `npm test` i nie uruchamia się sam.
//
// Blokadę DLL trzyma proces pomocniczy z LoadLibraryW, więc uruchomiony
// TeamSpeak nie jest potrzebny.
//
// Co dokładnie sprawdzamy:
//   1. instalator KOŃCZY SIĘ w rozsądnym czasie — przed poprawką wisi na
//      MessageBoksie "zamknij TeamSpeaka", bo MessageBox w NSIS wyświetla się
//      także przy /S;
//   2. powstał ts3_screenshare.dll.old ze STARĄ zawartością — dowód, że poszła
//      ścieżka z przemianowaniem, a nie zwykłe nadpisanie;
//   3. DRUGI cichy przebieg BEZ zwalniania blokady też przechodzi. To realny
//      przypadek "dwie aktualizacje bez restartu TeamSpeaka": .old jest wtedy
//      zablokowany i nie da się go skasować, a ts3_screenshare.dll to już nowy
//      plik, którego nikt nie trzyma — instalator musi pójść zwykłym
//      nadpisaniem i nie próbować przemianowywać na zajętą nazwę.
//
// Uruchomienie: npm run installer && npm run e2e:silent-install
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { lockDll } from './dll-lock.mjs'

const LIMIT_MS = 180_000

const pluginsDir = join(process.env.APPDATA ?? '', 'TS3Client', 'plugins')
const installedDll = join(pluginsDir, 'ts3_screenshare.dll')
const oldDll = `${installedDll}.old`

const releaseDir = join(import.meta.dirname, '..', 'release')
const setup = readdirSync(releaseDir).find(
  (name) => name.startsWith('TS3-Screen-Share-Setup-') && name.endsWith('.exe')
)
if (!setup) {
  console.error('Brak instalatora w release/. Zbuduj go: npm run installer')
  process.exit(1)
}
if (!existsSync(installedDll)) {
  console.error(`Brak ${installedDll}. Zainstaluj aplikacje recznie raz, potem wroc tutaj.`)
  process.exit(1)
}

const beforeBytes = readFileSync(installedDll)

// Sprzątamy zaległość po poprzednim przebiegu, żeby wynik był jednoznaczny.
// Jeśli się nie da (TeamSpeak trzyma stary plik), mówimy o tym wprost — wynik
// byłby wtedy nie do odczytania.
try {
  rmSync(oldDll, { force: true })
} catch {
  console.error(`Nie moge skasowac ${oldDll} — ktos go trzyma. Zamknij TeamSpeaka i sprobuj ponownie.`)
  process.exit(1)
}

// Rzucamy wyjatkiem zamiast process.exit — `finally` musi zwolnic proces
// pomocniczy, a process.exit blokow finally NIE wykonuje.
function fail(message) {
  throw new Error(message)
}

/** Jeden cichy przebieg instalatora. Zwraca kod wyjscia albo rzuca po limicie czasu. */
function runInstaller(label) {
  console.log(`\n[${label}] uruchamiam ${setup} z /S...`)
  const installer = spawn(join(releaseDir, setup), ['/S'])
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      installer.kill()
      reject(
        new Error(
          `[${label}] instalator nie skonczyl w ${LIMIT_MS / 1000} s.\n` +
            'Prawie na pewno wisi na MessageBoksie "zamknij TeamSpeaka" z customInit.\n' +
            'Przed poprawka w build/installer.nsh to jest OCZEKIWANY stan RED.'
        )
      )
    }, LIMIT_MS)
    installer.on('exit', (code) => {
      clearTimeout(timer)
      console.log(`[${label}] instalator zakonczyl sie z kodem ${code}.`)
      resolve(code)
    })
  })
}

const lock = await lockDll(installedDll)

try {
  console.log('DLL zablokowany przez proces pomocniczy.')

  // PRZEBIEG 1 — zablokowany DLL, spodziewamy sie sciezki z przemianowaniem.
  await runInstaller('przebieg 1')

  if (!existsSync(oldDll)) {
    fail(`nie powstal ${oldDll} — sciezka z przemianowaniem sie nie wykonala`)
  }
  if (!readFileSync(oldDll).equals(beforeBytes)) {
    fail('.old nie zawiera starego DLL')
  }
  if (!existsSync(installedDll)) {
    fail(`nie ma ${installedDll} — instalator nie polozyl nowego pliku`)
  }
  console.log('  OK  stary DLL czeka w .old, nowy lezy pod wlasciwa nazwa')

  // PRZEBIEG 2 — bez zwalniania blokady. To "dwie aktualizacje bez restartu
  // TeamSpeaka": .old jest zajety i nie da sie go skasowac, ale
  // ts3_screenshare.dll to juz nowy plik, ktorego nikt nie trzyma — instalator
  // ma pojsc zwyklym nadpisaniem, a NIE probowac przemianowac na zajete .old.
  await runInstaller('przebieg 2')

  if (!readFileSync(oldDll).equals(beforeBytes)) {
    fail('.old zmienil sie w drugim przebiegu — cos nadpisalo zablokowany plik')
  }
  if (!existsSync(installedDll)) {
    fail(`nie ma ${installedDll} po drugim przebiegu`)
  }
  console.log('  OK  drugi przebieg bez restartu TS3 tez przeszedl')

  console.log('\nOK: cichy instalator dziala przy zablokowanym DLL, dwa razy z rzedu.')
} catch (err) {
  console.error(`\nBLAD: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  lock.release()
}
```

- [ ] **Step 2: Dodaj skrypt npm**

W `companion-app/package.json`, w `scripts`, po `"e2e:dll-swap"`:

```json
    "e2e:silent-install": "node e2e/silent-install.mjs",
```

- [ ] **Step 3: [ZA ZGODĄ] Zbuduj obecny instalator**

```bash
cd companion-app && npm run installer
```

Oczekiwane: powstaje `release/TS3-Screen-Share-Setup-0.1.0.exe` (numer zależy od `package.json`).

- [ ] **Step 4: [ZA ZGODĄ] Uruchom sprawdzian i potwierdź RED**

```bash
cd companion-app && npm run e2e:silent-install
```

Oczekiwane: **FAIL po 180 sekundach** z komunikatem o wiszącym instalatorze. To jest dowód, że problem opisany w specu istnieje naprawdę, a nie tylko w teorii.

Gdyby przeszedł na zielono — zatrzymaj się i wyjaśnij dlaczego, zanim ruszysz Zadanie 6. Najbardziej prawdopodobny powód: DLL nie był realnie zablokowany.

- [ ] **Step 5: Commit**

```bash
git add companion-app/e2e/silent-install.mjs companion-app/package.json
git commit -m "test(update): sprawdzian cichego instalatora przy zablokowanym DLL"
```

---

### Task 6: Podmiana wtyczki w instalatorze — stan GREEN

**Files:**
- Modify: `companion-app/build/installer.nsh:41-65`

**Interfaces:**
- Consumes: sprawdzian z Zadania 5.
- Produces: instalator, który przy cichym uruchomieniu nie pokazuje dialogu i podmienia zablokowany DLL przez `.old`.

- [ ] **Step 1: Wycisz nag przy cichej instalacji**

W `companion-app/build/installer.nsh` zamień makro `customInit`:

```nsis
!macro customInit
  ; Autoaktualizacja leci z /S i NIE MA PRAWA pokazac zadnego dialogu — nikt by
  ; go nie kliknal, a instalator wisialby w nieskonczonosc. Przy cichym
  ; przebiegu zablokowany DLL nie jest bledem, tylko normalnym stanem:
  ; TeamSpeak dziala, bo to on uruchomil aplikacje. Obsluga jest w customInstall.
  ;
  ; ETYKIETA, nie skok wzgledny: !insertmacro rozwija sie do wielu instrukcji,
  ; wiec "IfSilent +2" wladowaloby sie w srodek makra.
  IfSilent pomin_sprawdzenie_ts3 0
    !insertmacro SprawdzTS3 "init"
  pomin_sprawdzenie_ts3:
!macroend
```

- [ ] **Step 2: Dodaj podmianę przez .old**

Zamień makro `customInstall`:

```nsis
!macro customInstall
  SetOutPath "${TS3_PLUGINS}"

  ; $0 jest rejestrem WSPOLDZIELONYM - electron-builder sam z niego korzysta.
  Push $0

  ; Zostalosc po poprzedniej cichej podmianie. Windows zwalnia ten plik dopiero
  ; po restarcie TeamSpeaka, wiec kasujemy "jak sie uda" i nie sprawdzamy wyniku.
  Delete "${TS3_DLL}.old"

  ; Zaladowanego DLL nie da sie NADPISAC, ale MOZNA go PRZEMIANOWAC — sprawdzone,
  ; patrz e2e/dll-swap.mjs. Rozgalezienie idzie po tym, co FAKTYCZNIE blokuje
  ; plik, a nie po trybie instalatora: przy zamknietym TS3 (instalacja reczna)
  ; leci zwykle nadpisanie i wtyczka dziala od razu, a przy zablokowanym pliku
  ; (autoaktualizacja) stary plik idzie na bok i TeamSpeak przelaczy sie na nowy
  ; przy nastepnym starcie.
  IfFileExists "${TS3_DLL}" 0 wpisz_dll
    ClearErrors
    FileOpen $0 "${TS3_DLL}" a
    IfErrors odsun_stary 0
      FileClose $0
      Goto wpisz_dll
    odsun_stary:
      Rename "${TS3_DLL}" "${TS3_DLL}.old"
  wpisz_dll:

  File "${BUILD_RESOURCES_DIR}\ts3_screenshare.dll"

  ; Pelna sciezka do .exe — po niej plugin znajduje aplikacje. Tego pliku nikt
  ; nie trzyma otwartego, wiec zwykly zapis wystarczy.
  FileOpen $0 "${TS3_PATHFILE}" w
  FileWrite $0 "$INSTDIR\${PRODUCT_FILENAME}.exe"
  FileClose $0

  Pop $0

  DetailPrint "Plugin TS3: ${TS3_PLUGINS}"
  DetailPrint "Aplikacja: $INSTDIR"
!macroend
```

`Push $0` / `Pop $0` obejmuje **oba** użycia rejestru — sprawdzenie blokady i zapis pliku ze ścieżką. Dzisiejszy kod używa `$0` przy pliku ze ścieżką bez zabezpieczenia; skoro i tak dotykamy tego makra, domykamy to przy okazji.

- [ ] **Step 3: Posprzątaj .old przy odinstalowaniu**

Zamień makro `customUnInstall`:

```nsis
!macro customUnInstall
  Delete "${TS3_DLL}"
  Delete "${TS3_DLL}.old"
  Delete "${TS3_PATHFILE}"
!macroend
```

- [ ] **Step 4: [ZA ZGODĄ] Przebuduj instalator**

```bash
cd companion-app && npm run installer
```

Oczekiwane: build przechodzi. Błąd składni NSIS wywali się właśnie tutaj.

- [ ] **Step 5: [ZA ZGODĄ] Uruchom sprawdzian i potwierdź GREEN**

```bash
cd companion-app && npm run e2e:silent-install
```

Oczekiwane: **PASS** — obydwa przebiegi w środku skryptu kończą się bez dialogu, powstaje `ts3_screenshare.dll.old` ze starą zawartością, a drugi przebieg (bez zwalniania blokady, czyli „dwie aktualizacje bez restartu TeamSpeaka") przechodzi zwykłym nadpisaniem i nie rusza zajętego `.old`.

- [ ] **Step 6: Sprawdź instalację interaktywną**

Uruchom `release/TS3-Screen-Share-Setup-*.exe` **bez** `/S`, z uruchomionym TeamSpeakiem.

Oczekiwane: dalej pojawia się dialog „Nie moge zapisac pliku wtyczki" z RETRY/CANCEL — dokładnie jak dziś. Ta ścieżka ma się **nie** zmienić: przy instalacji ręcznej chcemy, żeby wtyczka działała od razu, a nie po restarcie TS3.

- [ ] **Step 7: Commit**

```bash
git add companion-app/build/installer.nsh
git commit -m "fix(installer): cicha podmiana zablokowanego DLL wtyczki przez .old"
```

---

### Task 7: Publikacja wydań na GitHuba

**Files:**
- Modify: `companion-app/electron-builder.yml`
- Create: `companion-app/scripts/publish.mjs`
- Modify: `companion-app/package.json` (skrypt `release`)

**Interfaces:**
- Consumes: `gh auth token` (użytkownik zalogowany jako `PandakiraDev`).
- Produces: `npm run release` → szkic wydania na GitHubie z `.exe` i `latest.yml`.

- [ ] **Step 1: Dodaj sekcję publish**

W `companion-app/electron-builder.yml`, po bloku `nsis` (na końcu pliku):

```yaml
# Zrodlo aktualizacji dla electron-updater. Repozytorium jest publiczne, wiec
# uzytkownik koncowy nie potrzebuje zadnego tokenu — token jest potrzebny
# WYLACZNIE przy publikowaniu (patrz scripts/publish.mjs).
#
# electron-builder tworzy SZKIC wydania. To celowe: electron-updater szkicow nie
# widzi, wiec nikt nie dostanie aktualizacji, zanim recznie jej nie opublikujesz.
publish:
  provider: github
  owner: PandakiraDev
  repo: ts3_plugin_screenshare
```

- [ ] **Step 2: Napisz skrypt wydania**

Utwórz `companion-app/scripts/publish.mjs`:

```js
// Wydanie na GitHuba jednym poleceniem: npm run release
//
// Token bierzemy z `gh auth token`, a nie ze zmiennej środowiskowej ustawianej
// na stałe — nie ma powodu, żeby leżał gdziekolwiek na dysku. electron-builder
// czyta wyłącznie GH_TOKEN, więc podajemy mu go na czas jednego wywołania.
//
// Powstaje SZKIC wydania. Publikujesz go ręcznie na GitHubie — electron-updater
// szkiców nie widzi, więc do tego kliknięcia nikt aktualizacji nie dostanie.
//
// W wydaniu MUSZĄ wylądować dwa pliki: TS3-Screen-Share-Setup-<wersja>.exe
// ORAZ latest.yml. Bez tego drugiego electron-updater niczego nie znajdzie.
import { execFileSync } from 'node:child_process'

function run(command, args, options = {}) {
  // shell: true jest konieczne na Windows — npm, npx i gh to pliki .cmd,
  // których CreateProcess nie uruchomi bezpośrednio.
  execFileSync(command, args, { stdio: 'inherit', shell: true, ...options })
}

let token = ''
try {
  token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', shell: true }).trim()
} catch {
  token = ''
}
if (!token) {
  console.error('Nie udalo sie pobrac tokenu. Zaloguj sie: gh auth login')
  process.exit(1)
}

run('npm', ['run', 'sync:native'])
run('npm', ['run', 'build'])
run('npx', ['electron-builder', '--win', '--publish', 'always'], {
  env: { ...process.env, GH_TOKEN: token }
})

console.log('\nGotowe. Szkic wydania czeka na GitHubie:')
console.log('  https://github.com/PandakiraDev/ts3_plugin_screenshare/releases')
console.log('Sprawdz, czy sa TAM DWA pliki: .exe ORAZ latest.yml, i dopiero wtedy publikuj.')
```

- [ ] **Step 3: Dodaj skrypt npm**

W `companion-app/package.json`, w `scripts`, po `"installer"`:

```json
    "release": "node scripts/publish.mjs"
```

- [ ] **Step 4: Sprawdź, że konfiguracja się parsuje, nic nie publikując**

```bash
cd companion-app && npx electron-builder --win --publish never
```

Oczekiwane: build przechodzi. Sekcja `publish` jest wczytywana i walidowana także przy `--publish never`, więc literówka w `provider`, `owner` czy `repo` wyjdzie tutaj — bez dotykania GitHuba.

Sprawdź dodatkowo, że w `release/` powstał **`latest.yml`**. Ten plik jest generowany właśnie dzięki sekcji `publish`; jego brak oznacza, że konfiguracja nie zadziałała.

- [ ] **Step 5: Commit**

```bash
git add companion-app/electron-builder.yml companion-app/scripts/publish.mjs companion-app/package.json
git commit -m "feat(release): publikacja wydan na GitHuba jednym poleceniem"
```

---

### Task 8: Wersja 0.2.0 i dokumentacja

**Files:**
- Modify: `companion-app/package.json` (pole `version`)
- Modify: `README.md:26`
- Modify: `TODO.md:239-254`

**Interfaces:**
- Consumes: wszystko powyżej.
- Produces: repo gotowe do pierwszego wydania z autoaktualizacją.

- [ ] **Step 1: Podbij wersję**

W `companion-app/package.json` zmień `"version": "0.1.0"` na `"version": "0.2.0"`.

- [ ] **Step 2: Opisz wydawanie w README**

W `README.md` zamień linię 26 na:

```markdown
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
```

- [ ] **Step 3: Zamknij zadanie 3.1 w TODO.md**

Zastąp sekcję `### 3.1 Automatyczna aktualizacja aplikacji` (linie 239-254):

```markdown
### 3.1 Automatyczna aktualizacja aplikacji — ZROBIONE (2026-08-07)

`electron-updater` + GitHub Releases. Sprawdzanie przy starcie, pobieranie w
tle, instalacja po zamknięciu okna (`autoInstallOnAppQuit`). Sesja
udostępniania nigdy nie jest przerywana. Spec:
`docs/superpowers/specs/2026-08-07-auto-update-design.md`.

**Rzecz, której nie było w planie, a okazała się sednem zadania:** podczas
autoaktualizacji TeamSpeak ZAWSZE działa — bo to on uruchomił aplikację — więc
`ts3_screenshare.dll` jest załadowany i zablokowany. Dotychczasowy
`installer.nsh` pokazywał wtedy `MessageBox` RETRY/CANCEL, a `MessageBox` w NSIS
wyświetla się także przy `/S`: cichy instalator wisiałby przy każdym update.

Rozwiązanie: załadowanego DLL nie da się **nadpisać**, ale da się go
**przemianować** (sprawdzone, `npm run e2e:dll-swap`). Stary plik idzie na
`.old`, nowy ląduje pod właściwą nazwą, a TeamSpeak przełącza się na niego przy
następnym starcie. Rozgałęzienie w instalatorze idzie po faktycznej blokadzie
pliku, nie po trybie `/S`, więc instalacja ręczna przy zamkniętym TS3 działa
dokładnie jak wcześniej.

**Czego nie zrobiono:**

- **Restartu aplikacji z instalatora.** Argumenty `--ts3-server` / `--channel` /
  `--nick` przychodzą od wtyczki przez `CreateProcessW`; aplikacja wskrzeszona
  przez instalator dostałaby pustą linię poleceń i wstała poza kanałem.
- **Wersjonowania wtyczki.** Obie części jadą w jednym instalatorze, więc nie
  mają jak się rozjechać.
- **Podpisu kodu.** SmartScreen dalej ostrzega przy instalacji (patrz § 4).
- **Sprawdzenia na prawdziwej aktualizacji między dwoma wydaniami.** Blokadę DLL
  w `e2e/silent-install.mjs` symuluje proces z `LoadLibraryW`, a nie TeamSpeak,
  i przebieg 0.2.0 → 0.3.0 z realnym GitHubem jeszcze się nie odbył. To jedyna
  otwarta niewiadoma po tym zadaniu.
```

- [ ] **Step 4: Sprawdź, że całość dalej się buduje**

```bash
cd companion-app && npm test && npm run build
```

Oczekiwane: testy PASS, build bez błędów.

- [ ] **Step 5: Commit**

```bash
git add companion-app/package.json README.md TODO.md
git commit -m "docs: wersja 0.2.0 i opis wydawania z autoaktualizacja"
```

---

## Po planie — co zostaje do zrobienia ręcznie

Rzeczy, których żaden krok powyżej nie załatwia i które wymagają decyzji właściciela projektu:

1. **Pierwsza publikacja** (`npm run release` + ręczne opublikowanie szkicu na GitHubie). To działanie na zewnątrz — wymaga osobnej zgody.
2. **Rozesłanie 0.2.0 ręcznie.** Ostatnia ręczna instalacja w historii tego projektu.
3. **Prawdziwy sprawdzian mechanizmu** przy przejściu 0.2.0 → 0.3.0: czy pasek się pokazuje, czy aplikacja podmienia się po zamknięciu, czy wtyczka wchodzi po restarcie TS3.

---

## Po wykonaniu — w czym plan się mylił

Zapisane po zamknięciu wszystkich zadań. Kod w repo jest źródłem prawdy; te
punkty istnieją, żeby nikt nie odtworzył błędu z planu.

1. **Zadanie 6 było niekompletne i to był błąd krytyczny.** Plan wymieniał trzy
   makra do zmiany; potrzebne były cztery. Bez wyciszenia `customUnInit` cicha
   aktualizacja dalej wieszała się na `MessageBox`, tylko wychodzącym drugą
   drogą — przez stary deinstalator uruchamiany przez electron-buildera z
   `ExecWait … /S`. Pełny opis w specu, sekcja „Dlaczego punkt 4 jest
   konieczny".
2. **Zadanie 2 logowało ten sam błąd dwa razy.** `electron-updater` przy
   nieudanym sprawdzeniu robi `emit("error", …)` **i** `throw`
   (`AppUpdater.js:269-272`), a plan podpinał się do obu. Logowanie zostało
   tylko w `on('error')`.
3. **Zadanie 4: `dll-lock.mjs` w planie nie ma nasłuchu `'error'` na `spawn`.**
   Kod w repo ma. Bez tego niemożność uruchomienia PowerShella dawała
   nieobsłużony wyjątek i osierocony katalog tymczasowy.
4. **Zadanie 5: kod wyjścia instalatora był logowany, ale nie sprawdzany.**
   Instalator, który wystartował i padł, przeszedłby jako sukces. Dodane
   asercje na obu przebiegach.
5. **Zadanie 7: `--publish never` nie wykrywa literówki w `owner`/`repo`.**
   Tylko `provider` jest ograniczony schematem (`scheme.json`). Krok
   weryfikacyjny w planie obiecywał więcej, niż daje.
6. **Zadanie 4: sekcja Interfaces zakładała, że `companion-app/build/ts3_screenshare.dll`
   „istnieje w repo" — nieprawda.** Plik jest w `.gitignore`
   (`companion-app/build/*.dll`) i nieśledzony przez gita; `git ls-files` tego
   katalogu pokazuje wyłącznie `installer.nsh`. Błędne założenie przeszło
   nietknięte przez Zadania 4, 5 i 7 — żadne z nich nie sprawdza, czy DLL w
   ogóle tam jest, zanim go użyje albo spakuje. Naprawione osobno w
   `scripts/publish.mjs` (strażnik świeżości DLL przed wydaniem) i w
   `e2e/dll-swap.mjs` (czytelny komunikat zamiast gołego `ENOENT`).
