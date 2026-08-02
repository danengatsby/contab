@echo off
setlocal
title Contabo - contabilitate locala
cd /d "%~dp0"

rem ─────────────────────────────────────────────────────────────────────────
rem  Pornire locala, fara nicio instalare: Node vine in pachet (node.exe).
rem
rem  Se cheama DIRECT `node server.js`, nu `npm start`: `npm start` declanseaza
rem  `prestart`, adica intreaga suita de teste (peste 4.600 de verificari) la
rem  fiecare pornire. Corect pe server, absurd pe calculatorul tau.
rem ─────────────────────────────────────────────────────────────────────────

if not exist "date" mkdir "date"

rem Secretele se GENEREAZA la prima pornire, pe calculatorul tau — nu vin in
rem pachet. Altfel oricine ar avea aceeasi arhiva ar avea si cheile tale.
if not exist "date\.env" (
  echo Prima pornire: generez cheile de securitate...
  "%~dp0node.exe" -e "const c=require('crypto'),f=require('fs');f.writeFileSync('date/.env','CONTAB_DB_DRIVER=sqlite\nCONTAB_DATA_DIR='+process.cwd().replace(/\\/g,'/')+'/date\nCONTAB_DB_FILE='+process.cwd().replace(/\\/g,'/')+'/date/db.json\nPORT=8123\nHOST=127.0.0.1\nCONTAB_AUTH_SECRET='+c.randomBytes(32).toString('hex')+'\nCONTAB_SECRETS_KEY='+c.randomBytes(32).toString('hex')+'\n');"
  if errorlevel 1 goto :eroare
)

rem `.env` se citeste din radacina aplicatiei, deci il legam acolo la fiecare pornire.
copy /y "date\.env" "app\.env" >nul

echo.
echo   Contabo porneste... lasa fereastra asta DESCHISA cat lucrezi.
echo   Se deschide singur in browser, la adresa http://localhost:8123
echo.
echo   Ca sa oprești aplicatia: inchide fereastra asta.
echo.

rem Browserul se deschide dupa 3 secunde, cat sa apuce serverul sa asculte.
start "" /b cmd /c "timeout /t 3 >nul & start http://localhost:8123"

cd app
"%~dp0node.exe" server.js
goto :sfarsit

:eroare
echo.
echo   Nu am putut genera fisierul de configurare. Verifica daca ai drept de
echo   scriere in folderul acesta (muta Contabo in Documente, de exemplu).
pause

:sfarsit
echo.
echo   Contabo s-a oprit.
pause
