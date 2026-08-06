/*
 * TS3 Screen Share — plugin klienta TeamSpeak 3.
 *
 * Celowo cienki: jedyne, co robi, to dokłada pozycję do menu kontekstowego
 * kanału i uruchamia companion app z kontekstem odczytanym z Client API.
 * Cała właściwa logika (capture, WebRTC, UI) jest w Electronie — patrz brief.
 *
 * Jedna pozycja menu, nie dwie. W modelu lobby nie ma podziału na oglądającego
 * i nadającego: wchodzisz do pokoju kanału, widzisz to, co ktoś udostępnia,
 * i sam możesz zacząć. Osobne "Dołącz do udostępniania" nie ma już sensu.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <windows.h>

#include "plugin_definitions.h"
#include "teamspeak/public_definitions.h"
#include "teamspeak/public_errors.h"
#include "ts3_functions.h"

/*
 * Klient akceptuje ZAKRES wersji API i odrzuca plugin spoza niego. Sprawdzone
 * na dwóch maszynach — i te zakresy się NIE pokrywają:
 *
 *   TS3 3.6.2      -> minimum 26  (odrzuca 25)
 *   starszy klient -> minimum 23, maksimum 25  (odrzuca 26)
 *
 * Nie ma więc jednej wartości działającej wszędzie. Świadoma decyzja:
 * zostajemy przy 26 (zgodnie z SDK) i wymagamy klienta 3.6.x. Starsze klienty
 * dostaną komunikat "Api version is not compatible" i muszą się zaktualizować.
 *
 * Gdyby kiedyś trzeba było wspierać oba naraz — jedyną drogą są dwa osobne
 * DLL-e, bo wartość jest wkompilowana i klient nie negocjuje.
 */
#define PLUGIN_API_VERSION 26

/*
 * Bez tego MSVC buduje DLL, ale NIE eksportuje nic — klient nie znajduje
 * ts3plugin_apiVersion i plugin po cichu się nie ładuje. Sprawdzone przez
 * `dumpbin /exports`: pierwsza wersja miała pustą tablicę eksportów.
 */
#ifdef _WIN32
#define PLUGINS_EXPORTDLL __declspec(dllexport)
#else
#define PLUGINS_EXPORTDLL __attribute__((visibility("default")))
#endif

/* Makro z przykładowego plugin.c w SDK — nie ma go w nagłówkach, więc
 * definiujemy je u siebie (MSVC: bezpieczny wariant z rozmiarem bufora). */
#define _strcpy(dest, destSize, src) strcpy_s(dest, destSize, src)

#define MENU_ID_SHARE 1

static struct TS3Functions ts3;
static char* pluginID = NULL;

/*
 * Gdzie szukać companion app. Dwie drogi, w tej kolejności:
 *
 * 1. Plik `ts3-screenshare.path` obok DLL-a — zapisuje go instalator i trzyma
 *    w nim pełną ścieżkę do .exe. Dzięki temu aplikacja może leżeć tam, gdzie
 *    Windows normalnie instaluje programy, zamiast 270+ MB w katalogu pluginów.
 * 2. Ścieżka względna obok pluginu — dla instalacji ręcznej (rozpakowanie ZIP-a).
 *
 * Bez tego pierwszego instalator musiałby wymuszać katalog instalacji, czego
 * electron-builder i tak nie respektuje (sprawdzone: aplikacja lądowała
 * w %LOCALAPPDATA%\Programs mimo nadpisania $INSTDIR).
 */
#define COMPANION_PATH_FILE "ts3-screenshare.path"
#define COMPANION_RELATIVE "ts3-screenshare\\TS3 Screen Share.exe"

PLUGINS_EXPORTDLL const char* ts3plugin_name() { return "TS3 Screen Share"; }
PLUGINS_EXPORTDLL const char* ts3plugin_version() { return "0.1.0"; }
PLUGINS_EXPORTDLL int ts3plugin_apiVersion() { return PLUGIN_API_VERSION; }
PLUGINS_EXPORTDLL const char* ts3plugin_author() { return "Konrad"; }
PLUGINS_EXPORTDLL const char* ts3plugin_description()
{
    /* Polskie znaki są tu bezpieczne dzięki /utf-8 w build.bat — Client API
     * TS3 oczekuje UTF-8, a bez tej flagi MSVC kodowałby literały wg CP1250. */
    return "Udostępnianie ekranu w kanale TS3 (companion app + WebRTC).";
}

