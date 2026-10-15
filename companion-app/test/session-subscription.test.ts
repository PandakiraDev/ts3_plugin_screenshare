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
 * Testy chodzą w gołym Node, więc dotykają tylko ścieżek, które nie tworzą
 * `RTCPeerConnection`.
 */

type Listener = (...args: never[]) => void

interface Harness {
  session: LobbySession
  /** Co poszło do sygnalizacji, w kolejności wysyłki. */
  sent: { to: string; payload: Record<string, unknown> }[]
  /** Udaje zdarzenie od serwera sygnalizacyjnego. */
  fire: (event: string, ...args: unknown[]) => void
}

const NIC: LobbyCallbacks = {
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

function harness(): Harness {
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
  const session = new LobbySession(signaling as unknown as SignalingClient, NIC)
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
  expect(sent[0]?.payload).toEqual({ kind: 'unsubscribe', streamKind: 'screen' })
  // `toEqual` wyżej pilnuje już całego kształtu, ale ta asercja mówi wprost,
  // o co w nim chodzi: pole `stream` zepsułoby odbiór u starszych wersji.
  expect('stream' in (sent[0]?.payload ?? {})).toBe(false)
})

test('powrót do odbioru prosi nadawcę o ofertę', () => {
  const { session, sent } = harness()
  session.subscribeTo('michal', 'camera')
  expect(sent).toEqual([
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
  expect(sent).toEqual([])
})

test('rezygnacja po wyjściu osoby nie wysyła nic', () => {
  // Druga strona tego samego wyścigu: kliknięcie w krzyżyk może dojść już po
  // tym, jak osoba wyszła, a widok jeszcze tego nie pokazał.
  const { session, sent, fire } = harness()
  fire('peer-left', 'michal')
  session.unsubscribeFrom('michal', 'screen')
  expect(sent).toEqual([])
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
  expect(sent).toEqual([])
})

/**
 * Najmniejsza możliwa atrapa `RTCPeerConnection` — dokładnie to, czego dotyka
 * `createOutgoing` i `callPeer`, i nic więcej. Bez niej nie da się w gołym
 * Node sprawdzić RZECZY NAJWAŻNIEJSZEJ w tym zadaniu: że rezygnacja faktycznie
 * zwija nadawanie, a powrót faktycznie je odtwarza. Atrapa nie udaje
 * negocjacji — tylko oddaje sterowanie z powrotem do sesji.
 */
class FakeConnection {
  static readonly all: FakeConnection[] = []
  closed = false

  constructor() {
    FakeConnection.all.push(this)
  }

  addTrack(): RTCRtpSender {
    return {
      getParameters: () => ({ encodings: [{}] }),
      setParameters: () => Promise.resolve()
    } as unknown as RTCRtpSender
  }

  addEventListener(): void {}

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

  getSenders(): RTCRtpSender[] {
    return []
  }

  close(): void {
    this.closed = true
  }
}

/** Oddaje pętlę zdarzeń: `callPeer` jest wołane przez `void`, bez czekania. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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
    expect(sent[1]).toEqual({
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
    expect(sent.at(-1)).toEqual({
      to: 'michal',
      payload: { kind: 'unsubscribe', streamKind: 'screen' }
    })
  } finally {
    globalThis.RTCPeerConnection = previous
  }
})
