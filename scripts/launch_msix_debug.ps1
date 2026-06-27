<#
.SYNOPSIS
    Launch the MSIX / Microsoft Store build of TradingView Desktop with Chrome
    DevTools Protocol (CDP) enabled, and wire up WSL2 access correctly.

.DESCRIPTION
    The Store/MSIX build of TradingView installs into C:\Program Files\WindowsApps\
    which is locked by Windows - you cannot run the .exe directly or pass it
    command-line arguments the normal way (so scripts\launch_tv_debug.bat and the
    explorer.exe shell:AppsFolder trick in the old launch_tv_debug.vbs do NOT
    reliably pass --remote-debugging-port). This script launches the package through
    the IApplicationActivationManager COM API (the same mechanism Windows itself
    uses), which DOES accept launch arguments.

    It also avoids the two WSL2 portproxy traps that silently break CDP:
      1. A proxy bound to 0.0.0.0:PORT grabs the loopback port BEFORE Electron, so
         TradingView's CDP can never bind 127.0.0.1:PORT (requests loop into the
         proxy -> "fetch failed").
      2. Re-adding a 0.0.0.0:PORT proxy AFTER Electron owns 127.0.0.1:PORT fails to
         bind (wildcard overlaps the specific loopback bind) -> connection refused.
    The cure for both: launch TV first (Electron owns loopback), THEN add the proxy
    bound to the *specific* vEthernet (WSL) adapter IP - never 0.0.0.0.

    NETWORKING MODES (auto-detected):
      * NAT (default WSL2): a vEthernet (WSL) adapter exists. The script adds a
        portproxy bound to that adapter IP so WSL can reach CDP via the gateway.
      * Mirrored (networkingMode=mirrored) or no-WSL: no vEthernet (WSL) adapter.
        The script skips the proxy entirely (loopback is shared / not needed) and
        tells you to use CDP_HOST=127.0.0.1 from WSL. No admin/UAC required.

.PARAMETER Port
    CDP port. Default 9222.

.PARAMETER NoProxy
    Force-skip the WSL2 portproxy/firewall setup even if a WSL adapter is present
    (use for Windows-only, or WSL2 mirrored networking).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\launch_msix_debug.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\launch_msix_debug.ps1 -Port 9333 -NoProxy
#>
[CmdletBinding()]
param(
    [int]$Port = 9222,
    [switch]$NoProxy
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    $msg" -ForegroundColor Yellow }
function Get-WslAdapterIp {
    # Returns the vEthernet (WSL) adapter IPv4, or $null if none (mirrored / no WSL).
    (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.InterfaceAlias -match 'WSL' } |
        Select-Object -First 1).IPAddress
}

# --- 0. Decide whether a portproxy is needed (no admin required to check) ------
$wslIp = Get-WslAdapterIp
$useProxy = (-not $NoProxy) -and ($null -ne $wslIp)
$skipReason = if ($NoProxy) { '-NoProxy specified' }
              elseif (-not $wslIp) { 'no vEthernet (WSL) adapter (mirrored networking or no running WSL)' }
              else { '' }

# --- Elevate only if we actually need netsh (portproxy + firewall) ------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($useProxy -and -not $isAdmin) {
    Write-Warn2 "Not elevated - relaunching as Administrator (needed for the WSL portproxy)..."
    $argList = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"",'-Port',$Port)
    Start-Process powershell -Verb RunAs -ArgumentList $argList
    return
}

# --- 1. Locate the TradingView MSIX package & derive its AUMID ----------------
Write-Step "Locating TradingView MSIX package"
$pkg = Get-AppxPackage -Name 'TradingView.Desktop' -ErrorAction SilentlyContinue
if (-not $pkg) {
    Write-Warn2 "TradingView MSIX package not found (Get-AppxPackage -Name TradingView.Desktop)."
    Write-Warn2 "If you have the non-Store install, use scripts\launch_tv_debug.bat instead."
    exit 1
}
$appId = (Get-AppxPackageManifest $pkg).Package.Applications.Application.Id   # e.g. TradingView.Desktop
$aumid = "$($pkg.PackageFamilyName)!$appId"                                    # PFN!AppId
Write-Ok "Package : $($pkg.PackageFullName)"
Write-Ok "AUMID   : $aumid"