PLUGINS_EXPORTDLL void ts3plugin_setFunctionPointers(const struct TS3Functions funcs) { ts3 = funcs; }

PLUGINS_EXPORTDLL int ts3plugin_init() { return 0; }

PLUGINS_EXPORTDLL void ts3plugin_shutdown()
{
    if (pluginID) {
        free(pluginID);
        pluginID = NULL;
    }
}

PLUGINS_EXPORTDLL void ts3plugin_registerPluginID(const char* id)
{
    const size_t sz = strlen(id) + 1;
    pluginID        = (char*)malloc(sz);
    if (pluginID) _strcpy(pluginID, sz, id);
}

PLUGINS_EXPORTDLL void ts3plugin_freeMemory(void* data) { free(data); }

/* ---- menu ------------------------------------------------------------- */

static struct PluginMenuItem* createMenuItem(enum PluginMenuType type, int id, const char* text, const char* icon)
{
    struct PluginMenuItem* item = (struct PluginMenuItem*)malloc(sizeof(struct PluginMenuItem));
    if (!item) return NULL;
    item->type = type;
    item->id   = id;
    _strcpy(item->text, PLUGIN_MENU_BUFSZ, text);
    _strcpy(item->icon, PLUGIN_MENU_BUFSZ, icon);
    return item;
}

PLUGINS_EXPORTDLL void ts3plugin_initMenus(struct PluginMenuItem*** menuItems, char** menuIcon)
{
    const int count = 1;
    int       n     = 0;

    *menuItems      = (struct PluginMenuItem**)malloc(sizeof(struct PluginMenuItem*) * (count + 1));
    (*menuItems)[n++] = createMenuItem(PLUGIN_MENU_TYPE_CHANNEL, MENU_ID_SHARE, "Udostępnij ekran", "");
    (*menuItems)[n++] = NULL; /* lista musi być zakończona NULL-em */

    *menuIcon = NULL;
}

/* ---- uruchamianie companion app --------------------------------------- */

/** Ustala ścieżkę do .exe companion app: najpierw plik od instalatora, potem obok pluginu. */
static void resolveCompanionPath(char* out, size_t outSize)
{
    char pluginDir[MAX_PATH];
    ts3.getPluginPath(pluginDir, MAX_PATH, pluginID);

    char pathFile[MAX_PATH];
    _snprintf_s(pathFile, MAX_PATH, _TRUNCATE, "%s%s", pluginDir, COMPANION_PATH_FILE);

    FILE* f = NULL;
    if (fopen_s(&f, pathFile, "r") == 0 && f != NULL) {
        char      line[MAX_PATH] = {0};
        const int ok             = (fgets(line, (int)sizeof(line), f) != NULL);
        fclose(f);
        if (ok) {
            /* fgets zostawia znak nowej linii; obcinamy go razem z CR i spacjami. */
            size_t len = strlen(line);
            while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r' || line[len - 1] == ' ')) {
                line[--len] = '\0';
            }
            if (len > 0) {
                _strcpy(out, outSize, line);
                return;
            }
        }
    }

    _snprintf_s(out, outSize, _TRUNCATE, "%s%s", pluginDir, COMPANION_RELATIVE);
}

/*
 * Klucz pokoju liczy companion app z (identyfikator serwera + ID kanału).
 * Plugin przekazuje surowe dane; hashowanie zostaje po stronie aplikacji,
 * żeby istniała jedna implementacja tej reguły, a nie dwie do zsynchronizowania.
 *
 * Świadomie używamy VIRTUALSERVER_UNIQUE_IDENTIFIER zamiast adresu: adres bywa
 * różny (IP kontra domena, inny port), a to rozjechałoby pokoje między ludźmi
 * połączonymi z tym samym serwerem na różne sposoby.
 */
