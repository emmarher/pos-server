<#
  installer/windows/bin/stop-server.ps1 — Detiene el POS Server de forma fiable.

  Por que existe: el server corre OCULTO (lanzado por start-server.vbs), asi que
  matar por titulo de ventana no sirve; y `wmic` esta obsoleto/eliminado en Windows
  recientes y su ExecutablePath sale vacio para procesos elevados. Aqui se ubica el
  proceso por datos que SI son fiables:
    - el PID dueno del puerto TCP del API (leido del .env),
    - el PID dueno del UDP 5000 (discovery),
    - node.exe cuya ruta/linea de comando apunta a esta instalacion.

  Requiere ejecutarse como Administrador (el server corre elevado).

  Uso: stop-server.bat  (o este .ps1 directo). PowerShell 5.1 compatible.
#>
[CmdletBinding()]
param([string]$AppDir = '')

$ErrorActionPreference = 'Continue'

if ([string]::IsNullOrWhiteSpace($AppDir)) {
  $AppDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
$envFile = Join-Path $AppDir '.env'
$nodeExe = Join-Path $AppDir 'node\node.exe'

# Puerto efectivo del API (default 3000)
$port = 3000
if (Test-Path -LiteralPath $envFile) {
  $m = Select-String -LiteralPath $envFile -Pattern '^PORT=(\d+)' | Select-Object -First 1
  if ($m -and $m.Matches[0].Groups[1].Value) { $port = [int]$m.Matches[0].Groups[1].Value }
}

$pids = New-Object System.Collections.Generic.List[int]

# 1) Dueno del puerto TCP del API
try {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
    ForEach-Object { $pids.Add([int]$_.OwningProcess) }
} catch {}

# 2) Dueno del UDP 5000 (discovery)
try {
  Get-NetUDPEndpoint -LocalPort 5000 -ErrorAction Stop |
    ForEach-Object { $pids.Add([int]$_.OwningProcess) }
} catch {}

# 3) node.exe del server (por ruta del portable o linea de comando server.js)
try {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
    Where-Object {
      $_.ExecutablePath -eq $nodeExe -or
      $_.CommandLine -like '*dist\server.js*' -or
      $_.CommandLine -like '*dist/server.js*'
    } |
    ForEach-Object { $pids.Add([int]$_.ProcessId) }
} catch {}

$targets = @($pids | Sort-Object -Unique | Where-Object { $_ -and $_ -ne $PID })

if ($targets.Count -eq 0) {
  Write-Output "No se encontro el proceso del POS Server (puerto $port)."
  exit 0
}

$killed = 0
foreach ($targetPid in $targets) {
  try {
    Stop-Process -Id $targetPid -Force -ErrorAction Stop
    Write-Output "Detenido PID $targetPid"
    $killed++
  } catch {
    Write-Output "No se pudo detener PID $targetPid : $($_.Exception.Message)"
    Write-Output "  (ejecuta como Administrador: el server corre elevado)"
  }
}

if ($killed -gt 0) {
  Write-Output "POS Server detenido ($killed proceso(s))."
} else {
  Write-Output "No se detuvo ningun proceso. Reintenta como Administrador."
}
exit 0
