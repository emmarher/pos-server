<#
  installer/windows/bin/control-pos.ps1 - Arranque/parada/reinicio ordenado de POS.

  Orden correcto:
    start   : RustFS (:3900) -> POS Server (:PORT)
    stop    : POS Server -> RustFS
    restart : stop + start

  Uso: control-pos.bat start|stop|restart|status
  Requiere administrador para start/stop/restart (el POS corre elevado).
  PowerShell 5.1 compatible (sin ?? ni ternarios).
#>
[CmdletBinding()]
param(
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string]$Action = 'status',
  [string]$AppDir = ''
)

$ErrorActionPreference = 'Continue'

if ([string]::IsNullOrWhiteSpace($AppDir)) {
  $AppDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}

$BinDir      = Join-Path $AppDir 'bin'
$ServicePs1  = Join-Path $BinDir 'rustfs-service.ps1'
$StopPs1     = Join-Path $BinDir 'stop-server.ps1'
$StartVbs    = Join-Path $BinDir 'start-server.vbs'
$EnvFile     = Join-Path $AppDir '.env'

$Port = 3000
if (Test-Path -LiteralPath $EnvFile) {
  $m = Select-String -LiteralPath $EnvFile -Pattern '^PORT=(\d+)' | Select-Object -First 1
  if ($m -and $m.Matches[0].Groups[1].Value) { $Port = [int]$m.Matches[0].Groups[1].Value }
}

function Test-Port($p) {
  $listeners = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
  return ($listeners.Count -gt 0)
}

function Wait-Health($p, $seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$p/health" -TimeoutSec 2 -ErrorAction Stop
      if ($r.StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Seconds 1
  }
  return $false
}

function Start-Stack {
  $rustfsWasDown = -not (Test-Port 3900)

  if (Test-Path -LiteralPath $ServicePs1) {
    Write-Host 'Arrancando RustFS...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ServicePs1 -Action Start | Out-Host
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'AVISO: RustFS no arranco. El POS arrancara sin imagenes.'
      Write-Host '       Detalle en %ProgramData%\POS Server\logs (rustfs-install.log / rustfs.log).'
      Write-Host '       Tambien puedes ejecutar "Configurar imagenes (RustFS)" del menu Inicio.'
    }
  } else {
    Write-Host 'AVISO: falta rustfs-service.ps1; se omite RustFS.'
  }

  if (Test-Port $Port) {
    if ($rustfsWasDown) {
      Write-Host "El POS ya estaba escuchando en :$Port y RustFS estaba caido."
      Write-Host 'Ejecuta "control-pos.bat restart" para que el server tome RustFS.'
    } else {
      Write-Host "El POS ya esta escuchando en :$Port."
    }
    return $true
  }

  Write-Host 'Arrancando POS Server...'
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$StartVbs`"" | Out-Null

  if (Wait-Health $Port 60) {
    Write-Host "POS Server listo en http://127.0.0.1:$Port"
    return $true
  }
  Write-Host 'ERROR: el POS Server no respondio en 60 s. Revisa %ProgramData%\POS Server\logs.'
  return $false
}

function Stop-Stack {
  if (-not (Test-Path -LiteralPath $StopPs1)) {
    Write-Host 'ERROR: falta stop-server.ps1.'
    return $false
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $StopPs1 | Out-Host
  return ($LASTEXITCODE -eq 0)
}

function Show-Status {
  # OJO: sin administrador Get-ScheduledTask da "Access denied" y antes se
  # reportaba "missing", que hacia creer que la tarea no existia.
  $taskState = 'missing'
  try {
    $task = Get-ScheduledTask -TaskName 'POSRustFS' -ErrorAction Stop
    if ([string]$task.State -eq 'Running') { $taskState = 'running' } else { $taskState = 'stopped' }
  } catch {
    if ("$($_.Exception.Message)" -match 'denied|denegado|Acceso') {
      $taskState = 'sin permisos (admin)'
    }
  }

  $imagesFlag = 'false'
  if (Test-Path -LiteralPath $EnvFile) {
    $mImg = Select-String -LiteralPath $EnvFile -Pattern '^IMAGES_ENABLED=(.+)$' | Select-Object -First 1
    if ($mImg) { $imagesFlag = $mImg.Matches[0].Groups[1].Value.Trim() }
  }
  $exeOk = Test-Path -LiteralPath (Join-Path $AppDir 'rustfs\rustfs.exe')

  $rustfsUp = Test-Port 3900
  $posUp = Test-Port $Port

  Write-Output "Tarea POSRustFS : $taskState"
  Write-Output "RustFS :3900    : $(if ($rustfsUp) { 'LISTEN' } else { 'down' })"
  Write-Output "Imagenes (.env) : $imagesFlag"
  Write-Output "rustfs.exe      : $(if ($exeOk) { 'si' } else { 'NO (no se instalo)' })"
  Write-Output "POS Server :$Port : $(if ($posUp) { 'LISTEN' } else { 'down' })"
  if ($posUp) {
    if (Wait-Health $Port 3) { Write-Output 'GET /health    : 200' }
    else { Write-Output 'GET /health    : sin respuesta' }
  }
}

switch ($Action) {
  'start' {
    if (Start-Stack) { exit 0 } else { exit 1 }
  }
  'stop' {
    if (Stop-Stack) { exit 0 } else { exit 1 }
  }
  'restart' {
    Write-Output 'Deteniendo POS + RustFS...'
    if (-not (Stop-Stack)) { exit 1 }
    Start-Sleep -Seconds 2
    if (Start-Stack) { exit 0 } else { exit 1 }
  }
  'status' {
    Show-Status
    exit 0
  }
}
