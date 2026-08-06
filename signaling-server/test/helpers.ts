import { WebSocket } from 'ws'
import { startSignalingServer, type SignalingServer } from '../src/server.js'
import type { ServerMessage } from '../src/protocol.js'

/**
 * Poprawne identyfikatory pokojów: klient wylicza je jako SHA-256 z adresu
 * serwera TS3 i ID kanału, więc na wejściu serwera to zawsze 64 znaki hex.
 */
export const ROOM_A = 'a'.repeat(64)
export const ROOM_B = 'b'.repeat(64)

/** Serwer na porcie efemerycznym (0), żeby testy nie biły się o port. */
export async function startTestServer(): Promise<SignalingServer> {
  return startSignalingServer({ port: 0 })
}

/**
 * Klient testowy kolejkujący przychodzące wiadomości. Kolejka jest potrzebna,
 * bo wiadomość może dotrzeć zanim test zdąży na nią poczekać.
 */
export class TestClient {
  private readonly socket: WebSocket
  private readonly queue: ServerMessage[] = []
  private readonly waiters: ((message: ServerMessage) => void)[] = []

  private constructor(socket: WebSocket) {
    this.socket = socket
    this.socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as ServerMessage
      const waiter = this.waiters.shift()
      if (waiter) waiter(message)
      else this.queue.push(message)
    })
  }

  static async connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    return new TestClient(socket)
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message))
  }

  sendRaw(data: string): void {
    this.socket.send(data)
  }

  /** Kolejna wiadomość od serwera; rzuca, gdy nic nie przyjdzie w limicie. */
  next(timeoutMs = 1000): Promise<ServerMessage> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error('Nie doczekano się wiadomości od serwera'))
      }, timeoutMs)
      const waiter = (message: ServerMessage): void => {
        clearTimeout(timer)
        resolve(message)
      }
      this.waiters.push(waiter)
    })
  }

  /** Sprawdza, że przez podany czas NIC nie przyszło. */
  async expectSilence(ms = 250): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
    if (this.queue.length > 0) {
      throw new Error(`Spodziewano się ciszy, przyszło: ${JSON.stringify(this.queue)}`)
    }
  }

  close(): void {
    this.socket.close()
  }

  async waitClosed(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => this.socket.once('close', () => resolve()))
  }
}
