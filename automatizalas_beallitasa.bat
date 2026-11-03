@echo off
chcp 65001 >nul
title QUANTFOOTBALL PRO - Napi Automatikus Futas Beallitasa (Windows Feladatutemezo)
echo ============================================================================
echo   QUANTFOOTBALL PRO // Napi Automatikus Szelvenykeszito es Kiertekelo
echo ============================================================================
echo.
echo Beallitjuk a Windows Feladatutemezoben (Task Scheduler), hogy a rendszer
echo minden nap reggel 08:30-kor automatikusan a hatterben:
echo   1. Kiertekelje az elozo napi szelvenyeket a hivatalos vegeredmenyekkel,
echo   2. Frissitse az 5 000 Ft-os bankroll egyenlegedet,
echo   3. Lekerje a mai/holnapi elo meccseket es elkeszitse az uj szelvenyeket!
echo.

schtasks /Create /TN "QuantFootball_Napi_Automata" /TR "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%~dp0napi_futo.ps1\"" /SC DAILY /ST 08:30 /F

if %errorlevel% equ 0 (
    echo.
    echo [SIKER] A "QuantFootball_Napi_Automata" napi feladat sikeresen aktivalva!
    echo Mostantol minden nap 08:30-kor magatol lefut a hatterben.
) else (
    echo.
    echo [INFO] A feladat letrehozasahoz kattints jobb gombbal erre a fajlra,
    echo majd valaszd a "Futtatas rendszergazdakent" lehetoseget.
)
echo.
pause
