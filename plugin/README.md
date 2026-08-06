# TS3 Plugin

Cienki plugin klienta TeamSpeak 3. Jedyne, co robi: dokłada pozycję do menu
kontekstowego kanału i uruchamia companion app z kontekstem z Client API.

## Status

**Kompiluje się i produkuje poprawny DLL.** Zweryfikowane:

- buduje się bez błędów i ostrzeżeń MSVC,
- architektura **x64** — zgodna z `ts3client_win64.exe`,
- **12 funkcji `ts3plugin_*` w tablicy eksportów** (`dumpbin /exports`),
- `PLUGIN_API_VERSION` = 26, zgodnie z SDK.

Sprawdzone w działającym kliencie: wtyczka ładuje się bez błędu, pozycja menu
pojawia się w menu kontekstowym kanału, a kliknięcie odpala lobby companion app
ze ścieżki odczytanej z `ts3-screenshare.path`.

Uwaga: `build.bat` wypisuje po drodze `'vswhere.exe' is not recognized`.
Komunikat pochodzi z wnętrza `vcvars64.bat` Microsoftu, nie z naszego skryptu —
środowisko mimo to ustawia się poprawnie i kompilacja przechodzi. Kosmetyka.

## Wymagany klient: TeamSpeak 3.6.x

Klient akceptuje **zakres** wersji API i odrzuca wtyczkę spoza niego.
Sprawdzone na dwóch maszynach — zakresy się nie pokrywają:

| Klient | Akceptuje |
| --- | --- |
| TS3 3.6.2 | minimum **26** (odrzuca 25) |
| starszy klient | 23–**25** (odrzuca 26) |

Nie ma więc jednej wartości działającej wszędzie. Zostajemy przy **26** zgodnie
z SDK; użytkownicy starszych klientów zobaczą w Narzędzia → Opcje → Wtyczki
komunikat `Api version is not compatible` i muszą zaktualizować TeamSpeaka.

Gdyby kiedyś trzeba było wspierać oba naraz, jedyną drogą są dwa osobne DLL-e —
wartość jest wkompilowana i klient jej nie negocjuje.

## Jedna pozycja menu, nie dwie

Brief zakładał „Udostępnij ekran" i „Dołącz do udostępniania". W modelu lobby
druga jest zbędna: wchodzisz do pokoju kanału, od razu widzisz cudzy obraz
i sam możesz zacząć nadawać. Została jedna pozycja.

## Co plugin przekazuje

| Argument | Skąd |
| --- | --- |
| `--ts3-server` | `VIRTUALSERVER_UNIQUE_IDENTIFIER` |
| `--channel` | ID kanału, na którym kliknięto menu |
| `--nick` | `CLIENT_NICKNAME` (opcjonalny) |

Świadomie **identyfikator serwera, nie adres**: adres bywa różny (IP kontra
domena, inny port), co rozjechałoby pokoje między ludźmi połączonymi z tym samym
serwerem na różne sposoby. Hashowanie do `roomId` zostaje po stronie companion
app — jedna implementacja tej reguły zamiast dwóch do synchronizowania.

## Budowanie

Wymaga **MSVC Build Tools** (klient TS3 jest 64-bitowy, więc plugin też musi być).

```bat
build.bat
```

Uruchamiaj z „x64 Native Tools Command Prompt for VS", inaczej `cl.exe` nie
będzie w PATH. Skrypt sam to sprawdza i mówi, co zrobić.

Potem skopiuj `build\ts3_screenshare.dll` do `%APPDATA%\TS3Client\plugins\`
i w kliencie: Narzędzia → Opcje → Wtyczki → Przeładuj.

## SDK

`sdk/` to płytki klon [oficjalnego repo](https://github.com/teamspeak/ts3client-pluginsdk),
wyłączony z gita (`.gitignore`). Odtworzenie:

```bash
git clone --depth 1 https://github.com/teamspeak/ts3client-pluginsdk.git sdk
```

## Czego tu jeszcze nie ma
Ikona statusu przy nadającym w drzewie kanałów (brief: „do rozważenia, nie MVP")
oraz instalator pakujący plugin razem ze spakowaną companion app.
