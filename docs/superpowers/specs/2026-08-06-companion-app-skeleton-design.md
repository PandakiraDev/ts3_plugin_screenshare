# Companion App Skeleton — Design (step 1)

Data: 2026-08-06
Kontekst: [ts3-screenshare-brief.md](../../../ts3-screenshare-brief.md), krok 1 z "Sugerowana kolejność implementacji".

## Cel kroku
Zbudować szkielet companion-app (Electron + React + TypeScript), który waliduje, że
lokalny capture ekranu/okna działa — bez WebRTC, bez signaling, bez pluginu.

## Decyzje
- **Build tool**: `electron-vite` (Vite pod main/preload/renderer, HMR, minimalna konfiguracja).
- **Repo layout**: zwykłe foldery z osobnym `package.json` na komponent (bez workspaces).
- **UI**: ręczny CSS, ciemny motyw zbliżony do Discorda. Bez frameworka UI.
- **Bezpieczeństwo**: `contextIsolation: true`, `nodeIntegration: false`. `desktopCapturer`
  tylko w main, wystawiony do renderera przez `contextBridge` w preload.

## Struktura repo
```
plugin_ts3_screensharing/
├─ ts3-screenshare-brief.md
├─ README.md
├─ companion-app/      # implementowane teraz
├─ signaling-server/   # placeholder
└─ plugin/             # placeholder
```

## companion-app
```
companion-app/
├─ package.json
├─ tsconfig.json / tsconfig.node.json
├─ electron.vite.config.ts
├─ electron-builder.yml            # placeholder, nie budujemy instalatora teraz
├─ .gitignore
└─ src/
   ├─ main/index.ts                # BrowserWindow + IPC getSources
   ├─ preload/index.ts             # contextBridge API
   ├─ shared/types.ts              # CaptureSource, QualitySettings (współdzielone)
   └─ renderer/
      ├─ index.html
      ├─ main.tsx
      ├─ App.tsx
      ├─ styles.css
      ├─ hooks/useCapture.ts
      └─ components/
         ├─ SourceGrid.tsx
         ├─ SourceCard.tsx
         ├─ PreviewPane.tsx
         └─ SettingsPanel.tsx
```

## Data flow
1. Main: `desktopCapturer.getSources({ types:['screen','window'], thumbnailSize })`
   → `{ id, name, thumbnailDataURL, appIconDataURL, type }[]`, przez IPC `sources:get`.
2. Renderer: grid miniaturek (sekcje Screens / Windows). Klik → `useCapture` woła
   `getUserMedia` z `chromeMediaSource:'desktop'` + `chromeMediaSourceId` → `MediaStream`
   podpięty do `<video>` w PreviewPane.
3. SettingsPanel trzyma `QualitySettings` (resolution, fps) w stanie App; zmiana restartuje
   capture z nowymi constraintami. Bitrate = pole disabled.

## Ustawienia
- Rozdzielczość: 720p / 1080p / 1440p / Source (native).
- FPS: 30 / 60.
- Bitrate: disabled, placeholder "Auto (WebRTC — soon)".

## Error handling
- Błąd/pusty `getSources` → komunikat + "Refresh".
- `getUserMedia` reject → inline error w PreviewPane, powrót do gridu.
- Zawsze zwolnić poprzednie tracki (`stop()`) przed nowym capturem i przy unmount.

## Poza zakresem
WebRTC, signaling, CLI tryb stream/watch, headless, plugin C, pakowanie instalatora.
```
