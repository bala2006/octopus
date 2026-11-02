@echo off
rem Start Octopus in Docker, plus the laptop-side helper so Add opens Windows' native folder picker.
cd /d "%~dp0"
where py >nul 2>nul && (start "Octopus folder picker" /min py -3 scripts\folder_bridge.py & goto run)
where python >nul 2>nul && (start "Octopus folder picker" /min python scripts\folder_bridge.py & goto run)
if exist "%USERPROFILE%\py313\python.exe" (
  start "Octopus folder picker" /min "%USERPROFILE%\py313\python.exe" "%~dp0scripts\folder_bridge.py"
  goto run
)
echo Python not found: Add will use the in-app folder browser instead of the Windows folder dialog.
:run
echo Octopus: http://localhost:8080
docker compose up --build
