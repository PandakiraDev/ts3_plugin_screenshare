/**
 * Klient serwera sygnalizacyjnego (model lobby). Świadomie nie wie nic
 * o WebRTC — przenosi nieprzezroczysty `payload` w obie strony. Dzięki temu
 * da się go testować w Node (globalny WebSocket), bez uruchamiania Electrona.
 */

import type { StreamKind, StreamRef } from '../../shared/types'

export interface PeerInfo {
  peerId: string
  displayName: string
}

export interface JoinResult {
  peerId: string
  displayName: string
  peers: PeerInfo[]
  /** Wszystkie aktualnie nadawane strumienie w chwili wejścia (ekran i kamera tej
   *  samej osoby to dwa osobne wpisy). Pusta lista = nikt nie nadaje. */
  streams: StreamRef[]
}

type EventMap = {
  'peer-joined': (peer: PeerInfo) => void
  'peer-left': (peerId: string) => void
  'stream-started': (ref: StreamRef) => void
  'stream-stopped': (ref: StreamRef) => void
  signal: (from: string, payload: unknown) => void
  error: (message: string) => void
  close: () => void
}

interface Pending {
  resolve: (value: never) => void
  reject: (err: Error) => void
}

export class SignalingClient {
  private readonly socket: WebSocket
  private readonly listeners = new Map<keyof EventMap, Function[]>()

  /**
   * Żądania czekające na odpowiedź serwera. Serwer nie numeruje wiadomości,
   * więc rozstrzygamy je po typie: naraz może wisieć tylko jedno żądanie
   * danego rodzaju, bo UI nie pozwala kliknąć dwa razy.
   */
  private pendingJoin: Pending | null = null
  private pendingStart: Pending | null = null
  private pendingStop: Pending | null = null

  private _peerId: string | null = null

  private constructor(socket: WebSocket) {
    this.socket = socket
    this.socket.addEventListener('message', (event) => {
      this.handle(String((event as MessageEvent).data))
    })
    this.socket.addEventListener('close', () => {
      this._peerId = null
      this.failPending(new Error('Połączenie z serwerem sygnalizacyjnym zerwane'))
      this.emit('close')
    })
  }

  get peerId(): string | null {
    return this._peerId
  }

  static connect(url: string): Promise<SignalingClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.addEventListener('open', () => resolve(new SignalingClient(socket)), {
        once: true
      })
      socket.addEventListener(
        'error',
        () => reject(new Error(`Nie udało się połączyć z ${url}`)),
        { once: true }
      )
    })
  }

  on<K extends keyof EventMap>(event: K, listener: EventMap[K]): void {
    const current = this.listeners.get(event) ?? []
    current.push(listener)
    this.listeners.set(event, current)
  }

  private emit<K extends keyof EventMap>(
    event: K,
    ...args: Parameters<EventMap[K]>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      ;(listener as (...a: unknown[]) => void)(...args)
    }
  }

  join(roomId: string, displayName: string | null, apiKey = ''): Promise<JoinResult> {
    return new Promise<JoinResult>((resolve, reject) => {
      this.pendingJoin = { resolve: resolve as never, reject }
      this.send({ type: 'join', roomId, displayName, apiKey })
    })
  }

  /** Zgłasza chęć nadawania danego rodzaju strumienia (ekran albo kamera). */
  startStream(kind: StreamKind): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingStart = { resolve: resolve as never, reject }
      this.send({ type: 'start-stream', kind })
    })
  }

  stopStream(kind: StreamKind): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingStop = { resolve: resolve as never, reject }
      this.send({ type: 'stop-stream', kind })
    })
  }

  signal(to: string, payload: unknown): void {
    this.send({ type: 'signal', to, payload })
  }

  close(): void {
    this.socket.close()
  }

  private send(message: unknown): void {
    this.socket.send(JSON.stringify(message))
  }

  private failPending(err: Error): void {
    for (const pending of [this.pendingJoin, this.pendingStart, this.pendingStop]) {
      pending?.reject(err)
    }
    this.pendingJoin = null
    this.pendingStart = null
    this.pendingStop = null
  }

  private handle(raw: string): void {
    let message: { type?: string; [key: string]: unknown }
    try {
      message = JSON.parse(raw)
    } catch {
      this.emit('error', 'Serwer przysłał niepoprawny JSON')
      return
    }

    switch (message['type']) {
      case 'joined': {
        const peerId = message['peerId'] as string
        this._peerId = peerId
        this.pendingJoin?.resolve({
          peerId,
          displayName: message['displayName'] as string,
          peers: message['peers'] as PeerInfo[],
          streams: (message['streams'] as StreamRef[] | undefined) ?? []
        } as never)
        this.pendingJoin = null
        return
      }
      case 'peer-joined':
        this.emit('peer-joined', {
          peerId: message['peerId'] as string,
          displayName: message['displayName'] as string
        })
        return
      case 'peer-left':
        this.emit('peer-left', message['peerId'] as string)
        return
      case 'stream-started': {
        const peerId = message['peerId'] as string
        const kind = message['kind'] as StreamKind
        // Ta sama wiadomość jest potwierdzeniem dla zgłaszającego i zdarzeniem
        // dla reszty pokoju. Rozwiazujemy zadanie, ale zdarzenie emitujemy TAK
        // CZY OWAK: bez tego wlasne id nigdy nie trafia na liste nadajacych
        // i nadajacy nie widzi ikony przy sobie samym.
        if (peerId === this._peerId && this.pendingStart) {
          this.pendingStart.resolve(undefined as never)
          this.pendingStart = null
        }
        this.emit('stream-started', { peerId, kind })
        return
      }
      case 'stream-stopped': {
        const peerId = message['peerId'] as string
        const kind = message['kind'] as StreamKind
        if (peerId === this._peerId && this.pendingStop) {
          this.pendingStop.resolve(undefined as never)
          this.pendingStop = null
        }
        this.emit('stream-stopped', { peerId, kind })
        return
      }
      case 'signal':
        this.emit('signal', message['from'] as string, message['payload'])
        return
      case 'error': {
        const text = String(message['message'] ?? 'Nieznany błąd serwera')
        // Błąd tuż po żądaniu to jego odrzucenie (np. "ktoś już udostępnia"),
        // a nie ogólny błąd — inaczej UI nie wiedziałoby, że żądanie nie wyszło.
        const pending = this.pendingJoin ?? this.pendingStart ?? this.pendingStop
        if (pending) {
          pending.reject(new Error(text))
          this.pendingJoin = null
          this.pendingStart = null
          this.pendingStop = null
          return
        }
        this.emit('error', text)
        return
      }
      default:
        this.emit('error', `Nieznany typ wiadomości z serwera: ${String(message['type'])}`)
    }
  }
}
