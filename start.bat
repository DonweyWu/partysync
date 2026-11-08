@echo off
cd /d "%~dp0"
title PartySync - yi qi fang
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] Node.js not found.
  echo  Please install Node.js LTS from https://nodejs.org
  echo.
  pause
  exit /b 1
)
node server.js --open
pause
