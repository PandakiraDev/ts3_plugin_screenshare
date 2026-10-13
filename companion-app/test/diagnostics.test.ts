import { expect, test } from 'vitest'
import {
  appendSample,
  formatResourceBadge,
  parseNvidiaSmi,
  readGpu,
  ratesBetween,
  shortRoomFingerprint,
  shouldAppendLine,
  type DiagnosticsSample,
  type StreamStats
} from '../src/shared/diagnostics'

test('poprawny odczyt jednej karty', () => {
  const reading = parseNvidiaSmi('99, 10034, 12282', 1000)
  expect(reading).toEqual({
    utilizationPercent: 99,
    memoryUsedMb: 10034,
    memoryTotalMb: 12282,
    at: 1000
  })
})

test('nadmiarowe spacje i koniec linii nie przeszkadzają', () => {
  expect(parseNvidiaSmi('  23 ,  512 , 8192  \n', 5)?.utilizationPercent).toBe(23)
})

test('dwie karty: bierzemy pierwszą linię', () => {
  // nvidia-smi wypisuje jedną linię na kartę i tylko karty NVIDIA.
  const reading = parseNvidiaSmi('99, 10034, 12282\n5, 100, 8192', 1)
  expect(reading?.utilizationPercent).toBe(99)
  expect(reading?.memoryTotalMb).toBe(12282)
})

test('wartość [N/A] daje brak odczytu, a nie zero', () => {
  // Zero znaczyłoby „karta nic nie robi" — to kłamstwo. Część kart zwraca
  // [N/A] dla zużycia i wtedy po prostu NIE WIEMY.
  expect(parseNvidiaSmi('[N/A], 10034, 12282', 1)).toBeNull()
  expect(parseNvidiaSmi('99, [N/A], 12282', 1)).toBeNull()
})

test('puste wyjście daje brak odczytu', () => {
  expect(parseNvidiaSmi('', 1)).toBeNull()
  expect(parseNvidiaSmi('   \n  ', 1)).toBeNull()
})

