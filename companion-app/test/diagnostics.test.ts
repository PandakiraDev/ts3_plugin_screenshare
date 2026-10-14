import { expect, test } from 'vitest'
import {
  BUFFER_MAX_AGE_MS,
  BUFFER_MAX_SAMPLES,
  GPU_POLL_INTERVAL_MS,
  GPU_STALE_AFTER_MS,
  LOG_FILES_KEPT,
  LOG_SIZE_CEILING_BYTES,
  SAMPLE_INTERVAL_MS,
  STREAMS_MIN_INTERVAL_MS,
  STREAMS_STALE_AFTER_MS,
  advancePanelTimeline,
  appendSample,
  columnAppliesTo,
  emptyStreamStats,
  formatLimitation,
  formatResourceBadge,
  formatSilence,
  formatSystemLine,
  logFilesToDelete,
  parseNvidiaSmi,
  readGpu,
  ratesBetween,
  shortRoomFingerprint,
  shouldAppendLine,
  streamsFreshness,
  streamsIntervalMs,
  type DiagnosticsSample,
  type PanelTimeline,
  type StreamColumn,
  type StreamRates,
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
  const reading = await readGpu(async () => '99, 10034, 12282', () => 7)
  expect(reading?.utilizationPercent).toBe(99)
  expect(reading?.at).toBe(7)
})

test('wyjątek uruchamiacza daje brak odczytu, a nie wyjątek w górę', async () => {
  // Tak wygląda brak nvidia-smi w PATH (ENOENT), karta AMD albo sterownik
  // w trakcie aktualizacji. Jeden wyjątek nie może zatrzymać całego zapisu.
  const reading = await readGpu(async () => {
    throw new Error('spawn nvidia-smi ENOENT')
  }, () => 7)
  expect(reading).toBeNull()
})

test('odrzucona obietnica bez obiektu błędu też daje brak odczytu', async () => {
  const reading = await readGpu(() => Promise.reject('cokolwiek'), () => 7)
  expect(reading).toBeNull()
})

test('nieczytelne wyjście uruchamiacza daje brak odczytu', async () => {
  expect(await readGpu(async () => 'NVIDIA-SMI has failed', () => 7)).toBeNull()
})

test('synchroniczny wyjątek uruchamiacza też daje brak odczytu', async () => {
  // Typ `() => Promise<string>` obiecuje obietnicę, ale funkcja nieoznaczona
  // jako `async` może rzucić, zanim ją zwróci, na przykład gdy przed
  // `new Promise(...)` coś przygotowuje synchronicznie i to się nie powiedzie.
  // To się kompiluje (ciało, które tylko rzuca, pasuje do każdego typu
  // zwracanego) i nie jest odrzuceniem obietnicy, więc `.catch` na wyniku tego
  // nie złapie — łapie dopiero `try` obejmujący samo wywołanie.
  const reading = await readGpu(() => {
    throw new Error('spawnSync nvidia-smi ENOENT')
  }, () => 7)
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
  // nieskończone tempo. Reguła dotyczy WEJŚCIA: licznik lub odstęp, który nie
  // jest skończoną liczbą, nie trafia do wyniku jako pomiar. Skończony wynik
  // nie jest przez to gwarantowany — licznik rzędu 1e308 przy odstępie
  // 1000 ms przepełnia mnożenie i daje nieskończone tempo. Realne liczniki
  // WebRTC (do 2^53) tego nie osiągają, więc kod zostaje taki, jaki jest.
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
    instanceId: 'a1b2c3d4',
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
  // Nowa próbka zostaje zawsze, ale nie dlatego, że przeszła filtr wieku:
  // filtr działa tylko na wpisach już będących w buforze, a `slice` przy
  // `maxCount >= 1` zostawia ostatni.
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
  const text = formatResourceBadge({ cpuPercent: 23, memoryMb: 412, gpu: null }, 10_000)
  expect(text).toBe('CPU 23% · RAM 412 MB · GPU —')
})

test('pasek zużycia podaje pamięć karty w gigabajtach z przecinkiem', () => {
  const text = formatResourceBadge({
    cpuPercent: 23,
    memoryMb: 412,
    gpu: { utilizationPercent: 99, memoryUsedMb: 10_034, memoryTotalMb: 12_282, at: 1 }
  }, 1)
  expect(text).toBe('CPU 23% · RAM 412 MB · GPU 99% · VRAM 9,8/12,0 GB')
})

test('pasek zużycia zaokrągla procent CPU do najbliższej całości', () => {
  // 23,4 odróżnia zaokrąglanie od sufitu, a 23,6 od podłogi.
  const below = formatResourceBadge({ cpuPercent: 23.4, memoryMb: 411, gpu: null }, 10_000)
  const above = formatResourceBadge({ cpuPercent: 23.6, memoryMb: 411, gpu: null }, 10_000)
  expect(below).toBe('CPU 23% · RAM 411 MB · GPU —')
  expect(above).toBe('CPU 24% · RAM 411 MB · GPU —')
})

test('pasek zużycia zaokrągla megabajty RAM do najbliższej całości', () => {
  // 411,4 odróżnia zaokrąglanie od sufitu, a 411,6 od podłogi.
  const below = formatResourceBadge({ cpuPercent: 23, memoryMb: 411.4, gpu: null }, 10_000)
  const above = formatResourceBadge({ cpuPercent: 23, memoryMb: 411.6, gpu: null }, 10_000)
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
  }, 1)
  expect(text).toBe('CPU 0% · RAM 0 MB · GPU 0% · VRAM 0,0/12,0 GB')
})

