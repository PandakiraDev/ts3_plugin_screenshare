import { expect, test } from 'vitest'
// Import WARTOŚCI z `@shared`, nie typu — alias rozwiązuje `vitest.config.ts`,
// a nie `tsconfig.json`; import samego typu przeszedłby nawet bez aliasu, bo
// znika przy kompilacji, więc niczego by nie pilnował.
import { formatGpuCard, isNvidia, parseGpuRegistry, type GpuCard } from '@shared/gpuInfo'

/*
 * Wszystkie wyjścia niżej są PRAWDZIWE: skopiowane z `reg query` uruchomionego
 * na maszynie właściciela 16.10.2026, razem z końcówkami CRLF, czterema
 * spacjami rozdzielającymi kolumny i stopką „End of search". Wymyślone wyjście
 * nie pokazałoby żadnej z trzech rzeczy, które ta maszyna pokazała od razu:
 * kart jest kilka, `qwMemorySize` jest szesnastkowe i dłuższe niż 32 bity,
 * a wirtualny monitor w ogóle nie ma wpisu o pamięci.
 */
const KEY =
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'

/** Składa wyjście z CRLF, bo `reg` pisze CRLF i parser musi to znieść. */
function regOutput(lines: readonly string[]): string {
  return `${lines.join('\r\n')}\r\n`
}

/*
 * Nazwa i pamięć przychodzą z DWÓCH wywołań `reg query` (po jednym na nazwę
 * wartości), bo odczyt całego podklucza karty NVIDIA mierzy 1 480 ms, a
 * rekurencyjne `/s` po całej klasie nie mieści się w trzysekundowym `timeout`.
 * Parser dostaje oba wyjścia zlepione w jeden napis, więc fixture też je zlepia.
 */
const REG_OUTPUT_NVIDIA = regOutput([
  '',
  `${KEY}\\0000`,
  '    DriverDesc    REG_SZ    NVIDIA GeForce RTX 4070',
  '',
  'End of search: 1 match(es) found.',
  '',
  `${KEY}\\0000`,
  '    HardwareInformation.qwMemorySize    REG_QWORD    0x2ffa00000',
  '',
  'End of search: 1 match(es) found.'
])

/*
 * Podklucz 0002 tej maszyny: „Meta Virtual Monitor" ma `DriverDesc`, ale nie
 * ma ŻADNEGO wpisu o pamięci. To nie przypadek brzegowy wymyślony do testu —
 * tak wygląda każdy wirtualny monitor (Meta, Parsec, sterowniki dla gogli).
 */
const REG_OUTPUT_NO_MEMORY = regOutput([
  '',
  `${KEY}\\0002`,
  '    DriverDesc    REG_SZ    Meta Virtual Monitor',
  '',
  'End of search: 1 match(es) found.',
  '',
  'End of search: 0 match(es) found.'
])

/*
 * Pełne wyjście z maszyny właściciela: TRZY karty w klasie (NVIDIA, grafika
 * zintegrowana AMD, wirtualny monitor Meta) i tylko dwie z wpisem o pamięci.
 * Plan zakładał jedną kartę; prawdziwa maszyna ma trzy, więc wybór którejś
 * z nich jest regułą, a nie szczegółem implementacji.
 */
const REG_OUTPUT_THREE_CARDS = regOutput([
  '',
  `${KEY}\\0000`,
  '    DriverDesc    REG_SZ    NVIDIA GeForce RTX 4070',
  '',
  `${KEY}\\0001`,
  '    DriverDesc    REG_SZ    AMD Radeon(TM) Graphics',
  '',
  `${KEY}\\0002`,
  '    DriverDesc    REG_SZ    Meta Virtual Monitor',
  '',
  'End of search: 3 match(es) found.',
  '',
  `${KEY}\\0000`,
  '    HardwareInformation.qwMemorySize    REG_QWORD    0x2ffa00000',
  '',
  `${KEY}\\0001`,
  '    HardwareInformation.qwMemorySize    REG_QWORD    0x80000000',
  '',
  'End of search: 2 match(es) found.'
])

test('rozpoznaje nazwę karty i pamięć z rejestru', () => {
  // 12282 MB — karta 12 GB. Win32_VideoController.AdapterRAM podaje tu 4095 MB
  // (przepełnienie uint32), dlatego czytamy rejestr.
  const card = parseGpuRegistry(REG_OUTPUT_NVIDIA)
  expect(card?.memoryMb).toBe(12282)
  expect(card?.name).toBe('NVIDIA GeForce RTX 4070')
})

test('karta bez wpisu o pamięci daje null, nie zero', () => {
  // Zero znaczyłoby „karta bez pamięci"; null znaczy „nie wiem".
  expect(parseGpuRegistry(REG_OUTPUT_NO_MEMORY)?.memoryMb).toBeNull()
})

test('puste wyjście rejestru daje null', () => {
  expect(parseGpuRegistry('')).toBeNull()
})

