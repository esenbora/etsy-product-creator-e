@echo off
REM Tek tik launcher: update + CDP browser + server + tarayicida ac.
REM Goto for loop disinda. Delayed expansion icin enabledelayedexpansion.

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ====== Etsy Unalta E (fal.ai) ======
echo Klasor: %CD%
echo.

REM ---------- 1. Update check ----------
echo [1/4] Guncelleme kontrol...

set "LOCAL_VERSION="
if exist data\.version (
  set /p LOCAL_VERSION=<data\.version
)

set "REMOTE_VERSION="
for /f "tokens=*" %%v in ('node -e "fetch('https://www.flowiqa.com/api/version?app=etsy-product-creator-e').then(r=^>r.json()).then(j=^>console.log(j.version^|^|'')).catch(()=^>console.log(''))" 2^>nul') do set "REMOTE_VERSION=%%v"

if "!REMOTE_VERSION!"=="" (
  echo    Surum kontrol atlandi [offline?]
) else if "!LOCAL_VERSION!"=="!REMOTE_VERSION!" (
  echo    Guncel !LOCAL_VERSION!
) else (
  echo    Yeni surum: !LOCAL_VERSION! -^> !REMOTE_VERSION!, guncelleniyor...
  set "KEY="
  for /f "tokens=*" %%k in ('node -e "try{console.log(JSON.parse(require('fs').readFileSync('data/license.json')).payload.key)}catch{console.log('')}" 2^>nul') do set "KEY=%%k"
  if "!KEY!"=="" (
    echo    Lisans cache yok, guncelleme atlandi
  ) else (
    set "TARGET=%CD%"
    set "LICENSE_KEY=!KEY!"
    powershell -ExecutionPolicy Bypass -Command "iwr -useb https://www.flowiqa.com/install/etsy-product-creator-e.ps1 ^| iex" >"%TEMP%\epc-update.log" 2>&1
    if errorlevel 1 (
      echo    Guncelleme basarisiz [%%TEMP%%\epc-update.log incele]
    ) else (
      echo !REMOTE_VERSION!>data\.version
      echo    Guncelleme basarili: !REMOTE_VERSION!
    )
  )
)

REM ---------- 2. Config ----------
set "CDP_PORT=9333"
for /f "tokens=*" %%p in ('node -e "try { console.log(JSON.parse(require('fs').readFileSync('config.json')).cdpPort^|^|9333) } catch { console.log(9333) }" 2^>nul') do set "CDP_PORT=%%p"

set "SERVER_PORT=3001"
if defined PORT set "SERVER_PORT=%PORT%"

REM ---------- 3. CDP browser ----------
echo.
echo [2/4] CDP browser port=!CDP_PORT!...
call :check_cdp
if !ERRORLEVEL! equ 0 (
  echo    Zaten acik
) else (
  echo    Aciliyor...
  start "EPC Browser" /MIN cmd /c "npm run browser:dist > %TEMP%\epc-browser.log 2>&1"
  set "CDP_READY=0"
  for /l %%i in (1,1,30) do (
    if "!CDP_READY!"=="0" (
      timeout /t 1 /nobreak >nul
      call :check_cdp
      if !ERRORLEVEL! equ 0 set "CDP_READY=1"
    )
  )
  if "!CDP_READY!"=="1" (
    echo    Hazir
  ) else (
    echo    UYARI: CDP browser 30sn'de baslamadi
  )
)

REM ---------- 4. Server ----------
echo.
echo [3/4] Server port=!SERVER_PORT!...
call :check_server
if !ERRORLEVEL! equ 0 (
  echo    Zaten calisiyor
) else (
  echo    Baslatiliyor...
  start "EPC Server" /MIN cmd /c "npm run start:dist > %TEMP%\epc-server.log 2>&1"
  set "SRV_READY=0"
  for /l %%i in (1,1,30) do (
    if "!SRV_READY!"=="0" (
      timeout /t 1 /nobreak >nul
      call :check_server
      if !ERRORLEVEL! equ 0 set "SRV_READY=1"
    )
  )
  if "!SRV_READY!"=="1" (
    echo    Hazir
  ) else (
    echo    HATA: Server 30sn'de baslamadi
    echo    Detay: %%TEMP%%\epc-server.log
    echo    Manuel kontrol: npm run start:dist
  )
)

REM ---------- 5. Browser ac ----------
echo.
echo [4/4] Tarayici aciliyor: http://localhost:!SERVER_PORT!
start "" "http://localhost:!SERVER_PORT!"

echo.
echo ====== HAZIR ======
echo URL: http://localhost:!SERVER_PORT!
echo.
echo Bu pencereyi kapatabilirsiniz [server + browser arkada devam eder]
echo veya ENTER'a basarak kapatin.
pause >nul

endlocal
goto :eof

REM ---------- Subroutines ----------
:check_cdp
node -e "require('http').get('http://localhost:%CDP_PORT%/json/version', { timeout: 1000 }, r =^> process.exit(r.statusCode===200?0:1)).on('error', () =^> process.exit(1))" 2>nul
exit /b %ERRORLEVEL%

:check_server
node -e "require('http').get('http://localhost:%SERVER_PORT%/', { timeout: 1000 }, r =^> process.exit(0)).on('error', () =^> process.exit(1))" 2>nul
exit /b %ERRORLEVEL%
