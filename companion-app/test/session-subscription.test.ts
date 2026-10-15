import { expect, test } from 'vitest'
import type { JoinResult, SignalingClient } from '../src/renderer/signaling/SignalingClient'
import { LobbySession, type LobbyCallbacks } from '../src/renderer/webrtc/session'

/*
 * Rezygnacja z odbioru i powrót do niego, widziane od strony sygnalizacji.
 *
 * Treść wiadomości ma własny plik (`signal-compat.test.ts`) — tutaj pilnujemy
 * czegoś innego: że sesja TEJ treści rzeczywiście używa. Czysta funkcja może
 * być poprawna i nieużywana, a wtedy warunek zgodności wstecz nie dotyczyłby
 * niczego, co naprawdę leci do sieci.
 *
 * Testy chodzą w gołym Node, który nie ma `RTCPeerConnection`. Część z nich
 * i tak nie tworzy połączeń; te, które muszą, podstawiają atrapę
 * `FakeConnection` niżej.
 */

type Listener = (...args: never[]) => void

interface Harness {
  session: LobbySession
  /** Co poszło do sygnalizacji, w kolejności wysyłki. */
  sent: { to: string; payload: Record<string, unknown> }[]
  /** Udaje zdarzenie od serwera sygnalizacyjnego. */
  fire: (event: string, ...args: unknown[]) => void
}

const NO_CALLBACKS: LobbyCallbacks = {
  onRemoteStream: () => {},
  onStreamersChange: () => {},
  onViewersChange: () => {},
  onPeersChange: () => {},
  onError: () => {},
  onUnreachableChange: () => {},
  onViewerQualityChange: () => {}
}

/** Michał nadaje ekran, my tylko patrzymy. */
const JOINED: JoinResult = {
  peerId: 'ja',
  displayName: 'Ja',
  peers: [{ peerId: 'michal', displayName: 'Michał' }],
  streams: [{ peerId: 'michal', kind: 'screen' }]
}

function harness(callbacks: Partial<LobbyCallbacks> = {}): Harness {
  const listeners = new Map<string, Listener[]>()
  const sent: Harness['sent'] = []
  const signaling = {
    on(event: string, listener: Listener): void {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
    },
    signal(to: string, payload: unknown): void {
      sent.push({ to, payload: payload as Record<string, unknown> })
    },
    startStream(): Promise<void> {
      return Promise.resolve()
    }
  }
  const session = new LobbySession(signaling as unknown as SignalingClient, {
    ...NO_CALLBACKS,
    ...callbacks
  })
  session.begin(JOINED)
  return {
    session,
    sent,
    fire: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) {
        ;(listener as (...rest: unknown[]) => void)(...args)
      }
    }
  }
}

test('rezygnacja idzie do nadawcy i NIE MA pola `stream`', () => {
  const { session, sent } = harness()
  session.unsubscribeFrom('michal', 'screen')
  expect(sent).toHaveLength(1)
  expect(sent[0]?.to).toBe('michal')
  // `toStrictEqual`, nie `toEqual`: `toEqual` IGNORUJE pola o wartości
  // `undefined`, więc przepuściłby dołożone `candidate: undefined` — czyli
  // dokładnie ten kształt, którego stara ścieżka ICE boi się najbardziej.
  expect(sent[0]?.payload).toStrictEqual({ kind: 'unsubscribe', streamKind: 'screen' })
  // Osobna asercja mówi wprost, o co w tym kształcie chodzi: pole `stream`
  // zepsułoby odbiór u starszych wersji.
  expect('stream' in (sent[0]?.payload ?? {})).toBe(false)
})

test('powrót do odbioru prosi nadawcę o ofertę', () => {
  const { session, sent } = harness()
  session.subscribeTo('michal', 'camera')
  expect(sent).toStrictEqual([
    { to: 'michal', payload: { kind: 'subscribe', streamKind: 'camera' } }
  ])
})

