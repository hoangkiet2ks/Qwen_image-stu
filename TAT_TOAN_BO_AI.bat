@echo off
title Tat AI Server - Qwen Image Editor
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-tailscale-backend.ps1"
echo.
pause
