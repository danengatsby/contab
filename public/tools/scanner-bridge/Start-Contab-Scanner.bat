@echo off
title Contab Scanner Bridge
echo.
echo  Pornesc puntea de scanare Contab (descarc automat ultima versiune)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $wc=New-Object Net.WebClient; $wc.Encoding=[Text.Encoding]::UTF8; $code=$wc.DownloadString('https://contabo.space/tools/scanner-bridge/Contab-Scanner-Bridge.ps1'); Invoke-Expression $code } catch { Write-Host ('  Eroare: ' + $_.Exception.Message) -ForegroundColor Red; Read-Host '  Apasa Enter pentru a inchide' }"
echo.
echo  Puntea s-a oprit.
pause >nul
