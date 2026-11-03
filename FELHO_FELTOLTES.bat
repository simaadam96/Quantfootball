@echo off
chcp 65001 >nul
title QUANTFOOTBALL PRO - 1-Kattintasos Felhos Feltoltes (GitHub Pages + GitHub Actions)
echo ============================================================================
echo   QUANTFOOTBALL PRO // 0-24 Oras Ingyenes Felhos Weboldal Telepito
echo ============================================================================
echo.
echo Ez a varazslo feltolti a teljes rendszert a GitHub tarolodba, ahol:
echo   1. Minden reggel 08:00-kor automatikusan kiertekeli a tegnapi szelvenyeket,
echo      frissiti az 5 000 Ft-os bankrollt es elkesziti a napi TERVEZET (DRAFT)
echo      szelvenyeket (akkor is, ha a szamitogeped ki van kapcsolva!).
echo   2. A legkorabbi szelveny-meccs kezdete elott 1 oraval automatikusan
echo      lefuttatja a Melyelemzest (hianyzok, serulesek + piaci szorzomozgas),
echo      szukseg eseten lecsereli a gyengulo tippet, es VEGLEGESITI a szelvenyeket.
echo.
where git >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [FIGYELEM] A Git nincs telepitve ezen a gepen, vagy nincs a PATH-ban.
    echo Nyisd meg a FELHO_UTMUTATO.md fajlt a bongeszos / GitHub Desktopos 2 perces feltolteshez!
    pause
    exit /b 1
)

set /p REPO_URL="Illeszd be az uj (ures) GitHub tarolod URL-jet (pl. https://github.com/felhasznalonev/quantfootball.git): "
if "%REPO_URL%"=="" (
    echo Nem adtal meg URL-t. Kilepes...
    pause
    exit /b 1
)

cd /d "%~dp0"
if not exist ".git" (
    git init
    git branch -M main
)

git add .
git commit -m "QUANTFOOTBALL PRO - Teljes 2-lepcsos felhos automatika (08:00 Draft + 1o meccs elotti Veglegesites)"
git remote remove origin 2>nul
git remote add origin %REPO_URL%
git push -u origin main

echo.
echo ============================================================================
echo   SIKERES FELTOLTES!
echo   Most a GitHub oldaladon:
echo   1. Kattints a "Settings" -> "Pages" menure.
echo   2. A "Branch" alatt valaszd ki a "main" agat es a "/ (root)" mappat, majd "Save".
echo   3. 1 percen belul elerheto a sajat 0-24-es weboldalad!
echo ============================================================================
pause
