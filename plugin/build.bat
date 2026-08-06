@echo off
REM Budowanie pluginu TS3 Screen Share (Windows, MSVC, 64-bit).
REM Dziala ze ZWYKLEGO cmd — skrypt sam znajduje i uruchamia vcvars64.bat.

setlocal
cd /d "%~dp0"

REM Sama obecnosc cl.exe w PATH nie wystarcza: bez vcvars nie ma INCLUDE ani LIB,
REM i kompilacja pada na "nie mozna otworzyc windows.h".
if defined INCLUDE goto :srodowisko_ok

echo Ustawiam srodowisko MSVC...

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo [BLAD] Nie znaleziono vswhere.exe.
  echo Zainstaluj MSVC Build Tools:
  echo   winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  exit /b 1
)

REM Wynik przez plik tymczasowy: cytowanie sciezki ze spacjami wewnatrz for /f
REM potrafi sie rozjechac i cmd probuje wtedy uruchomic samo vswhere.exe.
"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath > "%TEMP%\ts3ss_vsroot.txt" 2>nul
set /p VSROOT=<"%TEMP%\ts3ss_vsroot.txt"
del "%TEMP%\ts3ss_vsroot.txt" 2>nul

if not defined VSROOT (
  echo [BLAD] Nie znaleziono instalacji MSVC z narzedziami C++.
  echo Doinstaluj workload "Desktop development with C++" w Visual Studio Installer.
  exit /b 1
)

if not exist "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat" (
  echo [BLAD] Brak vcvars64.bat w "%VSROOT%".
  exit /b 1
)

call "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (
  echo [BLAD] vcvars64.bat zwrocil blad.
  exit /b 1
)

:srodowisko_ok

where cl >nul 2>nul
if errorlevel 1 (
  echo [BLAD] Nie znaleziono cl.exe mimo ustawionego srodowiska.
  exit /b 1
)

if not exist build mkdir build

REM Klient TS3 jest 64-bitowy, wiec plugin tez musi byc 64-bitowy.
REM /utf-8: zrodlo jest w UTF-8 bez BOM, wiec bez tej flagi MSVC czyta je
REM wedlug systemowej strony kodowej (u nas 1250). Client API TS3 oczekuje
REM UTF-8, a napisy z polskimi znakami przechodzily dotad tylko przypadkiem.
cl /nologo /LD /O2 /W3 /utf-8 ^
   /I sdk\include ^
   src\plugin.c ^
   /Fo:build\ ^
   /Fe:build\ts3_screenshare.dll ^
   /link /DLL

if errorlevel 1 (
  echo.
  echo [BLAD] Kompilacja nie powiodla sie.
  exit /b 1
)

echo.
echo Zbudowano: build\ts3_screenshare.dll
echo.
echo Instalacja — skopiuj do katalogu pluginow i przeladuj w kliencie:
echo   copy /Y "build\ts3_screenshare.dll" "%APPDATA%\TS3Client\plugins\"
endlocal
