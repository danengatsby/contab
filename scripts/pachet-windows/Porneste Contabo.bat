@echo off
setlocal
title Contabo - contabilitate locala
cd /d "%~dp0"

rem ─────────────────────────────────────────────────────────────────────────
rem  Pornire locala, fara nicio instalare: Node vine in pachet (node.exe).
rem
rem  Se cheama DIRECT `node server.js`; garda de deploy din proces recunoaste
rem  marcajul pozitiv al distributiei. `npm start` ar rula in plus verificarea
rem  sintactica rapida, utila in depozit, dar inutila pentru arhiva deja probata.
rem
rem  Verificarile de mai jos exista fiindca prima varianta dadea un mesaj GRESIT:
rem  cand `node.exe` lipsea, spunea "verifica drepturile de scriere" si trimitea
rem  omul sa caute in alta parte. Fiecare cauza isi are acum propriul mesaj — un
rem  diagnostic care arata gresit e mai rau decat niciunul.
rem ─────────────────────────────────────────────────────────────────────────

rem ── 1. Exista node.exe? ──────────────────────────────────────────────────
if not exist "%~dp0node.exe" (
  echo.
  echo   NU GASESC node.exe in folderul acesta:
  echo   %~dp0
  echo.
  echo   Cauza cea mai probabila: arhiva nu s-a dezarhivat complet. node.exe are
  echo   83 MB si e exact fisierul pe care antivirusul sau OneDrive il pot lasa
  echo   pe dinafara.
  echo.
  echo   Ce sa faci:
  echo     1. Dezarhiveaza din nou Contabo-Windows.zip, pana la capat.
  echo     2. NU in OneDrive - pune folderul in C:\Contabo sau pe Desktop.
  echo        OneDrive poate tine fisierele mari doar "in cloud", iar Windows
  echo        nu poate porni un program care nu e chiar pe disc.
  echo     3. Daca antivirusul l-a sters, adauga folderul la exceptii.
  echo.
  pause
  exit /b 1
)

rem ── 2. Chiar porneste? (blocat de Windows sau de antivirus) ──────────────
"%~dp0node.exe" -v >nul 2>&1
if errorlevel 1 (
  echo.
  echo   node.exe exista, dar Windows nu il lasa sa porneasca.
  echo   De obicei inseamna ca fisierul e marcat "descarcat de pe internet".
  echo.
  echo   Deblocare - deschide PowerShell in acest folder si ruleaza:
  echo     Get-ChildItem -Recurse ^| Unblock-File
  echo.
  echo   Daca nici asa: muta folderul in afara OneDrive (ex. C:\Contabo^)
  echo   si adauga-l la exceptiile antivirusului.
  echo.
  pause
  exit /b 1
)

rem ── 3. Avertisment OneDrive (merge, dar cu surprize) ─────────────────────
echo %~dp0 | find /i "OneDrive" >nul
if not errorlevel 1 (
  echo.
  echo   ATENTIE: rulezi din OneDrive. Merge, dar OneDrive poate incerca sa
  echo   sincronizeze baza de date chiar in timp ce lucrezi si sa o blocheze.
  echo   Recomandat: muta folderul Contabo in C:\Contabo sau pe Desktop.
  echo.
)

rem ── 4. Prima pornire: cheile de securitate ───────────────────────────────
if not exist "date\.env" (
  echo Prima pornire: generez cheile de securitate...
  "%~dp0node.exe" "%~dp0genereaza-config.js"
  if errorlevel 1 (
    echo.
    echo   Nu am putut scrie fisierul de configurare in:
    echo   %~dp0date
    echo.
    echo   Muta folderul Contabo undeva unde ai drept de scriere
    echo   (Desktop sau C:\Contabo^) si incearca din nou.
    echo.
    pause
    exit /b 1
  )
)

rem `.env` se citeste din radacina aplicatiei, deci il legam acolo la fiecare pornire.
copy /y "date\.env" "app\.env" >nul

echo.
echo   Contabo porneste... lasa fereastra asta DESCHISA cat lucrezi.
echo   Se deschide singur in browser, la adresa http://localhost:8123
echo.
echo   Ca sa opresti aplicatia: inchide fereastra asta.
echo.

rem Browserul se deschide dupa 3 secunde, cat sa apuce serverul sa asculte.
start "" /b cmd /c "timeout /t 3 >nul & start http://localhost:8123"

cd app
"%~dp0node.exe" server.js

echo.
echo   Contabo s-a oprit.
pause
