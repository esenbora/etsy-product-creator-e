@echo off
REM Tek tik launcher (Windows): update + CDP browser + server + tarayicida ac.
REM Masaustu kisayolu buna point eder.

setlocal
cd /d "%~dp0"

REM 1. Update check (release branch)
echo ^>^> Guncelleme kontrol...
REM flowiqa.com tarball auto-update (git pull yok artik)
set LOCAL_VERSION=
if exist data\.version (
  set /p LOCAL_VERSION=<data\.version
)

set REMOTE_VERSION=
for /f "tokens=*" %%v in ('node -e "fetch('https://www.flowiqa.com/api/version?app=etsy-product-creator-e').then(r=^>r.json()).then(j=^>console.log(j.version^|^|'')).catch(()=^>console.log(''))" 2^>nul') do set REMOTE_VERSION=%%v

if "%REMOTE_VERSION%"=="" (
  echo    Surum kontrol atlandi ^(offline?^)
) else if "%LOCAL_VERSION%"=="%REMOTE_VERSION%" (
  echo    Guncel %LOCAL_VERSION%
) else (
  echo    Yeni surum: %LOCAL_VERSION% -^> %REMOTE_VERSION%, guncelleniyor...
  set KEY=
  for /f "tokens=*" %%k in ('node -e "try{console.log(JSON.parse(require('fs').readFileSync('data/license.json')).payload.key)}catch{console.log('')}" 2^>nul') do set KEY=%%k
  if "%KEY%"=="" (
    echo    Lisans cache yok, guncelleme atlandi
  ) else (
    set "TARGET=%CD%"
    set "LICENSE_KEY=%KEY%"
    powershell -ExecutionPolicy Bypass -Command "iwr -useb https://www.flowiqa.com/install/etsy-product-creator-e.ps1 | iex" >%TEMP%\epc-update.log 2>&1
    if errorlevel 1 (
      echo    Guncelleme basarisiz, eski surum ile devam ^(%%TEMP%%\epc-update.log incele^)
    ) else (
      echo %REMOTE_VERSION%>data\.version
      echo    Guncelleme basarili: %REMOTE_VERSION%
    )
  )
)

REM CDP port (config.json'dan oku, fallback 9333)
set CDP_PORT=9333
for /f "tokens=*" %%p in ('node -e "try { console.log(JSON.parse(require('fs').readFileSync('config.json')).cdpPort^|^|9333) } catch { console.log(9333) }" 2^>nul') do set CDP_PORT=%%p

set SERVER_PORT=3001
if defined PORT set SERVER_PORT=%PORT%

REM 2. CDP browser
echo ^>^> CDP browser (%CDP_PORT%)...
node -e "require('http').get('http://localhost:%CDP_PORT%/json/version', { timeout: 1000 }, r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))" 2>nul
if %ERRORLEVEL%==0 (
  echo    Zaten acik
) else (
  echo    Aciliyor...
  start "EPC Browser" /MIN cmd /c "npm run browser"
  for /l %%i in (1,1,30) do (
    timeout /t 1 /nobreak >nul
    node -e "require('http').get('http://localhost:%CDP_PORT%/json/version', { timeout: 1000 }, r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))" 2>nul
    if not errorlevel 1 goto cdp_ready
  )
  :cdp_ready
  echo    Hazir
)

REM 3. Server
echo ^>^> Server (%SERVER_PORT%)...
node -e "require('http').get('http://localhost:%SERVER_PORT%/', { timeout: 1000 }, r => process.exit(0)).on('error', () => process.exit(1))" 2>nul
if %ERRORLEVEL%==0 (
  echo    Zaten calisiyor
) else (
  start "EPC Server" /MIN cmd /c "npm start"
  for /l %%i in (1,1,30) do (
    timeout /t 1 /nobreak >nul
    node -e "require('http').get('http://localhost:%SERVER_PORT%/', { timeout: 1000 }, r => process.exit(0)).on('error', () => process.exit(1))" 2>nul
    if not errorlevel 1 goto srv_ready
  )
  :srv_ready
  echo    Hazir
)

REM 4. Tarayicida ac
start "" "http://localhost:%SERVER_PORT%"
echo.
echo Hazir: http://localhost:%SERVER_PORT%
echo.
echo (Pencereyi kapatmak icin ENTER'a bas)
pause >nul

endlocal