test('śmieci dają brak odczytu', () => {
  expect(parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate', 1)).toBeNull()
  expect(parseNvidiaSmi('99, 10034', 1)).toBeNull()
})

test('brak odczytu nigdy nie udaje bezczynnej karty', () => {
  // Test pilnuje reguły jako takiej, osobno od pojedynczych przypadków:
  // ŻADNE złe wejście nie może dać liczby zero zamiast null.
  for (const bad of ['', '   ', '[N/A], [N/A], [N/A]', 'blad', '1, 2']) {
    const reading = parseNvidiaSmi(bad, 1)
    expect(reading, `wejście ${JSON.stringify(bad)}`).toBeNull()
  }
})

test('puste pole między przecinkami daje brak odczytu, nie zero', () => {
  // Bez tego przypadku regex osłabiony z `\d+` na `\d*` przechodzi wszystkie
  // testy, a puste pole daje `Number('')` === 0 — czyli dokładnie to fałszywe
  // zero, którego ta funkcja ma nie produkować.
  expect(parseNvidiaSmi('1, , 3', 1)).toBeNull()
  expect(parseNvidiaSmi('1, 2,', 1)).toBeNull()
  expect(parseNvidiaSmi(',,', 1)).toBeNull()
})

test('za dużo pól daje brak odczytu', () => {
  // Pilnuje `parts.length !== 3`: przy osłabieniu do `< 3` cztery pola
  // dawałyby odczyt złożony z pierwszych trzech, bez śladu, że coś nie gra.
  expect(parseNvidiaSmi('1, 2, 3, 4', 1)).toBeNull()
})

test('[N/A] w ostatnim polu też daje brak odczytu', () => {
  // Osobny przypadek, bo sprawdzanie tylko dwóch pierwszych pól przechodziło
  // dotąd na zielono — trzecie było pokryte wyłącznie wejściem z trzema [N/A].
  expect(parseNvidiaSmi('99, 10034, [N/A]', 1)).toBeNull()
})

test('zakończenie CRLF z Windowsa nie przeszkadza', () => {
  // Zmierzone na prawdziwym nvidia-smi: zwraca "70, 10268, 12282\r\n", więc
  // po split('\n') pierwsza linia kończy się znakiem CR. Oba trim() zdejmują go
  // niezależnie, więc osłabienie jednego z nich nie psuje odczytu. Test łapie
  // dopiero osłabienie obu naraz: wtedy każdy odczyt z Windowsa dawałby brak
  // odczytu, czyli ciche „GPU —".
  const reading = parseNvidiaSmi('70, 10268, 12282\r\n', 9)
  expect(reading).toEqual({
    utilizationPercent: 70,
    memoryUsedMb: 10268,
    memoryTotalMb: 12282,
    at: 9
  })
})

test('liczba zbyt duża, by być skończoną, daje brak odczytu', () => {
  // 400 cyfr przechodzi regex `^\d+$`, ale Number() daje Infinity.
  // Nieskończoność nie jest ani poprawnym odczytem, ani brakiem odczytu, więc
  // bez tego sprawdzenia wyciekałaby do reszty aplikacji jako „prawdziwa" wartość.
  // Z nvidia-smi to się nie zdarzy — to zabezpieczenie na wypadek, gdyby
  // ktoś kiedyś podstawił tu inne źródło danych.
  const absurd = '9'.repeat(400)
  expect(parseNvidiaSmi(`${absurd}, 100, 200`, 1)).toBeNull()
})

test('odczyt GPU zwraca wartości, gdy uruchamiacz je poda', async () => {
  const reading = await readGpu(async () => '99, 10034, 12282', 7)
  expect(reading?.utilizationPercent).toBe(99)
  expect(reading?.at).toBe(7)
})

test('wyjątek uruchamiacza daje brak odczytu, a nie wyjątek w górę', async () => {
  // Tak wygląda brak nvidia-smi w PATH (ENOENT), karta AMD albo sterownik
  // w trakcie aktualizacji. Jeden wyjątek nie może zatrzymać całego zapisu.
  const reading = await readGpu(async () => {
    throw new Error('spawn nvidia-smi ENOENT')
  }, 7)
  expect(reading).toBeNull()
})

test('odrzucona obietnica bez obiektu błędu też daje brak odczytu', async () => {
  const reading = await readGpu(() => Promise.reject('cokolwiek'), 7)
  expect(reading).toBeNull()
})

test('nieczytelne wyjście uruchamiacza daje brak odczytu', async () => {
  expect(await readGpu(async () => 'NVIDIA-SMI has failed', 7)).toBeNull()
})

test('synchroniczny wyjątek uruchamiacza też daje brak odczytu', async () => {
  // execSync rzuca wyjątek od razu, zamiast odrzucić obietnicę. Typ wymaga
  // Promise, ale wstrzyknięty uruchamiacz może go nie dotrzymać.
  const reading = await readGpu(() => {
    throw new Error('spawnSync nvidia-smi ENOENT')
  }, 7)
  expect(reading).toBeNull()
})

function inbound(overrides: Partial<StreamStats> = {}): StreamStats {
  return {
    peerId: 'p1',
    kind: 'screen',
    direction: 'inbound',
    framesReceived: 0,
    framesDecoded: 0,
    framesPresented: 0,
    framesDropped: 0,
    framesEncoded: null,
    framesSent: null,
    bytes: 0,
    qualityLimitationReason: null,
    ...overrides
  }
}

test('zwykły przyrost daje tempo na sekundę', () => {
  const rates = ratesBetween(
    inbound({ framesReceived: 100, bytes: 1_000 }),
    inbound({ framesReceived: 160, bytes: 126_000 }),
    1_000
  )
  expect(rates?.receivedPerS).toBe(60)
  // 125 000 bajtów = 1 000 000 bitów = 1 000 kilobitów na sekundę
  expect(rates?.kilobitsPerS).toBe(1_000)
})

test('tempo to przyrost podzielony przez czas, a nie przez liczbę próbek', () => {
  // Przy odstępie równym sekundzie dzielenie przez czas i mnożenie przez czas
  // dają ten sam wynik, więc błąd w przeliczniku byłby niewidoczny. Dwie
  // sekundy to rozstrzygają.
  const rates = ratesBetween(
    inbound({ framesReceived: 100, bytes: 0 }),
    inbound({ framesReceived: 160, bytes: 250_000 }),
    2_000
  )
  expect(rates?.receivedPerS).toBe(30)
  // 250 000 bajtów w 2 s to 125 000 bajtów na sekundę = 1 000 kilobitów
  expect(rates?.kilobitsPerS).toBe(1_000)
})

test('zerowy i ujemny odstęp czasu unieważnia cały odczyt', () => {
  expect(ratesBetween(inbound(), inbound({ framesReceived: 10 }), 0)).toBeNull()
  expect(ratesBetween(inbound(), inbound({ framesReceived: 10 }), -5)).toBeNull()
})

test('NaN i nieskończoność nie trafiają do wyniku', () => {
  // NaN nie jest ani większy, ani mniejszy od czegokolwiek, więc zwykłe
  // porównania przepuściłyby go dalej. Nieskończoność z kolei daje NaN przy
  // odjęciu od samej siebie, a skończony licznik minus nieskończoność daje
  // nieskończone tempo. Reguła mówi: nigdy NaN ani nieskończoność.
  expect(ratesBetween(inbound(), inbound({ framesReceived: 10 }), Number.NaN)).toBeNull()
  expect(
    ratesBetween(inbound(), inbound({ framesReceived: 10 }), Number.POSITIVE_INFINITY)
  ).toBeNull()

  const nanCounter = ratesBetween(
    inbound({ framesReceived: Number.NaN }),
    inbound({ framesReceived: 10 }),
    1_000
  )
  expect(nanCounter?.receivedPerS).toBeNull()

  const infiniteCounter = ratesBetween(
    inbound({ framesReceived: 10 }),
    inbound({ framesReceived: Number.POSITIVE_INFINITY }),
    1_000
  )
  expect(infiniteCounter?.receivedPerS).toBeNull()

  const bothInfinite = ratesBetween(
    inbound({ framesReceived: Number.POSITIVE_INFINITY }),
    inbound({ framesReceived: Number.POSITIVE_INFINITY }),
    1_000
  )
  expect(bothInfinite?.receivedPerS).toBeNull()
})

test('brak poprzedniej próbki unieważnia cały odczyt', () => {
  // Tak wygląda strumień, który właśnie się pojawił: nie ma od czego liczyć
  // przyrostu, a liczenie od zera pokazałoby fałszywy skok.
  expect(ratesBetween(undefined, inbound({ framesReceived: 500 }), 1_000)).toBeNull()
})

test('cofnięty licznik zeruje SWOJE pole, nie cały odczyt', () => {
  // WebRTC zeruje liczniki przy przełączeniu kodeka. Bez tej reguły panel
  // pokazałby minus czterdzieści klatek na sekundę.
  const rates = ratesBetween(
    inbound({ framesReceived: 100, framesDecoded: 100 }),
    inbound({ framesReceived: 5, framesDecoded: 160 }),
    1_000
  )
  expect(rates?.receivedPerS).toBeNull()
  expect(rates?.decodedPerS).toBe(60)
})

test('cofnięty licznik bajtów zeruje tylko kilobity', () => {
  // Kilobity liczone są z bajtów, więc cofnięty licznik bajtów musi zerować
  // właśnie je, a nie cały odczyt.
  const rates = ratesBetween(
    inbound({ framesReceived: 100, bytes: 500_000 }),
    inbound({ framesReceived: 160, bytes: 1_000 }),
    1_000
  )
  expect(rates?.kilobitsPerS).toBeNull()
  expect(rates?.receivedPerS).toBe(60)
})

test('pole brakujące po którejkolwiek stronie daje null, nie NaN', () => {
  const rates = ratesBetween(
    inbound({ framesPresented: null }),
    inbound({ framesPresented: 60 }),
    1_000
  )
  expect(rates?.presentedPerS).toBeNull()
})

test('pola drugiego kierunku zostają null, gdy strumień ich nie ma', () => {
  const rates = ratesBetween(inbound(), inbound({ framesReceived: 30 }), 1_000)
  expect(rates?.encodedPerS).toBeNull()
  expect(rates?.sentPerS).toBeNull()
})

test('niezmieniony licznik daje zero, nie „nie wiem"', () => {
  // Zatrzymany strumień to 0 klatek na sekundę i panel ma to pokazać. Gdyby
  // guard odrzucał równe liczniki, zwykła cisza dawałaby `null`, czyli „nie
  // wiem", i zniknęłaby najważniejsza informacja: że obraz stoi.
  const rates = ratesBetween(
    inbound({ framesDecoded: 500, bytes: 1_000 }),
    inbound({ framesDecoded: 500, bytes: 1_000 }),
    1_000
  )
  expect(rates?.decodedPerS).toBe(0)
  expect(rates?.kilobitsPerS).toBe(0)
})

test('każde pole bierze dane ze swojego licznika, nie z sąsiedniego', () => {
  // Wartości są rozłączne celowo: gdyby którekolwiek pole było podpięte pod
  // sąsiedni licznik, asercja pokazałaby liczbę z innego pola zamiast błędu
  // typu. Cztery mutacje podpięcia przeżyły dotąd wszystkie testy.
  const previous: StreamStats = {
    peerId: 'p1',
    kind: 'screen',
    direction: 'outbound',
    framesReceived: 0,
    framesDecoded: 0,
    framesPresented: 0,
    framesDropped: 0,
    framesEncoded: 0,
    framesSent: 0,
    bytes: 0,
    qualityLimitationReason: null
  }
  const next: StreamStats = {
    ...previous,
    framesReceived: 1,
    framesDecoded: 2,
    framesPresented: 3,
    framesDropped: 4,
    framesEncoded: 5,
    framesSent: 6,
    bytes: 125_000
  }
  const rates = ratesBetween(previous, next, 1_000)
  expect(rates?.receivedPerS).toBe(1)
  expect(rates?.decodedPerS).toBe(2)
  expect(rates?.presentedPerS).toBe(3)
  expect(rates?.droppedPerS).toBe(4)
  expect(rates?.encodedPerS).toBe(5)
  expect(rates?.sentPerS).toBe(6)
  expect(rates?.kilobitsPerS).toBe(1_000)
})

function sample(at: number): DiagnosticsSample {
  return {
    at,
    system: { cpuPercent: 1, memoryMb: 2, gpu: null },
    streams: [],
    streamsAgeMs: null
  }
}

test('bufor zachowuje kolejność i to, co się mieści', () => {
  let buffer = appendSample([], sample(1_000), 10_000, 600)
  buffer = appendSample(buffer, sample(2_000), 10_000, 600)
  buffer = appendSample(buffer, sample(3_000), 10_000, 600)
  expect(buffer.map((entry) => entry.at)).toEqual([1_000, 2_000, 3_000])
})

test('bufor przycina próbki starsze niż podany wiek', () => {
  let buffer = appendSample([], sample(1_000), 5_000, 600)
  buffer = appendSample(buffer, sample(3_000), 5_000, 600)
  buffer = appendSample(buffer, sample(7_000), 5_000, 600)
  // Granica liczona względem najnowszej próbki: 7000 - 5000 = 2000,
  // więc próbka z 1000 wypada, a ta z 3000 zostaje.
  expect(buffer.map((entry) => entry.at)).toEqual([3_000, 7_000])
})

test('próbka dokładnie na granicy wieku zostaje', () => {
  let buffer = appendSample([], sample(2_000), 5_000, 600)
  buffer = appendSample(buffer, sample(7_000), 5_000, 600)
  expect(buffer.map((entry) => entry.at)).toEqual([2_000, 7_000])
})

test('cofnięty zegar systemowy nie wyrzuca ani historii, ani nowej próbki', () => {
  // Synchronizacja czasu w trakcie sesji potrafi cofnąć zegar. Granica wieku
  // liczy się od próbki właśnie dokładanej, więc cofnięta próbka nie wyrzuca
  // starszych wpisów: wypycha je dopiero sufit liczby wpisów (test poniżej).
  // Nowa próbka zostaje zawsze, bo jej wiek względem granicy wynosi zero.
  let buffer = appendSample([], sample(100_000), 5_000, 600)
  buffer = appendSample(buffer, sample(101_000), 5_000, 600)
  buffer = appendSample(buffer, sample(1_000), 5_000, 600)
  expect(buffer.length).toBe(3)
  expect(buffer.map((entry) => entry.at)).toContain(100_000)
})

test('granicę wieku wyznacza próbka właśnie dokładana, nie najnowszy znacznik w buforze', () => {
  // Względem najnowszego znacznika 7000 wpis z 1000 wypadłby (6000 > 5000).
  // Granica liczy się jednak od cofniętej próbki 1500: 1500 - 1000 = 500 mieści
  // się w oknie, więc wpis zostaje. Wpis z 7000 ma różnicę ujemną i też zostaje.
  const buffer = [sample(1_000), sample(7_000)]
  const next = appendSample(buffer, sample(1_500), 5_000, 600)
  expect(next.map((entry) => entry.at)).toEqual([1_000, 7_000, 1_500])
})

test('cofnięcie zegara większe niż okno odzyskuje świeżość w granicach sufitu', () => {
  // Gdyby granica liczyła się od największego znacznika, każda nowa próbka
  // wypadałaby przy następnym dopisaniu jako starsza od okna liczonego względem
  // starej epoki i bufor zostałby w większości ze starą epoką. Przy granicy od
  // próbki przychodzącej nowe narastają, a stare wypycha sufit liczby wpisów.
  let buffer: DiagnosticsSample[] = []
  for (let at = 1_000_000; at < 1_000_000 + 5 * 1_000; at += 1_000) {
    buffer = appendSample(buffer, sample(at), 5_000, 4)
  }
  // Zegar cofa się o niemal tysiąc sekund, czyli daleko poza okno pięciu sekund.
  for (let at = 1_000; at <= 4 * 1_000; at += 1_000) {
    buffer = appendSample(buffer, sample(at), 5_000, 4)
  }
  // Po czterech taktach nowej epoki bufor ma wyłącznie nowe próbki.
  expect(buffer.map((entry) => entry.at)).toEqual([1_000, 2_000, 3_000, 4_000])
})

test('dopisanie nie zmienia przekazanego bufora', () => {
  const buffer = [sample(1_000)]
  const next = appendSample(buffer, sample(2_000), 10_000, 600)
  expect(buffer.map((entry) => entry.at)).toEqual([1_000])
  expect(next.map((entry) => entry.at)).toEqual([1_000, 2_000])
})

test('sufit liczby wpisów ogranicza bufor niezależnie od zegara', () => {
  // To jest zabezpieczenie na wypadek, gdy filtr wieku nie wystarczy — na
  // przykład po cofnięciu zegara, gdy w buforze siedzą dwie epoki naraz.
  // Wiek jest tu ogromny, więc o wycięciu decyduje wyłącznie sufit liczby.
  let buffer: DiagnosticsSample[] = []
  for (let at = 1; at <= 10; at++) {
    buffer = appendSample(buffer, sample(at), 10_000_000, 4)
    // Długość sprawdzana po każdym dopisaniu. Sam stan końcowy przepuszcza
    // bufor oscylujący między trzema a czterema wpisami, bo przy dziesięciu
    // dopisaniach akurat wypada cztery.
    expect(buffer.length).toBe(Math.min(at, 4))
  }
  expect(buffer.map((entry) => entry.at)).toEqual([7, 8, 9, 10])
})

test('sufit pliku wstrzymuje dopisywanie, gdy linia by go przekroczyła', () => {
  expect(shouldAppendLine(0, 100, 1_000)).toBe(true)
  expect(shouldAppendLine(900, 100, 1_000)).toBe(true)
  expect(shouldAppendLine(901, 100, 1_000)).toBe(false)
  expect(shouldAppendLine(5_000, 1, 1_000)).toBe(false)
})

test('pasek zużycia pokazuje brak odczytu GPU kreską, nie zerem', () => {
  const text = formatResourceBadge({ cpuPercent: 23, memoryMb: 412, gpu: null })
  expect(text).toBe('CPU 23% · RAM 412 MB · GPU —')
})

test('pasek zużycia podaje pamięć karty w gigabajtach z przecinkiem', () => {
  const text = formatResourceBadge({
    cpuPercent: 23,
    memoryMb: 412,
    gpu: { utilizationPercent: 99, memoryUsedMb: 10_034, memoryTotalMb: 12_282, at: 1 }
  })
  expect(text).toBe('CPU 23% · RAM 412 MB · GPU 99% · VRAM 9,8/12,0 GB')
})

test('pasek zużycia zaokrągla procent CPU do najbliższej całości', () => {
  // 23,4 odróżnia zaokrąglanie od sufitu, a 23,6 od podłogi.
  const below = formatResourceBadge({ cpuPercent: 23.4, memoryMb: 411, gpu: null })
  const above = formatResourceBadge({ cpuPercent: 23.6, memoryMb: 411, gpu: null })
  expect(below).toBe('CPU 23% · RAM 411 MB · GPU —')
  expect(above).toBe('CPU 24% · RAM 411 MB · GPU —')
})

test('pasek zużycia zaokrągla megabajty RAM do najbliższej całości', () => {
  // 411,4 odróżnia zaokrąglanie od sufitu, a 411,6 od podłogi.
  const below = formatResourceBadge({ cpuPercent: 23, memoryMb: 411.4, gpu: null })
  const above = formatResourceBadge({ cpuPercent: 23, memoryMb: 411.6, gpu: null })
  expect(below).toBe('CPU 23% · RAM 411 MB · GPU —')
  expect(above).toBe('CPU 23% · RAM 412 MB · GPU —')
})

test('zero z odczytu GPU pokazuje się jako zero, nie jako kreska', () => {
  // Odwrotna strona reguły o kresce: gdy odczyt istnieje, zero jest pomiarem
  // i ma zostać zerem. Inaczej bezczynna karta wyglądałaby jak brak danych.
  const text = formatResourceBadge({
    cpuPercent: 0,
    memoryMb: 0,
    gpu: { utilizationPercent: 0, memoryUsedMb: 0, memoryTotalMb: 12_288, at: 1 }
  })
  expect(text).toBe('CPU 0% · RAM 0 MB · GPU 0% · VRAM 0,0/12,0 GB')
})

test('odcisk palca lobby to osiem pierwszych znaków skrótu', () => {
  expect(shortRoomFingerprint('3f9a2c1b4d5e6f70' + 'a'.repeat(48))).toBe('3f9a2c1b')
})

test('odcisk palca krótszego wejścia nie wywraca funkcji', () => {
  expect(shortRoomFingerprint('abc')).toBe('abc')
  expect(shortRoomFingerprint('')).toBe('')
})