test('powrót do odbioru po wyjściu osoby nie wysyła nic', () => {
  // Osoba mogła wyjść między ukryciem i odkryciem. Sygnał do nieobecnego
  // serwer odbija błędem `Nieznany peer: …`, a ten błąd klient przypisuje
  // najstarszemu wiszącemu żądaniu — wywróciłby np. włączanie kamery.
  // Wyjście idzie PRAWDZIWYM zdarzeniem `peer-left`, nie dłubaniem
  // w prywatnych polach, żeby test potwierdzał więcej niż to, co sam ustawił.
  const { session, sent, fire } = harness()
  fire('peer-left', 'michal')
  session.subscribeTo('michal', 'screen')
  expect(sent).toStrictEqual([])
})

test('rezygnacja po wyjściu osoby nie wysyła nic', () => {
  // Druga strona tego samego wyścigu: kliknięcie w krzyżyk może dojść już po
  // tym, jak osoba wyszła, a widok jeszcze tego nie pokazał.
  const { session, sent, fire } = harness()
  fire('peer-left', 'michal')
  session.unsubscribeFrom('michal', 'screen')
  expect(sent).toStrictEqual([])
})

test('prośba o powrót od widza nie daje oferty, gdy nic nie nadajemy', async () => {
  // `onSignal` celowo nie powtarza warunków `callPeer`. Ten test potwierdza,
  // że garda w `callPeer` naprawdę ich pilnuje: nie wysyłamy oferty na
  // strumień, którego nie mamy.
  const { sent, fire } = harness()
  fire('signal', 'michal', { kind: 'subscribe', streamKind: 'screen' })
  // `onSignal` jest asynchroniczne — bez oddania pętli zdarzeń test
  // przechodziłby na pusto, zanim cokolwiek miałoby szansę się wysłać.
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(sent).toStrictEqual([])
})

/**
 * Najmniejsza atrapa `RTCPeerConnection`, jaką przechodzą ścieżki używane
 * w tym pliku: nadawanie (`callPeer` plus `createOutgoing`) i przyjęcie
 * oferty (`ensureIncoming` plus `onSignal`, stąd `createAnswer`
 * i `setRemoteDescription`). W gołym Node wywraca się WYKONANIE
 * `new RTCPeerConnection`, nie import `session.ts` — i bez tej atrapy nie da
 * się sprawdzić rzeczy najważniejszej w tym zadaniu: że rezygnacja naprawdę
 * zwija nadawanie, a powrót naprawdę je odtwarza. Atrapa nie udaje
 * negocjacji, tylko oddaje sterowanie z powrotem do sesji.
 *
 * Nasłuchy zapisuje i da się je odpalić (`emit`), a `connectionState` ustawia
 * test — bez tego nie dałoby się wywołać awarii połączenia, a więc sprawdzić,
 * że rezygnacja ją po sobie sprząta.
 */
class FakeConnection {
  static readonly all: FakeConnection[] = []
  closed = false
  connectionState: RTCPeerConnectionState = 'new'
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>()

  constructor() {
    FakeConnection.all.push(this)
  }

  addTrack(): RTCRtpSender {
    return {
      getParameters: () => ({ encodings: [{}] }),
      setParameters: () => Promise.resolve()
    } as unknown as RTCRtpSender
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  /** Odpala nasłuchy tak, jak zrobiłaby to przeglądarka. */
  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'offer', sdp: 'sdp-atrapa' })
  }

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'answer', sdp: 'sdp-odpowiedz' })
  }

  setRemoteDescription(): Promise<void> {
    return Promise.resolve()
  }

  setLocalDescription(): Promise<void> {
    return Promise.resolve()
  }

  close(): void {
    this.closed = true
    // Jak w WebRTC 1.0: stan `closed` BEZ zdarzenia `connectionstatechange`.
    // Dlatego po rezygnacji nasłuch milczy i sprzątać musi sama sesja.
    this.connectionState = 'closed'
  }
}

/** Oddaje pętlę zdarzeń: `callPeer` jest wołane przez `void`, bez czekania. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Podstawia atrapę na czas jednego testu i zawsze ją zdejmuje. */
async function withFakeConnections(body: () => Promise<void>): Promise<void> {
  const previous = globalThis.RTCPeerConnection
  globalThis.RTCPeerConnection = FakeConnection as unknown as typeof RTCPeerConnection
  FakeConnection.all.length = 0
  try {
    await body()
  } finally {
    globalThis.RTCPeerConnection = previous
  }
}

