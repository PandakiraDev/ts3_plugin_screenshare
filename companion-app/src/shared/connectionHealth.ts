/**
 * Co jest nie tak z połączeniem — wyliczane z bieżących warunków, nigdy
 * z zapamiętanych zdarzeń.
 *
 * Dlaczego stan, a nie zdarzenia: z jednorazowego „połączenie nie wstało" nie
 * da się dowiedzieć, że problem MINĄŁ. Pasek zbudowany na zdarzeniach wisiałby
 * po ustaniu przyczyny i wymagałby przycisku zamykania. Ten model gaśnie sam.
 */
export type ConnectionProblem =
  /**
   * Gniazdo do serwera sygnalizacyjnego padło bez naszego udziału.
   *
   * DLACZEGO TO NIE JEST ZAPAMIĘTANE ZDARZENIE, choć tak wygląda. Nagłówek tego
   * pliku zabrania problemów budowanych na zdarzeniach, bo takie wiszą po
   * ustaniu przyczyny. `signalingClosed` z `useLobby` opisuje stan
   * TERAŹNIEJSZY — „to okno jest odcięte od serwera" — a nie fakt z przeszłości:
   * dopóki jest prawdą, pasek ma prawo świecić, i gaśnie sam, bo `useLobby`
   * zeruje to pole na starcie każdej nowej próby połączenia, tym samym
   * `setState` co `error`.
   *
   * WARUNEK, OD KTÓREGO TO ZALEŻY — i jedyny sposób, żeby to złamać. Dziś jedyną
   * drogą do nowego gniazda jest nowa próba połączenia, a ta pole zeruje. Gdyby
   * ktoś dołożył PONAWIANIE połączenia (wciąż otwarte na liście długów
   * w `TODO.md`, sekcja z 2026-08-10), musi zerować to pole po UDANYM
   * połączeniu. Inaczej pasek zostanie zapalony do końca sesji i trzeba będzie
   * dorobić mu przycisk zamykania — czyli dokładnie ta awaria, której zakazuje
   * nagłówek.
   */
  | { kind: 'signaling-closed' }
  | { kind: 'server-waking'; secondsWaiting: number }
  | { kind: 'peer-unreachable'; names: string[] }
  | { kind: 'slow-uplink' }
  | { kind: 'viewers-struggling' }

/** Zwykłe połączenie wstaje od razu; dłuższe czekanie to budzący się Render. */
export const SERVER_WAKING_AFTER_MS = 5_000

/**
 * Ile pierwszych sekund strumienia ignorujemy przy ocenie łącza.
 *
 * Pomiar z TODO § 1: przy kamerze 1080p60 `qualityLimitationReason` było
 * `bandwidth` do ~41 s, po czym samo spadło do `none` — sterowanie przepływem
 * dochodziło do równowagi, łącze nie miało z tym nic wspólnego. 45 s daje zapas
 * ponad tę wartość.
 */
export const UPLINK_WARMUP_MS = 45_000

/** Jak długo ograniczenie musi się utrzymać PO rozbiegu, zanim coś powiemy. */
export const UPLINK_DEBOUNCE_MS = 10_000

/**
 * Jeden problem naraz, po priorytecie. Kolejność odzwierciedla zagnieżdżenie:
 * bez serwera informacja o łączu jest bez znaczenia.
 */
