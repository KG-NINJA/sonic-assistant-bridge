@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or later is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\three\build\three.module.js" (
  echo Run npm ci in this folder once, then launch again.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:8765 in Chrome or Edge.
echo Keep this window open. Press Ctrl+C to stop the server.
node server.js
pause