# --- 2. Kill any running TradingView so CDP can bind cleanly -------------------
Write-Step "Stopping any running TradingView"
Get-Process -Name TradingView -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Write-Ok "Stopped"

# --- 3. Remove any stale portproxy on this port (prevents the loopback loop) ---
if ($useProxy) {
    Write-Step "Clearing stale portproxy rules on port $Port"
    netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>$null | Out-Null
    if ($wslIp) { netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=$wslIp 2>$null | Out-Null }
    Write-Ok "Cleared"
}

# --- 4. Launch TradingView via COM with the debug flag ------------------------
Write-Step "Launching TradingView with --remote-debugging-port=$Port"
if (-not ([System.Management.Automation.PSTypeName]'TVLauncher').Type) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TVLauncher {
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationActivationManager {
        int ActivateApplication(string appUserModelId, string arguments, int options, out uint processId);
        int ActivateForFile(string appUserModelId, IntPtr itemArray, string verb, out uint processId);
        int ActivateForProtocol(string appUserModelId, IntPtr itemArray, out uint processId);
    }
    [ComImport, Guid("45ba127d-10a8-46ea-8ab7-56ea9078943c"), ClassInterface(ClassInterfaceType.None)]
    class ApplicationActivationManager {}
    public static uint Launch(string aumid, string args) {
        var mgr = (IApplicationActivationManager)new ApplicationActivationManager();
        uint pid; mgr.ActivateApplication(aumid, args, 0, out pid); return pid;
    }
}
"@
}
$tvPid = [TVLauncher]::Launch($aumid, "--remote-debugging-port=$Port")
Write-Ok "Launched PID: $tvPid"

# --- 5. Wait for CDP to come up on Windows loopback ---------------------------
Write-Step "Waiting for CDP at http://localhost:$Port"
$up = $false
foreach ($i in 1..20) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/json/version" -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $up = $true; break }
    } catch { Start-Sleep -Milliseconds 800 }
}
if (-not $up) {
    Write-Warn2 "CDP did not come up after ~16s. TradingView may still be loading - re-run, or check the window opened."
    exit 1
}
$ver = (Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/json/version").Content | ConvertFrom-Json
Write-Ok "CDP ready: $($ver.Browser)"

# --- 6. WSL2 access ------------------------------------------------------------
if (-not $useProxy) {
    Write-Step "Skipping portproxy ($skipReason)"
    Write-Host ""
    Write-Host "TradingView CDP is ready." -ForegroundColor Green
    Write-Host "  Windows : http://localhost:$Port/json/version"
    Write-Host "  WSL2    : set CDP_HOST=127.0.0.1 (mirrored networking shares loopback), then run 'tv status'"
    return
}

Write-Step "Configuring WSL2 access (NAT mode)"
# Bind to the SPECIFIC WSL adapter IP, never 0.0.0.0 (0.0.0.0 overlaps Electron's
# 127.0.0.1:$Port bind and silently fails to listen).
netsh interface portproxy add v4tov4 listenport=$Port listenaddress=$wslIp connectport=$Port connectaddress=127.0.0.1 | Out-Null
netsh advfirewall firewall add rule name="CDP $Port for WSL2" dir=in action=allow protocol=TCP localport=$Port 2>$null | Out-Null
Write-Ok "portproxy: ${wslIp}:$Port -> 127.0.0.1:$Port"

# Verify the listener actually bound
if (netstat -ano | Select-String "${wslIp}:$Port\s.*LISTENING") {
    Write-Ok "Listener confirmed on ${wslIp}:$Port"
} else {
    Write-Warn2 "Proxy rule added but no listener detected - check 'netsh interface portproxy show all'."
}

Write-Host ""
Write-Host "TradingView CDP is ready." -ForegroundColor Green
Write-Host "  Windows : http://localhost:$Port/json/version"
Write-Host "  WSL2    : http://${wslIp}:$Port/json/version   (tv CLI auto-detects this gateway)"
Write-Host "  Verify  : from WSL run  ->  tv status"
Write-Host ""
Write-Host "NOTE: the WSL adapter IP ($wslIp) can change after a Windows reboot. If 'tv status'"
Write-Host "fails later, just re-run this script. Permanent fix: WSL2 mirrored networking"
Write-Host "(networkingMode=mirrored in %USERPROFILE%\.wslconfig) removes the portproxy entirely."
