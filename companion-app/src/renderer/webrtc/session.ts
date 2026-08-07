import type { StreamKind, StreamRef } from '../../shared/types'
import { CAMERA_BITRATE_KBPS, DEFAULT_CAMERA_SETTINGS } from '../../shared/types'
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
 * Liczy WIDZOW, nie polaczenia. Widz ogladajacy nasz ekran i nasza kamere ma
 * dwa polaczenia wychodzace, wiec `outgoing.size` pokazywaloby "2 widzow",
 * choc po drugiej stronie siedzi jedna osoba. Pytamy o gotowy klucz zamiast
 * rozbierac go z powrotem na peerId — peerId pochodzi z serwera i nikt nam nie
 * obiecal, ze nie ma w nim dwukropka.
 */
export function policzWidzow(
  peerIds: Iterable<string>,
  maPolaczenie: (klucz: string) => boolean
): number {
  let ilu = 0
  for (const peerId of peerIds) {
    if (STREAM_KINDS.some((kind) => maPolaczenie(connectionKey(peerId, kind)))) ilu += 1
  }
  return ilu
}

interface Jakosc {
  bitrateKbps: number
  maxFramerate: number
}

/**
 * Jakosc startowa osobno dla kazdego rodzaju. Kamera nie dziedziczy ustawien
 * ekranu: przy 1080p60 i 25 Mb/s koder pompowalby w obraz twarzy pasmo
 * przewidziane na czytelny drobny druk, a panel ustawien kamery celowo nie ma
 * suwaka bitrate.
 */
const DOMYSLNA_JAKOSC: Record<StreamKind, Jakosc> = {
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

export interface LobbyCallbacks {
  /**
   * Obraz od konkretnego nadającego, dla konkretnego rodzaju strumienia;
   * `stream === null` = ta transmisja się skończyła. Ekran i kamera tej
   * samej osoby przychodzą jako dwa osobne wywołania.
   */
  onRemoteStream: (peerId: string, kind: StreamKind, stream: MediaStream | null) => void
  /** Pełna lista aktualnie nadawanych strumieni (łącznie z naszym, jeśli nadajemy). */
  onStreamersChange: (streams: StreamRef[]) => void
  onViewerCountChange: (count: number) => void
  /** Lista uczestników pokoju (bez nas) — zasila panel boczny. */
  onPeersChange: (peers: PeerInfo[]) => void
  onError: (message: string) => void
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
  private readonly jakosc = new Map<StreamKind, Jakosc>(
    STREAM_KINDS.map((kind) => [kind, { ...DOMYSLNA_JAKOSC[kind] }])
  )

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
    const jakosc = this.jakosc.get(kind) ?? DOMYSLNA_JAKOSC[kind]
    const parameters = sender.getParameters()
    // Świeże połączenie potrafi nie mieć jeszcze `encodings` — wtedy
    // setParameters by rzuciło, więc uzupełniamy.
    if (!parameters.encodings || parameters.encodings.length === 0) {
      parameters.encodings = [{}]
    }
    for (const encoding of parameters.encodings) {
      encoding.maxBitrate = jakosc.bitrateKbps * 1000
      encoding.maxFramerate = jakosc.maxFramerate
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
    this.jakosc.set(kind, { bitrateKbps, maxFramerate })
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
      if (connection.connectionState === 'failed') {
        this.callbacks.onError(`Połączenie z widzem ${peerId.slice(0, 8)} nie wstało`)
      }
    })
    const key = connectionKey(peerId, kind)
    this.outgoing.set(key, connection)
    this.outgoingBuffers.set(key, new CandidateBuffer(connection))
    this.emitViewerCount()
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
    this.outgoing.delete(key)
    this.outgoingBuffers.delete(key)
    this.emitViewerCount()
  }

  private emitViewerCount(): void {
    this.callbacks.onViewerCountChange(
      policzWidzow(this.peers.keys(), (klucz) => this.outgoing.has(klucz))
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
      if (connection.connectionState === 'failed') {
        this.callbacks.onError('Nie udało się zestawić połączenia z nadającym')
      }
    })
    this.incoming.set(key, connection)
    this.incomingBuffers.set(key, new CandidateBuffer(connection))
    return connection
  }

  private closeIncoming(streamerId: string, kind: StreamKind): void {
    const key = connectionKey(streamerId, kind)
    this.incoming.get(key)?.close()
    this.incoming.delete(key)
    this.incomingBuffers.delete(key)
  }

  // --- sygnalizacja ------------------------------------------------------

  private async onSignal(from: string, payload: SignalPayload): Promise<void> {
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
    this.peers.clear()
    this.streamerRefs.clear()
  }
}