export function pickProblem(input: {
  connectingForMs: number | null
  unreachableNames: string[]
  uplinkSlow: boolean
  viewersStruggling: boolean
  signalingClosed: boolean
}): ConnectionProblem | null {
  /*
   * Zerwane gniazdo sygnalizacji PRZED wszystkim innym: ten sam układ
   * zagnieżdżenia co niżej („bez serwera informacja o łączu jest bez
   * znaczenia"), tylko o piętro wyżej. To jest przyczyna, i jedyna rada, jaka
   * przy niej zostaje (otwórz okno ponownie), jest zarazem jedyną, która
   * dotyczy TEGO stanu — każda inna posłałaby użytkownika do przykręcania
   * rozdzielczości albo do cudzego firewalla, podczas gdy okno jest głuche.
   *
   * Uczciwie o zasięgu tego argumentu, bo pozostałych NIE obejmuje jednakowo
   * i NIE jest prawdą, że po zerwaniu gniazda nic innego się już nie
   * aktualizuje — sprawdzone w kodzie, nie założone:
   * - `viewersStruggling` faktycznie przestaje być odświeżane: raporty widzów
   *   jadą wiadomością `signal` przez to gniazdo. Gaśnie samo po
   *   `QUALITY_STALE_AFTER_MS` (15 s, `shared/viewerQuality.ts`), więc przez te
   *   15 s podawałoby ostatni werdykt jako bieżący.
   * - `unreachableNames` aktualizuje się DALEJ — bierze się z lokalnego
   *   `connectionstatechange` na naszych połączeniach (`session.ts`,
   *   `markReachability`), a nie z serwera. Przegrywa z dwóch innych powodów:
   *   nazwy dokłada mu skład lobby, a ten po zerwaniu jest zamrożony, i zdanie
   *   o NAT-cie albo firewallu konkretnej osoby wskazywałoby winnego w chwili,
   *   w której padło nam łącze do serwera — kierunkowe kłamstwo tej samej
   *   klasy co opisane przy `peer-unreachable` niżej.
   * - `uplinkSlow` też jest świeży (`getStats` na własnych nadajnikach, bez
   *   udziału serwera). Przegrywa, bo pasek mówi jedną rzecz naraz, a rada
   *   „zmniejsz rozdzielczość" nie dotyka tego, co użytkownik właśnie stracił.
   * - `connectingForMs` da się mieć ustawione razem z tym polem tylko w wąskim
   *   okienku, gdy gniazdo pada W TRAKCIE `join` (subskrypcja `close`
   *   w `useLobby` stoi przed `join`). Wtedy zamknięte gniazdo jest
   *   dokładniejszą przyczyną niż „serwer się budzi, czekaj".
   */
  if (input.signalingClosed) return { kind: 'signaling-closed' }
  if (input.connectingForMs !== null && input.connectingForMs >= SERVER_WAKING_AFTER_MS) {
    return {
      kind: 'server-waking',
      secondsWaiting: Math.floor(input.connectingForMs / 1000)
    }
  }
  if (input.unreachableNames.length > 0) {
    return { kind: 'peer-unreachable', names: input.unreachableNames }
  }
  if (input.uplinkSlow) return { kind: 'slow-uplink' }
  // Niżej niż zatkane łącze: obie sytuacje mają tę samą radę, ale tamta
  // nazywa przyczynę dokładniej.
  if (input.viewersStruggling) return { kind: 'viewers-struggling' }
  return null
}

