@echo off
chcp 65001 >nul
title QUANTFOOTBALL PRO - Kvantitativ Fogadasi Analitika es Szelvenygenerator
echo ============================================================================
echo   QUANTFOOTBALL PRO // Bivariate Poisson + xG Analitika es Szelvenygenerator
echo ============================================================================
echo.
echo [1/2] Korabbi napok ellenorzese es napi automatika szinkronizalasa...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0napi_futo.ps1"

echo [2/2] Helyi Kvantitativ Szerver inditasa es bongeszo megnyitasa...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
pause
