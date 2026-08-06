@echo off
REM Uruchamia diagnostyke i ZAPISUJE wynik do pliku obok tego skryptu.
REM Dwuklik wystarczy - okno nie zamknie sie samo.
REM
REM Osobny .bat jest potrzebny, bo dwuklik w .ps1 domyslnie otwiera Notatnik,
REM a nawet gdy skrypt sie uruchomi, konsola znika natychmiast po zakonczeniu.

setlocal
cd /d "%~dp0"
set "WYNIK=%~dp0ts3-diagnostyka.txt"

if not exist "%~dp0diagnostyka.ps1" (
  echo [BLAD] Brak pliku diagnostyka.ps1 obok tego skryptu.
  echo Rozpakuj oba pliki do tego samego katalogu.
  echo.
  pause
  exit /b 1
)

echo Zbieram informacje, chwile to potrwa...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnostyka.ps1" > "%WYNIK%" 2>&1

type "%WYNIK%"

echo.
echo ============================================================
echo Wynik zapisany w pliku:
echo   %WYNIK%
echo Wyslij ten plik.
echo ============================================================
echo.
pause
endlocal
