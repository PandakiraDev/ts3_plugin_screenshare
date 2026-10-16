/*
 * Karta graficzna: co to za model, ile ma pamięci i czy umiemy zmierzyć jej
 * zużycie.
 *
 * Osobny plik, nie dopisek do `src/shared/diagnostics.ts`: tamten ma już 783
 * linie. Czysty, bez `electron` i `node:child_process`, żeby dał się sprawdzić
 * w gołym vitest — proces główny wstrzykuje uruchamianie `reg query` i podaje
 * tutaj gotowe wyjście, tak samo jak robi to z `nvidia-smi` dla `readGpu`.
 */

/**
 * Co wiemy o karcie. Trzy pola, trzy różne rodzaje niewiedzy:
 * - `name` jest zawsze — wpis bez nazwy nie staje się kartą, bo nie ma czego
 *   pokazać człowiekowi;
 * - `memoryMb === null` znaczy „nie wiem", NIGDY „karta bez pamięci". Ta sama
 *   reguła co w `SystemStats.gpu` i w licznikach klatek;
 * - `utilizationAvailable` mówi, czy w ogóle ma sens odpytywanie zużycia.
 */
export interface GpuCard {
  name: string
  memoryMb: number | null
  utilizationAvailable: boolean
}

/**
 * Klucz klasy „Display adapters" w rejestrze. Karty siedzą w PODKLUCZACH
 * numerowanych (`\0000`, `\0001`, ...), a nie w nim samym — sam klucz ma tylko
 * metadane klasy (`Class`, `ClassDesc`, `IconPath`). Zmierzone: `reg query`
 * na samym kluczu wraca w 11,5 ms i nie zawiera ANI JEDNEJ nazwy karty.
 */
export const GPU_REGISTRY_CLASS_KEY =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'

/**
 * Nazwa wartości z opisem karty, czyli to, co widzi człowiek.
 *
 * `DriverDesc`, a nie `HardwareInformation.AdapterString`: na maszynie
 * właściciela karta AMD trzyma `AdapterString` jako `REG_BINARY` (UTF-16LE
 * w heksach), więc parsowanie jej wymagałoby dekodowania napisu z bajtów dla
 * jednego producenta, a dla drugiego nie. `DriverDesc` jest `REG_SZ` u obu.
 */
export const GPU_REGISTRY_VALUE_NAME_DESCRIPTION = 'DriverDesc'

/**
 * Nazwa wartości z rozmiarem pamięci karty, 64-bitowa.
 *
 * Tylko `qwMemorySize`. Obok leży `HardwareInformation.MemorySize` typu
 * `REG_DWORD`, czyli ta sama liczba obcięta do 32 bitów: zmierzone
 * `0xfff00000` = 4095 MB dla karty 12 GB — to samo przepełnienie, z którego
 * powodu nie używamy `Win32_VideoController.AdapterRAM`. Użycie go jako
 * zapasowego źródła dałoby licznik, który kłamie, a kłamać mu nie wolno:
 * lepiej `null` („nie wiem") niż pewna nieprawda.
 */
export const GPU_REGISTRY_VALUE_NAME_MEMORY = 'HardwareInformation.qwMemorySize'

/**
 * Czy to karta NVIDIA, czyli jedyna, której zużycie umiemy zmierzyć tanio.
 *
 * Dopasowanie do nazwy producenta w opisie sterownika. Nie do słów z nazwy
 * modelu („GeForce", „RTX"), bo te wędrują po napisach producentów kart
 * niereferencyjnych i po wirtualnych monitorach.
 *
 * Ściślejszy byłby identyfikator producenta z PCI (`MatchingDeviceId` zawiera
 * `ven_10de` dla NVIDII), ale to trzecie wywołanie `reg query` i kolejne
 * 16 ms przy starcie; przy opisie sterownika pisanym przez samego producenta
 * ryzyko pomyłki jest teoretyczne, więc zostawiamy to na później.
 */
export function isNvidia(name: string): boolean {
  return /nvidia/i.test(name)
}

/** Nagłówek podklucza w wyjściu `reg query`. */
const REGISTRY_SUBKEY_LINE = /^HKEY_/

