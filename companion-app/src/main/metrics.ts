import { app } from 'electron'
import { execFile } from 'node:child_process'
import { readGpu, type GpuReading, type SystemStats } from '@shared/diagnostics'
import {
  GPU_REGISTRY_CLASS_KEY,
  GPU_REGISTRY_VALUE_NAME_DESCRIPTION,
  GPU_REGISTRY_VALUE_NAME_MEMORY,
  parseGpuRegistry,
  type GpuCard
} from '@shared/gpuInfo'

/*
 * Odczyt GPU trzymamy osobno od zegara próbek. `nvidia-smi` to uruchomienie
 * procesu i mierzy 46,5 ms (min 45,5, max 47,9), czyli 4,7% sekundy. Czekanie
 * na niego w tyknięciu zablokowałoby proces główny i dałoby zacinanie
 * interfejsu — dokładnie to, czego w tej aplikacji szukamy.
 *
 * Zamiast tego odpytujemy w tle, rzadziej niż próbkujemy
 * (`GPU_POLL_INTERVAL_MS`), a tyknięcie bierze ostatni znany odczyt razem
 * z JEGO znacznikiem czasu.
 */
let lastGpu: GpuReading | null = null

/*
 * Najwyżej jedno wywołanie `nvidia-smi` naraz. Gdy poprzednie jeszcze nie
 * wróciło, tyknięcie jest pomijane, a nie uruchamiane drugi raz: przy wolnym
 * sterowniku dokładanie procesów zmieniałoby to, co mierzymy. Znacznik zdejmujemy
 * zawsze, także po błędzie, bo inaczej jedna awaria zablokowałaby odpytywanie
 * na stałe.
 *
 * Blokada obejmuje CAŁE tyknięcie, więc w pierwszym także czekanie na wykrycie
 * karty (24 ms odczytu rejestru) — patrz `pollOnce`. Dalej trzyma się do
 * POWROTU CALLBACKU `execFile`, a nie do upływu 3 s:
 * `timeout` tylko zabija proces, a znacznik zdejmuje dopiero wywołanie
 * callbacku. Osobnego watchdoga nie ma, więc callback, który nigdy nie wróci,
 * zatrzymałby odpytywanie do restartu aplikacji. Ten skutek jest WIDOCZNY:
 * ostatni odczyt zostaje ze swoim znacznikiem, a `formatResourceBadge` po
 * `GPU_STALE_AFTER_MS` pokazuje kreskę z jego godziną zamiast liczb. Do
 * przeglądu przed scaleniem nie pokazywał tego nikt — `GpuReading.at` nie miał
 * ani jednego czytelnika — więc zawieszony sterownik przyklejałby na pasku
 * swoje ostatnie procenty do końca sesji.
 */
let gpuPollInFlight = false

/*
 * Numer wywołania zamiast znacznika `at`: wynik starszego wywołania nie może
 * nadpisać nowszego. Przy działającej blokadzie wyżej wywołania nie nakładają
 * się, a wynik jest zapisywany, zanim blokada zostanie zdjęta (ciało
 * `pollOnce` kończy się przed jej `finally`), więc ten strażnik NIGDY nie
 * zadziała. To obrona w głąb, nie czynny mechanizm: zadziałałby dopiero po
 * usunięciu lub zepsuciu blokady.
 *
 * Porównujemy numery, a nie czas, z dwóch powodów. Zegar systemowy może się
 * cofnąć i wtedy porównanie znaczników zamroziłoby odczyt na czas cofnięcia.
 * Poza tym odczyt `null` (nieudany) NIE MA pola `at`, więc znaczniki w ogóle
 * nie uporządkowałyby porażek względem udanych odczytów, a numer porządkuje
 * jedne i drugie. Odczyt `null` też zapisujemy, jeśli jest nowszy: brak
 * informacji zastępuje starą informację.
 */
let gpuRequestSeq = 0
let gpuStoredSeq = 0

const NVIDIA_SMI_ARGS = [
  '--query-gpu=utilization.gpu,memory.used,memory.total',
  '--format=csv,noheader,nounits'
]

