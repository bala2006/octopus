@echo off
rem Start Octopus: build the UI when stale, then serve everything on http://127.0.0.1:8000 (set OCTOPUS_PORT to change it).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0octopus.ps1" start %*
