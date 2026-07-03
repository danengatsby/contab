# ============================================================
#  Contab Scanner Bridge  (Windows)  — pe 127.0.0.1:8765
#  Pod local intre scanerul tau si aplicatia Contab din browser.
#  Porneste-l prin "Start-Contab-Scanner.bat" si lasa fereastra deschisa.
#  Foloseste TcpListener (NU necesita drepturi de administrator).
# ============================================================
$ErrorActionPreference = 'Stop'
$port = 8765

function Find-NAPS2 {
  $cands = @(
    "$env:ProgramFiles\NAPS2\NAPS2.Console.exe",
    "${env:ProgramFiles(x86)}\NAPS2\NAPS2.Console.exe",
    "$env:LOCALAPPDATA\Programs\NAPS2\NAPS2.Console.exe"
  )
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command NAPS2.Console.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Invoke-Scan {
  $naps2 = Find-NAPS2
  if ($naps2) {
    $out = [IO.Path]::Combine($env:TEMP, "contab-scan-$(Get-Date -Format yyyyMMddHHmmss).pdf")
    # incearca mai multe variante de comanda (versiuni NAPS2 diferite), capturand mesajele
    $attempts = @(
      @('-o', $out, '--noprofile', '--driver', 'wia'),   # NAPS2 nou, fara profil
      @('-o', $out),                                       # foloseste profilul IMPLICIT (configurat in NAPS2)
      @('-o', $out, '--driver', 'twain', '--noprofile')   # unele scanere doar pe TWAIN
    )
    $log = ''
    foreach ($cmdargs in $attempts) {
      if (Test-Path $out) { Remove-Item $out -Force -ErrorAction SilentlyContinue }
      $o = & $naps2 @cmdargs 2>&1 | Out-String
      $log += "[$($cmdargs -join ' ')] => " + $o.Trim() + " | "
      if (Test-Path $out) { return @{ path = $out; type = 'application/pdf' } }
    }
    throw ("NAPS2 nu a scanat. Verifica un profil/scaner in NAPS2. Mesaje: " + $log.Trim())
  }
  $cd = New-Object -ComObject WIA.CommonDialog
  $image = $cd.ShowAcquireImage()
  if (-not $image) { throw "Scanare anulata." }
  $ip = New-Object -ComObject WIA.ImageProcess
  $ip.Filters.Add($ip.FilterInfos.Item("Convert").FilterID)
  $ip.Filters.Item(1).Properties.Item("FormatID").Value = "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}"
  $jpeg = $ip.Apply($image)
  $out = [IO.Path]::Combine($env:TEMP, "contab-scan-$(Get-Date -Format yyyyMMddHHmmss).jpg")
  if (Test-Path $out) { Remove-Item $out -Force }
  $jpeg.SaveFile($out)
  return @{ path = $out; type = 'image/jpeg' }
}

function Send-Response($stream, $statusLine, $contentType, [byte[]]$body) {
  $h = "HTTP/1.1 $statusLine`r`n"
  $h += "Access-Control-Allow-Origin: *`r`n"
  $h += "Access-Control-Allow-Headers: *`r`n"
  $h += "Access-Control-Allow-Methods: GET,OPTIONS`r`n"
  $h += "Access-Control-Allow-Private-Network: true`r`n"
  if ($contentType) { $h += "Content-Type: $contentType`r`n" }
  $len = 0; if ($body) { $len = $body.Length }
  $h += "Content-Length: $len`r`n"
  $h += "Connection: close`r`n`r`n"
  $hb = [Text.Encoding]::ASCII.GetBytes($h)
  $stream.Write($hb, 0, $hb.Length)
  if ($len -gt 0) { $stream.Write($body, 0, $len) }
  $stream.Flush()
}

try {
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
  $listener.Start()
} catch {
  Write-Host "  Nu pot porni pe portul $port (poate ruleaza deja). $($_.Exception.Message)" -ForegroundColor Red
  Read-Host "  Apasa Enter pentru a inchide"; exit 1
}
Write-Host ""
Write-Host "  ============================================" -ForegroundColor Green
Write-Host "   Contab Scanner Bridge ruleaza pe http://127.0.0.1:$port" -ForegroundColor Green
Write-Host "   Lasa aceasta fereastra DESCHISA cat scanezi din aplicatie." -ForegroundColor Green
Write-Host "   Test: deschide http://127.0.0.1:$port/ping in browser." -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $client.ReceiveTimeout = 8000
    $stream = $client.GetStream()
    $reader = New-Object IO.StreamReader($stream)
    $requestLine = $reader.ReadLine()
    while ($true) { $l = $reader.ReadLine(); if ($l -eq "" -or $null -eq $l) { break } }
    if (-not $requestLine) { $client.Close(); continue }
    $parts = $requestLine.Split(' ')
    $method = $parts[0]; $path = $parts[1]
    if ($method -eq "OPTIONS") { Send-Response $stream "204 No Content" $null $null; $client.Close(); continue }
    if ($path -eq "/ping") {
      $b = [Text.Encoding]::UTF8.GetBytes('{"ok":true,"app":"contab-scanner-bridge","v":3}')
      Send-Response $stream "200 OK" "application/json" $b; $client.Close(); continue
    }
    if ($path -eq "/scan") {
      Write-Host "  -> Cerere de scanare..." -ForegroundColor Cyan
      try {
        $r = Invoke-Scan
        $data = [IO.File]::ReadAllBytes($r.path)
        Remove-Item $r.path -Force -ErrorAction SilentlyContinue
        Send-Response $stream "200 OK" $r.type $data
        Write-Host "  <- Trimis ($($data.Length) octeti)." -ForegroundColor Cyan
      } catch {
        Write-Host "  ! $($_.Exception.Message)" -ForegroundColor Yellow
        $m = [Text.Encoding]::UTF8.GetBytes($_.Exception.Message)
        Send-Response $stream "500 Internal Server Error" "text/plain; charset=utf-8" $m
      }
      $client.Close(); continue
    }
    Send-Response $stream "404 Not Found" "text/plain" ([Text.Encoding]::ASCII.GetBytes("not found"))
    $client.Close()
  } catch {
    try { $client.Close() } catch {}
  }
}
