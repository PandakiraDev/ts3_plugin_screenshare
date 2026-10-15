import type { StreamKind, StreamRef } from '../../shared/types'
import { CAMERA_BITRATE_KBPS, DEFAULT_CAMERA_SETTINGS } from '../../shared/types'
import { freezeDelta, type FreezeReport } from '../../shared/viewerQuality'
import { subscribePayload, unsubscribePayload } from './signalCompat'
import type {
  JoinResult,
  PeerInfo,
  SignalingClient
} from '../signaling/SignalingClient.js'

/**
 * Sesja lobby: jeden obiekt obsługuje oba kierunki. Nie ma osobnej klasy dla
 * streamera i widza, bo w lobby rola nie jest przypisana — ten sam peer raz
 * ogląda, raz nadaje, bez restartu aplikacji.
 *
 * Kierunek negocjacji: **inicjuje nadający**. Wysyła ofertę do każdego, kogo
 * zna z listy przy wejściu i ze zdarzeń `peer-joined`, więc kolejność
 * dołączania nie ma znaczenia.
 */

const RTC_CONFIG: RTCConfiguration = {
  // Na razie sam STUN. TURN dojdzie osobno — i to on, nie sygnalizacja,
  // będzie kosztować pasmo.
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
}

/**
 * Jedyne dwa rodzaje strumienia. Peer może nadawać oba naraz (ekran i kamera
 * to niezależne połączenia — patrz `connectionKey`), więc sprzątanie po
 * odejściu peera musi sprawdzić obydwa, nie tylko ten, który akurat wiadomo,
 * że trwał.
 */
const STREAM_KINDS: readonly StreamKind[] = ['screen', 'camera']

/**
 * Klucz polaczenia. Ekran i kamera jada osobnymi polaczeniami, zeby wlaczenie
 * kamery nie wymagalo renegocjacji dzialajacego lacza z obrazem.
 */
export function connectionKey(peerId: string, kind: StreamKind): string {
  return `${peerId}:${kind}`
}

/**
 * Zwraca WIDZÓW, nie połączenia. Widz oglądający nasz ekran i naszą kamerę ma
 * dwa połączenia wychodzące, więc sama liczba połączeń pokazywałaby "2 widzów",
 * choć po drugiej stronie siedzi jedna osoba. Pytamy o gotowy klucz zamiast
 * rozbierać go z powrotem na peerId — peerId pochodzi z serwera i nikt nam nie
 * obiecał, że nie ma w nim dwukropka.
 *
 * Lista, nie liczba: wskaźnik jakości odbioru trzeba postawić przy konkretnej
 * osobie, a z liczby nie da się odtworzyć, przy której.
 */
export function viewerPeerIds(
  peerIds: Iterable<string>,
  hasConnection: (key: string) => boolean
): string[] {
  const viewers: string[] = []
  for (const peerId of peerIds) {
    if (STREAM_KINDS.some((kind) => hasConnection(connectionKey(peerId, kind)))) {
      viewers.push(peerId)
    }
  }
  return viewers
}

interface Quality {
  bitrateKbps: number
  maxFramerate: number
}

/**
 * Jakosc startowa osobno dla kazdego rodzaju. Kamera nie dziedziczy ustawien
 * ekranu: przy 1080p60 i 25 Mb/s koder pompowalby w obraz twarzy pasmo
 * przewidziane na czytelny drobny druk, a panel ustawien kamery celowo nie ma
 * suwaka bitrate.
 */
const DEFAULT_STREAM_QUALITY: Record<StreamKind, Quality> = {
  screen: { bitrateKbps: 8000, maxFramerate: 60 },
  camera: { bitrateKbps: CAMERA_BITRATE_KBPS, maxFramerate: DEFAULT_CAMERA_SETTINGS.fps }
}

/**
 * `owner` = peerId tego, kto nadaje obraz na danym połączeniu. Bez tego pola
 * routing jest niejednoznaczny, gdy DWIE osoby nadają do siebie nawzajem:
 * istnieją wtedy dwa połączenia z tym samym `from`, jedno w każdą stronę,
 * a kandydat ICE trafiał zawsze do wychodzącego. Połączenie przychodzące
 * nigdy się nie zestawiało i widz miał czarny ekran.
 *
 * `stream` = rodzaj strumienia, którego dotyczy sygnał. Nazwa inna niż
 * `kind`, bo `kind` jest już zajęte przez dyskryminator rodzaju sygnału
 * (offer/answer/ice). Razem z `from` (peerId nadawcy sygnału) wyznacza
 * `connectionKey`, po którym wybieramy WŁAŚCIWE połączenie — ekran i kamera
 * tej samej osoby mają swoje własne, osobne RTCPeerConnection.
 */