test('odcisk palca lobby to osiem pierwszych znaków skrótu', () => {
  expect(shortRoomFingerprint('3f9a2c1b4d5e6f70' + 'a'.repeat(48))).toBe('3f9a2c1b')
})

test('odcisk palca krótszego wejścia nie wywraca funkcji', () => {
  expect(shortRoomFingerprint('abc')).toBe('abc')
  expect(shortRoomFingerprint('')).toBe('')
})

test('brak jakiegokolwiek odezwania renderera daje never', () => {
  // `never` to nie to samo co `stale`: pierwsze to tryb bez pokoju albo start
  // aplikacji, drugie to objaw, którego szukamy.
  expect(streamsFreshness(null)).toBe('never')
})

test('dane zebrane przed chwilą są świeże', () => {
  expect(streamsFreshness(0)).toBe('fresh')
})

test('wiek równy progowi jest już przestarzały', () => {
  expect(streamsFreshness(STREAMS_STALE_AFTER_MS)).toBe('stale')
})

test('wiek o milisekundę mniejszy od progu jest jeszcze świeży', () => {
  // Razem z poprzednim testem przybija granicę z obu stron.
  expect(streamsFreshness(STREAMS_STALE_AFTER_MS - 1)).toBe('fresh')
})

test('wiek dużo ponad progiem jest przestarzały', () => {
  expect(streamsFreshness(STREAMS_STALE_AFTER_MS + 1)).toBe('stale')
  expect(streamsFreshness(10 * 60 * 1_000)).toBe('stale')
})

test('ujemny wiek to drżenie zegara, nie milczenie renderera', () => {
  expect(streamsFreshness(-1)).toBe('fresh')
  expect(streamsFreshness(-5_000)).toBe('fresh')
})

test('zdrowy renderer nigdy nie zapala przestarzałości', () => {
  // Renderer przysyła raz na okres próbkowania, więc w chwili tyknięcia jego
  // dane mają od zera do około okresu, plus drżenie zegara. Gdyby próg wynosił
  // jeden okres, ta normalna praca zapalałaby ostrzeżenie.
  expect(STREAMS_STALE_AFTER_MS).toBeGreaterThan(SAMPLE_INTERVAL_MS)
  expect(streamsFreshness(SAMPLE_INTERVAL_MS)).toBe('fresh')
  expect(streamsFreshness(SAMPLE_INTERVAL_MS + 500)).toBe('fresh')
})

test('wiek, który nie jest liczbą, nie bywa świeży', () => {
  // NaN nie jest pomiarem, więc nie wolno ręczyć za liczby, które do niego
  // należą. Nieskończoność wypada poza próg sama.
  expect(streamsFreshness(Number.NaN)).toBe('stale')
  expect(streamsFreshness(Number.POSITIVE_INFINITY)).toBe('stale')
})

function sampleWithStreams(
  at: number,
  streamsAgeMs: number | null,
  streams: StreamStats[]
): DiagnosticsSample {
  return {
    at,
    instanceId: 'a1b2c3d4',
    system: { cpuPercent: 1, memoryMb: 2, gpu: null },
    streams,
    streamsAgeMs
  }
}

test('odstęp między statystykami liczy się od chwili ich odebrania, nie od tyknięcia', () => {
  // Dane odebrane o 9 700 i o 10 900, choć próbki dzieli równa sekunda.
  const previous = sampleWithStreams(10_000, 300, [])
  const next = sampleWithStreams(11_000, 100, [])
  expect(streamsIntervalMs(previous, next)).toBe(1_200)
})

test('ten sam push widziany w dwóch tyknięciach nie daje tempa, a nie zero klatek', () => {
  // Zagłodzony renderer: rejestrator tyka dalej i powtarza ostatnie liczby.
  // Odstęp liczony od tyknięć dałby sekundę i tempo 0 klatek na sekundę,
  // czyli wniosek „strumień stoi", którego pole wieku miało zabronić.
  // Liczby są realistyczne, nie wyidealizowane: dwa zegary nigdy nie zgadzają
  // się co do milisekundy, więc odstęp wychodzi tu 3 ms, nie zero.
  const frozen = inbound({ framesReceived: 500, framesDecoded: 500, bytes: 90_000 })
  const previous = sampleWithStreams(40_000, 20_000, [frozen])
  const next = sampleWithStreams(41_000, 20_997, [frozen])
  expect(streamsIntervalMs(previous, next)).toBeNull()
})

test('drżenie dwóch zegarów wokół zera nie robi z tego samego pusha pomiaru', () => {
  // `at` idzie zegarem ściennym, a `streamsAgeMs` monotonicznym, i oba są
  // czytane w różnych chwilach tyknięcia, więc dla TEGO SAMEGO pusha odstęp
  // wychodzi od kilku ms na minus do kilku na plus. Przy dodatnim znaku
  // `ratesBetween` policzyłby tempo z niezmienionych liczników i pokazał
  // 0 klatek na sekundę jako dane świeże.
  const frozen = inbound({ framesReceived: 500 })
  for (const jitter of [-3, -2, -1, 0, 1, 2, 3]) {
    const previous = sampleWithStreams(10_000, 300, [frozen])
    const next = sampleWithStreams(11_000, 1_300 - jitter, [frozen])
    expect(streamsIntervalMs(previous, next), `drżenie ${jitter} ms`).toBeNull()
  }
})