function formatWait(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export function problemText(problem: ConnectionProblem): string {
  switch (problem.kind) {
    case 'signaling-closed':
      // Co się dzieje, co to znaczy dla człowieka, co ma zrobić — ten sam układ
      // co w pozostałych zdaniach. Rada jest jedna i jest prawdziwa: nic tego
      // połączenia nie ponawia (zadanie 8 potwierdziło to czytaniem kodu, a
      // `TODO.md` trzyma ponawianie jako dług OTWARTY), więc obiecanie powrotu
      // albo zaproszenie do czekania — jak „Czekam…" przy budzącym się
      // serwerze — byłoby obietnicą, której nic nie dowiezie.
      //
      // Czego to zdanie świadomie NIE mówi: że obraz, który już idzie, nie
      // przerwie się. Trwające połączenia faktycznie zwykle żyją dalej, ale
      // renegocjacja i nowi kandydaci ICE jadą tym samym martwym gniazdem, więc
      // ta pociecha byłaby obietnicą na przyszłość, której nie mamy z czego
      // dać. Ta sama lekcja co przy `peer-unreachable` niżej: nie precyzuj
      // rzeczy, o których ten moduł nie wie.
      //
      // Zdanie jest INNE niż wpis w dzienniku (`SIGNALING_CLOSED_TEXT`
      // w `src/shared/lobbyEvents.ts`), choć pierwsza połowa mówi to samo, i to
      // jest celowe: tam czyta diagnozujący, więc gniazdo nazywa się „serwerem
      // sygnalizacyjnym" i nie ma rady, bo linia czytana godzinę później
      // kazałaby zrestartować okno, które dawno jest zrestartowane. Tu czyta
      // ktoś w trakcie grania. Dlatego też nie wspólna stała przez import:
      // pasek nie ma powodu zależeć od dziennika, a oba napisy są przypięte
      // testami na dokładny tekst, więc rozjazd nie przejdzie niezauważony.
      return (
        'Połączenie z serwerem zerwane — wejścia, wyjścia i nowe transmisje nie będą już ' +
        'widoczne. Nic tego połączenia nie ponawia: otwórz okno ponownie z menu kanału ' +
        'w TeamSpeaku.'
      )
    case 'server-waking':
      return (
        'Serwer się budzi — pierwsze połączenie wieczorem trwa kilkadziesiąt ' +
        `sekund. Czekam… (${formatWait(problem.secondsWaiting)})`
      )
    case 'peer-unreachable':
      // Przy kilku osobach wymieniamy liczbę, nie listę: pasek ma jedną linijkę,
      // a lista nazwisk rozepchnęłaby go na pół okna.
      //
      // Zdanie musi być neutralne kierunkowo: rejestr `failedConnections` w
      // session.ts miesza połączenia WYCHODZĄCE (`out:`, my nadajemy) i
      // PRZYCHODZĄCE (`in:`, ktoś nadaje do nas) — z samej nazwy na liście nie
      // wiadomo, w którą stronę padło. „Obraz od tej osoby nie dojdzie" byłoby
      // fałszywe przy awarii połączenia wychodzącego (my nadajemy, adresat nie
      // widzi NASZEGO obrazu) — a układ „jeden nadaje, kilku ogląda" jest tu
      // najczęstszy, więc ten fałszywy wariant widziałoby się częściej niż
      // prawdziwy. Nie precyzuj z powrotem kierunku bez dodania pola
      // `direction` do rejestru — inaczej wracamy do kłamstwa.
      return problem.names.length === 1
        ? `Nie udało się zestawić połączenia z ${problem.names[0]} — obraz między ` +
            'wami nie przejdzie. Zwykle winny jest restrykcyjny NAT albo firewall.'
        : `Nie udało się zestawić połączenia z ${problem.names.length} osobami — ` +
            'obraz między wami nie przejdzie. Zwykle winny jest restrykcyjny NAT ' +
            'albo firewall.'
    case 'slow-uplink':
      return 'Twoje łącze nie nadąża — zmniejsz rozdzielczość albo FPS w ustawieniach.'
    case 'viewers-struggling':
      return 'Obraz zacina się u wszystkich widzów — zmniejsz rozdzielczość albo FPS.'
  }
}

/** Stan obserwacji łącza. Trzyma go hook, przesuwa `advanceUplinkWatch`. */
export interface UplinkWatch {
  /** Kiedy zaczęliśmy nadawać; null = nie nadajemy. */
  sharingSince: number | null
  /** Od kiedy trwa ograniczenie liczone PO rozbiegu; null = nie trwa. */
  limitedSince: number | null
  /**
   * Posortowany, złączony zestaw aktualnie nadawanych rodzajów strumienia
   * (np. `'camera,screen'`); pusty string = nie nadajemy. Identyfikuje bieżący
   * rozbieg — zmiana zestawu (np. dołożenie kamery do trwającego udostępniania
   * ekranu) zaczyna go od nowa, patrz niżej.
   */
  sharingKey: string
}

export const NO_UPLINK_WATCH: UplinkWatch = {
  sharingSince: null,
  limitedSince: null,
  sharingKey: ''
}

/**
 * Uwaga na kolejność: w czasie rozbiegu `limitedSince` w ogóle się NIE zaczyna
 * liczyć. Gdyby zaczynało, licznik debounce'u zdążyłby dobiec do końca razem
 * z rozbiegiem i komunikat wyskoczyłby dokładnie w momencie, w którym
 * ograniczenie samo znika.
 *
 * Zmiana `sharingKey` (inny zestaw nadawanych rodzajów niż w poprzedniej
 * próbce) zaczyna rozbieg od nowa — bez tego stary `sharingSince` przetrwałby
 * np. dołożenie kamery do trwającego udostępniania ekranu, a dawno ubiegły
 * rozbieg ekranu maskowałby świeży rozbieg kamery: pasek oskarżyłby łącze
 * w trakcie ramp-upu sterowania przepływem, dokładnie tego, co rozbieg ma
 * tłumić (patrz komentarz przy UPLINK_WARMUP_MS wyżej). Świadomy koszt:
 * włączenie ALBO wyłączenie kamery w trakcie sesji ucisza ostrzeżenie o łączu
 * na kolejne 45 s, nawet jeśli łącze faktycznie jest zatkane. Wybieramy
 * chwilową ciszę zamiast fałszywego oskarżenia — komunikat, który raz
 * skłamie, przestaje być czytany.
 */
export function advanceUplinkWatch(
  watch: UplinkWatch,
  sample: { sharingKey: string; limited: boolean; now: number }
): UplinkWatch {
  if (sample.sharingKey === '') return NO_UPLINK_WATCH

  // Nowy zestaw strumieni = nowy rozbieg, od zera. `sharingSince` ustawiony na
  // `sample.now` gwarantuje, że poniższe `inWarmup` wyjdzie prawdziwe (różnica
  // to 0 < UPLINK_WARMUP_MS), więc druga gałąź niżej i tak zawsze widzi
  // `startingNewRun === false` — `limitedSince` nie musi tego osobno sprawdzać.
  const startingNewRun = sample.sharingKey !== watch.sharingKey
  const sharingSince = startingNewRun ? sample.now : (watch.sharingSince ?? sample.now)
  const inWarmup = sample.now - sharingSince < UPLINK_WARMUP_MS
  if (inWarmup || !sample.limited) {
    return { sharingSince, limitedSince: null, sharingKey: sample.sharingKey }
  }

  return {
    sharingSince,
    limitedSince: watch.limitedSince ?? sample.now,
    sharingKey: sample.sharingKey
  }
}

export function isUplinkSlow(watch: UplinkWatch, now: number): boolean {
  if (watch.limitedSince === null) return false
  return now - watch.limitedSince >= UPLINK_DEBOUNCE_MS
}
