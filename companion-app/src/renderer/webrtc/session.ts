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

type SignalPayload =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit }

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
 * `detail` trzyma rozdzielczość i czytelność. Sprawdzony wariant `motion`
 * kazał koderowi bronić płynności kosztem obrazu i zbijał go do 480×270 —
 * przy udostępnianiu ekranu nie do użytku.
 */
function hintContent(stream: MediaStream): void {
  for (const track of stream.getVideoTracks()) track.contentHint = 'detail'
}

export interface LobbyCallbacks {
  /** Obraz od konkretnego nadającego; `stream === null` = jego transmisja się skończyła. */
  onRemoteStream: (peerId: string, stream: MediaStream | null) => void
  /** Pełna lista aktualnie nadających (bez nas). */
  onStreamersChange: (peerIds: string[]) => void
  onViewerCountChange: (count: number) => void
  /** Lista uczestników pokoju (bez nas) — zasila panel boczny. */
  onPeersChange: (peers: PeerInfo[]) => void
  onError: (message: string) => void
}

export class LobbySession {
  /** peerId -> nazwa. Mapa, nie zbiór, bo panel boczny potrzebuje nazw. */
  private readonly peers = new Map<string, string>()
  /** Połączenia wychodzące, gdy to my nadajemy: peerId widza -> połączenie. */
  private readonly outgoing = new Map<string, RTCPeerConnection>()
  private readonly outgoingBuffers = new Map<string, CandidateBuffer>()
  /**
   * Połączenia przychodzące: peerId nadającego -> połączenie. Mapa, nie jedno
   * połączenie, bo nadających może być wielu naraz i każdy wymaga osobnego
   * RTCPeerConnection.
   */
  private readonly incoming = new Map<string, RTCPeerConnection>()
  private readonly incomingBuffers = new Map<string, CandidateBuffer>()

  private readonly streamerIds = new Set<string>()
  private localStream: MediaStream | null = null
  private disposed = false
  private bitrateKbps = 8000
  private maxFramerate = 60

  constructor(
    private readonly signaling: SignalingClient,
    private readonly callbacks: LobbyCallbacks
  ) {}

  get isStreaming(): boolean {
    return this.localStream !== null
  }

  begin(joined: JoinResult): void {
    for (const peer of joined.peers) this.peers.set(peer.peerId, peer.displayName)
    for (const id of joined.streamers) this.streamerIds.add(id)
    this.emitStreamers()
    this.emitPeers()

    this.signaling.on('peer-joined', (peer) => {
      this.peers.set(peer.peerId, peer.displayName)
      this.emitPeers()
      // Jeśli to my nadajemy, nowy peer od razu dostaje ofertę.
      if (this.localStream) void this.callPeer(peer.peerId)
    })

    this.signaling.on('peer-left', (peerId) => {
      this.peers.delete(peerId)
      this.emitPeers()
      this.dropOutgoing(peerId)
      // Peer mógł odejść nie zdejmując wcześniej transmisji.
      if (this.streamerIds.delete(peerId)) {
        this.closeIncoming(peerId)
        this.emitStreamers()
        this.callbacks.onRemoteStream(peerId, null)
      }
    })

    this.signaling.on('stream-started', (peerId) => {
      this.streamerIds.add(peerId)
      this.emitStreamers()
    })

    this.signaling.on('stream-stopped', (peerId) => {
      if (!this.streamerIds.delete(peerId)) return
      this.closeIncoming(peerId)
      this.emitStreamers()
      // Koniec transmisji to zwykły stan lobby, nie błąd — dlatego czyścimy
      // obraz zamiast pokazywać komunikat, z którego nie ma powrotu.
      this.callbacks.onRemoteStream(peerId, null)
    })

    this.signaling.on('signal', (from, payload) => {
      void this.onSignal(from, payload as SignalPayload)
    })
  }

  private emitStreamers(): void {
    this.callbacks.onStreamersChange([...this.streamerIds])
  }

  private emitPeers(): void {
    this.callbacks.onPeersChange(
      [...this.peers].map(([peerId, displayName]) => ({ peerId, displayName }))
    )
  }

  // --- nadawanie ---------------------------------------------------------

  /** Wywoływane PO tym, jak serwer przyznał prawo do nadawania. */
  startStreaming(stream: MediaStream): void {
    this.localStream = stream
    hintContent(stream)
    for (const peerId of this.peers.keys()) void this.callPeer(peerId)
  }

  /**
   * Podmienia wysyłany obraz bez zrywania połączeń. Zmiana rozdzielczości albo
   * FPS tworzy nowy MediaStream, a stare ścieżki zostają zatrzymane — bez
   * `replaceTrack` widzowie zobaczyliby zamrożony obraz. Renegocjacja zbędna.
   */
  async replaceStream(next: MediaStream): Promise<void> {
    if (!this.localStream) return
    this.localStream = next
    hintContent(next)
    const track = next.getVideoTracks()[0] ?? null
    for (const connection of this.outgoing.values()) {
      const sender = connection.getSenders().find((s) => s.track?.kind === 'video')
      if (sender) await sender.replaceTrack(track)
    }
  }

  stopStreaming(): void {
    this.localStream = null
    for (const peerId of [...this.outgoing.keys()]) this.dropOutgoing(peerId)
  }

