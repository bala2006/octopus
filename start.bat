@echo off
rem Start Octopus in Docker, plus the laptop-side folder picker so "Open project folder" shows Windows' own dialog.
cd /d "%~dp0"
where py >nul 2>nul && (start "Octopus folder picker" /min py -3 scripts\folder_bridge.py & goto run)
where python >nul 2>nul && (start "Octopus folder picker" /min python scripts\folder_bridge.py & goto run)
echo Python not found: the in-app folder browser will be used instead of the Windows folder dialog.
:run
echo Octopus: http://localhost:8080
docker compose up --build