test('wyjście bez ani jednego trafienia daje null', () => {
  // `reg query ... /s /v <wartość>` kończy się kodem 1 i taką stopką, gdy nic
  // nie znalazł. Zmierzone, nie zgadnięte — i dlatego każde z dwóch wywołań
  // jest w `metrics.ts` zabezpieczone osobno.
  expect(parseGpuRegistry('\r\nEnd of search: 0 match(es) found.\r\n')).toBeNull()
})

test('przy kilku kartach wybrana jest ta, której zużycie umiemy zmierzyć', () => {
  // Na maszynie właściciela klasa ma trzy wpisy. Gdyby wybór szedł po numerze
  // podklucza, trafienie na NVIDIĘ byłoby przypadkiem kolejności instalacji
  // sterowników, a pasek pokazywałby „zużycie niedostępne" komuś, kto ma
  // kartę NVIDIA i działające `nvidia-smi`.
  const card = parseGpuRegistry(REG_OUTPUT_THREE_CARDS)
  expect(card?.name).toBe('NVIDIA GeForce RTX 4070')
  expect(card?.utilizationAvailable).toBe(true)
})

test('podklucz z pamięcią, ale bez nazwy, nie staje się kartą', () => {
  // Nazwa jest tym, co widzi człowiek. Wpis bez niej nie ma czego pokazać,
  // więc nie jest kandydatem — inaczej pasek pisałby pustą nazwę i pamięć.
  const orphan = regOutput(['', `${KEY}\\0001`, '    HardwareInformation.qwMemorySize    REG_QWORD    0x80000000'])
  expect(parseGpuRegistry(orphan)).toBeNull()
})

test('przepełniony wpis DWORD nie jest używany jako pamięć', () => {
  // `HardwareInformation.MemorySize` to ta sama liczba obcięta do 32 bitów:
  // 0xfff00000 = 4095 MB dla karty 12 GB. Użycie go „na wszelki wypadek"
  // dałoby licznik, który KŁAMIE — a tego zabrania specyfikacja wprost.
  const onlyDword = regOutput([
    '',
    `${KEY}\\0000`,
    '    DriverDesc    REG_SZ    NVIDIA GeForce RTX 4070',
    '    HardwareInformation.MemorySize    REG_DWORD    0xfff00000'
  ])
  expect(parseGpuRegistry(onlyDword)?.memoryMb).toBeNull()
})

test('isNvidia nie zgaduje po samym słowie w nazwie modelu', () => {
  expect(isNvidia('NVIDIA GeForce RTX 4070')).toBe(true)
  expect(isNvidia('AMD Radeon RX 7800 XT')).toBe(false)
  expect(isNvidia('Intel(R) Arc(TM) A770')).toBe(false)
})

test('opis karty bez dostępnego zużycia mówi, czego nie wie', () => {
  // Punkt 2 z Review Focus: sama kreska jest nieodróżnialna od zawieszonego
  // sterownika, więc tekst MUSI nazwać kartę i powiedzieć, że zużycia nie znamy.
  const text = formatGpuCard({
    name: 'AMD Radeon RX 7800 XT',
    memoryMb: 16384,
    utilizationAvailable: false
  })
  expect(text).toContain('AMD Radeon RX 7800 XT')
  expect(text).toMatch(/niedostępne/i)
})

test('opis karty bez zużycia nie wygląda jak zamarły odczyt', () => {
  // `formatResourceBadge` pokazuje dla zamarłego sterownika „GPU — (odczyt
  // z 22:03)". Gdyby mój tekst też był kreską, dołożyłbym DRUGĄ nieodróżnialną
  // kreskę i nie naprawił niczego. Dlatego: żadnej pauzy jako wartości i żadnej
  // godziny — zamiast tego nazwa karty i powód.
  const text = formatGpuCard({
    name: 'AMD Radeon RX 7800 XT',
    memoryMb: 16384,
    utilizationAvailable: false
  })
  expect(text).not.toContain('—')
  expect(text).not.toMatch(/odczyt z /)
})

test('karta ze znanym zużyciem nie zapowiada niedostępności', () => {
  // Odwrotna strona poprzedniego testu: użytkownik NVIDII nie może dostać
  // zdania o niedostępności obok działających liczb.
  const text = formatGpuCard({
    name: 'NVIDIA GeForce RTX 4070',
    memoryMb: 12282,
    utilizationAvailable: true
  })
  expect(text).toContain('NVIDIA GeForce RTX 4070')
  expect(text).not.toMatch(/niedostępne/i)
})

test('nieznana pamięć jest w opisie powiedziana, a nie pominięta', () => {
  // Brakująca pamięć bez słowa wyglądałaby na kartę bez pamięci.
  const card: GpuCard = {
    name: 'Meta Virtual Monitor',
    memoryMb: null,
    utilizationAvailable: false
  }
  expect(formatGpuCard(card)).toMatch(/pamięć nieznana/i)
})

test('brak rozpoznanej karty też jest powiedziany wprost', () => {
  expect(formatGpuCard(null)).toMatch(/nie rozpozna/i)
})