/**
 * Wiersz wartości: `    NazwaWartości    REG_TYP    dana`.
 *
 * Zakotwiczone na ŻETONIE TYPU, a nie na liczeniu spacji od lewej, z dwóch
 * powodów zmierzonych na prawdziwym wyjściu: nazwa wartości może zawierać
 * spacje (`Device Description`) i dana też może je zawierać („NVIDIA GeForce
 * RTX 4070"), więc podział po pierwszej spacji rozjechałby jedno albo drugie.
 * Żetony `REG_SZ`/`REG_QWORD` nie są tłumaczone na język systemu, w odróżnieniu
 * od stopki „End of search" — dlatego kotwica jest właśnie tutaj.
 */
const REGISTRY_VALUE_LINE = /^\s+(\S.*?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/

/** Szesnastkowa dana `reg query`, np. `0x2ffa00000`. */
const REGISTRY_HEX_VALUE = /^0x[0-9a-f]+$/i

const BYTES_IN_MEGABYTE = 1024 * 1024

/** Kandydat zbierany po podkluczach, zanim wybierzemy jednego. */
interface CardCandidate {
  name: string | null
  memoryMb: number | null
}

/**
 * Składa kartę z wyjścia `reg query`.
 *
 * Bierze JEDEN napis, choć proces główny robi DWA wywołania (po jednym na
 * nazwę wartości) i zlepia ich wyjścia — powód jest w `metrics.ts` przy
 * `readGpuRegistry`. Parser jest na to obojętny, bo akumuluje po nagłówkach
 * podkluczy: ten sam podklucz wystąpi dwa razy i za drugim razem dołoży
 * brakujące pole. Kolejność wywołań nie ma znaczenia, a wyjście pełnego
 * `/s` (gdyby kiedyś było tanie) przeszłoby przez to samo ciało.
 *
 * Nigdy nie rzuca: wyjście nieznanego kształtu daje `null`, czyli „nie
 * rozpoznaliśmy karty", a to jest stan, który `formatGpuCard` umie nazwać.
 */
export function parseGpuRegistry(stdout: string): GpuCard | null {
  const candidates = new Map<string, CardCandidate>()
  let subkey: string | null = null

  for (const rawLine of stdout.split('\n')) {
    // `reg` pisze CRLF; bez tego cięcia dana ostatniej kolumny kończyłaby się
    // znakiem powrotu karetki i nazwa karty miałaby niewidoczny ogon.
    const line = rawLine.replace(/\r$/, '')
    if (REGISTRY_SUBKEY_LINE.test(line)) {
      subkey = line.trim()
      continue
    }
    // Wiersz wartości bez nagłówka nad sobą nie wie, do której karty należy,
    // więc jest pomijany, a nie przypisywany do czegokolwiek.
    if (subkey === null) continue

    const match = REGISTRY_VALUE_LINE.exec(line)
    if (match === null) continue
    const [, valueName, , data] = match

    if (valueName === GPU_REGISTRY_VALUE_NAME_DESCRIPTION) {
      const name = data.trim()
      if (name !== '') candidateFor(candidates, subkey).name = name
      continue
    }
    if (valueName === GPU_REGISTRY_VALUE_NAME_MEMORY) {
      candidateFor(candidates, subkey).memoryMb = parseMemoryMb(data.trim())
    }
  }

  return bestCard([...candidates.values()])
}

function candidateFor(candidates: Map<string, CardCandidate>, subkey: string): CardCandidate {
  const existing = candidates.get(subkey)
  if (existing !== undefined) return existing
  const fresh: CardCandidate = { name: null, memoryMb: null }
  candidates.set(subkey, fresh)
  return fresh
}

/**
 * Szesnastkowe bajty na megabajty.
 *
 * `Number.parseInt` bez `BigInt`, choć wartość przekracza 32 bity (zmierzone
 * `0x2ffa00000` = 12 878 610 432 B = 12 282 MB): liczby całkowite są w
 * JavaScripcie dokładne do 2^53, czyli do 9 petabajtów pamięci karty. Zero
 * i wartość nieczytelna dają `null`, nie zero — karta z zerem pamięci nie
 * istnieje, a zero na pasku czytałoby się jako pomiar.
 */
function parseMemoryMb(data: string): number | null {
  if (!REGISTRY_HEX_VALUE.test(data)) return null
  const bytes = Number.parseInt(data, 16)
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  return Math.round(bytes / BYTES_IN_MEGABYTE)
}

/**
 * Wybiera jedną kartę z kilku wpisanych w klasę.
 *
 * Maszyna właściciela ma w tej klasie TRZY wpisy: NVIDIA GeForce RTX 4070,
 * zintegrowana AMD Radeon(TM) Graphics i wirtualny monitor Meta. Plan zakładał
 * jeden, więc ta reguła jest tu dopisana z pomiaru, nie z planu.
 *
 * Najpierw karta, której zużycie umiemy zmierzyć: inaczej u właściciela
 * o treści paska decydowałaby kolejność instalacji sterowników i człowiek
 * z działającym `nvidia-smi` mógłby zobaczyć „zużycie niedostępne". Przy
 * remisie większa pamięć, co odsuwa na koniec wirtualne monitory — one nie
 * mają wpisu o pamięci wcale, więc wypadają same, bez wyliczania nazw
 * sterowników, które trzeba by dopisywać przy każdym nowym producencie gogli.
 */
function bestCard(candidates: readonly CardCandidate[]): GpuCard | null {
  let best: GpuCard | null = null
  for (const candidate of candidates) {
    if (candidate.name === null) continue
    const card: GpuCard = {
      name: candidate.name,
      memoryMb: candidate.memoryMb,
      utilizationAvailable: isNvidia(candidate.name)
    }
    if (best === null || outranks(card, best)) best = card
  }
  return best
}

function outranks(card: GpuCard, best: GpuCard): boolean {
  if (card.utilizationAvailable !== best.utilizationAvailable) return card.utilizationAvailable
  return (card.memoryMb ?? -1) > (best.memoryMb ?? -1)
}

/**
 * Pamięć w gigabajtach z przecinkiem dziesiętnym, tak jak VRAM na pasku.
 *
 * Trzy linie powtórzone z prywatnego `formatGigabytes` w `diagnostics.ts`
 * świadomie: eksport tamtej funkcji byłby zmianą pliku, który ta część
 * specyfikacji zostawia w spokoju. Gdyby konwencja zapisu liczb kiedyś się
 * zmieniła, to są dwa miejsca — i dlatego ten komentarz tu stoi.
 */
function formatGigabytes(megabytes: number): string {
  return (megabytes / 1024).toFixed(1).replace('.', ',')
}

/**
 * Opis karty dla człowieka.
 *
 * Ten tekst istnieje po to, żeby rozróżnić dwie sytuacje, które dzisiaj
 * wyglądają identycznie — i to jest punkt 2 z Review Focus:
 *
 * - „nie mam karty NVIDIA" — zużycia nie zmierzymy NIGDY, bo licznik systemowy
 *   Windows kosztuje 3,9 s przeciw 46,5 ms dla `nvidia-smi`, czyli 84 razy
 *   gorzej (zmierzone). Nie da się go wołać w pętli próbkującej aplikacji,
 *   w której diagnozujemy zacinanie. Ta liczba jest tu zapisana dlatego, że
 *   bez niej następna osoba spróbuje „dorobić AMD" i odkryje to po zacięciu
 *   interfejsu;
 * - „sterownik się zawiesił" — odczyt BYŁ i zamarł. Tym zajmuje się
 *   `GPU_STALE_AFTER_MS` i `formatResourceBadge`, pisząc „GPU — (odczyt
 *   z 22:03)".
 *
 * Dlatego ten tekst nie może być kreską ani nie może podawać godziny: byłby
 * DRUGĄ nieodróżnialną kreską i niczego nie naprawiłby. Nazywa kartę i mówi
 * wprost, czego o niej nie wiemy.
 */
export function formatGpuCard(card: GpuCard | null): string {
  if (card === null) {
    // Nie „brak karty": karta w maszynie jest, bo obraz na ekranie jest. Nie
    // udało się ją rozpoznać, a to inna wiadomość i inna rada dla człowieka.
    return 'Karta graficzna: nie rozpoznano'
  }

  const parts = [card.name]
  parts.push(card.memoryMb === null ? 'pamięć nieznana' : `${formatGigabytes(card.memoryMb)} GB`)
  if (!card.utilizationAvailable) {
    parts.push('zużycie niedostępne (mierzymy je tylko dla kart NVIDIA)')
  }
  return `Karta graficzna: ${parts.join(' · ')}`
}
