; Instalator kladzie aplikacje tam, gdzie Windows normalnie instaluje programy,
; a do katalogu pluginow TS3 wrzuca tylko DLL i maly plik ze sciezka do .exe.
;
; Wymuszanie $INSTDIR na katalog pluginow zostalo sprawdzone i NIE dziala —
; electron-builder nadpisuje je po preInit i aplikacja ladowala
; w %LOCALAPPDATA%\Programs mimo podmiany. Stad plik ze sciezka: plugin go
; czyta (resolveCompanionPath w plugin.c) i nie musi zgadywac lokalizacji.

!define TS3_PLUGINS "$APPDATA\TS3Client\plugins"
!define TS3_DLL "$APPDATA\TS3Client\plugins\ts3_screenshare.dll"
!define TS3_PATHFILE "$APPDATA\TS3Client\plugins\ts3-screenshare.path"

; Windows blokuje DLL zaladowany do procesu, wiec przy dzialajacym TeamSpeaku
; podmiana pluginu cicho by sie nie udala. Zamiast zgadywac po nazwie procesu,
; sprawdzamy to, co faktycznie blokuje: mozliwosc zapisu do pliku.
; Parametr SUFFIX daje unikalne etykiety — NSIS nie pozwala ich powtarzac.
!macro SprawdzTS3 SUFFIX
  ; $0 jest rejestrem WSPOLDZIELONYM - electron-builder sam z niego korzysta.
  ; Bez Push/Pop nadpisanie go tutaj rozstraja logike instalatora.
  Push $0
  sprawdz_${SUFFIX}:
  IfFileExists "${TS3_DLL}" 0 koniec_${SUFFIX}
    ClearErrors
    FileOpen $0 "${TS3_DLL}" a
    IfErrors zablokowany_${SUFFIX} 0
    FileClose $0
    Goto koniec_${SUFFIX}
  zablokowany_${SUFFIX}:
    ; Nie da sie zapisac do pliku wtyczki. Najczesciej trzyma go TeamSpeak,
    ; ale rownie dobrze moze to byc brak uprawnien albo antywirus - komunikat
    ; wymienia wszystkie trzy, zamiast wskazywac tylko jedna przyczyne.
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "Nie moge zapisac pliku wtyczki:$\r$\n${TS3_DLL}$\r$\n$\r$\nNajczestsza przyczyna: uruchomiony TeamSpeak 3.$\r$\nMoze to byc tez brak uprawnien albo blokada antywirusa.$\r$\n$\r$\nZamknij TeamSpeaka i kliknij Ponow." \
      IDRETRY sprawdz_${SUFFIX}
    Pop $0
    Abort
  koniec_${SUFFIX}:
  Pop $0
!macroend

!macro customInit
  !insertmacro SprawdzTS3 "init"
!macroend

!macro customInstall
  SetOutPath "${TS3_PLUGINS}"
  File "${BUILD_RESOURCES_DIR}\ts3_screenshare.dll"

  ; Pelna sciezka do .exe — po niej plugin znajduje aplikacje.
  FileOpen $0 "${TS3_PATHFILE}" w
  FileWrite $0 "$INSTDIR\${PRODUCT_FILENAME}.exe"
  FileClose $0

  DetailPrint "Plugin TS3: ${TS3_PLUGINS}"
  DetailPrint "Aplikacja: $INSTDIR"
!macroend

!macro customUnInit
  !insertmacro SprawdzTS3 "uninit"
!macroend

!macro customUnInstall
  Delete "${TS3_DLL}"
  Delete "${TS3_PATHFILE}"
!macroend