/** Jedyne połączenie utworzone w teście; brak oznacza, że test nie dotarł do tworzenia. */
function onlyConnection(): FakeConnection {
  const connection = FakeConnection.all[0]
  if (!connection) throw new Error('Test nie utworzył żadnego połączenia')
  return connection
}

test('rezygnacja widza zwija nadawanie, a jego powrót znów wysyła ofertę', async () => {
  const previous = globalThis.RTCPeerConnection
  globalThis.RTCPeerConnection = FakeConnection as unknown as typeof RTCPeerConnection
  FakeConnection.all.length = 0
  try {
    const { session, sent, fire } = harness()
    const track = { kind: 'video', contentHint: '' }
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track]
    } as unknown as MediaStream

    await session.startStream(stream, 'screen')
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.payload['kind']).toBe('offer')
    expect(FakeConnection.all).toHaveLength(1)

    // Widz rezygnuje: nadawanie DO NIEGO ma się zwinąć, bo samo przestanie
    // rysować obraz nie oszczędza ani pasma, ani dekodowania.
    fire('signal', 'michal', { kind: 'unsubscribe', streamKind: 'screen' })
    await flush()
    expect(FakeConnection.all[0]?.closed).toBe(true)
    expect(sent).toHaveLength(1)

    // Widz wraca: dostaje świeżą ofertę, czyli NOWE połączenie. Gdyby
    // rezygnacja nie wyczyściła mapy `outgoing`, garda w `callPeer` uznałaby
    // połączenie za istniejące i oferta nigdy by nie poszła.
    fire('signal', 'michal', { kind: 'subscribe', streamKind: 'screen' })
    await flush()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toStrictEqual({
      to: 'michal',
      payload: { kind: 'offer', sdp: 'sdp-atrapa', owner: 'ja', stream: 'screen' }
    })
    expect(FakeConnection.all).toHaveLength(2)
  } finally {
    globalThis.RTCPeerConnection = previous
  }
})

test('rezygnacja zamyka NASZE połączenie przychodzące i zapomina o nim', async () => {
  const previous = globalThis.RTCPeerConnection
  globalThis.RTCPeerConnection = FakeConnection as unknown as typeof RTCPeerConnection
  FakeConnection.all.length = 0
  try {
    const { session, sent, fire } = harness()

    // Michał nadaje, więc przychodzi od niego oferta i powstaje połączenie
    // przychodzące — dopiero od tego momentu jest co zamykać.
    fire('signal', 'michal', { kind: 'offer', sdp: 'sdp-michala', owner: 'michal', stream: 'screen' })
    await flush()
    const inbound = (): number =>
      session.diagnosticConnections().filter((c) => c.direction === 'inbound').length
    expect(inbound()).toBe(1)
    expect(FakeConnection.all).toHaveLength(1)

    session.unsubscribeFrom('michal', 'screen')
    // Dekodowanie kosztuje po NASZEJ stronie, więc własne połączenie musi
    // zniknąć od razu, nie dopiero kiedy nadawca łaskawie przestanie wysyłać.
    expect(FakeConnection.all[0]?.closed).toBe(true)
    expect(inbound()).toBe(0)
    // A do nadawcy i tak leci prośba, żeby przestał — inaczej pasmo dalej
    // by płynęło.
    expect(sent.at(-1)).toStrictEqual({
      to: 'michal',
      payload: { kind: 'unsubscribe', streamKind: 'screen' }
    })
  } finally {
    globalThis.RTCPeerConnection = previous
  }
})

test('rezygnacja każe interfejsowi zapomnieć o odebranym obrazie', () =>
  withFakeConnections(async () => {
    // Obraz po zamkniętym połączeniu jest martwy. Gdyby interfejs go zachował,
    // odkryty kafelek pokazałby jego ostatnią klatkę, zanim przyjdzie nowa
    // oferta — a od nadawcy, który `subscribe` ignoruje, nie przyjdzie wcale.
    const remote: [string, string, MediaStream | null][] = []
    const { session, fire } = harness({
      onRemoteStream: (peerId, kind, stream) => remote.push([peerId, kind, stream])
    })
    const stream = { id: 'obraz-michala' } as unknown as MediaStream

    fire('signal', 'michal', { kind: 'offer', sdp: 'sdp-michala', owner: 'michal', stream: 'screen' })
    await flush()
    onlyConnection().emit('track', { streams: [stream] })
    // Kontrola: obraz faktycznie doszedł. Bez niej test przeszedłby na pusto,
    // gdyby atrapa nie umiała dostarczyć ścieżki.
    expect(remote).toStrictEqual([['michal', 'screen', stream]])

    session.unsubscribeFrom('michal', 'screen')
    expect(remote).toStrictEqual([
      ['michal', 'screen', stream],
      ['michal', 'screen', null]
    ])
  }))