test('drżenie zegarów nie psuje pomiaru między dwoma różnymi pushami', () => {
  // Dwa kolejne pushe dzieli około sekundy; kilka ms drżenia w którąkolwiek
  // stronę ma zostać pomiarem, a nie zamienić się w brak odstępu.
  const previous = sampleWithStreams(10_000, 300, [])
  for (const jitter of [-3, -2, -1, 0, 1, 2, 3]) {
    const next = sampleWithStreams(11_000, 300 - jitter, [])
    expect(streamsIntervalMs(previous, next)).toBe(1_000 + jitter)
  }
})

test('próg odstępu: o milisekundę poniżej połowy okresu to brak pomiaru, równy już pomiar', () => {
  const previous = sampleWithStreams(10_000, 0, [])
  const below = sampleWithStreams(10_000 + STREAMS_MIN_INTERVAL_MS - 1, 0, [])
  const at = sampleWithStreams(10_000 + STREAMS_MIN_INTERVAL_MS, 0, [])
  expect(streamsIntervalMs(previous, below)).toBeNull()
  expect(streamsIntervalMs(previous, at)).toBe(STREAMS_MIN_INTERVAL_MS)
  // Próg leży między drżeniem (kilka ms) a okresem próbkowania (sekunda).
  expect(STREAMS_MIN_INTERVAL_MS).toBeGreaterThan(10)
  expect(STREAMS_MIN_INTERVAL_MS).toBeLessThan(SAMPLE_INTERVAL_MS)
})

test('odstęp ujemny, na przykład po cofnięciu zegara, nie jest pomiarem', () => {
  const previous = sampleWithStreams(10_000, 100, [])
  const next = sampleWithStreams(9_000, 100, [])
  expect(streamsIntervalMs(previous, next)).toBeNull()
})

test('wiek NaN po którejkolwiek stronie nie daje odstępu', () => {
  // Gałąź skończoności jest osobna od progu: NaN nie jest mniejszy od niczego,
  // więc samo porównanie z progiem przepuściłoby go dalej jako „odstęp".
  // Odrzuca go dopiero `Number.isFinite`.
  const healthy = sampleWithStreams(10_000, 300, [])
  const notANumber = sampleWithStreams(11_000, Number.NaN, [])
  expect(streamsIntervalMs(healthy, notANumber)).toBeNull()
  expect(streamsIntervalMs(notANumber, healthy)).toBeNull()
  expect(streamsIntervalMs(notANumber, notANumber)).toBeNull()
})

test('nieskończony wiek po którejkolwiek stronie nie daje odstępu', () => {
  // Wiek +Infinity w poprzedniej próbce daje początek w -Infinity, a więc
  // odstęp +Infinity, który próg przepuszcza, bo jest większy od każdego progu.
  // To samo daje wiek -Infinity w następnej próbce. Dwie nieskończoności naraz
  // odejmują się do NaN. Pozostałe ustawienia (+Infinity w następnej, -Infinity
  // w poprzedniej) dają odstęp -Infinity, który odrzuca już sam próg.
  const healthy = sampleWithStreams(10_000, 300, [])
  const infinitelyOld = sampleWithStreams(10_000, Number.POSITIVE_INFINITY, [])
  const infinitelyYoung = sampleWithStreams(11_000, Number.NEGATIVE_INFINITY, [])
  expect(streamsIntervalMs(infinitelyOld, healthy)).toBeNull()
  expect(streamsIntervalMs(healthy, infinitelyYoung)).toBeNull()
  expect(streamsIntervalMs(infinitelyOld, infinitelyOld)).toBeNull()
  expect(streamsIntervalMs(healthy, infinitelyOld)).toBeNull()
  expect(streamsIntervalMs(infinitelyYoung, healthy)).toBeNull()
})

test('po powrocie renderera tempo liczy się z całej ciszy, bez skoku', () => {
  // Cisza 30 s: dane z 10 000 i z 40 900. Od tyknięć wyszłaby sekunda
  // i tempo 927 klatek na sekundę; od chwili odebrania wychodzi uczciwe 30.
  const before = inbound({ framesReceived: 0 })
  const after = inbound({ framesReceived: 927 })
  const previous = sampleWithStreams(40_000, 30_000, [before])
  const next = sampleWithStreams(41_000, 100, [after])
  const interval = streamsIntervalMs(previous, next)
  expect(interval).toBe(30_900)
  expect(ratesBetween(before, after, interval ?? 0)?.receivedPerS).toBeCloseTo(30, 5)
})

test('brak danych o strumieniach po którejkolwiek stronie daje brak odstępu', () => {
  const never = sampleWithStreams(1_000, null, [])
  const fresh = sampleWithStreams(2_000, 100, [])
  expect(streamsIntervalMs(never, fresh)).toBeNull()
  expect(streamsIntervalMs(fresh, never)).toBeNull()
  expect(streamsIntervalMs(never, never)).toBeNull()
})

test('znacznik odczytu GPU powstaje PO powrocie wywołania, nie przed nim', async () => {
  // `nvidia-smi` mierzy 46,5 ms, więc znacznik zdjęty przed uruchomieniem
  // procesu jest stale o tyle starszy od wartości, którą opisuje. Od wieku tego
  // znacznika zależy teraz, czy pasek pokaże liczby, czy kreskę, więc stałe
  // zaniżanie go nie wchodzi w grę.
  const order: string[] = []
  const reading = await readGpu(
    async () => {
      order.push('nvidia-smi')
      return '99, 10034, 12282'
    },
    () => {
      order.push('zegar')
      return 1_000
    }
  )
  expect(order).toEqual(['nvidia-smi', 'zegar'])
  expect(reading?.at).toBe(1_000)
})