type SignalPayload =
  | { kind: 'offer'; sdp: string; owner: string; stream: StreamKind }
  | { kind: 'answer'; sdp: string; owner: string; stream: StreamKind }
  | { kind: 'ice'; candidate: RTCIceCandidateInit; owner: string; stream: StreamKind }
  /**
   * Raport widza o tym, jak mu dochodzi nasz obraz.
   *
   * CELOWO bez pola `stream` — i to jest warunek zgodności wstecz, nie
   * przeoczenie. `onSignal` w starszych klientach liczy
   * `connectionKey(from, payload.stream)`; bez tego pola klucz nigdy nie
   * pasuje i wiadomość jest po cichu ignorowana. Z polem `stream` stary
   * klient próbowałby dodać `undefined` jako kandydata ICE.
   */
  | { kind: 'quality'; frozenMs: number; windowMs: number }
  /**
   * Widz rezygnuje z odbioru tego strumienia albo wraca do niego.
   *
   * CELOWO bez pola `stream` — ta sama reguła zgodności co przy `quality`
   * wyżej. Rodzaj jedzie w `streamKind`, a treść tych wiadomości powstaje
   * w `signalCompat.ts`, gdzie da się ją sprawdzić testem w gołym Node —
   * patrz `test/signal-compat.test.ts`.
   */
  | { kind: 'unsubscribe'; streamKind: StreamKind }
  | { kind: 'subscribe'; streamKind: StreamKind }

/**
 * Kandydaci ICE potrafią dotrzeć zanim ustawimy zdalny opis sesji —
 * `addIceCandidate` rzuciłby wtedy wyjątkiem, więc trzymamy je w kolejce.
 */
class CandidateBuffer {
  private readonly pending: RTCIceCandidateInit[] = []
  private ready = false

  constructor(private readonly connection: RTCPeerConnection) {}

  async add(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.ready) {
      this.pending.push(candidate)
      return
    }
    await this.connection.addIceCandidate(candidate)
  }

  async flush(): Promise<void> {
    this.ready = true
    while (this.pending.length > 0) {
      const candidate = this.pending.shift()
      if (candidate) await this.connection.addIceCandidate(candidate)
    }
  }
}

/**
 * `detail` trzyma rozdzielczość i czytelność ekranu. Sprawdzony wariant
 * `motion` kazał koderowi bronić płynności kosztem obrazu i zbijał go do
 * 480×270 — przy udostępnianiu ekranu nie do użytku. Kamera to odwrotny
 * przypadek: twarz to ruch, nie drobny druk, więc dla niej `motion` jest
 * właściwym wyborem.
 */
function hintContent(stream: MediaStream, kind: StreamKind): void {
  const hint = kind === 'screen' ? 'detail' : 'motion'
  for (const track of stream.getVideoTracks()) track.contentHint = hint
}

/** Jedno połączenie wraz z opisem tego, czego dotyczy — do odczytu statystyk. */
export interface DiagnosticConnection {
  peerId: string
  kind: StreamKind
  direction: 'inbound' | 'outbound'
  connection: RTCPeerConnection
}

export interface LobbyCallbacks {
  /**
   * Obraz od konkretnego nadającego, dla konkretnego rodzaju strumienia;
   * `stream === null` = ta transmisja się skończyła. Ekran i kamera tej
   * samej osoby przychodzą jako dwa osobne wywołania.
   */
  onRemoteStream: (peerId: string, kind: StreamKind, stream: MediaStream | null) => void
  /** Pełna lista aktualnie nadawanych strumieni (łącznie z naszym, jeśli nadajemy). */
  onStreamersChange: (streams: StreamRef[]) => void
  /**
   * Kto nas aktualnie ogląda. Lista, nie liczba — przy każdej z tych osób
   * stoi wskaźnik jakości odbioru.
   */
  onViewersChange: (peerIds: string[]) => void
  /** Lista uczestników pokoju (bez nas) — zasila panel boczny. */
  onPeersChange: (peers: PeerInfo[]) => void
  onError: (message: string) => void
  /**
   * Osoby, z którymi połączenie jest w stanie `failed`. ZBIÓR, nie zdarzenie:
   * z jednorazowego zgłoszenia nie dałoby się dowiedzieć, że problem minął,
   * więc komunikat wisiałby w interfejsie po ustaniu przyczyny.
   */
  onUnreachableChange: (peerIds: string[]) => void
  /** Raport od widza: ile jego obraz stał zamrożony w ostatnim oknie. */
  onViewerQualityChange: (peerId: string, report: FreezeReport) => void
}