  /**
   * Bez tego WebRTC trzyma się ~2500 kbps niezależnie od ustawień. Zmierzone
   * przy 1080p60: klatki szły poprawnie (58 fps, zero zgubionych), ale obraz
   * rozmywał się na ruchu — co odbiera się jako klatkowanie, choć nim nie jest.
   *
   * `maintain-resolution`, a NIE `maintain-framerate`: zmierzone, że przy
   * framerate-first koder zbija obraz do 480×270, żeby utrzymać 60 fps —
   * przy udostępnianiu ekranu to nie do użytku. Lepiej stracić trochę
   * płynności niż czytelność.
   *
   * Sufit płynności stawia koder: Chromium negocjuje VP8 kodowany programowo
   * (`libvpx`). Wymuszanie H.264 przez `setCodecPreferences` sprawdzone —
   * nie działa, bo ten build Electrona nie ma enkodera H.264 i negocjacja
   * i tak wraca do VP8. Przy 1080p daje to 40–55 fps zamiast 60.
   */
  private async applyEncoding(sender: RTCRtpSender): Promise<void> {
    const parameters = sender.getParameters()
    // Świeże połączenie potrafi nie mieć jeszcze `encodings` — wtedy
    // setParameters by rzuciło, więc uzupełniamy.
    if (!parameters.encodings || parameters.encodings.length === 0) {
      parameters.encodings = [{}]
    }
    for (const encoding of parameters.encodings) {
      encoding.maxBitrate = this.bitrateKbps * 1000
      encoding.maxFramerate = this.maxFramerate
    }
    parameters.degradationPreference = 'maintain-resolution'
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

  /** Zmiana bitrate w locie — bez zrywania połączeń i bez renegocjacji. */
  async setBitrate(kbps: number): Promise<void> {
    this.bitrateKbps = kbps
    for (const connection of this.outgoing.values()) {
      const sender = connection.getSenders().find((s) => s.track?.kind === 'video')
      if (sender) await this.applyEncoding(sender)
    }
  }

  setMaxFramerate(fps: number): void {
    this.maxFramerate = fps
  }

  private createOutgoing(peerId: string): RTCPeerConnection {
    const connection = new RTCPeerConnection(RTC_CONFIG)
    const stream = this.localStream
    if (stream) {
      for (const track of stream.getTracks()) {
        const sender = connection.addTrack(track, stream)
        if (track.kind === 'video') void this.applyEncoding(sender)
      }
    }
    connection.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        this.signaling.signal(peerId, { kind: 'ice', candidate: event.candidate.toJSON() })
      }
    })
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed') {
        this.callbacks.onError(`Połączenie z widzem ${peerId.slice(0, 8)} nie wstało`)
      }
    })
    this.outgoing.set(peerId, connection)
    this.outgoingBuffers.set(peerId, new CandidateBuffer(connection))
    this.callbacks.onViewerCountChange(this.outgoing.size)
    return connection
  }

  private async callPeer(peerId: string): Promise<void> {
    if (this.disposed || this.outgoing.has(peerId) || !this.localStream) return
    const connection = this.createOutgoing(peerId)
    const offer = await connection.createOffer()
    await connection.setLocalDescription(offer)
    this.signaling.signal(peerId, { kind: 'offer', sdp: offer.sdp ?? '' })
  }

  private dropOutgoing(peerId: string): void {
    const connection = this.outgoing.get(peerId)
    if (!connection) return
    connection.close()
    this.outgoing.delete(peerId)
    this.outgoingBuffers.delete(peerId)
    this.callbacks.onViewerCountChange(this.outgoing.size)
  }

  // --- oglądanie ---------------------------------------------------------

  private ensureIncoming(streamerId: string): RTCPeerConnection {
    const istniejace = this.incoming.get(streamerId)
    if (istniejace) return istniejace

    const connection = new RTCPeerConnection(RTC_CONFIG)
    connection.addEventListener('track', (event) => {
      const [stream] = event.streams
      if (stream) this.callbacks.onRemoteStream(streamerId, stream)
    })
    connection.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        this.signaling.signal(streamerId, {
          kind: 'ice',
          candidate: event.candidate.toJSON()
        })
      }
    })
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed') {
        this.callbacks.onError('Nie udało się zestawić połączenia z nadającym')
      }
    })
    this.incoming.set(streamerId, connection)
    this.incomingBuffers.set(streamerId, new CandidateBuffer(connection))
    return connection
  }

  private closeIncoming(streamerId: string): void {
    this.incoming.get(streamerId)?.close()
    this.incoming.delete(streamerId)
    this.incomingBuffers.delete(streamerId)
  }

  // --- sygnalizacja ------------------------------------------------------

  private async onSignal(from: string, payload: SignalPayload): Promise<void> {
    if (payload.kind === 'offer') {
      // Nadający zaczął od nowa (np. po restarcie transmisji) — stare
      // połączenie z NIM jest bezużyteczne, więc budujemy je od zera.
      // Połączeń z pozostałymi nadającymi to nie dotyka.
      this.closeIncoming(from)
      const connection = this.ensureIncoming(from)
      await connection.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
      await this.incomingBuffers.get(from)?.flush()
      const answer = await connection.createAnswer()
      await connection.setLocalDescription(answer)
      this.signaling.signal(from, { kind: 'answer', sdp: answer.sdp ?? '' })
      return
    }

    if (payload.kind === 'answer') {
      const connection = this.outgoing.get(from)
      if (!connection) return
      await connection.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
      await this.outgoingBuffers.get(from)?.flush()
      return
    }

    // ICE trafia albo do połączenia z widzem, albo do tego z nadającym.
    if (this.outgoing.has(from)) {
      await this.outgoingBuffers.get(from)?.add(payload.candidate)
      return
    }
    if (this.incoming.has(from)) await this.incomingBuffers.get(from)?.add(payload.candidate)
  }

  dispose(): void {
    this.disposed = true
    this.stopStreaming()
    for (const id of [...this.incoming.keys()]) this.closeIncoming(id)
    this.peers.clear()
    this.streamerIds.clear()
  }
}
