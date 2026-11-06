@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Zhajinhua - Local Server

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Please install Node.js 18 or newer: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting server ... keep this window open.
echo.

node server.js

echo.
echo   Server stopped.
pause
