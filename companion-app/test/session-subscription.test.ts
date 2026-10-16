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

/**
 * Michał nadaje ekran ORAZ kamerę. Konfiguracja celowo wspierana (patrz
 * `src/shared/tileLayout.ts`: „Ta sama osoba nadająca ekran i kamerę ma DWA
 * klucze i to jest celowe") i jedyna, w której widać, czy operacja na jednym
 * rodzaju nie rusza drugiego. Przy atrapie z jednym strumieniem każda ścieżka
 * rodzaju mogła być zepsuta i test by tego nie zauważył.
 */
const JOINED_BOTH: JoinResult = {
  peerId: 'ja',
  displayName: 'Ja',
  peers: [{ peerId: 'michal', displayName: 'Michał' }],
  streams: [
    { peerId: 'michal', kind: 'screen' },
    { peerId: 'michal', kind: 'camera' }
  ]
}

function harness(callbacks: Partial<LobbyCallbacks> = {}, joined: JoinResult = JOINED): Harness {
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
  session.begin(joined)
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

// --- jedna osoba nadająca OBA rodzaje ------------------------------------

/*
 * Niezmiennik: ekran i kamera to osobne strumienie z osobnymi połączeniami, więc
 * operacja na jednym rodzaju nie ma prawa ruszyć drugiego. Testy wyżej używają
 * atrapy z JEDNYM strumieniem Michała, w której żadna ścieżka rodzaju nie jest
 * sprawdzana — a stawka jest konkretna: jedno kliknięcie krzyżyka gasiłoby dwa
 * kafelki, albo krzyżyk na kamerze kazałby nadawcy wyłączyć ekran.
 */

/** Rodzaje połączeń danego kierunku, w kolejności powstawania. */
function connectionKinds(session: LobbySession, direction: 'inbound' | 'outbound'): string[] {
  return session
    .diagnosticConnections()
    .filter((connection) => connection.direction === direction)
    .map((connection) => connection.kind)
}

/** Atrapa NASZEGO strumienia lokalnego; `hintContent` ustawia `contentHint` na ścieżce. */
function localVideoStream(): MediaStream {
  const track = { kind: 'video', contentHint: '' }
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track]
  } as unknown as MediaStream
}

/** Same wiadomości o odbiorze — oferty i odpowiedzi negocjacji nas tu nie dotyczą. */
function subscriptionMessages(sent: Harness['sent']): Harness['sent'] {
  return sent.filter(
    (message) =>
      message.payload['kind'] === 'unsubscribe' || message.payload['kind'] === 'subscribe'
  )
}

test('rezygnacja z odbioru ekranu nie zamyka kamery tej samej osoby', () =>
  withFakeConnections(async () => {
    const remote: [string, string, MediaStream | null][] = []
    const { session, sent, fire } = harness(
      { onRemoteStream: (peerId, kind, stream) => remote.push([peerId, kind, stream]) },
      JOINED_BOTH
    )

    // Oba strumienie Michała zestawiają się niezależnie: dwie oferty, dwa
    // osobne połączenia przychodzące.
    fire('signal', 'michal', {
      kind: 'offer',
      sdp: 'sdp-ekranu',
      owner: 'michal',
      stream: 'screen'
    })
    fire('signal', 'michal', {
      kind: 'offer',
      sdp: 'sdp-kamery',
      owner: 'michal',
      stream: 'camera'
    })
    await flush()
    // Kontrola: bez dwóch połączeń dalsze asercje byłyby prawdziwe na pusto.
    expect(connectionKinds(session, 'inbound')).toStrictEqual(['screen', 'camera'])

    session.unsubscribeFrom('michal', 'screen')
    // Zostaje DOKŁADNIE kamera — jedno kliknięcie krzyżyka gasi jeden kafelek.
    expect(connectionKinds(session, 'inbound')).toStrictEqual(['camera'])
    // Interfejs zapomina tylko o ekranie; kafelek kamery zachowuje swój obraz.
    expect(remote).toStrictEqual([['michal', 'screen', null]])
    // A do nadawcy idzie jedna wiadomość i tylko o ekranie.
    expect(subscriptionMessages(sent)).toStrictEqual([
      { to: 'michal', payload: { kind: 'unsubscribe', streamKind: 'screen' } }
    ])
  }))

