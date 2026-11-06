@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Zhajinhua - Public Tunnel

echo.
echo   Building public tunnel with built-in ssh (nothing to download) ...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\share-ssh.ps1"

echo.
echo   Tunnel closed.
pause
