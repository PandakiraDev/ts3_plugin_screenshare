/** Nazwy kanałów IPC — jedno miejsce, żeby main i preload nie rozjechały się literówką. */

export const IPC_GET_SOURCES = 'sources:get'
export const IPC_GET_LAUNCH = 'launch:get'
/**
 * Renderer zapowiada, co zaraz przechwyci. getDisplayMedia nie przyjmuje id
 * źródła — wybór trafia do handlera w main process, a ten musi wiedzieć,
 * które źródło użytkownik kliknął.
 */
export const IPC_SET_CAPTURE_TARGET = 'capture:target'

/** Klucz dostępu do serwera sygnalizacyjnego — odczyt i zapis w userData. */
export const IPC_GET_API_KEY = 'apikey:get'
export const IPC_SET_API_KEY = 'apikey:set'

/** Dźwięk wybranej aplikacji: start (podaje PID) i stop. */
export const IPC_AUDIO_START = 'audio:start'
export const IPC_AUDIO_STOP = 'audio:stop'

/**
 * Kanał, którym main przekazuje `MessagePort` z próbkami PCM. Osobno od
 * zwykłego IPC, bo pakietów jest około stu na sekundę — nie mają zapychać
 * kanału, którym lecą wywołania interfejsu.
 *
 * Port trafia do renderera przez `window.postMessage` z preloada, bo przez
 * contextBridge nie przechodzi.
 *
 * UWAGA na kolejność: port przychodzi *w trakcie* `startAppAudio()`, więc
 * nasłuch trzeba założyć wcześniej, inaczej wiadomość przepadnie:
 *
 * ```ts
 * const portReady = new Promise((resolve) => { ...nasłuch na IPC_AUDIO_PORT... })
 * const format = await window.companion.startAppAudio(pid)
 * const port = await portReady
 * ```
 */
export const IPC_AUDIO_PORT = 'audio:port'

/** Numer wersji aplikacji — do plakietki w nagłówku. */
export const IPC_GET_VERSION = 'app:version'

/**
 * Stan aktualizacji. Dwa kanały, bo renderer montuje się później niż main:
 * zdarzenie `update-downloaded` może przyjść, zanim ktokolwiek słucha, więc
 * `IPC_GET_UPDATE_STATE` pozwala dociągnąć stan raz na starcie, a
 * `IPC_UPDATE_STATE` niesie każdą kolejną zmianę.
 */
export const IPC_GET_UPDATE_STATE = 'update:get'
export const IPC_UPDATE_STATE = 'update:state'

/*
 * Diagnostyka. Cztery kanały: trzy do podglądu i jeden do wykrytej karty
 * graficznej. O flagę renderer nie pyta w ogóle — od 0.3.4 podgląd należy do
 * każdego i nic go nie włącza. Ustawienie zapisu na dysk jedzie osobnymi
 * kanałami (`IPC_GET_SETTINGS` / `IPC_SET_SETTINGS` niżej), bo renderer rysuje
 * jego pole wyboru; z PODGLĄDEM nie ma ono nic wspólnego i żaden z czterech
 * kanałów tej sekcji od niego nie zależy.
 *
 * `LATEST` i `READ` są rozdzielone celowo: pasek w rogu potrzebuje jednej
 * najnowszej próbki co sekundę, a panel całego bufora tylko wtedy, gdy jest
 * otwarty. Przesyłanie sześciuset wpisów co sekundę dla czterech liczb
 * w rogu byłoby marnotrawstwem.
 */
export const IPC_DIAGNOSTICS_PUSH = 'diagnostics:push'
export const IPC_DIAGNOSTICS_LATEST = 'diagnostics:latest'
export const IPC_DIAGNOSTICS_READ = 'diagnostics:read'
/**
 * Nazwa i pamięć karty graficznej, wykryte raz przy starcie procesu głównego.
 *
 * Osobny kanał, a nie pole w próbce: karta nie zmienia się w trakcie sesji,
 * więc wkładanie jej w każdą z sześciuset próbek bufora byłoby powtarzaniem
 * tego samego napisu sześćset razy.
 */
export const IPC_GPU_CARD = 'diagnostics:gpu-card'

/*
 * Dziennik lobby. Dwa kanały: renderer wypycha wpisy, okno dziennika czyta
 * cały pierścień.
 *
 * Pierścień trzyma PROCES GŁÓWNY (`src/main/lobbyLog.ts`), bo renderer jest
 * tym, co diagnozujemy: gdyby był właścicielem, przestawałby zapisywać
 * dokładnie w interesującej nas chwili, a jego przeładowanie czyściłoby
 * dziennik. Rejestracja obu kanałów jest BEZWARUNKOWA, tak samo jak przy
 * podglądzie zużycia — dziennik należy od 0.3.4 do każdego, a ustawienie
 * zapisu na dysk nie ma na te dwa kanały żadnego wpływu: pierścień w pamięci
 * zapełnia się i daje czytać niezależnie od niego.
 *
 * `PUSH` bierze TABLICĘ wpisów, nie jeden: jedna zmiana stanu w lobby daje
 * często kilka wpisów naraz (ktoś wszedł i od razu nadaje ekran oraz kamerę),
 * a rozbijanie ich na osobne wywołania byłoby kilkoma przejściami granicy
 * procesów po to samo. Osobny `READ` zamiast odsyłania pierścienia w
 * odpowiedzi na `PUSH`, bo czyta go tylko otwarte okno dziennika — wypycha
 * każda sesja, czyta rzadko kto.
 */
export const IPC_LOBBY_LOG_PUSH = 'lobby-log:push'
export const IPC_LOBBY_LOG_READ = 'lobby-log:read'

/*
 * Ustawienia z `<userData>/settings.json`. Jeden odczyt przy montowaniu panelu
 * i jeden zapis na kliknięcie pola wyboru.
 *
 * `SET` robi DWIE rzeczy w procesie głównym, nie jedną: zapisuje plik ORAZ
 * przestawia zapis na dysk w obu rejestratorach na gorąco. Rozdzielenie tego
 * na dwa kanały dałoby stan, w którym plik mówi jedno, a sesja robi drugie —
 * a o przestawienie W TRAKCIE sesji szło w tej zmianie od początku.
 *
 * `SET` ODPOWIADA wartością logiczną: czy plik faktycznie powstał. To nie jest
 * ozdoba — spakowana aplikacja Windows nie ma podpiętej konsoli (patrz
 * `main/updateLogger.ts`), więc nieudany zapis byłby bez tej odpowiedzi
 * całkowicie niewidoczny: pole wyboru pokazywałoby „włączone" i po cichu
 * wracało do „wyłączone" po restarcie.
 */
export const IPC_GET_SETTINGS = 'settings:get'
export const IPC_SET_SETTINGS = 'settings:set'
