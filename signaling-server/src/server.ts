import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { parseClientMessage, type ServerMessage } from './protocol.js'

export interface SignalingServerOptions {
  /** 0 = port efemeryczny (testy). */
  port: number
}

export interface SignalingServer {
  port: number
  close: () => Promise<void>
}

interface Peer {
  peerId: string
  displayName: string
  roomId: string
  socket: WebSocket
}

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message))
}

export async function startSignalingServer(
  options: SignalingServerOptions
): Promise<SignalingServer> {
  const wss = new WebSocketServer({ port: options.port })
  /** peerId -> Peer. Pokój wyciągamy filtrując po roomId. */
  const peers = new Map<string, Peer>()
  /** roomId -> peerId nadającego. Brak wpisu = nikt nie nadaje. */
  const streamers = new Map<string, string>()
  /**
   * roomId -> ile razy nadano zastępczą nazwę. Numeruje serwer, nie klient:
   * gdyby każdy numerował u siebie, każdy widziałby inną listę uczestników.
   * Licznik celowo nie maleje przy wyjściu — inaczej dwie osoby w pokoju
   * mogłyby dostać ten sam numer.
   */
  const nameCounters = new Map<string, number>()

  /** Wysyła do wszystkich w pokoju poza wskazanym peerem. */
  function broadcastToRoom(
    roomId: string,
    exceptPeerId: string,
    message: ServerMessage
  ): void {
    for (const peer of peers.values()) {
      if (peer.roomId !== roomId || peer.peerId === exceptPeerId) continue
      send(peer.socket, message)
    }
  }

  /** Zdejmuje transmisję, jeśli dany peer ją trzymał. Zwraca, czy coś zmieniło. */
  function releaseStream(peer: Peer): boolean {
    if (streamers.get(peer.roomId) !== peer.peerId) return false
    streamers.delete(peer.roomId)
    broadcastToRoom(peer.roomId, peer.peerId, {
      type: 'stream-stopped',
      peerId: peer.peerId
    })
    return true
  }

  wss.on('connection', (socket) => {
    let self: Peer | undefined

    socket.on('message', (raw) => {
      const parsed = parseClientMessage(String(raw))
      if (!parsed.ok) {
        // Zła ramka nie może zabić połączenia — klient ma szansę się poprawić.
        send(socket, { type: 'error', message: parsed.error })
        return
      }
      const message = parsed.message

      if (message.type === 'join') {
        const peerId = randomUUID()
        const roommates = [...peers.values()]
          .filter((peer) => peer.roomId === message.roomId)
          .map((peer) => ({ peerId: peer.peerId, displayName: peer.displayName }))

        let displayName = message.displayName
        if (displayName === null) {
          const next = (nameCounters.get(message.roomId) ?? 0) + 1
          nameCounters.set(message.roomId, next)
          displayName = `Użytkownik ${next}`
        }

        self = { peerId, displayName, roomId: message.roomId, socket }
        peers.set(peerId, self)

        send(socket, {
          type: 'joined',
          peerId,
          displayName,
          peers: roommates,
          // Dołączający od razu wie, czy jest co oglądać — bez tego musiałby
          // czekać na przypadkowe `stream-started`, które już dawno przeszło.
          streamerId: streamers.get(message.roomId) ?? null
        })
        broadcastToRoom(message.roomId, peerId, {
          type: 'peer-joined',
          peerId,
          displayName
        })
        return
      }

      const sender = self
      if (!sender) {
        send(socket, { type: 'error', message: 'Najpierw dołącz do pokoju' })
        return
      }

      if (message.type === 'start-stream') {
        // MVP: jeden nadający na pokój. Rozstrzygamy to na serwerze, bo dwie
        // osoby mogą kliknąć "udostępnij" w tej samej chwili. Wielu naraz =
        // usunięcie tego bloku; reszta serwera jest już na to gotowa.
        const current = streamers.get(sender.roomId)
        if (current !== undefined && current !== sender.peerId) {
          send(socket, {
            type: 'error',
            message: 'Ktoś już udostępnia ekran w tym kanale'
          })
          return
        }
        streamers.set(sender.roomId, sender.peerId)
        // Potwierdzenie leci też do nadawcy — to jego sygnał, że zgłoszenie
        // przeszło i może zacząć wysyłać oferty.
        send(socket, { type: 'stream-started', peerId: sender.peerId })
        broadcastToRoom(sender.roomId, sender.peerId, {
          type: 'stream-started',
          peerId: sender.peerId
        })
        return
      }

      if (message.type === 'stop-stream') {
        // Bez tego sprawdzenia dowolny widz mógłby zrzucić cudzą transmisję.
        if (!releaseStream(sender)) {
          send(socket, { type: 'error', message: 'Nie udostępniasz ekranu' })
          return
        }
        send(socket, { type: 'stream-stopped', peerId: sender.peerId })
        return
      }

      const target = peers.get(message.to)
      // Adresat z innego pokoju jest tak samo nieosiągalny jak nieistniejący —
      // pokój jest granicą widoczności i nie zdradzamy, że taki peer istnieje.
      if (!target || target.roomId !== sender.roomId) {
        send(socket, { type: 'error', message: `Nieznany peer: ${message.to}` })
        return
      }
      send(target.socket, {
        type: 'signal',
        from: sender.peerId,
        payload: message.payload
      })
    })

    socket.on('close', () => {
      if (!self) return
      peers.delete(self.peerId)
      // Kolejność: najpierw zwolnienie transmisji, potem odejście peera —
      // inaczej zamknięcie okna nadającego zablokowałoby kanał na zawsze.
      releaseStream(self)
      broadcastToRoom(self.roomId, self.peerId, {
        type: 'peer-left',
        peerId: self.peerId
      })
      self = undefined
    })
  })

  // Bez nasłuchu na 'error' nieudany start (najczęściej zajęty port) leciałby
  // jako nieobsłużone zdarzenie: proces wywala stack trace, a `startSignalingServer`
  // nigdy się nie rozwiązuje.
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve())
    wss.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${options.port} jest zajęty — prawdopodobnie serwer sygnalizacyjny ` +
              'już działa. Zamknij tamten proces albo ustaw inny port zmienną PORT.'
          )
        )
        return
      }
      reject(err)
    })
  })

  const address = wss.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Serwer nie zwrócił portu TCP')
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const peer of peers.values()) peer.socket.terminate()
        wss.close((err) => (err ? reject(err) : resolve()))
      })
  }
}