/*
 * UTF-8 z Client API na UTF-16 dla WinAPI. Pusty napis przy braku wejścia,
 * żeby wołający nie musiał sprawdzać NULL-a przy każdym użyciu.
 */
static void utf8ToWide(const char* utf8, wchar_t* out, int outChars)
{
    if (!utf8 || MultiByteToWideChar(CP_UTF8, 0, utf8, -1, out, outChars) == 0) {
        out[0] = L'\0';
    }
}

static void launchCompanion(uint64 serverConnectionHandlerID, uint64 channelID)
{
    char* serverUid = NULL;
    char* nickname  = NULL;
    anyID myClientID;

    if (ts3.getServerVariableAsString(serverConnectionHandlerID, VIRTUALSERVER_UNIQUE_IDENTIFIER, &serverUid) != ERROR_ok) {
        ts3.logMessage("Nie udalo sie odczytac identyfikatora serwera", LogLevel_ERROR, "TS3ScreenShare", serverConnectionHandlerID);
        return;
    }

    if (ts3.getClientID(serverConnectionHandlerID, &myClientID) == ERROR_ok) {
        /* Nick jest opcjonalny: bez niego serwer sygnalizacyjny nada zastępczy
         * "Uzytkownik N", więc brak nicku nie może blokować uruchomienia. */
        ts3.getClientVariableAsString(serverConnectionHandlerID, myClientID, CLIENT_NICKNAME, &nickname);
    }

    char exePath[MAX_PATH];
    resolveCompanionPath(exePath, sizeof(exePath));

    /*
     * Client API TS3 oddaje napisy w UTF-8, a CreateProcessA interpretuje je
     * według systemowej strony kodowej (w Polsce 1250). Nick "Michał" docierał
     * przez to do companion app jako "MichaÅ‚". Dlatego całą linię poleceń
     * budujemy w UTF-16 i wołamy wersję W.
     *
     * Dotyczy też ścieżki: getPluginPath zwraca UTF-8, więc katalog użytkownika
     * z polskimi znakami psuł uruchomienie w ogóle.
     */
    wchar_t exePathW[MAX_PATH];
    wchar_t serverUidW[256];
    wchar_t nicknameW[128];
    utf8ToWide(exePath, exePathW, MAX_PATH);
    utf8ToWide(serverUid, serverUidW, 256);
    utf8ToWide(nickname, nicknameW, 128);

    /* Cudzysłowy wokół ścieżki i nicku: obie potrafią zawierać spacje. */
    wchar_t cmdline[2048];
    _snwprintf_s(cmdline, 2048, _TRUNCATE,
                 L"\"%s\" --ts3-server=\"%s\" --channel=%llu%s%s%s",
                 exePathW,
                 serverUidW,
                 (unsigned long long)channelID,
                 nickname ? L" --nick=\"" : L"",
                 nickname ? nicknameW : L"",
                 nickname ? L"\"" : L"");

    STARTUPINFOW        si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    if (CreateProcessW(NULL, cmdline, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        /* Uchwytów nie trzymamy — companion app żyje własnym życiem i nie chcemy,
         * żeby jej zamknięcie czy działanie blokowało klienta TS3. */
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    } else {
        char err[512];
        _snprintf_s(err, sizeof(err), _TRUNCATE,
                    "Nie udało się uruchomić companion app (błąd %lu): %s",
                    GetLastError(), exePath);
        ts3.logMessage(err, LogLevel_ERROR, "TS3ScreenShare", serverConnectionHandlerID);
        ts3.printMessageToCurrentTab("[TS3 Screen Share] Nie udalo sie uruchomic aplikacji udostepniania.");
    }

    if (serverUid) ts3.freeMemory(serverUid);
    if (nickname) ts3.freeMemory(nickname);
}

PLUGINS_EXPORTDLL void ts3plugin_onMenuItemEvent(uint64 serverConnectionHandlerID, enum PluginMenuType type, int menuItemID, uint64 selectedItemID)
{
    if (type != PLUGIN_MENU_TYPE_CHANNEL || menuItemID != MENU_ID_SHARE) return;

    /* selectedItemID to ID kanału, na którym kliknięto menu. */
    launchCompanion(serverConnectionHandlerID, selectedItemID);
}