test('wpis strumienia przed odczytem RTP nie ma ani jednego zera', () => {
  // Reguła tego wydania: brak odczytu nigdy nie udaje zera. Wpisu
  // `inbound-rtp`/`outbound-rtp` może nie być wcale (uzgadnianie ICE w toku,
  // połączenie zamknięte między pobraniem listy a odczytem statystyk), a wtedy
  // CAŁY wpis składa się z wartości początkowych.
  const entry = emptyStreamStats('p1', 'screen', 'outbound')
  expect(entry).toEqual({
    peerId: 'p1',
    kind: 'screen',
    direction: 'outbound',
    framesReceived: null,
    framesDecoded: null,
    framesPresented: null,
    framesDropped: null,
    framesEncoded: null,
    framesSent: null,
    bytes: null,
    qualityLimitationReason: null
  })
})

test('brak wpisu RTP daje kreskę w kilobitach, a nie „nadaję 0,0 kb/s"', () => {
  // Dla wiersza nadawania bajty są dziś JEDYNĄ liczbą w całym wierszu, więc
  // `bytes: 0` w wartości początkowej kazałoby właścicielowi odczytać „nadaję
  // zero kilobitów" tam, gdzie prawdziwa odpowiedź to „nie wiem, połączenie
  // jeszcze nie stoi".
  const previous = emptyStreamStats('p1', 'screen', 'outbound')
  const next = emptyStreamStats('p1', 'screen', 'outbound')
  expect(ratesBetween(previous, next, 1_000)?.kilobitsPerS).toBeNull()
})

test('sufit pliku mieści całą najgorszą zmierzoną sesję', () => {
  // Sufit nie jest budżetem, tylko bezpiecznikiem — ale jedna sesja musi się
  // w nim zmieścić cała, bo zapis jest źródłem prawdy o wieczorze, którego nikt
  // nie oglądał. Najgorszy zmierzony przypadek: sześć osób z ekranem i kamerą
  // (20 połączeń) to 5 709 B na linię, a dziesięć godzin przy 1 Hz to 36 000
  // linii, czyli 196 MiB. Przy poprzednich 8 MiB zapis milkł po 24,5 minuty.
  const worstLineBytes = 5_709
  const samplesInTenHours = (10 * 60 * 60 * 1_000) / SAMPLE_INTERVAL_MS
  expect(LOG_SIZE_CEILING_BYTES).toBeGreaterThanOrEqual(worstLineBytes * samplesInTenHours)
})

test('retencja zostawia najnowsze pliki, a nie najstarsze', () => {
  // Sortowanie po nazwie jest tu dozwolone tylko dlatego, że format
  // `YYYY-MM-DD-HHmmss` porządkuje się leksykograficznie zgodnie z czasem.
  const names = [
    '2026-10-13-220301.jsonl',
    '2026-10-12-193000.jsonl',
    '2026-10-13-013000.jsonl'
  ]
  expect(logFilesToDelete(names, 2)).toEqual(['2026-10-12-193000.jsonl'])
  expect(logFilesToDelete(names, 1)).toEqual([
    '2026-10-12-193000.jsonl',
    '2026-10-13-013000.jsonl'
  ])
})

test('retencja nie usuwa niczego, dopóki plików nie jest więcej niż próg', () => {
  // Granica z obu stron: przy równej liczbie nie ginie nic, a dopiero plik ponad
  // próg wypycha najstarszy. Bez tego osłabienie o jeden przechodziłoby
  // niezauważone, a usuwałoby plik sesji, która właśnie się skończyła.
  const names = Array.from(
    { length: LOG_FILES_KEPT },
    (_value, index) => `2026-10-13-${String(index).padStart(6, '0')}.jsonl`
  )
  expect(logFilesToDelete(names, LOG_FILES_KEPT)).toEqual([])
  expect(logFilesToDelete([...names, '2026-10-14-200000.jsonl'], LOG_FILES_KEPT)).toEqual([
    '2026-10-13-000000.jsonl'
  ])
})

test('retencja rusza tylko pliki zapisu, ale rusza też stare nazwy dzienne', () => {
  // Filtrem jest samo rozszerzenie: pliki o starej, dziennej nazwie
  // (`YYYY-MM-DD.jsonl`) też dają się sprzątnąć, a cokolwiek innego w katalogu
  // zostaje nietknięte.
  const names = ['2026-10-12.jsonl', '2026-10-13-220301.jsonl', 'notatki.txt', 'podkatalog']
  expect(logFilesToDelete(names, 1)).toEqual(['2026-10-12.jsonl'])
  expect(logFilesToDelete(['notatki.txt', 'podkatalog'], 0)).toEqual([])
})

/** Zamarły sterownik: odczyt z 22:03:17 czasu lokalnego. */
const GPU_READ_AT = new Date(2026, 9, 13, 22, 3, 17).getTime()
const STUCK_GPU = {
  utilizationPercent: 97,
  memoryUsedMb: 11_469,
  memoryTotalMb: 12_282,
  at: GPU_READ_AT
}