test('rezygnacja z odbioru kamery mówi nadawcy o kamerze, nie o ekranie', () => {
  // Bez atrapy połączeń: nic nie zostało zestawione, a `closeIncoming`
  // nieistniejącego połączenia jest bezpieczne — tu chodzi o samą treść.
  const { session, sent } = harness({}, JOINED_BOTH)
  session.unsubscribeFrom('michal', 'camera')
  expect(sent).toStrictEqual([
    { to: 'michal', payload: { kind: 'unsubscribe', streamKind: 'camera' } }
  ])
})

test('przyjęta rezygnacja widza z ekranu nie zwija nadawanej mu kamery', () =>
  withFakeConnections(async () => {
    // Tu oba rodzaje nadajemy MY: ten jeden widz ma od nas dwa połączenia
    // wychodzące, każde pod własnym `connectionKey`.
    const { session, fire } = harness({}, JOINED_BOTH)
    await session.startStream(localVideoStream(), 'screen')
    await session.startStream(localVideoStream(), 'camera')
    await flush()
    expect(connectionKinds(session, 'outbound')).toStrictEqual(['screen', 'camera'])

    fire('signal', 'michal', { kind: 'unsubscribe', streamKind: 'screen' })
    await flush()
    // Krzyżyk na kafelku ekranu nie może wyłączyć naszej kamery u tego widza.
    expect(connectionKinds(session, 'outbound')).toStrictEqual(['camera'])
  }))

test('powrót widza do kamery daje ofertę na kamerę, nie na ekran', () =>
  withFakeConnections(async () => {
    const { session, sent, fire } = harness({}, JOINED_BOTH)
    await session.startStream(localVideoStream(), 'screen')
    await session.startStream(localVideoStream(), 'camera')
    await flush()
    expect(sent).toHaveLength(2)

    fire('signal', 'michal', { kind: 'unsubscribe', streamKind: 'camera' })
    await flush()
    // Rezygnacja widza niczego nie wysyła — zwija tylko nasze połączenie.
    expect(sent).toHaveLength(2)

    fire('signal', 'michal', { kind: 'subscribe', streamKind: 'camera' })
    await flush()
    // Trzecia wiadomość MUSI się pojawić. Gdyby powrót brał rodzaj skądkolwiek
    // indziej niż z treści prośby, trafiłby w nadal istniejące połączenie
    // ekranu, `callPeer` uznałby je za gotowe i oferta nie poszłaby wcale.
    expect(sent).toHaveLength(3)
    expect(sent[2]).toStrictEqual({
      to: 'michal',
      payload: { kind: 'offer', sdp: 'sdp-atrapa', owner: 'ja', stream: 'camera' }
    })
    expect(connectionKinds(session, 'outbound')).toStrictEqual(['screen', 'camera'])
  }))

test('`setSubscribed` kieruje: `false` to rezygnacja, `true` to powrót', () => {
  // Jedno wejście z interfejsu. Gałąź siedzi w sesji właśnie po to, żeby dało
  // się ją sprawdzić: w hooku jej odwrócenie przechodzi kompilację (oba
  // warianty mają ten sam typ) i cały zestaw testów, a dla człowieka znaczy,
  // że krzyżyk każe nadawcy PRZYSŁAĆ obraz.
  const { session, sent } = harness({}, JOINED_BOTH)
  session.setSubscribed('michal', 'screen', false)
  session.setSubscribed('michal', 'camera', true)
  expect(sent).toStrictEqual([
    { to: 'michal', payload: { kind: 'unsubscribe', streamKind: 'screen' } },
    { to: 'michal', payload: { kind: 'subscribe', streamKind: 'camera' } }
  ])
})

test('prośba o powrót od osoby, która już wyszła, nie daje oferty', () =>
  withFakeConnections(async () => {
    // Strażnik obecności w `callPeer`. Oferta do nieobecnego wraca od serwera
    // błędem `Nieznany peer: …`, a ten — niezaadresowany — trafia
    // w NAJSTARSZE wiszące żądanie i wywraca zupełnie inną operację. Samo
    // sprawdzenie w `subscribeTo` tu nie pomaga: prośba przychodzi z sieci,
    // a nie od naszego widoku.
    const { session, sent, fire } = harness()
    await session.startStream(localVideoStream(), 'screen')
    await flush()
    // Kontrola: nadajemy, więc jest o co prosić.
    expect(sent).toHaveLength(1)

    fire('peer-left', 'michal')
    fire('signal', 'michal', { kind: 'subscribe', streamKind: 'screen' })
    await flush()
    expect(sent).toHaveLength(1)
  }))
