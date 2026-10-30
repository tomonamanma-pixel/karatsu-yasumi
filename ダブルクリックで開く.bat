@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 唐津店 休み希望
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Node.js が見つかりません。
  echo https://nodejs.org/ の LTS を入れてから、もう一度開いてください。
  echo.
  pause
  exit /b 1
)
node server.js
echo.
pause