test('zamarły odczyt GPU pokazuje kreskę z godziną, nie przyklejone procenty', () => {
  // Gdy `nvidia-smi` przestaje wracać (zawieszony sterownik, czyli przy
  // obciążeniu, którego szukamy), ostatni odczyt zostaje w pamięci na zawsze.
  // Bez tej gałęzi pasek i panel pokazywałyby „GPU 97% · VRAM 11,2/12,0 GB" dla
  // każdej kolejnej próbki aż do restartu, a właściciel przewijający suwak
  // czasu odczytałby przyklejone 97% jako przyczynę lagów.
  const text = formatResourceBadge(
    { cpuPercent: 23, memoryMb: 412, gpu: STUCK_GPU },
    GPU_READ_AT + GPU_STALE_AFTER_MS
  )
  expect(text).toBe('CPU 23% · RAM 412 MB · GPU — (odczyt z 22:03)')
})

test('wiek odczytu GPU o milisekundę krótszy od progu jeszcze pokazuje liczby', () => {
  // Razem z poprzednim testem przybija granicę z obu stron: próg jest włączny
  // od strony przestarzałości, tak samo jak w `streamsFreshness`.
  const text = formatResourceBadge(
    { cpuPercent: 23, memoryMb: 412, gpu: STUCK_GPU },
    GPU_READ_AT + GPU_STALE_AFTER_MS - 1
  )
  expect(text).toBe('CPU 23% · RAM 412 MB · GPU 97% · VRAM 11,2/12,0 GB')
})

test('„nie ma karty" i „odczyt zamarł" dają dwa różne napisy', () => {
  // To dwie bardzo różne sytuacje dla kogoś, kto szuka przyczyny: pierwsza
  // znaczy „tym przyrządem nic o karcie nie powiem", druga „karta była, a od
  // 22:03 nie odpowiada". Jeden napis na oba stany gubiłby tę informację.
  const missing = formatResourceBadge({ cpuPercent: 23, memoryMb: 412, gpu: null }, GPU_READ_AT)
  const frozen = formatResourceBadge(
    { cpuPercent: 23, memoryMb: 412, gpu: STUCK_GPU },
    GPU_READ_AT + GPU_STALE_AFTER_MS
  )
  expect(missing).toBe('CPU 23% · RAM 412 MB · GPU —')
  expect(frozen).not.toBe(missing)
  expect(frozen).toContain('22:03')
})

test('godzina odczytu ma zawsze dwie cyfry', () => {
  // Pierwsza w nocy to „01:05", nie „1:5". Bez dopełnienia napis rozjeżdżałby
  // się z resztą projektu, która składa godziny z lokalnych getterów.
  const earlyRead = new Date(2026, 9, 14, 1, 5, 0).getTime()
  const text = formatResourceBadge(
    { cpuPercent: 0, memoryMb: 0, gpu: { ...STUCK_GPU, at: earlyRead } },
    earlyRead + GPU_STALE_AFTER_MS
  )
  expect(text).toBe('CPU 0% · RAM 0 MB · GPU — (odczyt z 01:05)')
})

test('ujemny wiek odczytu GPU to drżenie zegara, nie zamarły sterownik', () => {
  // Synchronizacja czasu w trakcie sesji potrafi cofnąć zegar ścienny, a oba
  // znaczniki (próbki i odczytu) z niego pochodzą. Kreska znaczy „nie wiem",
  // więc nie wolno jej zapalać przy pomiarze, który po prostu wyprzedza próbkę.
  const text = formatResourceBadge(
    { cpuPercent: 23, memoryMb: 412, gpu: STUCK_GPU },
    GPU_READ_AT - 5_000
  )
  expect(text).toBe('CPU 23% · RAM 412 MB · GPU 97% · VRAM 11,2/12,0 GB')
})

test('odczyt GPU bez wiarygodnego znacznika czasu liczy się jako brak odczytu', () => {
  // Odczytu, którego nie da się umiejscowić w czasie, nie wolno pokazać jako
  // bieżącego — nie wiemy, czy jest aktualny — ale nie ma też godziny, którą
  // można by pokazać w nawiasie. Zostaje więc sama kreska. Odwrotnie przy
  // znaczniku próbki: godzinę odczytu znamy, więc pokazujemy ją, a za
  // świeżość nie ręczymy, bo wiek nie jest pomiarem.
  const text = formatResourceBadge(
    { cpuPercent: 23, memoryMb: 412, gpu: { ...STUCK_GPU, at: Number.NaN } },
    GPU_READ_AT
  )
  expect(text).toBe('CPU 23% · RAM 412 MB · GPU —')
  expect(
    formatResourceBadge({ cpuPercent: 23, memoryMb: 412, gpu: STUCK_GPU }, Number.NaN)
  ).toBe('CPU 23% · RAM 412 MB · GPU — (odczyt z 22:03)')
})

test('zdrowe odpytywanie GPU nigdy nie zapala kreski', () => {
  // Odpytujemy rzadziej, niż próbkujemy, więc odczyt starszy od próbki o cały
  // okres odpytywania jest NORMĄ, a nie objawem. Gdyby próg wynosił jeden
  // okres, zwykła praca zapalałaby kreskę co kilka próbek.
  expect(GPU_POLL_INTERVAL_MS).toBeGreaterThan(SAMPLE_INTERVAL_MS)
  expect(GPU_POLL_INTERVAL_MS % SAMPLE_INTERVAL_MS).toBe(0)
  expect(GPU_STALE_AFTER_MS).toBeGreaterThan(GPU_POLL_INTERVAL_MS)
  const healthy = formatResourceBadge(
    { cpuPercent: 23, memoryMb: 412, gpu: STUCK_GPU },
    GPU_READ_AT + GPU_POLL_INTERVAL_MS + 47
  )
  expect(healthy).toContain('GPU 97%')
})