export class LobbySession {
  /** peerId -> nazwa. Mapa, nie zbiór, bo panel boczny potrzebuje nazw. */
  private readonly peers = new Map<string, string>()
  /**
   * Połączenia wychodzące, gdy to my nadajemy: connectionKey(peerId widza,
   * rodzaj) -> połączenie. Jeden widz może mieć DWA wpisy naraz (ekran
   * i kamera) — każdy to osobny RTCPeerConnection.
   */
  private readonly outgoing = new Map<string, RTCPeerConnection>()
  private readonly outgoingBuffers = new Map<string, CandidateBuffer>()
  /**
   * Połączenia przychodzące: connectionKey(peerId nadającego, rodzaj) ->
   * połączenie. Klucz łączony, nie sam peerId, bo nadających może być wielu
   * naraz i ten sam nadający może wysyłać ekran i kamerę jednocześnie —
   * każdy strumień wymaga osobnego RTCPeerConnection.
   */
  private readonly incoming = new Map<string, RTCPeerConnection>()
  private readonly incomingBuffers = new Map<string, CandidateBuffer>()
  /**
   * Połączenia w stanie `failed`: identyfikator połączenia -> peerId właściciela.
   *
   * Mapa per POŁĄCZENIE, nie zbiór per osoba, i to jest tu istotne: jedna osoba
   * ma nawet cztery połączenia naraz (wychodzące i przychodzące × ekran
   * i kamera). Przy zbiorze kluczowanym po peerId normalne zamknięcie jednego
   * z nich skasowałoby wpis o awarii drugiego i komunikat zgasłby mimo trwającego
   * problemu.
   */
  private readonly failedConnections = new Map<string, string>()

  /** connectionKey(peerId, rodzaj) -> StreamRef aktualnie nadawanego strumienia. */
  private readonly streamerRefs = new Map<string, StreamRef>()
  /** Nasz peerId — po nim rozpoznajemy, czy sygnał dotyczy naszego nadawania. */
  private myPeerId = ''
  /** Nasze własne strumienie wychodzące, po rodzaju — ekran i kamera niezależnie. */
  private readonly localStreams = new Map<StreamKind, MediaStream>()
  private disposed = false
  /**
   * Jakosc osobno dla kazdego rodzaju. Wspolne pola bitrate/FPS nakladaly
   * ustawienia EKRANU takze na polaczenie z kamera, ktora ma wlasna
   * rozdzielczosc i wlasny limit klatek.
   */
  private readonly quality = new Map<StreamKind, Quality>(
    STREAM_KINDS.map((kind) => [kind, { ...DEFAULT_STREAM_QUALITY[kind] }])
  )
  /**
   * Poprzedni odczyt zamrożeń na połączeniu PRZYCHODZĄCYM:
   * connectionKey -> { łączny czas zamrożeń, kiedy odczytany }.
   *
   * `totalFreezesDuration` narasta od początku połączenia, więc bez poprzedniej
   * wartości nie da się policzyć, ile obraz stał w OSTATNIM oknie.
   */
  private readonly lastFreezeSample = new Map<string, { totalMs: number; at: number }>()

  constructor(
    private readonly signaling: SignalingClient,
    private readonly callbacks: LobbyCallbacks
  ) {}

  get isStreaming(): boolean {
    return this.localStreams.size > 0
  }

  begin(joined: JoinResult): void {
    this.myPeerId = joined.peerId
    for (const peer of joined.peers) this.peers.set(peer.peerId, peer.displayName)
    for (const ref of joined.streams) {
      this.streamerRefs.set(connectionKey(ref.peerId, ref.kind), ref)
    }
    this.emitStreamers()
    this.emitPeers()

    this.signaling.on('peer-joined', (peer) => {
      this.peers.set(peer.peerId, peer.displayName)
      this.emitPeers()
      // Jeśli to my nadajemy — dowolny rodzaj strumienia — nowy peer od razu
      // dostaje ofertę na każdy z nich.
      for (const kind of this.localStreams.keys()) void this.callPeer(peer.peerId, kind)
    })

    this.signaling.on('peer-left', (peerId) => {
      this.peers.delete(peerId)
      // Problem osoby, której już nie ma, przestał istnieć razem z nią.
      for (const [id, owner] of this.failedConnections) {
        if (owner === peerId) this.markReachability(id, owner, false)
      }
      this.emitPeers()
      for (const kind of STREAM_KINDS) this.dropOutgoing(peerId, kind)
      // Peer mógł odejść nie zdejmując wcześniej transmisji (ekranu i/lub kamery).
      let wasStreaming = false
      for (const kind of STREAM_KINDS) {
        if (this.streamerRefs.delete(connectionKey(peerId, kind))) {
          wasStreaming = true
          this.closeIncoming(peerId, kind)
          this.callbacks.onRemoteStream(peerId, kind, null)
        }
      }
      if (wasStreaming) this.emitStreamers()
    })

    this.signaling.on('stream-started', (ref) => {
      this.streamerRefs.set(connectionKey(ref.peerId, ref.kind), ref)
      this.emitStreamers()
    })

    this.signaling.on('stream-stopped', (ref) => {
      if (!this.streamerRefs.delete(connectionKey(ref.peerId, ref.kind))) return
      this.closeIncoming(ref.peerId, ref.kind)
      this.emitStreamers()
      // Koniec transmisji to zwykły stan lobby, nie błąd — dlatego czyścimy
      // obraz zamiast pokazywać komunikat, z którego nie ma powrotu.
      this.callbacks.onRemoteStream(ref.peerId, ref.kind, null)
    })

    this.signaling.on('signal', (from, payload) => {
      void this.onSignal(from, payload as SignalPayload)
    })
  }

