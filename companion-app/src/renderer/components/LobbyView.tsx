import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { CameraSettings, CaptureSource, QualitySettings, StreamKind } from '@shared/types'
import { CAMERA_BITRATE_KBPS, DEFAULT_CAMERA_SETTINGS, DEFAULT_QUALITY } from '@shared/types'
import type { UpdateState } from '@shared/update'
import type { LaunchOptions } from '../../shared/cli'
import { useCamera } from '../hooks/useCamera'
import { useCapture } from '../hooks/useCapture'
import { buildTiles, useLobby } from '../hooks/useLobby'
import { SourcePicker } from './SourcePicker'
import { PeerPanel } from './PeerPanel'
import { SettingsPanel } from './SettingsPanel'
import { StreamTile } from './StreamTile'
import { ApiKeyPrompt } from './ApiKeyPrompt'
import { AppVersion, UpdateNotice } from './UpdateNotice'
import { useConnectionHealth } from '../hooks/useConnectionHealth'
import { useViewerQuality } from '../hooks/useViewerQuality'
import { ConnectionNotice } from './ConnectionNotice'
import { allViewersStruggling } from '@shared/viewerQuality'
import {
  buildParticipants,
  emptyGridMessage,
  streamCountLabel,
  type EmptyGridMessage
} from '@shared/participants'
import { useLeaveTransition } from '../hooks/useLeaveTransition'
import { useDiagnosticsReporter } from '../hooks/useDiagnosticsReporter'
import { useReorderAnimation } from '../hooks/useReorderAnimation'
import { shortRoomFingerprint } from '@shared/diagnostics'
import {
  applyTileOrder,
  orderAfterDrop,
  pruneLayout,
  restoreUnrenderedKeys,
  visibleTiles,
  type TileCenter,
  type TileLayout
} from '@shared/tileLayout'
import { connectionKey } from '../webrtc/session'

const EMPTY_GRID_TEXT: Record<EmptyGridMessage, string> = {
  'nobody-streaming': 'Nikt nie nadaje obrazu. Możesz zacząć jako pierwszy.',
  connecting: 'Odbieranie obrazu…',
  'all-hidden':
    'Wszystkie strumienie są ukryte. Oczko przy nazwie w liście uczestników przywraca je.'
}

interface LobbyViewProps {
  options: LaunchOptions
  version: string
  update: UpdateState
}

/**
 * Jedno okno na wszystko. Domyślnie oglądasz to, co ktoś udostępnia; wybór
 * źródła pojawia się dopiero po kliknięciu "Udostępnij ekran", żeby lobby
 * zostało czyste. Kamera jest niezależna od ekranu — można mieć jedno, drugie
 * albo oba naraz, każde jako osobny kafelek.
 */
