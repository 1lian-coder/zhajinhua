@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   Stopping server and public tunnel ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop.ps1"
echo.
pause
