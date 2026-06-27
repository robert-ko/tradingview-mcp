@echo off
REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled
REM Usage: scripts\launch_tv_debug.bat [port]

set PORT=%1
if "%PORT%"=="" set PORT=9222

REM If TradingView is installed as MSIX/Store app, its .exe in WindowsApps is locked
REM and cannot be launched with arguments from here. Redirect to the COM launcher.
set "TV_MSIX="
for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "if (Get-AppxPackage -Name 'TradingView.Desktop' -ErrorAction SilentlyContinue) { 'MSIX' }"`) do set "TV_MSIX=%%i"
if "%TV_MSIX%"=="MSIX" (
    echo TradingView is an MSIX/Store install -- this .bat cannot pass launch args to it.
    echo Use the PowerShell launcher instead:
    echo     powershell -ExecutionPolicy Bypass -File "%~dp0launch_msix_debug.ps1"
    exit /b 1
)

REM Kill existing TradingView instances
taskkill /F /IM TradingView.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM Auto-detect TradingView install location
set "TV_EXE="

REM Check common install locations
if exist "%LOCALAPPDATA%\TradingView\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES(x86)%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES(x86)%\TradingView\TradingView.exe"

REM Check MSIX / Windows Store installs via PowerShell (avoids permission issues with WindowsApps)
if "%TV_EXE%"=="" (
    for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "try { $p = (Get-AppxPackage -Name 'TradingView.Desktop' -ErrorAction Stop).InstallLocation; if ($p) { Join-Path $p 'TradingView.exe' } } catch {}"`) do set "TV_EXE=%%i"
)
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('where TradingView.exe 2^>nul') do set "TV_EXE=%%i"
)

if "%TV_EXE%"=="" (
    echo Error: TradingView not found.
    echo Checked: %%LOCALAPPDATA%%\TradingView, %%PROGRAMFILES%%\TradingView, WindowsApps
    echo.
    echo If installed elsewhere, run manually:
    echo   "C:\path\to\TradingView.exe" --remote-debugging-port=%PORT%
    exit /b 1
)

echo Found TradingView at: %TV_EXE%
echo Starting with --remote-debugging-port=%PORT%...
start "" "%TV_EXE%" --remote-debugging-port=%PORT%

echo Waiting for CDP to become available...
timeout /t 5 /nobreak >nul

:check
curl -s http://localhost:%PORT%/json/version >nul 2>&1
if %errorlevel% neq 0 (
    echo Still waiting...
    timeout /t 2 /nobreak >nul
    goto check
)

echo.
echo CDP ready at http://localhost:%PORT%
curl -s http://localhost:%PORT%/json/version
echo.

REM Forward port so WSL2 (NAT mode) can reach CDP. Bind to the SPECIFIC vEthernet (WSL)
REM adapter IP -- never 0.0.0.0, which overlaps Electron's 127.0.0.1:%PORT% bind and
REM silently fails to listen. Requires admin (netsh part skips silently if not).
set "WSLIP="
for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object { $_.InterfaceAlias -match 'WSL' } ^| Select-Object -First 1).IPAddress"`) do set "WSLIP=%%i"
if "%WSLIP%"=="" (
    echo No vEthernet ^(WSL^) adapter found ^(mirrored networking or no running WSL^).
    echo From WSL set CDP_HOST=127.0.0.1 -- no portproxy needed.
) else (
    netsh interface portproxy delete v4tov4 listenport=%PORT% listenaddress=0.0.0.0 >nul 2>&1
    netsh interface portproxy delete v4tov4 listenport=%PORT% listenaddress=%WSLIP% >nul 2>&1
    netsh interface portproxy add v4tov4 listenport=%PORT% listenaddress=%WSLIP% connectport=%PORT% connectaddress=127.0.0.1 >nul 2>&1
    netsh advfirewall firewall add rule name="CDP %PORT% for WSL2" dir=in action=allow protocol=TCP localport=%PORT% >nul 2>&1
    echo WSL2 port forwarding configured: %WSLIP%:%PORT% -^> 127.0.0.1:%PORT%
)
