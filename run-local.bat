@echo off
setlocal EnableDelayedExpansion
title Smart Water Meter - local dev
cd /d "%~dp0"

set "FW_RULE=SWM-SmartWater-Dev"
set "PORTS=1883,3000,5173"
set "CONFIG_H=firmware\smart_water_meter\config.h"
set "LAN_JSON=mobile_app\env\lan.json"

echo ============================================================
echo  Smart Water Meter - local backend + admin web
echo ============================================================
echo.

rem ---------------------------------------------------------------
rem 1. IP address
rem ---------------------------------------------------------------
echo [1/4] Checking IP address...
set "LAN_IP="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1).IPv4Address.IPAddress"`) do set "LAN_IP=%%i"

if not defined LAN_IP (
  echo   [!] No active network with a gateway found. Connect to Wi-Fi / hotspot first.
  echo       All IPv4 addresses:
  ipconfig | findstr /C:"IPv4"
  set "LAN_IP=localhost"
) else (
  echo   This PC's LAN IP: !LAN_IP!
)

rem IP the ESP firmware points at
set "ESP_IP="
if exist "%CONFIG_H%" (
  for /f "tokens=3" %%a in ('findstr /R /C:"^#define MQTT_HOST " "%CONFIG_H%"') do set "ESP_IP=%%~a"
)
if defined ESP_IP (
  if /i "!ESP_IP!"=="!LAN_IP!" (
    echo   [OK] ESP config.h MQTT_HOST = !ESP_IP!
  ) else (
    echo   [!] ESP config.h MQTT_HOST = !ESP_IP!  ^(does NOT match !LAN_IP!^)
    echo       Update MQTT_HOST in %CONFIG_H% and re-upload the sketch.
  )
)

rem IP the mobile app points at
set "APP_IP="
if exist "%LAN_JSON%" (
  for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "([uri](Get-Content '%LAN_JSON%' -Raw | ConvertFrom-Json).API_BASE_URL).Host"`) do set "APP_IP=%%a"
)
if defined APP_IP (
  if /i "!APP_IP!"=="!LAN_IP!" (
    echo   [OK] Mobile app env\lan.json  = !APP_IP!
  ) else (
    echo   [!] Mobile app env\lan.json  = !APP_IP!  ^(does NOT match !LAN_IP!^)
    echo       Update API_BASE_URL and SOCKET_URL in %LAN_JSON%.
  )
)
echo.

rem ---------------------------------------------------------------
rem 2. Firewall
rem ---------------------------------------------------------------
echo [2/4] Checking Windows Firewall (TCP %PORTS%)...
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "(Get-NetConnectionProfile | Select-Object -First 1).NetworkCategory"`) do echo   Network profile: %%p

netsh advfirewall firewall show rule name=%FW_RULE% >nul 2>&1
if !errorlevel! equ 0 (
  echo   [OK] Inbound rule "%FW_RULE%" exists:
  netsh advfirewall firewall show rule name=%FW_RULE% | findstr /R /C:"Enabled" /C:"LocalPort" /C:"Action" /C:"Profiles"
) else (
  echo   [!] No inbound rule for ports %PORTS%. Adding one ^(needs admin - accept the UAC prompt^)...
  net session >nul 2>&1
  if !errorlevel! equ 0 (
    netsh advfirewall firewall add rule name=%FW_RULE% dir=in action=allow protocol=TCP localport=%PORTS% profile=any >nul
  ) else (
    powershell -NoProfile -Command "Start-Process netsh -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList 'advfirewall firewall add rule name=%FW_RULE% dir=in action=allow protocol=TCP localport=%PORTS% profile=any'"
  )
  netsh advfirewall firewall show rule name=%FW_RULE% >nul 2>&1
  if !errorlevel! equ 0 (
    echo   [OK] Firewall rule added.
  ) else (
    echo   [!] Could not add the rule. The ESP and phone may not reach this PC.
    echo       Run this file as Administrator, or allow TCP %PORTS% manually.
  )
)
echo.

rem ---------------------------------------------------------------
rem 3. Backend (API :3000 + MQTT :1883)
rem ---------------------------------------------------------------
echo [3/4] Starting backend...
where node >nul 2>&1 || (echo   [X] Node.js not found. Install Node 20+ from nodejs.org. & pause & exit /b 1)

if not exist "backend\.env" if exist "backend\.env.example" (
  copy /y "backend\.env.example" "backend\.env" >nul
  echo   Created backend\.env from .env.example
)
if not exist "backend\node_modules" (
  echo   Installing backend packages...
  pushd backend & call npm install & popd
)

netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul
if !errorlevel! equ 0 (
  echo   Port 3000 is already in use - assuming the backend is already running.
) else (
  start "SWM Backend" cmd /k "cd /d "%~dp0backend" && npm run dev"
)

echo   Waiting for backend health check...
set /a TRIES=0
:wait_backend
curl -s -f http://localhost:3000/health >nul 2>&1
if !errorlevel! equ 0 goto backend_up
set /a TRIES+=1
if !TRIES! geq 45 (
  echo   [!] Backend did not answer on :3000 after 90 s. Check the "SWM Backend" window.
  goto start_admin
)
timeout /t 2 /nobreak >nul
goto wait_backend
:backend_up
echo   [OK] Backend is up.
echo.

rem ---------------------------------------------------------------
rem 4. Admin web (Vite, exposed on the LAN with --host)
rem ---------------------------------------------------------------
:start_admin
echo [4/4] Starting admin web (--host)...
if not exist "admin-web\node_modules" (
  echo   Installing admin-web packages...
  pushd admin-web & call npm install & popd
)
netstat -ano | findstr /R /C:":5173 .*LISTENING" >nul
if !errorlevel! equ 0 (
  echo   Port 5173 is already in use - assuming admin web is already running.
) else (
  start "SWM Admin Web" cmd /k "cd /d "%~dp0admin-web" && npm run dev -- --host"
)

echo.
echo ============================================================
echo  Admin web : http://localhost:5173
echo              http://!LAN_IP!:5173   ^(other devices on the Wi-Fi^)
echo  API       : http://!LAN_IP!:3000/api/v1
echo  MQTT      : !LAN_IP!:1883  ^(ESP MQTT_HOST^)
echo  Login     : admin@swm.local / Admin@123
echo.
echo  Close the "SWM Backend" and "SWM Admin Web" windows to stop.
echo ============================================================
pause