/** Zużycie systemu bez odczytu karty — bierze go każdy test, który jej nie bada. */
const SYSTEM = { cpuPercent: 23, memoryMb: 412 }

test('linia panelu pokazuje godzinę odczytu GPU także przy świeżym odczycie', () => {
  // Kartę odpytujemy rzadziej, niż próbkujemy, więc te same liczby GPU stoją
  // w pięciu kolejnych próbkach. Właściciel przewijający suwak czasu widzi
  // pięć identycznych odczytów pod rząd i bez godziny czyta to jako „karta
  // przyklejona" — to samo złe wrażenie, które naprawiła gałąź z zamarłym
  // sterownikiem.
  const line = formatSystemLine({ ...SYSTEM, gpu: STUCK_GPU }, GPU_READ_AT + 1_000)
  expect(line).toBe('CPU 23% · RAM 412 MB · GPU 97% · VRAM 11,2/12,0 GB · odczyt z 22:03')
})

test('pasek w rogu milczy o godzinie, dopóki odczyt GPU jest świeży', () => {
  // To jedyna różnica między paskiem a linią panelu, więc test trzyma je
  // rozdzielone: pasek jest wąski i ma być cichy.
  const at = GPU_READ_AT + 1_000
  expect(formatResourceBadge({ ...SYSTEM, gpu: STUCK_GPU }, at)).toBe(
    'CPU 23% · RAM 412 MB · GPU 97% · VRAM 11,2/12,0 GB'
  )
  expect(formatSystemLine({ ...SYSTEM, gpu: STUCK_GPU }, at)).toContain('odczyt z 22:03')
})

test('po progu przestarzałości linia panelu i pasek mówią to samo', () => {
  // Gałąź z zamarłym sterownikiem pokazywała godzinę od początku, więc wariant
  // panelu nie ma jej dokładać po raz drugi.
  const system = { ...SYSTEM, gpu: STUCK_GPU }
  const at = GPU_READ_AT + GPU_STALE_AFTER_MS
  expect(formatSystemLine(system, at)).toBe('CPU 23% · RAM 412 MB · GPU — (odczyt z 22:03)')
  expect(formatSystemLine(system, at)).toBe(formatResourceBadge(system, at))
})

test('o milisekundę przed progiem linia panelu ma i liczby, i godzinę', () => {
  // Razem z poprzednim testem przybija granicę z obu stron — dla wariantu
  // panelu, nie tylko dla paska.
  const line = formatSystemLine(
    { ...SYSTEM, gpu: STUCK_GPU },
    GPU_READ_AT + GPU_STALE_AFTER_MS - 1
  )
  expect(line).toBe('CPU 23% · RAM 412 MB · GPU 97% · VRAM 11,2/12,0 GB · odczyt z 22:03')
})

test('bez odczytu GPU linia panelu nie ma godziny do pokazania', () => {
  // Nie ma odczytu — nie ma też jego godziny, więc zostaje sama kreska. Tak
  // samo przy znaczniku, którego nie da się umiejscowić w czasie.
  expect(formatSystemLine({ ...SYSTEM, gpu: null }, GPU_READ_AT)).toBe(
    'CPU 23% · RAM 412 MB · GPU —'
  )
  expect(
    formatSystemLine({ ...SYSTEM, gpu: { ...STUCK_GPU, at: Number.NaN } }, GPU_READ_AT)
  ).toBe('CPU 23% · RAM 412 MB · GPU —')
})

/**
 * Wszystkie kolumny liczbowe tabeli strumieni.
 *
 * `Record` po `keyof StreamRates` jest tu strażnikiem kompilacji: nowe pole
 * tempa wywali `npm run build`, dopóki nie trafi na tę listę — a wtedy
 * `columnAppliesTo` musi mieć dla niego rozstrzygnięty kierunek.
 */
const RATE_COLUMNS: Record<keyof StreamRates, true> = {
  receivedPerS: true,
  decodedPerS: true,
  presentedPerS: true,
  droppedPerS: true,
  encodedPerS: true,
  sentPerS: true,
  kilobitsPerS: true
}
const ALL_COLUMNS: StreamColumn[] = [
  ...(Object.keys(RATE_COLUMNS) as (keyof StreamRates)[]),
  'qualityLimitationReason'
]

test('kolumny odbioru nie dotyczą wiersza nadawania', () => {
  // Klatki odebrane i zdekodowane pochodzą z wpisu `inbound-rtp`, a wystawione
  // i porzucone z elementu `<video>`. Na połączeniu wychodzącym nie ma ani
  // jednego, ani drugiego — i nie będzie nigdy, więc to nie jest brak odczytu,
  // o którym panel miałby mówić kreską „nie wiem".
  expect(columnAppliesTo('receivedPerS', 'outbound')).toBe(false)
  expect(columnAppliesTo('decodedPerS', 'outbound')).toBe(false)
  expect(columnAppliesTo('presentedPerS', 'outbound')).toBe(false)
  expect(columnAppliesTo('droppedPerS', 'outbound')).toBe(false)
  expect(columnAppliesTo('receivedPerS', 'inbound')).toBe(true)
  expect(columnAppliesTo('decodedPerS', 'inbound')).toBe(true)
  expect(columnAppliesTo('presentedPerS', 'inbound')).toBe(true)
  expect(columnAppliesTo('droppedPerS', 'inbound')).toBe(true)
})

