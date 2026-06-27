' keep_wsl_alive.vbs
' Starts the Ubuntu-24.04 WSL distro at Windows logon and keeps it running, so that
' WSL cron jobs fire on schedule (e.g. the 16:00 weekday after-market trade-plotter cron
' in scripts/afterhours_plot.sh). systemd (enabled in /etc/wsl.conf) boots cron when the
' distro starts; the "sleep infinity" process keeps the distro from idle-shutting-down.
'
' Runs hidden (0) and does not wait (False). Safe to run when WSL is already up.
' Installed copy lives in the user's Startup folder:
'   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\keep_wsl_alive.vbs
Set sh = CreateObject("WScript.Shell")
sh.Run "wsl.exe -d Ubuntu-24.04 -e sh -c ""exec sleep infinity""", 0, False
