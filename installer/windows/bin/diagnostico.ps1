<#
  installer/windows/bin/diagnostico.ps1 — Diagnóstico del servidor POS.

  Revisa en orden y reporta OK/FAIL por chequeo (código de salida = nº de fallos):
    1. node.exe + dist\server.js existen
    2. .env existe (+ puerto efectivo)
    3. proceso node del server corriendo (por línea de comando, no cualquier node)
    4. puerto TCP en LISTEN
    5. GET /health (código + cuerpo)
    6. UDP 5000 enlazado (discovery)
    7. cola del log del server (últimas 25 líneas)

  Uso: diagnostico.bat (o este .ps1 directo). Solo lectura: no cambia nada.
  PowerShell 5.1 compatible.
#>
[CmdletBinding()]
param([string]$AppDir = '')

$ErrorActionPreference = 'Continue'
$failures = 0

if ([string]::IsNullOrWhiteSpace($AppDir)) {
  $AppDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
$NodeExe = Join-Path $AppDir 'node\node.exe'
$ServerJs = Join-Path $AppDir 'dist\server.js'
$EnvFile = Join-Path $AppDir '.env'
$LogDir = Join-Path $env:ProgramData 'POS Server\logs'

function Test-Ok($name, $cond, $hint) {
  if ($cond) { Write-Output "[OK]   $name" }
  else { Write-Output "[FAIL] $name -- $hint"; $script:failures++ }
}

Write-Output '=== Diagnóstico POS Server ==='
Write-Output "App: $AppDir"
Write-Output ''

# 1) Archivos
Test-Ok 'node.exe presente' (Test-Path -LiteralPath $NodeExe) 'reinstala (stage/node faltante)'
Test-Ok 'dist\server.js presente' (Test-Path -LiteralPath $ServerJs) 'reinstala (dist faltante)'
Test-Ok '.env presente' (Test-Path -LiteralPath $EnvFile) 'reinstala (WriteEnvFile no corrió)'

# Puerto efectivo del .env (default 3000)
$Port = '3000'
if (Test-Path -LiteralPath $EnvFile) {
  $m = Select-String -LiteralPath $EnvFile -Pattern '^PORT=(\d+)' | Select-Object -First 1
  if ($m -and $m.Matches[0].Groups[1].Value) { $Port = $m.Matches[0].Groups[1].Value }
}
Write-Output "Puerto API: $Port"
Write-Output ''

# 2) Proceso del server (por línea de comando exacta, no cualquier node.exe)
$procs = @()
try {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -like '*dist\server.js*' -or $_.CommandLine -like '*dist/server.js*' })
} catch {}
Test-Ok 'proceso node del server corriendo' ($procs.Count -gt 0) 'arráncalo: menú inicio → Iniciar POS Server (fondo)'
if ($procs.Count -gt 0) { Write-Output ("       PID(s): " + (($procs | ForEach-Object { $_.ProcessId }) -join ', ')) }

# 3) Puerto en escucha
$listening = $false
try {
  $conn = Get-NetTCPConnection -LocalPort ([int]$Port) -State Listen -ErrorAction Stop
  if ($conn) { $listening = $true }
} catch {
  $ns = (netstat -ano 2>$null) -join "`n"
  if ($ns -match (':{0}\s.*LISTENING' -f $Port)) { $listening = $true }
}
Test-Ok "puerto $Port en LISTEN" $listening 'el proceso no levantó el puerto: revisa la cola del log abajo'

# 4) HTTP /health (código + cuerpo real, no solo el número)
$code = -1
$body = ''
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 8 -ErrorAction Stop
  $code = [int]$r.StatusCode
  $body = [string]$r.Content
} catch {
  if ($_.Exception.Response) {
    $code = [int]$_.Exception.Response.StatusCode
    try {
      $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
      $body = $sr.ReadToEnd()
    } catch {}
  }
}
Test-Ok "GET /health responde 200 (código: $code)" ($code -eq 200) 'server caído o puerto equivocado; cola del log abajo'
if ($body) { Write-Output ("       cuerpo: " + $body.Substring(0, [Math]::Min(300, $body.Length))) }

# 5) UDP discovery enlazado
$udp = $false
try {
  $u = Get-NetUDPEndpoint -LocalPort 5000 -ErrorAction Stop
  if ($u) { $udp = $true }
} catch {}
Test-Ok 'UDP 5000 enlazado (discovery)' $udp 'el server no abrió discovery (¿arrancó incompleto? ver log)'
Write-Output ''

# 6) Cola del log (últimas 25 líneas del más reciente)
$logs = @()
if (Test-Path -LiteralPath $LogDir) {
  $logs = @(Get-ChildItem -LiteralPath $LogDir -Filter 'server-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}
if ($logs.Count -gt 0) {
  Write-Output ("--- cola del log (" + $logs[0].Name + ") ---")
  Get-Content -LiteralPath $logs[0].FullName -Tail 25
} else {
  Write-Output '--- sin archivos de log (el server nunca escribió: no arrancó o versión vieja sin logs) ---'
  $script:failures++
}
Write-Output ''
Write-Output "Fallos: $failures (0 = sano)"
exit $failures