export function LobbyView({ options, version, update }: LobbyViewProps): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false)
  // Jedyna droga do ustawień kamery podczas trwającego udostępniania ekranu —
  // SourcePicker (a z nim SettingsPanel) jest wtedy niedostępny, bo przycisk
  // "Udostępnij ekran" zamienia się w "Zakończ udostępnianie".
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [zoomed, setZoomed] = useState<string | null>(null)
  // Zmiana klucza musi przelaczyc widok od razu, bez restartu aplikacji.
  const [apiKeyVersion, setApiKeyVersion] = useState(0)
  const [selected, setSelected] = useState<CaptureSource | null>(null)
  const [quality, setQuality] = useState<QualitySettings>(DEFAULT_QUALITY)
  const [cameraSettings, setCameraSettings] = useState<CameraSettings>(DEFAULT_CAMERA_SETTINGS)
  const [cameraEnabled, setCameraEnabled] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [cameraError, setCameraError] = useState<string | null>(null)
  /*
   * Ukryte kafelki i kolejność. BEZ zapisywania na dysk — decyzja właściciela:
   * „za każdym razem będą inni użytkownicy strimać i inna ilość użytkowników".
   * Klucze to `tileKey`, czyli `connectionKey(peerId, kind)`.
   *
   * Oba zbiory w JEDNYM stanie, bo `pruneLayout` przycina je razem: jeden
   * aktualizator i jedno wywołanie, zamiast dwóch stanów, których spójność
   * trzymałoby tylko grupowanie aktualizacji w jednym efekcie. Zagnieżdżenie
   * jednego ustawiacza w aktualizatorze drugiego odpada: aktualizator musi
   * być czysty, a w StrictMode wykonuje się dwa razy.
   */
  const [layout, setLayout] = useState<TileLayout>(() => ({ hidden: new Set(), order: [] }))
  const { hidden, order } = layout
  // Klucz przeciąganego kafelka albo `null`. Stan, a nie ref: od niego zależy
  // wygląd (przygaszony kafelek, kursor na siatce), a przeciąganie ma jedno
  // źródło prawdy zamiast pary ref plus stan, które mogłyby się rozjechać.
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  const capture = useCapture(selected, quality)
  const camera = useCamera(cameraEnabled, cameraSettings)
  const lobby = useLobby(options, apiKeyVersion)
  const viewerQuality = useViewerQuality(lobby)
  const connectionProblem = useConnectionHealth(
    lobby,
    allViewersStruggling([...viewerQuality.values()])
  )
  const { startStream, stopStream, replaceStream, applyQuality, setStreamSubscribed } = lobby

  const sharingScreen = lobby.state.myStreamKinds.includes('screen')
  const sharingCamera = lobby.state.myStreamKinds.includes('camera')

  /**
   * Kafelki: cudze strumienie plus nasze wlasne podglady. Wlasne bierzemy
   * z lokalnego capture, a nie z sieci — nie wysylamy obrazu do samych siebie.
   */
  const own: { kind: StreamKind; stream: MediaStream }[] = []
  if (sharingScreen && capture.stream) own.push({ kind: 'screen', stream: capture.stream })
  if (sharingCamera && camera.stream) own.push({ kind: 'camera', stream: camera.stream })

  const tiles = buildTiles(
    own,
    lobby.state.remoteStreams.values(),
    lobby.state.me,
    lobby.state.peers
  )

  /*
   * UWAGA: oba hooki MUSZĄ stać tutaj, przed instrukcjami `return` niżej.
   * LobbyView wychodzi wcześniej przy `bad-key` i przy otwartym wyborze źródła,
   * a hook wywołany po takim wyjściu łamie zasady Reacta i wywala aplikację
   * przy pierwszym otwarciu okna wyboru.
   */
  const participants = buildParticipants({
    me: lobby.state.me,
    peers: lobby.state.peers,
    streams: lobby.state.streams,
    viewerPeerIds: lobby.state.viewerPeerIds,
    viewerQuality,
    unreachablePeerIds: lobby.state.unreachablePeerIds
  })
  const participantRows = useLeaveTransition(participants, (view) => view.peerId)
  /*
   * Odsiewanie ukrytych PRZED przejściem wyjścia, a kolejność PO nim.
   *
   * Przed: ukrycie wygląda wtedy jak każde inne zniknięcie strumienia, czyli
   * dostaje darmową animację wyjścia, a odkrycie animację wejścia.
   * Po: `useLeaveTransition` ma własną kolejność, a my chcemy, żeby decydowała
   * nasza — gasnący kafelek zachowuje klucz, więc zachowuje miejsce i nie
   * przeskakuje w trakcie zanikania.
   */
  const shownTiles = visibleTiles(tiles, hidden)
  const transitioned = useLeaveTransition(shownTiles, (tile) => tile.tileKey)
  const tileRows = applyTileOrder(transitioned, order, (row) => row.item.tileKey)

  // Też hook, więc stoi przed instrukcjami `return` z tego samego powodu co
  // `useLeaveTransition` wyżej.
  const toggleHidden = useCallback(
    (tileKey: string, peerId: string, kind: StreamKind, isMe: boolean) => {
      // Kierunek liczymy z `hidden` PRZED aktualizacją, a nie w jej środku:
      // aktualizator musi być czysty (React w StrictMode wywołuje go w dev dwa razy),
      // a wiadomość do sieci czystą nie jest — poszłyby dwie na jedno kliknięcie.
      const hiding = !hidden.has(tileKey)
      setLayout((current) => {
        const nextHidden = new Set(current.hidden)
        if (hiding) nextHidden.add(tileKey)
        else nextHidden.delete(tileKey)
        return { ...current, hidden: nextHidden }
      })
      // Własny podgląd jest lokalny — nie ma od kogo przestać go odbierać.
      if (!isMe) setStreamSubscribed(peerId, kind, !hiding)
    },
    [hidden, setStreamSubscribed]
  )

  /*
   * Przeciąganie kafelka uchwytem. Zdarzenia wskaźnika, nie HTML5 drag-and-drop:
   * ten rysuje własny obraz przeciąganego elementu, czego przy kafelku z żywym
   * wideo nie da się opanować, nie działa sensownie z dotykiem i nie pozwala
   * animować. Zwykłe funkcje, nie `useCallback`: nie są hookami, a świeże
   * domknięcie za każdym renderem daje im aktualne `zoomed` i `draggingKey`.
   */
  const startTileDrag =
    (tileKey: string) =>
    (event: ReactPointerEvent<HTMLElement>): void => {
      // Prawy i środkowy przycisk myszy nie zaczynają przeciągania.
      if (event.button !== 0) return
      event.preventDefault()
      // Przechwycenie wskaźnika: bez niego ruch poza uchwyt gubi zdarzenia,
      // a puszczenie przycisku poza kafelkiem nie dochodzi do siatki.
      event.currentTarget.setPointerCapture(event.pointerId)
      setDraggingKey(tileKey)
    }

  const endTileDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    // Handler wisi na całej siatce, więc łapie też zwykłe kliknięcia w kafelki.
    if (draggingKey === null) return
    const fromKey = draggingKey
    setDraggingKey(null)

    /*
     * Zamek drugi z dwóch (pierwszy to brak `onDragStart` w kafelku przy
     * powiększeniu). Przy powiększeniu siatka rysuje JEDEN kafelek, więc z jej
     * dzieci wyszłaby kolejność o jednym kluczu, a zapisana wyrzuciłaby z układu
     * wszystkie pozostałe: po wyjściu z powiększenia poleciałyby na koniec, w
     * kolejności ze źródła, nie w ustawionej ręcznie. Całe ułożenie człowieka
     * przepada po jednym geście.
     *
     * Żaden zamek sam nie wystarcza. Sam brak uchwytu nie obejmuje gestu, który
     * zaczął się PRZED powiększeniem: przechwycenie wskaźnika nie blokuje
     * klawiatury, a `.tile__stage` ma `role="button"` i reaguje na Enter, więc
     * powiększenie włączy się w trakcie przeciągania. Sam ten zamek zostawiałby
     * z kolei uchwyt na powiększonym kafelku: można by go chwycić, dostać kursor
     * i przygaszenie, a po puszczeniu nic by się nie stało — funkcja wyglądałaby
     * na zepsutą. Stan przeciągania gasimy wyżej przed tym wyjściem, żeby nie
     * zostawał ustawiony.
     */
    if (zoomed) return

    const grid = gridRef.current
    if (!grid) return

    /*
     * Środki liczymy tylko dla dzieci z `data-tile-key`: dziecko bez klucza
     * mogłoby zostać wybrane jako najbliższe, a kafelek wstawiłby się wtedy
     * względem nieistniejącego celu.
     *
     * Bierzemy WSZYSTKIE narysowane, także wiersze jeszcze dogasające
     * (`tile--leaving`, stoją w DOM-ie przez 400 ms). Nie odsiewać ich, choć ich
     * klucze i tak wypadną przy przycinaniu: gdyby najbliższy okazał się wiersz
     * spoza listy, indeks wyszedłby -1, `moveTile` przycięłby go do zera i
     * kafelek wskoczyłby na początek, a nie tam, gdzie człowiek celował. Cena:
     * klucz zakończonego strumienia może przez chwilę wejść do `order`;
     * wyleczy się sam przy następnym przycięciu (`pruneLayout`), gdy nie będzie
     * ani obecny, ani na ekranie.
     *
     * `orderAfterDrop` zwraca permutację tylko tego, co narysowane, więc samo
     * zapisanie jej gubiłoby klucze chwilowo niewidoczne — ukryty kafelek albo
     * strumień ogłoszony, ale jeszcze bez obrazu. `restoreUnrenderedKeys`
     * wstawia je z powrotem za ich poprzednikami, dzięki czemu ukrywanie
     * i przestawianie nie psują się w zderzeniu: po odkryciu kafelek wraca na
     * swoje miejsce, a nie na koniec.
     */
    const centers: TileCenter[] = []
    for (const element of grid.querySelectorAll<HTMLElement>(':scope > [data-tile-key]')) {
      const key = element.dataset.tileKey
      if (key === undefined) continue // selektor to wyklucza; to tylko dla typów
      const box = element.getBoundingClientRect()
      centers.push({ key, x: box.left + box.width / 2, y: box.top + box.height / 2 })
    }

    const dropped = orderAfterDrop(centers, fromKey, { x: event.clientX, y: event.clientY })
    if (dropped !== null) {
      setLayout((current) => ({
        ...current,
        order: restoreUnrenderedKeys(current.order, dropped)
      }))
    }
  }

  // Przerwany gest (np. system zabrał wskaźnik) to NIE upuszczenie: współrzędne
  // takiego zdarzenia nie wskazują miejsca, w które człowiek celował, więc
  // niczego nie przestawiamy.
  const cancelTileDrag = (): void => setDraggingKey(null)

  /*
   * Zakończony strumień zapomina o sobie wszystko: wypada z ukrytych i z
   * kolejności, więc gdy wróci, jest nowym kafelkiem — widocznym i na końcu.
   *
   * `presentKeys` to `lobby.state.streams` i NIC więcej. Ta lista zawiera
   * także nasze własne strumienie: serwer odsyła `stream-started` nadawcy
   * (przypięte testem „nadający dostaje zdarzenie także o własnej transmisji”
   * w `test/signaling-client.test.ts`), więc ukrycie własnego podglądu nie
   * zdejmuje się samo w tej samej klatce. Nie wolno składać jej z `tiles` ani
   * z `remoteStreams`: własnych kafelków nie ma w tym drugim, a ukryty cudzy
   * strumień wypada z obu.
   *
   * Prawda z SYGNALIZACJI, nie ze stanu połączeń ani z DOM-u, bo oba są
   * przejściowe w DWÓCH kierunkach: kafelek wisi w DOM-ie jeszcze 400 ms
   * animacji wyjścia po końcu strumienia, a połączenie bywa zrywane
   * i zestawiane od nowa, choć strumień trwa.
   *
   * Wyjątek dotyczy tylko kolejności: wiersze, które jeszcze stoją na ekranie
   * (`onScreenKeys`, czyli `transitioned`), zachowują w niej miejsce do końca
   * animacji, bo inaczej, jako nieznane, przeskoczyłyby na koniec w trakcie
   * zanikania. Bierzemy wszystkie, nie tylko dogasające: nie zależymy wtedy od
   * tego, czy przerysowanie po końcu strumienia zdążyło już oznaczyć wiersz
   * jako dogasający. Cena tego wyjątku, opisana przy `forgetMissingTiles`:
   * strumień ogłoszony na nowo w ciągu 400 ms od końca wraca na stare miejsce.
   *
   * Bez `useMemo`: efekt niżej chodzi po każdym renderze, więc tożsamość tego
   * zbioru nic nie znaczy, a zbudowanie go kosztuje ok. 2 µs przy 20
   * strumieniach (zmierzone).
   */
  const presentKeys = new Set(lobby.state.streams.map((ref) => connectionKey(ref.peerId, ref.kind)))

  /*
   * Bez tablicy zależności, tak jak efekt powiększenia niżej: `transitioned` to
   * nowa tablica w każdym renderze, więc jakakolwiek lista zależności i tak
   * odpalałaby się za każdym razem. Pętli nie ma dzięki tożsamości, którą
   * pilnuje `pruneLayout` (gdy nic nie wypada, oddaje ten sam obiekt, a React
   * pomija przerysowanie). Zależność `transitioned` od `hidden` też jej nie
   * tworzy: zdjęcie klucza z ukrytych zmienia siatkę tylko wtedy, gdy kafelek
   * tego klucza istnieje, a przy zakończonym strumieniu nie istnieje.
   */
  useEffect(() => {
    const onScreenKeys = new Set(transitioned.map((row) => row.item.tileKey))
    setLayout((current) => pruneLayout(current, presentKeys, onScreenKeys))
  })

  /*
   * UWAGA: musi stać tutaj, przed instrukcjami `return` niżej. LobbyView
   * wychodzi wcześniej przy `bad-key` i przy otwartym oknie wyboru źródła,
   * a hook wywołany po takim wyjściu łamie zasady Reacta i wywala aplikację
   * przy pierwszym otwarciu pickera. Ta sama pułapka wystąpiła w 0.3.2.
   */
  // Też hook, więc obowiązuje go ta sama zasada co niżej: przed wyjściami.
  useReorderAnimation(gridRef)

  useDiagnosticsReporter(lobby, options.diagnostics)

  /*
   * Pokazujemy skrót ORAZ wejścia, z których powstał. Sam skrót powie tylko
   * „różnimy się"; dopiero wejścia powiedzą dlaczego.
   *
   * Wtyczka TS3 przekazuje IDENTYFIKATOR wirtualnego serwera, nie jego adres
   * (`plugin.c`, `VIRTUALSERVER_UNIQUE_IDENTIFIER`) — u wszystkich na jednym
   * serwerze jest identyczny, więc „jedna osoba ma domenę, druga IP" tu nie
   * zachodzi. Jedyne wejście, które realnie różni się między osobami z tego
   * samego serwera, to numer kanału — a wtyczka bierze kanał, NA KTÓRYM
   * KLIKNIĘTO menu (`selectedItemID`), niekoniecznie ten, w którym się siedzi.
   * Dwie osoby z jednego kanału mogą więc trafić do dwóch różnych pokoi i to
   * jest pierwsza rzecz do sprawdzenia, gdy odciski się różnią.
   */
  // Trzy człony warunku zawężają typy pól z `string | null` do `string`; nie
  // obsługują przypadku z czasu działania, bo w trybie lobby `parseLaunchArgs`
  // nie przepuszcza pustych wejść.
  const roomFingerprint =
    options.roomId && options.ts3ServerAddress && options.channelId
      ? {
          short: shortRoomFingerprint(options.roomId),
          derivedFrom:
            `Pokój wyliczony z:\n` +
            `• kanał ${options.channelId} — ten, na którym kliknięto ` +
            `„Udostępnij ekran", niekoniecznie ten, w którym siedzisz\n` +
            `• serwer ${options.ts3ServerAddress} — u wszystkich ` +
            `na tym serwerze identyczny`
        }
      : null

  // Zmiana rozdzielczości albo FPS w trakcie nadawania: podmieniamy ścieżkę
  // zamiast zrywać połączenia (chwilowy null w trakcie restartu ignorujemy).
  useEffect(() => {
    if (sharingScreen && capture.stream) replaceStream(capture.stream, 'screen')
  }, [sharingScreen, capture.stream, replaceStream])

  useEffect(() => {
    if (sharingCamera && camera.stream) replaceStream(camera.stream, 'camera')
  }, [sharingCamera, camera.stream, replaceStream])

  // Bitrate i limit FPS idą przez setParameters — bez dotykania strumienia.
  // Osobno dla każdego rodzaju: kamera ma własny sufit i własny limit klatek,
  // więc ustawienia ekranu nie mają prawa na nią spłynąć.
  useEffect(() => {
    applyQuality('screen', quality.bitrateKbps, quality.fps)
  }, [quality.bitrateKbps, quality.fps, applyQuality])

  useEffect(() => {
    applyQuality('camera', CAMERA_BITRATE_KBPS, cameraSettings.fps)
  }, [cameraSettings.fps, applyQuality])

  /**
   * Zgłoszenie kamery leci osobnym efektem, a nie z handlera przycisku:
   * `useCamera` oddaje strumień dopiero po starcie urządzenia, więc w chwili
   * kliknięcia nie ma jeszcze czego wysłać.
   */
  const cameraStartInProgress = useRef(false)
  useEffect(() => {
    if (!cameraEnabled || !camera.stream || sharingCamera || cameraStartInProgress.current) return
    cameraStartInProgress.current = true
    void startStream(camera.stream, 'camera')
      .catch((err: unknown) => {
        setCameraError(err instanceof Error ? err.message : String(err))
        setCameraEnabled(false)
      })
      .finally(() => {
        cameraStartInProgress.current = false
      })
  }, [cameraEnabled, camera.stream, sharingCamera, startStream])

  // Zdjęcie transmisji też efektem: przycisk może zgasnąć zanim serwer w ogóle
  // potwierdzi start, a wtedy zatrzymywanie z handlera nie miałoby czego zdjąć.
  useEffect(() => {
    if (cameraEnabled || !sharingCamera) return
    // Serwer może odmówić (np. przy zerwanym łączu). Bez tego byłoby to ciche
    // odrzucenie obietnicy, a kafelek kamery zostałby u wszystkich widzów.
    void stopStream('camera').catch((err: unknown) => {
      setCameraError(err instanceof Error ? err.message : String(err))
    })
  }, [cameraEnabled, sharingCamera, stopStream])

  // Powiększony kafelek może zniknąć (nadający skończył albo my go ukryliśmy) —
  // wtedy wracamy do siatki. Sprawdzamy `shownTiles`, nie `tiles`: ukryty kafelek
  // dalej jest w `tiles`, a bez tego powiększenie zostałoby włączone na kafelku,
  // którego nie ma w siatce, i została pusta scena bez drogi powrotu.
  useEffect(() => {
    if (zoomed && !shownTiles.some((t) => t.tileKey === zoomed)) setZoomed(null)
  })

  // Przeciągany kafelek mógł zniknąć w trakcie gestu (koniec strumienia) albo
  // gest zastało powiększenie. Wtedy puszczenie przycisku może nie dojść do
  // siatki (przechwytujący element wyszedł z DOM-u), a bez tego kursor
  // `grabbing` i przygaszenie zostałyby ustawione na stałe.
  useEffect(() => {
    if (draggingKey === null) return
    if (zoomed || !tileRows.some((row) => row.item.tileKey === draggingKey)) {
      setDraggingKey(null)
    }
  })

  const confirmSelection = async (): Promise<void> => {
    if (!capture.stream) return
    setStartError(null)
    try {
      await startStream(capture.stream, 'screen')
      setPickerOpen(false)
    } catch (err: unknown) {
      setStartError(err instanceof Error ? err.message : String(err))
    }
  }

  const endScreenShare = async (): Promise<void> => {
    // Bez tego odrzucenie obietnicy byłoby nieobsłużone, a setSelected(null)
    // nigdy by się nie wykonał — przechwytywanie pulpitu zostałoby żywe mimo
    // przełączonego przycisku. Ten sam wzorzec co przy zatrzymaniu kamery.
    await stopStream('screen').catch((err: unknown) => {
      setStartError(err instanceof Error ? err.message : String(err))
    })
    setSelected(null)
  }

  const toggleCamera = (): void => {
    setCameraError(null)
    setCameraEnabled((enabled) => !enabled)
  }

  if (lobby.state.connection === 'bad-key') {
    return (
      <ApiKeyPrompt
        error={lobby.state.error}
        onSave={(key) => {
          void window.companion.setApiKey(key).then(() => setApiKeyVersion((n) => n + 1))
        }}
      />
    )
  }

  if (pickerOpen) {
    return (
      <SourcePicker
        selected={selected}
        onSelect={setSelected}
        quality={quality}
        onQualityChange={setQuality}
        cameraSettings={cameraSettings}
        onCameraSettingsChange={setCameraSettings}
        cameraDevices={camera.devices}
        capture={capture}
        error={startError}
        onConfirm={() => void confirmSelection()}
        onCancel={() => {
          setPickerOpen(false)
          setSelected(null)
          setStartError(null)
        }}
      />
    )
  }

  // Kamera potrafi nie wstać (zajęta przez Discorda, brak zgody) albo zostać
  // odrzucona przez serwer. Bez tego paska jedynym śladem byłaby konsola.
  const cameraErrorText = cameraError ?? camera.error

  /*
   * Powód pustej siatki liczymy po `lobby.state.streams` (to, co ogłosił
   * serwer, razem z naszymi własnymi), a NIE po `tiles`. Kafelek powstaje
   * dopiero, gdy obraz dojdzie, więc po `tiles` strumień „w drodze" byłby
   * niewidoczny: przy pustych `tiles` wyszłoby „Nikt nie nadaje", choć ktoś
   * nadaje, a „Odbieranie obrazu…" nie pokazałoby się nigdy.
   */
  const emptyGridText =
    EMPTY_GRID_TEXT[emptyGridMessage({ streams: lobby.state.streams, hidden })]

  /*
   * Licznik w nagłówku z tego samego źródła co komunikat pustej siatki, bo
   * z `tiles` rozjeżdżały się: ukryty cudzy strumień wypada z `tiles` (rezygnacja
   * z odbioru zdejmuje jego obraz), więc po ukryciu jedynej transmisji nagłówek
   * mówiłby „Nikt nie nadaje obrazu", a środek ekranu — że wszystkie są ukryte.
   * Liczymy ukryte też: transmisja trwa, tylko jej nie oglądasz.
   */
  const streamCount = lobby.state.streams.length

  return (
    <div className="app">
      <header className="app__titlebar">
        <h1 className="app__title">TS3 Screen Share</h1>
        <AppVersion version={version} />
        <span className="app__stage-tag">
          {lobby.state.connection === 'connecting' && 'Łączenie z kanałem…'}
          {lobby.state.connection === 'error' && 'Brak połączenia'}
          {lobby.state.connection === 'ready' &&
            (streamCount === 0
              ? 'Nikt nie nadaje obrazu'
              : streamCountLabel(streamCount) +
                (sharingScreen || sharingCamera
                  ? ` · Ty: ${
                      lobby.state.viewerPeerIds.length === 0
                        ? 'nikt nie ogląda'
                        : `${lobby.state.viewerPeerIds.length} ${
                            lobby.state.viewerPeerIds.length === 1 ? 'widz' : 'widzów'
                          }`
                    }`
                  : ''))}
        </span>

        <div className="app__actions">
          <button
            type="button"
            className={`btn ${cameraEnabled ? 'btn--danger' : 'btn--ghost'}`}
            onClick={toggleCamera}
            disabled={lobby.state.connection !== 'ready'}
            aria-pressed={cameraEnabled}
          >
            {cameraEnabled ? '📷 Wyłącz kamerę' : '📷 Włącz kamerę'}
          </button>

          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setSettingsOpen((open) => !open)}
            aria-pressed={settingsOpen}
            aria-label="Ustawienia"
            title="Ustawienia"
          >
            ⚙️
          </button>

          {sharingScreen ? (
            <button type="button" className="btn btn--danger" onClick={() => void endScreenShare()}>
              Zakończ udostępnianie
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setPickerOpen(true)}
              disabled={lobby.state.connection !== 'ready'}
            >
              Udostępnij ekran
            </button>
          )}
        </div>
      </header>

      <UpdateNotice update={update} />
      <ConnectionNotice problem={connectionProblem} />

      {cameraErrorText && (
        <div className="sharebar">
          <div className="notice notice--error sharebar__error">
            <strong>Kamera</strong>
            <span>{cameraErrorText}</span>
          </div>
        </div>
      )}

      <div className="lobby">
        <div className="viewer">
          {lobby.state.connection === 'error' ? (
            <div className="notice notice--error">
              <strong>Nie udało się połączyć z kanałem.</strong>
              <span>{lobby.state.error}</span>
            </div>
          ) : tileRows.length === 0 ? (
            <div className="viewer__stage">
              <div className="viewer__waiting">
                {emptyGridText}
              </div>
            </div>
          ) : (
            <div
              ref={gridRef}
              className={`siatka${zoomed ? ' siatka--zoom' : ''}`}
              data-ile={Math.min(tileRows.length, 4)}
              data-dragging={draggingKey !== null ? '' : undefined}
              onPointerUp={endTileDrag}
              onPointerCancel={cancelTileDrag}
              /*
               * Osierocony ostatni kafelek: nieparzysta liczba przy układzie
               * dwukolumnowym. Liczymy TUTAJ, a nie w CSS po `data-ile`, bo
               * `data-ile` jest ograniczone przez `Math.min(…, 4)` — przy pięciu
               * kafelkach wynosi też 4, więc reguła oparta na `data-ile="3"`
               * naprawiłaby trzy kafelki i zostawiła pięć z tą samą usterką.
               */
              data-sierota={tileRows.length >= 3 && tileRows.length % 2 === 1 ? '' : undefined}
            >
              {tileRows
                .filter((row) => !zoomed || row.item.tileKey === zoomed)
                .map((row) => (
                  <StreamTile
                    key={row.item.tileKey}
                    tileKey={row.item.tileKey}
                    stream={row.item.stream}
                    peerId={row.item.peerId}
                    name={row.item.label}
                    kind={row.item.kind}
                    isMe={row.item.isMe}
                    leaving={row.leaving}
                    zoomed={zoomed === row.item.tileKey}
                    dragged={draggingKey === row.item.tileKey}
                    /*
                     * Zamek pierwszy z dwóch (drugi w `endTileDrag`): przy
                     * powiększeniu uchwytu nie ma wcale, bo jeden widoczny
                     * kafelek nie ma czego przestawiać. Nie ma go też na
                     * kafelku dogasającym — przestawianie czegoś, co znika,
                     * nie ma sensu.
                     */
                    onDragStart={
                      zoomed || row.leaving ? undefined : startTileDrag(row.item.tileKey)
                    }
                    onHide={() =>
                      toggleHidden(row.item.tileKey, row.item.peerId, row.item.kind, row.item.isMe)
                    }
                    onToggleZoom={() =>
                      setZoomed((current) => (current === row.item.tileKey ? null : row.item.tileKey))
                    }
                  />
                ))}
            </div>
          )}
        </div>

        <PeerPanel
          rows={participantRows}
          collapsed={panelCollapsed}
          onToggle={() => setPanelCollapsed((current) => !current)}
          roomFingerprint={roomFingerprint}
          hidden={hidden}
          onToggleStream={(peerId, kind, isMe) =>
            toggleHidden(connectionKey(peerId, kind), peerId, kind, isMe)
          }
        />

        {settingsOpen && (
          <SettingsPanel
            quality={quality}
            onChange={setQuality}
            cameraSettings={cameraSettings}
            onCameraSettingsChange={setCameraSettings}
            cameraDevices={camera.devices}
          />
        )}
      </div>
    </div>
  )
}