  private emitStreamers(): void {
    this.callbacks.onStreamersChange([...this.streamerRefs.values()])
  }

  private emitPeers(): void {
    this.callbacks.onPeersChange(
      [...this.peers].map(([peerId, displayName]) => ({ peerId, displayName }))
    )
  }

  /**
   * `failed` dodaje, każdy inny stan usuwa. Dzięki temu odbudowane połączenie
   * gasi komunikat samo, bez żadnej dodatkowej ścieżki.
   *
   * `connectionId` musi być unikalny w obrębie osoby — stąd prefiks kierunku.
   */
  private markReachability(connectionId: string, peerId: string, failed: boolean): void {
    if (failed === this.failedConnections.has(connectionId)) return
    if (failed) this.failedConnections.set(connectionId, peerId)
    else this.failedConnections.delete(connectionId)
    this.callbacks.onUnreachableChange([...new Set(this.failedConnections.values())])
  }

  // --- nadawanie ---------------------------------------------------------

  /**
   * Zgłasza serwerowi chęć nadawania i DOPIERO po zgodzie zaczyna wysyłać —
   * odmowa (np. "ktoś już udostępnia ten rodzaj strumienia") wraca jako
   * odrzucona obietnica, zanim cokolwiek poszło do sieci. Ekran i kamera to
   * niezależne zgłoszenia: włączenie kamery nie dotyka trwającego streamu
   * ekranu, bo każdy rodzaj ma swój komplet połączeń pod `connectionKey`.
   */
  async startStream(stream: MediaStream, kind: StreamKind): Promise<void> {
    await this.signaling.startStream(kind)
    this.localStreams.set(kind, stream)
    hintContent(stream, kind)
    for (const peerId of this.peers.keys()) void this.callPeer(peerId, kind)
  }

  /**
   * Podmienia wysyłany obraz DANEGO RODZAJU bez zrywania połączeń. Zmiana
   * rozdzielczości albo FPS tworzy nowy MediaStream, a stare ścieżki zostają
   * zatrzymane — bez `replaceTrack` widzowie zobaczyliby zamrożony obraz.
   * Renegocjacja zbędna.
   */
  async replaceStream(next: MediaStream, kind: StreamKind): Promise<void> {
    if (!this.localStreams.has(kind)) return
    this.localStreams.set(kind, next)
    hintContent(next, kind)
    const track = next.getVideoTracks()[0] ?? null
    for (const peerId of this.peers.keys()) {
      const connection = this.outgoing.get(connectionKey(peerId, kind))
      if (!connection) continue
      const sender = connection.getSenders().find((s) => s.track?.kind === 'video')
      if (sender) await sender.replaceTrack(track)
    }
  }

  /** Zdejmuje transmisję danego rodzaju; pozostałe (np. kamera, gdy kończymy ekran) trwają dalej. */
  async stopStream(kind: StreamKind): Promise<void> {
    this.localStreams.delete(kind)
    for (const peerId of [...this.peers.keys()]) this.dropOutgoing(peerId, kind)
    await this.signaling.stopStream(kind)
  }

