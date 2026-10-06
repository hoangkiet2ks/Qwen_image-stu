Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSCommandPath
$comfyRoot = $env:COMFYUI_PORTABLE_ROOT
if (-not $comfyRoot) { throw 'Set COMFYUI_PORTABLE_ROOT to your ComfyUI portable directory.' }
$comfyReadyUrl = 'http://127.0.0.1:8188/system_stats'
$frontendRoot = Join-Path $projectRoot 'client'
$frontendReadyUrl = 'http://127.0.0.1:5174/'
$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $tailscale -and $env:TAILSCALE_EXE) {
  $tailscaleExe = $env:TAILSCALE_EXE
}
elseif ($tailscale) {
  $tailscaleExe = $tailscale.Source
}
else {
  throw 'Tailscale is not installed. Install it, sign in, then run this file again.'
}

$status = & $tailscaleExe status --json | ConvertFrom-Json
if ($status.BackendState -ne 'Running' -or -not $status.Self.DNSName) {
  throw 'Tailscale is not signed in or ready. Open Tailscale, sign in, then run this file again.'
}

$comfyListener = Get-NetTCPConnection -State Listen -LocalPort 8188 -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $comfyListener) {
  if (-not (Test-Path -LiteralPath (Join-Path $comfyRoot 'run_nvidia_gpu.bat'))) {
    throw "ComfyUI launcher was not found at $comfyRoot."
  }
  Write-Host 'Starting ComfyUI AI engine...' -ForegroundColor Cyan
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'run_nvidia_gpu.bat' -WorkingDirectory $comfyRoot -WindowStyle Hidden

  $ready = $false
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    Start-Sleep -Seconds 3
    try {
      Invoke-WebRequest -Uri $comfyReadyUrl -UseBasicParsing -TimeoutSec 2 | Out-Null
      $ready = $true
      break
    } catch {}
  }
  if (-not $ready) {
    throw 'ComfyUI did not become ready within 3 minutes. Check its startup log or GPU memory.'
  }
  Write-Host 'ComfyUI AI engine is ready.' -ForegroundColor Green
}
else {
  Write-Host 'ComfyUI AI engine is already running.' -ForegroundColor Green
}

$listener = Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $running = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
  if ($running.CommandLine -notmatch 'server\.js') {
    throw "Cong 3000 dang duoc tien trinh khac su dung: $($running.Name). Khong tu dong dung tien trinh nay."
  }
  Stop-Process -Id $listener.OwningProcess -Force
  Start-Sleep -Milliseconds 600
}

$previousBindHost = $env:BIND_HOST
$env:BIND_HOST = '127.0.0.1'
Start-Process -FilePath 'node.exe' -ArgumentList 'server.js' -WorkingDirectory $projectRoot -WindowStyle Hidden
$env:BIND_HOST = $previousBindHost
Start-Sleep -Seconds 2
Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/models' -UseBasicParsing -TimeoutSec 8 | Out-Null

# Always run the web frontend locally. It proxies /api to the local backend,
# allowing one Tailscale HTTPS URL to work for browser clients and the APK.
$frontendListener = Get-NetTCPConnection -State Listen -LocalPort 5174 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($frontendListener) {
  $frontendProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($frontendListener.OwningProcess)"
  if ([string]$frontendProcess.CommandLine -notmatch '(?i)vite') {
    throw "Cong 5174 dang duoc tien trinh khac su dung: $($frontendProcess.Name). Khong tu dong dung tien trinh nay."
  }
  Stop-Process -Id $frontendListener.OwningProcess -Force
  Start-Sleep -Milliseconds 600
}

if (-not (Test-Path -LiteralPath (Join-Path $frontendRoot 'package.json'))) {
  throw "Khong tim thay frontend tai $frontendRoot."
}

Write-Host 'Starting web frontend...' -ForegroundColor Cyan
$env:__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = $status.Self.DNSName.TrimEnd('.')
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm.cmd run dev -- --host 127.0.0.1 --port 5174' -WorkingDirectory $frontendRoot -WindowStyle Hidden

$frontendReady = $false
for ($attempt = 1; $attempt -le 20; $attempt++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-WebRequest -Uri $frontendReadyUrl -UseBasicParsing -TimeoutSec 2 | Out-Null
    $frontendReady = $true
    break
  } catch {}
}
if (-not $frontendReady) {
  throw 'Frontend did not become ready. Check Node.js and client dependencies.'
}

# Serve the frontend, not port 3000 directly. Vite forwards /api/* to the
# private backend, so every Tailscale device uses one stable HTTPS endpoint.
& $tailscaleExe serve --bg http://127.0.0.1:5174

$url = "https://$($status.Self.DNSName.TrimEnd('.'))"
Write-Host ''
Write-Host 'May AI va giao dien da san sang.' -ForegroundColor Green
Write-Host "Mot URL dung chung cho moi may: $url" -ForegroundColor Cyan
Write-Host 'Mo URL nay tren browser, hoac nhap chinh URL nay vao APK.' -ForegroundColor Yellow