test('rezygnacja po wyjściu osoby i tak zdejmuje obraz z interfejsu', () => {
  // To nasz własny stan, nie wiadomość do kogoś: sprzątamy go bez względu na to,
  // czy osoba jeszcze jest. `peer-left` zdejmuje tylko pary, które ogłosił
  // serwer (tu ekran), więc kamera, o której rezygnujemy po wyjściu, zostałaby
  // w interfejsie, gdyby zdjęcie stało za strażnikiem `peers.has`.
  const remote: [string, string, MediaStream | null][] = []
  const { session, sent, fire } = harness({
    onRemoteStream: (peerId, kind, stream) => remote.push([peerId, kind, stream])
  })
  fire('peer-left', 'michal')
  expect(remote).toStrictEqual([['michal', 'screen', null]])

  session.unsubscribeFrom('michal', 'camera')
  expect(remote).toStrictEqual([
    ['michal', 'screen', null],
    ['michal', 'camera', null]
  ])
  expect(sent).toStrictEqual([])
})

test('rezygnacja gasi nieaktualne ostrzeżenie o awarii połączenia przychodzącego', () =>
  withFakeConnections(async () => {
    // Ostrzeżenie zapaliło się WCZEŚNIEJ, bo połączenie padło, a dopiero potem
    // widz schował kafelek. `close()` nie emituje `connectionstatechange`,
    // więc nasłuch nie zgasi go sam — gasi je `markReachability(..., false)`
    // w `closeIncoming`. Bez tej linii „Brak połączenia" wisiałoby przy osobie
    // aż do jej wyjścia z kanału.
    const unreachable: string[][] = []
    const { session, fire } = harness({
      onUnreachableChange: (peerIds) => unreachable.push(peerIds)
    })

    fire('signal', 'michal', { kind: 'offer', sdp: 'sdp-michala', owner: 'michal', stream: 'screen' })
    await flush()
    const connection = onlyConnection()
    connection.connectionState = 'failed'
    connection.emit('connectionstatechange')
    // Kontrola: ostrzeżenie faktycznie się zapaliło. Bez niej test przeszedłby
    // na pusto, gdyby atrapa nie umiała wywołać awarii — a wtedy końcowa
    // asercja o pustym zbiorze byłaby prawdziwa z zupełnie innego powodu.
    expect(unreachable).toStrictEqual([['michal']])

    session.unsubscribeFrom('michal', 'screen')
    expect(unreachable).toStrictEqual([['michal'], []])
  }))

test('rezygnacja widza gasi nieaktualne ostrzeżenie o awarii połączenia wychodzącego', () =>
  withFakeConnections(async () => {
    // Lustro poprzedniego testu po stronie nadawcy: `dropOutgoing` ma tę samą
    // linię `markReachability(..., false)` i tę samą lukę — `close()` nie
    // emituje zdarzenia, więc stare ostrzeżenie przy widzu, który właśnie
    // zrezygnował, zostałoby do jego wyjścia z kanału.
    const unreachable: string[][] = []
    const { fire, session } = harness({
      onUnreachableChange: (peerIds) => unreachable.push(peerIds)
    })
    const track = { kind: 'video', contentHint: '' }
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track]
    } as unknown as MediaStream

    await session.startStream(stream, 'screen')
    await flush()
    const connection = onlyConnection()
    connection.connectionState = 'failed'
    connection.emit('connectionstatechange')
    // Kontrola, jak wyżej: ostrzeżenie musi się najpierw zapalić.
    expect(unreachable).toStrictEqual([['michal']])

    fire('signal', 'michal', { kind: 'unsubscribe', streamKind: 'screen' })
    await flush()
    expect(unreachable).toStrictEqual([['michal'], []])
  }))