  /**
   * Bez tego WebRTC trzyma się ~2500 kbps niezależnie od ustawień. Zmierzone
   * przy 1080p60: klatki szły poprawnie (58 fps, zero zgubionych), ale obraz
   * rozmywał się na ruchu — co odbiera się jako klatkowanie, choć nim nie jest.
   *
   * Dla ekranu `maintain-resolution`, a NIE `maintain-framerate`: zmierzone,
   * że przy framerate-first koder zbija obraz do 480×270, żeby utrzymać
   * 60 fps — przy udostępnianiu ekranu to nie do użytku. Lepiej stracić
   * trochę płynności niż czytelność.
   *
   * Dla kamery odwrotnie — `maintain-framerate`. `contentHint` kamery to
   * `'motion'` (twarz, ruch), więc `maintain-resolution` kazałoby koderowi
   * bronić rozdzielczości kosztem klatek: przy 1080p60 i stałym suficie
   * `CAMERA_BITRATE_KBPS` skutkiem byłyby pojedyncze klatki na sekundę —
   * pokaz slajdów zamiast obrazu z kamery. Dla ruchomego obrazu płynność
   * liczy się bardziej niż ostrość pojedynczej klatki.
   *
   * Sufit płynności i zużycia CPU stawia koder: Chromium negocjuje VP8
   * kodowany PROGRAMOWO (`libvpx`), mimo że GPU jest sprawne
   * (`video_encode = enabled`, RTX 4070).
   *
   * Dlaczego nie da się tego przenieść na GPU: NVENC nie koduje VP8, a jedyny
   * powszechnie akcelerowany kodek — H.264 — jest w tym buildzie Electrona
   * niedostępny do NADAWANIA. Sprawdzone wprost:
   *
   *   RTCRtpSender.getCapabilities('video')   -> setCodecPreferences rzuca
   *     InvalidModificationError: invalid codec with name "H264"
   *   RTCRtpReceiver.getCapabilities('video') -> OK (dekodowanie dziala)
   *
   * Czyli Electron potrafi H.264 odtwarzac, ale nie kodowac. Realne dzwignie
   * na CPU to nizsza rozdzielczosc i FPS, a nie zmiana kodeka.
   */
  private async applyEncoding(sender: RTCRtpSender, kind: StreamKind): Promise<void> {
    const quality = this.quality.get(kind) ?? DEFAULT_STREAM_QUALITY[kind]
    const parameters = sender.getParameters()
    // Świeże połączenie potrafi nie mieć jeszcze `encodings` — wtedy
    // setParameters by rzuciło, więc uzupełniamy.
    if (!parameters.encodings || parameters.encodings.length === 0) {
      parameters.encodings = [{}]
    }
    for (const encoding of parameters.encodings) {
      encoding.maxBitrate = quality.bitrateKbps * 1000
      encoding.maxFramerate = quality.maxFramerate
    }
    parameters.degradationPreference = kind === 'screen' ? 'maintain-resolution' : 'maintain-framerate'
    try {
      await sender.setParameters(parameters)
    } catch (err: unknown) {
      this.callbacks.onError(
        `Nie udało się ustawić jakości wysyłania: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  /**
   * Zmiana bitrate i limitu FPS w locie — bez zrywania połączeń i bez
   * renegocjacji. Dotyczy JEDNEGO rodzaju strumienia: podniesienie jakości
   * ekranu nie może ruszyć połączenia z kamerą, bo kamera ma własną
   * rozdzielczość i własny limit klatek.
   */
  async setQuality(kind: StreamKind, bitrateKbps: number, maxFramerate: number): Promise<void> {
    this.quality.set(kind, { bitrateKbps, maxFramerate })
    for (const peerId of this.peers.keys()) {
      const connection = this.outgoing.get(connectionKey(peerId, kind))
      const sender = connection?.getSenders().find((s) => s.track?.kind === 'video')
      if (sender) await this.applyEncoding(sender, kind)
    }
  }

  private createOutgoing(peerId: string, kind: StreamKind): RTCPeerConnection {
    const connection = new RTCPeerConnection(RTC_CONFIG)
    const stream = this.localStreams.get(kind)
    if (stream) {
      for (const track of stream.getTracks()) {
        const sender = connection.addTrack(track, stream)
        if (track.kind === 'video') void this.applyEncoding(sender, kind)
      }
    }
    connection.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        // Nasze wychodzące połączenie — właścicielem strumienia jesteśmy my.
        this.signaling.signal(peerId, {
          kind: 'ice',
          candidate: event.candidate.toJSON(),
          owner: this.myPeerId,
          stream: kind
        })
      }
    })
    connection.addEventListener('connectionstatechange', () => {
      this.markReachability(
        `out:${connectionKey(peerId, kind)}`,
        peerId,
        connection.connectionState === 'failed'
      )
    })
    const key = connectionKey(peerId, kind)
    this.outgoing.set(key, connection)
    this.outgoingBuffers.set(key, new CandidateBuffer(connection))
    this.emitViewers()
    return connection
  }

  private async callPeer(peerId: string, kind: StreamKind): Promise<void> {
    const key = connectionKey(peerId, kind)
    if (this.disposed || this.outgoing.has(key) || !this.localStreams.has(kind)) return
    const connection = this.createOutgoing(peerId, kind)
    const offer = await connection.createOffer()
    await connection.setLocalDescription(offer)
    this.signaling.signal(peerId, {
      kind: 'offer',
      sdp: offer.sdp ?? '',
      owner: this.myPeerId,
      stream: kind
    })
  }

  private dropOutgoing(peerId: string, kind: StreamKind): void {
    const key = connectionKey(peerId, kind)
    const connection = this.outgoing.get(key)
    if (!connection) return
    connection.close()
    // WebRTC 1.0 przy procedurze close() ustawia connectionState na 'closed'
    // BEZ emitowania connectionstatechange — nasłuch w createOutgoing się
    // nie odpali. To jedyne miejsce, które wyczyści wpis o awarii tego
    // połączenia; markReachability ma guard na starcie, więc jest bezpieczne
    // nawet gdyby zdarzenie jednak kiedyś poleciało.
    this.markReachability(`out:${key}`, peerId, false)
    this.outgoing.delete(key)
    this.outgoingBuffers.delete(key)
    this.emitViewers()
  }

  private emitViewers(): void {
    this.callbacks.onViewersChange(
      viewerPeerIds(this.peers.keys(), (key) => this.outgoing.has(key))
    )
  }

  // --- oglądanie ---------------------------------------------------------

  private ensureIncoming(streamerId: string, kind: StreamKind): RTCPeerConnection {
    const key = connectionKey(streamerId, kind)
    const existing = this.incoming.get(key)
    if (existing) return existing

    const connection = new RTCPeerConnection(RTC_CONFIG)
    connection.addEventListener('track', (event) => {
      const [stream] = event.streams
      if (stream) this.callbacks.onRemoteStream(streamerId, kind, stream)
    })
    connection.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        // Połączenie przychodzące — właścicielem strumienia jest nadający.
        this.signaling.signal(streamerId, {
          kind: 'ice',
          candidate: event.candidate.toJSON(),
          owner: streamerId,
          stream: kind
        })
      }
    })
    connection.addEventListener('connectionstatechange', () => {
      this.markReachability(
        `in:${connectionKey(streamerId, kind)}`,
        streamerId,
        connection.connectionState === 'failed'
      )
    })
    this.incoming.set(key, connection)
    this.incomingBuffers.set(key, new CandidateBuffer(connection))
    return connection
  }

  private closeIncoming(streamerId: string, kind: StreamKind): void {
    const key = connectionKey(streamerId, kind)
    this.incoming.get(key)?.close()
    // Jak w dropOutgoing: close() nie emituje connectionstatechange (spec
    // WebRTC 1.0), więc nasłuch w ensureIncoming milczy. Bez tej linii wpis
    // o awarii przeżyłby zdjęcie transmisji — dokładnie ten błąd, który cały
    // rejestr miał wyeliminować.
    this.markReachability(`in:${key}`, streamerId, false)
    this.incoming.delete(key)
    this.incomingBuffers.delete(key)
    this.lastFreezeSample.delete(key)
  }

  /**
   * Rezygnuje z odbioru: zamyka naszą stronę i prosi nadawcę, żeby przestał
   * wysyłać. Samo przestanie rysować obraz zostawiłoby pasmo i dekodowanie
   * w robocie, więc do nadawcy musi pójść wiadomość, nie tylko zmiana widoku.
   *
   * Nie trzyma śladu „z tego zrezygnowałem": `closeIncoming` kończy się
   * `markReachability(..., false)`, czyli czyści wpis o awarii, a `close()`
   * (WebRTC 1.0) nie emituje `connectionstatechange`, więc nasłuch nie
   * dorobi nowego. Zrezygnowanie z odbioru nie zapala ostrzeżenia o awarii
   * samo z siebie i nie ma czego tłumić.
   */
  unsubscribeFrom(peerId: string, kind: StreamKind): void {
    // Własną stronę zwijamy BEZ WARUNKU — to nasz stan i trzeba go sprzątnąć
    // nawet wtedy, gdy osoby już nie ma na liście.
    this.closeIncoming(peerId, kind)
    // Nieobecnemu nie ma czego mówić, a sygnał do niego kończy się u serwera
    // błędem — dlaczego to boli, stoi w `subscribeTo` niżej.
    if (!this.peers.has(peerId)) return
    this.signaling.signal(peerId, unsubscribePayload(kind))
  }

  /**
   * Wraca do odbioru: prosi nadawcę o ofertę. Oferta przyjdzie zwykłą
   * ścieżką `onSignal`, więc odbiór odtwarza się tak samo jak za pierwszym
   * razem — bez osobnego trybu „ponownego podłączenia".
   *
   * Osoba mogła wyjść między ukryciem i odkryciem. Sygnał do nieobecnego
   * serwer odbija komunikatem `Nieznany peer: <id>`, a `SignalingClient`
   * przypisuje taki błąd NAJSTARSZEMU oczekującemu żądaniu
   * (`takeOldestPending`) — trafiłby więc np. we właśnie włączaną kamerę
   * i wywrócił ją komunikatem o kimś zupełnie innym.
   */
  subscribeTo(peerId: string, kind: StreamKind): void {
    if (!this.peers.has(peerId)) return
    this.signaling.signal(peerId, subscribePayload(kind))
  }

  // --- sygnalizacja ------------------------------------------------------

  private async onSignal(from: string, payload: SignalPayload): Promise<void> {
    // Przed czymkolwiek innym te trzy warianty, bo ŻADEN nie ma pola `stream`
    // i liczenie z niego klucza połączenia nie miałoby sensu. Dalsza część
    // funkcji traktuje wszystko, co nie jest ofertą ani odpowiedzią, jako
    // kandydata ICE.
    if (payload.kind === 'quality') {
      this.callbacks.onViewerQualityChange(from, {
        frozenMs: payload.frozenMs,
        windowMs: payload.windowMs
      })
      return
    }

    if (payload.kind === 'unsubscribe') {
      // Widz nie chce już tego strumienia: zwijamy nadawanie DO NIEGO i tylko
      // tego rodzaju — pozostali widzowie i drugi strumień tej samej osoby
      // lecą dalej, bo każda para ma własne połączenie pod `connectionKey`.
      // `dropOutgoing` jest bezpieczne także wtedy, gdy połączenia nie ma.
      this.dropOutgoing(from, payload.streamKind)
      return
    }

    if (payload.kind === 'subscribe') {
      /*
       * Widz wraca. NIE dublujemy tu warunków: `callPeer` już sprawdza, czy
       * sesja nie jest zamknięta, czy połączenie już nie istnieje i czy ten
       * rodzaj FAKTYCZNIE nadajemy (`!this.localStreams.has(kind)`).
       * Powtórzenie tych sprawdzeń tworzyłoby drugie źródło tej samej prawdy,
       * które rozjedzie się przy pierwszej zmianie w `callPeer`.
       */
      void this.callPeer(from, payload.streamKind)
      return
    }

    const kind = payload.stream
    const key = connectionKey(from, kind)

    if (payload.kind === 'offer') {
      // Nadający zaczął od nowa (np. po restarcie transmisji) — stare
      // połączenie z NIM, na TYM rodzaju strumienia, jest bezużyteczne, więc
      // budujemy je od zera. Połączeń z pozostałymi nadającymi (i drugiego
      // rodzaju strumienia od tego samego nadającego) to nie dotyka.
      this.closeIncoming(from, kind)
      const connection = this.ensureIncoming(from, kind)
      await connection.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
      await this.incomingBuffers.get(key)?.flush()
      const answer = await connection.createAnswer()
      await connection.setLocalDescription(answer)
      this.signaling.signal(from, {
        kind: 'answer',
        sdp: answer.sdp ?? '',
        owner: from,
        stream: kind
      })
      return
    }

    if (payload.kind === 'answer') {
      const connection = this.outgoing.get(key)
      if (!connection) return
      await connection.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
      await this.outgoingBuffers.get(key)?.flush()
      return
    }

    /*
     * Rozstrzyga `owner`, nie kolejność sprawdzania. Gdy dwie osoby nadają
     * do siebie nawzajem, `from` pasuje do OBU map naraz — wcześniejsza
     * wersja zawsze wybierała wychodzące i gubiła kandydatów dla przychodzącego.
     */
    if (payload.owner === this.myPeerId) {
      await this.outgoingBuffers.get(key)?.add(payload.candidate)
      return
    }
    await this.incomingBuffers.get(key)?.add(payload.candidate)
  }

  /**
   * Czy KTÓRYKOLWIEK z naszych nadajników jest duszony przez pasmo.
   *
   * Ekran i kamera to osobne połączenia z osobnymi limitami, ale rada dla
   * użytkownika jest ta sama, więc nie rozróżniamy ich w wyniku.
   *
   * Własny typ zamiast `RTCOutboundRtpStreamStats`: pole
   * `qualityLimitationReason` bywa nieobecne w typach DOM zależnie od wersji
   * TypeScriptu, a to jedyne pole, którego tu potrzebujemy.
   */
  async uplinkLimited(): Promise<boolean> {
    type OutboundStat = { type: string; kind?: string; qualityLimitationReason?: string }

    for (const connection of this.outgoing.values()) {
      const report = await connection.getStats()
      for (const entry of report.values()) {
        const stat = entry as OutboundStat
        if (stat.type !== 'outbound-rtp' || stat.kind !== 'video') continue
        if (stat.qualityLimitationReason === 'bandwidth') return true
      }
    }
    return false
  }

  /**
   * Wysyła każdemu nadającemu raport o tym, jak nam dochodzi jego obraz.
   * Wołane cyklicznie z warstwy interfejsu — sesja nie ma własnych timerów.
   *
   * Osoba nadająca ekran i kamerę naraz dostaje JEDEN raport: bierzemy
   * najgorszy z jej strumieni. Wskaźnik i tak stoi przy nazwisku, więc
   * rozbijanie go na strumienie niczego by nie wniosło.
   *
   * Sama arytmetyka przyrostu (pierwsza próbka, cofnięty licznik, zerowe
   * okno) mieszka w `freezeDelta` (`src/shared/viewerQuality.ts`) — tu
   * zostaje tylko odczyt `getStats()`, przeliczenie sekund na milisekundy
   * i ta agregacja "najgorszy strumień na osobę".
   */
  async reportQualityToStreamers(): Promise<void> {
    type InboundStat = { type: string; kind?: string; totalFreezesDuration?: number }

    const now = Date.now()
    const worst = new Map<string, FreezeReport>()

    for (const ref of this.streamerRefs.values()) {
      if (ref.peerId === this.myPeerId) continue
      const key = connectionKey(ref.peerId, ref.kind)
      const connection = this.incoming.get(key)
      if (!connection) continue

      let stats: RTCStatsReport
      try {
        stats = await connection.getStats()
      } catch {
        // Jedno odrzucone getStats() nie może uciszyć raportów do WSZYSTKICH
        // pozostałych nadających w tym cyklu — pomijamy TYLKO to połączenie
        // i lecimy dalej, żeby reszta pętli (i już policzone wpisy w `worst`)
        // przeżyła i trafiła do wysyłki niżej.
        continue
      }

      let totalMs: number | null = null
      for (const entry of stats.values()) {
        const stat = entry as InboundStat
        if (stat.type !== 'inbound-rtp' || stat.kind !== 'video') continue
        // Statystyka jest w sekundach, my liczymy w milisekundach.
        if (typeof stat.totalFreezesDuration === 'number') {
          totalMs = stat.totalFreezesDuration * 1000
        }
      }
      if (totalMs === null) continue

      const current = { totalMs, at: now }
      const previous = this.lastFreezeSample.get(key)
      this.lastFreezeSample.set(key, current)
      const report = freezeDelta(previous, current)
      if (!report) continue

      const previousWorst = worst.get(ref.peerId)
      if (
        !previousWorst ||
        report.frozenMs / report.windowMs > previousWorst.frozenMs / previousWorst.windowMs
      ) {
        worst.set(ref.peerId, report)
      }
    }

    for (const [peerId, report] of worst) {
      this.signaling.signal(peerId, { kind: 'quality', ...report })
    }
  }

  /**
   * Płaska lista połączeń do odczytu statystyk, z opisem czego dotyczą.
   *
   * Czyta tylko to, co już jest — żadnego nowego stanu ani zegara, zgodnie
   * z układem tej klasy: statystyki czytamy na żądanie.
   *
   * Klucz ma postać `peerId:rodzaj`. Dzielimy go na OSTATNIM dwukropku, bo
   * `rodzaj` (`screen` albo `camera`) nigdy dwukropka nie zawiera, więc rozbiór
   * działa niezależnie od formatu `peerId`. Na tym, że `peerId` dwukropka nie
   * ma, nie polegamy: serwer dziś nadaje UUID-y, ale — jak pisze `viewerPeerIds`
   * — nikt nam tego nie obiecał. Kierunku nie zgadujemy po zawartości
   * połączenia — wiemy go z tego, z której mapy element pochodzi.
   */
  diagnosticConnections(): DiagnosticConnection[] {
    const result: DiagnosticConnection[] = []
    const collect = (
      source: Map<string, RTCPeerConnection>,
      direction: 'inbound' | 'outbound'
    ): void => {
      for (const [key, connection] of source) {
        const separator = key.lastIndexOf(':')
        if (separator <= 0) continue
        result.push({
          peerId: key.slice(0, separator),
          kind: key.slice(separator + 1) as StreamKind,
          direction,
          connection
        })
      }
    }
    collect(this.outgoing, 'outbound')
    collect(this.incoming, 'inbound')
    return result
  }

  dispose(): void {
    this.disposed = true
    // Bezpośrednie sprzątanie lokalnego stanu, bez wołania signaling.stopStream:
    // socket zaraz i tak się zamknie (patrz useLobby), a serwer sam wykrywa
    // rozłączenie i rozgłasza koniec transmisji pozostałym — nie ma po co o to
    // prosić drugi raz i czekać na odpowiedź, która może nigdy nie przyjść.
    this.localStreams.clear()
    for (const connection of this.outgoing.values()) connection.close()
    this.outgoing.clear()
    this.outgoingBuffers.clear()
    for (const connection of this.incoming.values()) connection.close()
    this.incoming.clear()
    this.incomingBuffers.clear()
    this.lastFreezeSample.clear()
    this.peers.clear()
    this.streamerRefs.clear()
    this.failedConnections.clear()
    // Zamykanie połączeń wyżej nie odpala connectionstatechange (jak w
    // dropOutgoing/closeIncoming), więc bez tego jawnego wywołania stary
    // komunikat o awarii przeżyłby koniec sesji i wisiałby dalej w interfejsie
    // po ponownym połączeniu (np. po zapisaniu nowego klucza API).
    this.callbacks.onUnreachableChange([])
    // To samo dla listy widzów — symetria z wywołaniem wyżej, żeby "kogoś tam
    // ogląda" nie przeżyło końca sesji.
    this.callbacks.onViewersChange([])
  }
}