test('kolumny nadawania nie dotyczą wiersza odbioru', () => {
  // Rozkład jest symetryczny: `framesEncoded` i `framesSent` pochodzą z wpisu
  // `outbound-rtp`, którego na połączeniu przychodzącym nie ma.
  expect(columnAppliesTo('encodedPerS', 'inbound')).toBe(false)
  expect(columnAppliesTo('sentPerS', 'inbound')).toBe(false)
  expect(columnAppliesTo('encodedPerS', 'outbound')).toBe(true)
  expect(columnAppliesTo('sentPerS', 'outbound')).toBe(true)
})

test('powód ograniczenia jakości dotyczy tylko nadawania', () => {
  // `qualityLimitationReason` to pole SAMEGO `outbound-rtp`: koder mówi, czemu
  // zszedł z jakości. Odbierający takiego pola nie dostaje w ogóle, więc
  // kreska w tej kolumnie znaczyłaby „nie wiem" o czymś, czego nie da się
  // wiedzieć. Odczyt w `useDiagnosticsReporter` wypełnia je wyłącznie
  // z gałęzi `outbound-rtp`.
  expect(columnAppliesTo('qualityLimitationReason', 'outbound')).toBe(true)
  expect(columnAppliesTo('qualityLimitationReason', 'inbound')).toBe(false)
})

test('„nic mnie nie ogranicza" to odczyt, nie brak odczytu', () => {
  // `'none'` z `getStats()` znaczy „koder nie zszedł z jakości". To pełna
  // odpowiedź i przy zgłoszeniu „laguje, gdy gram" często najważniejsza w całej
  // tabeli: przenosi podejrzenie na inne ogniwo łańcucha. Kreska znaczy „nie
  // wiem", więc zlanie obu w jedno kłamałoby o zdrowym koderze.
  expect(formatLimitation('none')).toBe('nic')
  expect(formatLimitation(null)).toBe('—')
  expect(formatLimitation('none')).not.toBe(formatLimitation(null))
})

test('prawdziwy powód ograniczenia idzie do panelu bez zmian', () => {
  // Wartości wyliczenia WebRTC przepuszczamy dosłownie, bez tłumaczenia na
  // polskie nazwy: to terminy, które właściciel wpisze w wyszukiwarkę, szukając,
  // co z nimi zrobić.
  for (const reason of ['cpu', 'bandwidth', 'other']) {
    expect(formatLimitation(reason)).toBe(reason)
  }
})

test('tylko bajty liczą się w obie strony', () => {
  // Jedyna kolumna wspólna dla obu kierunków: `bytesReceived` i `bytesSent`.
  // Gdyby regułą domyślną było „dotyczy obu", test pokazałby to od razu.
  const both = ALL_COLUMNS.filter(
    (column) => columnAppliesTo(column, 'inbound') && columnAppliesTo(column, 'outbound')
  )
  expect(both).toEqual(['kilobitsPerS'])
})

test('każda kolumna dotyczy przynajmniej jednego kierunku', () => {
  // Kolumna, która nie dotyczy żadnego kierunku, byłaby pusta w każdym
  // wierszu, czyli zabierałaby miejsce i nie mówiła nic.
  for (const column of ALL_COLUMNS) {
    expect(
      columnAppliesTo(column, 'inbound') || columnAppliesTo(column, 'outbound'),
      `kolumna ${column} nie dotyczy żadnego kierunku`
    ).toBe(true)
  }
})

test('krótkie milczenie renderera liczy się w sekundach', () => {
  expect(formatSilence(3_000)).toBe('3 s')
  expect(formatSilence(59_400)).toBe('59 s')
})

test('milczenie dłuższe niż minuta przestaje być liczone w sekundach', () => {
  expect(formatSilence(60_000)).toBe('1 min')
  expect(formatSilence(90_000)).toBe('1 min 30 s')
  expect(formatSilence(59 * 60 * 1_000)).toBe('59 min')
})

test('godzina milczenia jest godziną, nie 3600 sekundami', () => {
  // Panel pokazuje teraz także zapis z dawnej chwili i nadąża przy otwartym
  // oknie, więc ten napis trafia na ciszę mierzoną w godzinach. „Renderer
  // milczy od 3600 s" wymaga przeliczania w głowie.
  expect(formatSilence(60 * 60 * 1_000)).toBe('1 godz.')
  expect(formatSilence(60 * 60 * 1_000 + 61_000)).toBe('1 godz. 1 min')
  expect(formatSilence(3 * 60 * 60 * 1_000 + 25 * 60 * 1_000)).toBe('3 godz. 25 min')
})

test('zaokrąglamy raz, do pełnych sekund, a nie każdą jednostkę osobno', () => {
  // Inaczej 119,6 s dałoby „1 min 60 s", a 59,6 s „0 min 60 s".
  expect(formatSilence(119_600)).toBe('2 min')
  expect(formatSilence(59_600)).toBe('1 min')
})

test('wiek milczenia, który nie jest liczbą, nie dostaje liczby', () => {
  // Zachowanie przeniesione bez zmiany z `Diagnostics.tsx`: nie ma pomiaru,
  // nie ma liczby.
  expect(formatSilence(null)).toBe('nieznanego czasu')
  expect(formatSilence(Number.NaN)).toBe('nieznanego czasu')
  expect(formatSilence(Number.POSITIVE_INFINITY)).toBe('nieznanego czasu')
})

