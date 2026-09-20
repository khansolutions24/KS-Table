@echo off
rem Startet KS Table im Entwicklungsmodus (Electron-Fenster mit Hot-Reload).
rem Dieses Konsolenfenster offen lassen; Schliessen beendet die App.
title KS Table
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron fehlt in node_modules - bitte "npm install" ausfuehren.
  pause
  exit /b 1
)
call npm run dev
