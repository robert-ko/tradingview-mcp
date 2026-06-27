# Windows + WSL2 Setup (and the CDP "fetch failed" gotchas)

This is the canonical guide for running the `tv` CLI / MCP server from **WSL2** against
**TradingView Desktop on Windows** over Chrome DevTools Protocol (CDP, port 9222).

The architecture is:

```
WSL2 (tv CLI / MCP)  ──►  Windows host  ──►  TradingView Desktop (Electron) CDP on 127.0.0.1:9222
```

WSL2 cannot see the Windows loopback by default, so the connection needs either a
**portproxy** (NAT networking) or **mirrored networking**. Two subtle bugs make this
fail silently — both are handled by `scripts/launch_msix_debug.ps1`.

---

## TL;DR — recommended setup

1. **Launch TradingView with CDP** (MSIX/Store install — see "Which install do I have?"):
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\launch_msix_debug.ps1
   ```
   It auto-detects your networking mode and configures everything (relaunches elevated
   if it needs to add the portproxy).

2. **From WSL**, verify:
   ```bash
   source scripts/setup_env.sh
   tv status      # -> "success": true, "cdp_connected": true
   ```

That's it. The rest of this doc explains the moving parts and the failure modes.

---

## Which install do I have?

| Install type | Where the .exe lives | Launcher to use |
|---|---|---|
| **MSIX / Microsoft Store** (most common) | `C:\Program Files\WindowsApps\TradingView.Desktop_*` (locked) | `scripts\launch_msix_debug.ps1` |
| Classic / non-Store | `%LOCALAPPDATA%\TradingView\TradingView.exe` | `scripts\launch_tv_debug.bat` |

Check from PowerShell:
```powershell
Get-AppxPackage -Name TradingView.Desktop   # non-empty => MSIX install
```

**Why MSIX needs a special launcher:** the `WindowsApps` folder is ACL-locked. You
cannot run the `.exe` directly or pass it `--remote-debugging-port`. `launch_msix_debug.ps1`
activates the package through the `IApplicationActivationManager` COM API (the same
mechanism the Start menu uses), which *does* forward launch arguments. The old
`explorer.exe shell:AppsFolder\<AUMID>` trick (and `ELECTRON_EXTRA_LAUNCH_ARGS`) does
**not** reliably pass the debug flag — that produces a TradingView that looks like it's
"in debug mode" but never actually opened a CDP port.

---

## Networking modes

### NAT (default WSL2)
WSL2 gets its own virtual network; `127.0.0.1` inside WSL is the Linux VM's loopback,
**not** Windows'. A `vEthernet (WSL)` adapter exists on the Windows host (e.g.
`172.21.112.1`). To reach CDP, a `netsh portproxy` forwards
`<WSL-adapter-IP>:9222 -> 127.0.0.1:9222`. `connection.js` auto-detects the gateway IP.

### Mirrored (`networkingMode=mirrored`) — recommended permanent fix
WSL2 shares the Windows loopback, so `127.0.0.1:9222` in WSL reaches Windows CDP
directly. **No portproxy, no reboot IP-drift, fewer moving parts.**

Enable it in `%USERPROFILE%\.wslconfig`:
```ini
[wsl2]
networkingMode=mirrored
```
then from PowerShell:
```powershell
wsl --shutdown
```
Reopen WSL and launch with the proxy skipped (auto-detected, or force it):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\launch_msix_debug.ps1 -NoProxy
```
From WSL, loopback is shared — `connection.js` probes and uses `127.0.0.1` automatically.
To be explicit: `export CDP_HOST=127.0.0.1`.

---

## The two portproxy traps (why "fetch failed" happens)

Both produce `tv status` -> `{"success": false, "error": "...fetch failed"}` even though
TradingView is running with `--remote-debugging-port=9222`.

1. **Self-referential / wrong-order proxy.** A rule
   `listenaddress=0.0.0.0 listenport=9222 -> 127.0.0.1:9222` binds loopback (0.0.0.0
   covers it) **before** Electron, so TradingView's CDP can never bind `127.0.0.1:9222`.
   Requests loop into the proxy itself.
   *Tell:* TV process has the flag + many renderers, but `netstat` shows **no** Electron
   listener on 9222 and there is **no** `DevToolsActivePort` file; `curl` returns empty
   (exit 52).

2. **Reverse overlap.** After a clean relaunch Electron owns `127.0.0.1:9222` first, so
   re-adding the proxy on `0.0.0.0:9222` fails to bind (the wildcard overlaps the
   specific loopback bind). The rule appears in `netsh ... show all` but **no socket
   listens**; `curl` is refused (exit 7).

**The fix for both:** launch TradingView first (Electron owns loopback), **then** add the
proxy bound to the *specific* `vEthernet (WSL)` adapter IP — **never `0.0.0.0`**.
`launch_msix_debug.ps1` does exactly this, in the right order.

---

## Manual recovery (if you ever need it without the script)

From an **elevated** PowerShell:
```powershell
# 1. Clear any stale rule
netsh interface portproxy delete v4tov4 listenport=9222 listenaddress=0.0.0.0

# 2. (Re)launch TradingView with CDP  -- see launch_msix_debug.ps1 for the COM call
#    then confirm Windows-local CDP is up:
Invoke-WebRequest http://localhost:9222/json/version -UseBasicParsing   # -> 200

# 3. Add the proxy bound to the WSL adapter IP (NOT 0.0.0.0)
$wslIp = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.InterfaceAlias -match 'WSL' } | Select-Object -First 1).IPAddress
netsh interface portproxy add v4tov4 listenport=9222 listenaddress=$wslIp connectport=9222 connectaddress=127.0.0.1
```
From WSL: `curl http://$wslIp:9222/json/version` then `tv status`.

---

## Troubleshooting quick table

| Symptom | Cause | Fix |
|---|---|---|
| `tv status` -> `fetch failed`, `curl` to gateway empty (exit 52) | Proxy bound `0.0.0.0` shadowing loopback; CDP never bound | Re-run `launch_msix_debug.ps1` |
| `curl` to gateway refused (exit 7), rule shows but nothing listens | Proxy `0.0.0.0` overlaps Electron's loopback bind | Re-run `launch_msix_debug.ps1` (binds WSL IP) |
| Worked yesterday, broken after reboot | WSL adapter IP changed; stale proxy rule | Re-run the script, or switch to mirrored networking |
| TV "in debug mode" but no CDP | Launched via `explorer shell:` / `ELECTRON_EXTRA_LAUNCH_ARGS` (flag not passed) | Use `launch_msix_debug.ps1` (COM launch) |
| `tv status` works on Windows but not WSL after enabling mirrored mode | `connection.js` probing/old `CDP_HOST` | `export CDP_HOST=127.0.0.1` |