test('suwak stojący na końcu idzie za teraźniejszością', () => {
  // Panel był zamrożony od chwili otwarcia, a pasek w tym samym oknie tykał co
  // sekundę — właściciel otwiera panel właśnie dlatego, że coś się zacięło.
  const start: PanelTimeline = { samples: [sample(1_000), sample(2_000)], cursor: 1 }
  const next = advancePanelTimeline(start, sample(3_000))
  expect(next.samples.map((entry) => entry.at)).toEqual([1_000, 2_000, 3_000])
  expect(next.cursor).toBe(2)
})

test('pusta historia przyjmuje pierwszą próbkę i staje na niej', () => {
  // Panel otwarty, gdy bufor był pusty: koniec pustej listy ma indeks −1, więc
  // równość z położeniem suwaka nigdy nie zachodzi. Stąd nierówność w regule.
  const next = advancePanelTimeline({ samples: [], cursor: 0 }, sample(1_000))
  expect(next.samples).toHaveLength(1)
  expect(next.cursor).toBe(0)
})

test('suwak poza listą wraca na koniec, a nie zostaje poza nią', () => {
  // Takiego położenia panel dziś nie wyprodukuje (`max` suwaka to ostatni
  // indeks), ale reguła, która na to liczy, zostawiałaby panel pokazujący
  // „bufor jest pusty" przy historii pełnej próbek. Reguła jest całkowita, bo
  // tak jest o jeden przypadek brzegowy taniej.
  const next = advancePanelTimeline({ samples: [sample(1_000)], cursor: 7 }, sample(2_000))
  expect(next.samples).toHaveLength(2)
  expect(next.cursor).toBe(1)
})

test('próbka nie nowsza od ostatniej nie zmienia historii panelu', () => {
  // Zegar paska pobiera tę samą najnowszą próbkę raz na sekundę, a rejestrator
  // tyka niezależnie od niego, więc powtórzenia są normą. Zwracamy TEN SAM
  // obiekt, żeby React pominął przerysowanie.
  const start: PanelTimeline = { samples: [sample(1_000), sample(2_000)], cursor: 1 }
  expect(advancePanelTimeline(start, sample(2_000))).toBe(start)
  expect(advancePanelTimeline(start, sample(1_500))).toBe(start)
})

test('dopisanie tej samej próbki dwa razy nie daje duplikatu', () => {
  // Efekty w StrictMode wykonują się w trybie rozwojowym podwójnie, więc
  // drugie wywołanie z tą samą próbką musi być bezczynne.
  const start: PanelTimeline = { samples: [sample(1_000)], cursor: 0 }
  const once = advancePanelTimeline(start, sample(2_000))
  expect(once.samples).toHaveLength(2)
  expect(advancePanelTimeline(once, sample(2_000))).toBe(once)
})

test('suwak przewinięty w tył zostaje na swojej próbce', () => {
  // Przewinięcie w tył jest czynnością świadomą; wyrywanie widoku byłoby wrogie.
  const start: PanelTimeline = {
    samples: [sample(1_000), sample(2_000), sample(3_000)],
    cursor: 0
  }
  const next = advancePanelTimeline(start, sample(4_000))
  expect(next.cursor).toBe(0)
  expect(next.samples[next.cursor]).toBe(start.samples[0])
})

test('przycięcie historii nie przewija panelu pod ręką', () => {
  // Przy pełnym buforze każde dopisanie wyrzuca wpis z POCZĄTKU listy, więc
  // ten sam indeks wskazuje co sekundę inną, późniejszą chwilę. Przewinięty
  // w tył panel przewijałby się sam, choć nikt go nie ruszał.
  const samples = Array.from({ length: BUFFER_MAX_SAMPLES }, (_, index) =>
    sample(index * SAMPLE_INTERVAL_MS)
  )
  const watched = samples[100]
  const next = advancePanelTimeline(
    { samples, cursor: 100 },
    sample(BUFFER_MAX_SAMPLES * SAMPLE_INTERVAL_MS)
  )
  expect(next.samples).toHaveLength(BUFFER_MAX_SAMPLES)
  expect(next.cursor).toBe(99)
  expect(next.samples[next.cursor]).toBe(watched)
})

test('historia panelu nie przegania bufora procesu głównego', () => {
  // Panel otwarty dłużej niż okno bufora pokazywałby inaczej okno czasu
  // szersze niż zapis, z którego powstał.
  let timeline: PanelTimeline = { samples: [], cursor: 0 }
  for (let index = 0; index < BUFFER_MAX_SAMPLES + 50; index += 1) {
    timeline = advancePanelTimeline(timeline, sample(index * SAMPLE_INTERVAL_MS))
  }
  expect(timeline.samples).toHaveLength(BUFFER_MAX_SAMPLES)
  expect(timeline.cursor).toBe(BUFFER_MAX_SAMPLES - 1)
})

test('próbki starsze niż okno bufora wypadają z historii panelu', () => {
  const start: PanelTimeline = { samples: [sample(0), sample(1_000)], cursor: 1 }
  const next = advancePanelTimeline(start, sample(BUFFER_MAX_AGE_MS + 1))
  expect(next.samples.map((entry) => entry.at)).toEqual([1_000, BUFFER_MAX_AGE_MS + 1])
  expect(next.cursor).toBe(1)
})

test('dopisanie nie zmienia przekazanej historii', () => {
  const samples = [sample(1_000)]
  const start: PanelTimeline = { samples, cursor: 0 }
  advancePanelTimeline(start, sample(2_000))
  expect(samples).toHaveLength(1)
  expect(start.cursor).toBe(0)
})
