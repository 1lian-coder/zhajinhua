@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Zhajinhua - Current URL

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\show-url.ps1"

