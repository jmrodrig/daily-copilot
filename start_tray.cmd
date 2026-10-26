@echo off
rem Daily Co-Pilot tray: start, stop and restart the dev servers from the Windows system tray.
if not exist "%~dp0start_tray.lnk" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%~dp0start_tray.lnk'); $s.TargetPath = '%~dp0start_tray.cmd'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = '%~dp0docs\brand\favicon\favicon.ico,0'; $s.Description = 'Daily Co-Pilot System Tray Controller'; $s.Save()" >nul 2>&1
)
start "" pythonw "%~dp0scripts\copilot_tray.pyw"