function runNvidiaSmi(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('nvidia-smi', NVIDIA_SMI_ARGS, { timeout: 3_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/*
 * Wykrycie karty RAZ na uruchomienie, nie przy próbce: karta nie zmienia się
 * w trakcie sesji, a każdy odczyt to uruchomienie procesu.
 *
 * Obietnica, nie zwykła wartość, bo odczyt jest ASYNCHRONICZNY, a pierwsze
 * tyknięcie odpytywania wypada przed jego powrotem — patrz komentarz
 * w `startGpuPolling`. Trzymamy ją w module, żeby wszyscy czekali na TO SAMO
 * wywołanie: drugi wołający dostaje tę samą obietnicę, a nie drugi `reg query`.
 */
let gpuCardDetection: Promise<GpuCard | null> | null = null
let detectedCard: GpuCard | null = null

/*
 * Jedno wywołanie `reg query` na nazwę wartości, zamiast jednego na wszystko.
 * To wygląda na komplikację i jest nią, ale pomiary na maszynie właściciela nie
 * zostawiają wyboru (mediana z siedmiu przebiegów, `execFile` bez powłoki):
 *
 *   klucz klasy, bez `/s`                      11,5 ms   ale ZERO nazw kart
 *   klucz klasy z `/s` (rekurencyjnie)       > 3 000 ms   zabity przez `timeout`
 *   jeden podklucz karty NVIDIA              1 480,9 ms   55 KB wyjścia
 *   klucz klasy z `/s /v DriverDesc`            16,2 ms   508 B
 *   klucz klasy z `/s /v ...qwMemorySize`       15,1 ms   378 B
 *
 * Czyli: klucz klasy sam w sobie nie zawiera nazw kart (to tylko metadane
 * klasy), rekurencyjny odczyt całej klasy nie mieści się w trzysekundowym
 * `timeout`, a podklucz karty NVIDIA trwa półtorej sekundy, bo sterownik
 * upycha tam setki wartości. Dwa zapytania zawężone do nazwy wartości
 * kosztują razem 24 ms zmierzone równolegle — i to jest jedyny kształt
 * mieszczący się w wymaganiu „dziesiątki milisekund" ze specyfikacji.
 */
function runRegQuery(valueName: string): Promise<string> {
  return new Promise((resolve) => {
    /*
     * Każde z dwóch wywołań jest zabezpieczone OSOBNO i porażka daje pusty
     * napis, a nie odrzucenie. Zmierzone: gdy żadna karta nie publikuje
     * `qwMemorySize`, `reg` kończy się kodem 1 i stopką „End of search: 0
     * match(es) found." — przy wspólnym `catch` zgubilibyśmy wtedy także
     * NAZWĘ karty, czyli całą wiadomość dla człowieka z powodu brakującego
     * pola dodatkowego.
     *
     * Ten sam `timeout` co dla `nvidia-smi`: nie jest budżetem (te zapytania
     * mierzą 16 ms), tylko bezpiecznikiem przed zawieszonym `reg`.
     */
    execFile(
      'reg',
      ['query', GPU_REGISTRY_CLASS_KEY, '/s', '/v', valueName],
      { timeout: 3_000 },
      (_error, stdout) => resolve(stdout ?? '')
    )
  })
}

/**
 * Jaką kartę widzi system. Wykrywa przy pierwszym wywołaniu, potem oddaje
 * zapamiętany wynik. Nigdy nie odrzuca obietnicy — diagnostyka jest dodatkiem
 * i jej awaria nie może zatrzymać niczego wyżej.
 */
export function detectGpuCard(): Promise<GpuCard | null> {
  gpuCardDetection ??= (async () => {
    try {
      // Równolegle, nie po kolei: 24 ms zamiast 31 ms, a oba zapytania są
      // czytaniem rejestru, więc nie przeszkadzają sobie wzajemnie.
      const outputs = await Promise.all([
        runRegQuery(GPU_REGISTRY_VALUE_NAME_DESCRIPTION),
        runRegQuery(GPU_REGISTRY_VALUE_NAME_MEMORY)
      ])
      // Zlepione w jeden napis: parser akumuluje po nagłówkach podkluczy,
      // więc ten sam podklucz z dwóch wyjść składa się w jedną kartę.
      detectedCard = parseGpuRegistry(outputs.join(''))
    } catch {
      detectedCard = null
    }
    return detectedCard
  })()
  return gpuCardDetection
}

/** Zwraca funkcję zatrzymującą odpytywanie. */
export function startGpuPolling(intervalMs: number): () => void {
  let stopped = false
  /*
   * Nazwany `let` z jawnym `null`, a nie `const` z wnioskowania: zegar jest
   * teraz zatrzymywany z DWÓCH miejsc — przez zwróconą funkcję i przez samo
   * tyknięcie, gdy okaże się, że karta nie jest NVIDIĄ. Przy `const`
   * przypisywanym po pierwszym `tick()` zatrzymanie z wnętrza tyknięcia
   * zależałoby od tego, że `await` zawsze ustępuje do mikrozadania — prawda,
   * ale prawda niewidoczna w kodzie i znikająca przy pierwszej przebudowie.
   */
  let timer: ReturnType<typeof setInterval> | null = null
  const stopTimer = (): void => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  const pollOnce = async (seq: number): Promise<void> => {
    /*
     * Czekamy na wykrycie karty PRZED odpytaniem jej o zużycie, i to jest
     * świadome rozstrzygnięcie okienka między startem a powrotem wykrywania.
     *
     * Wykrywanie jest asynchroniczne, a `startGpuPolling` wołane przy starcie,
     * więc pierwsze tyknięcie wypada, kiedy nie wiemy jeszcze, co to za karta.
     * Dwie łatwe odpowiedzi są obie złe: odpytać `nvidia-smi` „na wszelki
     * wypadek" znaczy uruchomić proces, którego właśnie postanowiliśmy nie
     * uruchamiać u użytkownika AMD, a pominąć pierwsze tyknięcie znaczy
     * odebrać użytkownikowi NVIDII pierwszy odczyt i kazać mu czekać pełne
     * `GPU_POLL_INTERVAL_MS` (5 s) na pierwsze liczby na pasku.
     *
     * Dlatego pierwsze tyknięcie CZEKA. Kosztuje to 24 ms zmierzonego odczytu
     * rejestru — mniej, niż trwa samo `nvidia-smi` (46,5 ms) — i nie gubi
     * ani jednego odczytu. Blokada `gpuPollInFlight` jest już wtedy założona
     * (ustawia ją `tick` przed wywołaniem), więc to czekanie nie wpuszcza
     * drugiego wywołania. Kolejne tyknięcia dostają obietnicę już spełnioną,
     * czyli czekają przez jedno mikrozadanie.
     */
    const card = await detectGpuCard()
    if (stopped) return
    /*
     * Rozpoznana karta inna niż NVIDIA: nie odpytujemy NIC i gasimy zegar.
     * Dotąd proces startował co 5 s tylko po to, żeby dostać błąd „nie ma
     * takiego programu" — w aplikacji, w której diagnozujemy zacinanie.
     *
     * Warunek jest o karcie ROZPOZNANEJ. Przy `card === null` (rejestr
     * nieczytelny, `reg` nieobecny, wyjście nieznanego kształtu) odpytujemy
     * dalej, czyli zachowujemy się jak dotychczas: niewiedza o karcie nie może
     * wyłączyć licznika komuś, kto ma NVIDIĘ i działające `nvidia-smi`.
     *
     * `lastGpu` zostaje wtedy `null` na zawsze i pasek pokazuje „GPU —".
     * Samo to jest nieodróżnialne od zawieszonego sterownika — nazwę karty
     * i powód niesie osobny tekst (`formatGpuCard`), patrz punkt 2 z Review
     * Focus w planie.
     */
    if (card !== null && !card.utilizationAvailable) {
      stopTimer()
      return
    }
    // Znacznik czasu zdejmuje `readGpu` PO powrocie wywołania, nie tutaj przed
    // nim: opisuje chwilę, w której wartości były znane, a nie chwilę, w której
    // o nie zapytaliśmy. Te dwie dzieli 46,5 ms, czyli tyle, ile trwa
    // `nvidia-smi` — przy progu rzędu sekund nieszkodliwie, ale jako stałe
    // zaniżanie wieku, od którego zależy teraz kreska na pasku, już nie.
    const reading = await readGpu(runNvidiaSmi, () => Date.now())
    // Po zatrzymaniu nie zapisujemy nic: wynik w locie nadpisałby
    // wyzerowany `lastGpu` odczytem, który od tej chwili już tylko się
    // starzeje, bo nic go nie odświeży.
    if (stopped) return
    if (seq > gpuStoredSeq) {
      gpuStoredSeq = seq
      lastGpu = reading
    }
  }

  const tick = (): void => {
    if (gpuPollInFlight) return
    gpuPollInFlight = true
    const seq = ++gpuRequestSeq
    // Zapis siedzi w ciele `pollOnce`, czyli kończy się PRZED spełnieniem jej
    // obietnicy, a więc przed `finally` zdejmującym blokadę — ta kolejność jest
    // założeniem strażnika numerów wyżej.
    void pollOnce(seq).finally(() => {
      gpuPollInFlight = false
    })
  }
  tick()
  timer = setInterval(tick, intervalMs)
  return () => {
    stopped = true
    stopTimer()
    // Zerujemy ostatni odczyt, bo po zatrzymaniu nikt go już nie odświeży:
    // `latestGpu()` oddawałby coraz starszy odczyt jako bieżący. Dziś stop jest
    // przy `will-quit`, ale wiek odczytu decyduje teraz o tym, co widać na
    // pasku, więc „nieszkodliwe" przestało być prawdą.
    lastGpu = null
  }
}

export function latestGpu(): GpuReading | null {
  return lastGpu
}

/**
 * Zużycie procesora i pamięci całej aplikacji — suma po wszystkich procesach
 * Electrona. Rozbicie na procesy świadomie pomijamy: suma odpowiada na pytanie
 * „czy aplikacja zjada maszynę", a to jest pytanie, które zadajemy.
 *
 * `getAppMetrics()` jest synchroniczne i tanie, więc wywołujemy je w tyknięciu.
 */
export function readSystemStats(): SystemStats {
  let cpuPercent = 0
  let memoryKb = 0
  for (const entry of app.getAppMetrics()) {
    cpuPercent += entry.cpu?.percentCPUUsage ?? 0
    memoryKb += entry.memory?.workingSetSize ?? 0
  }
  return { cpuPercent, memoryMb: memoryKb / 1024, gpu: latestGpu() }
}
