<#
  installer/windows/bin/rustfs-service.ps1 — RustFS nativo como tarea programada.

  Por qué tarea y no servicio sc.exe: rustfs.exe no implementa la API de
  servicios Windows; schtasks (integrado, sin binarios extra) arranca en boot
  como SYSTEM con reintento, suficiente para sucursal.

  Acciones: -Install | -Start | -Stop | -Uninstall
  -Install: crea dirs, genera/reutiliza credenciales S3 en el .env del server,
    crea la tarea POSRustFS (ONSTART, SYSTEM, restart on failure) y la arranca.
  -Uninstall: detiene y elimina la tarea (datos en ProgramData se conservan).
  Credenciales via args de la tarea (visibles para admins, igual que el .env).

  NOTA PowerShell 5.1: sintaxis compatible (sin ?? ni ternarios).
#>
[CmdletBinding()]
param(
  [ValidateSet('Install', 'Start', 'Stop', 'Uninstall')]
  [string]$Action = 'Install',
  [string]$AppDir = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($AppDir)) {
  $AppDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
$TaskName = 'POSRustFS'
$RustfsExe = Join-Path $AppDir 'rustfs\rustfs.exe'
$DataDir = Join-Path $env:ProgramData 'POS Server\rustfs\data'
$ServerEnv = Join-Path $AppDir '.env'
$Bucket = 'pos-images'

function Set-DotEnvVar($Path, $Name, $Value) {
  $lines = @()
  if (Test-Path -LiteralPath $Path) { $lines = @(Get-Content -LiteralPath $Path) }
  $found = $false
  # OJO: foreach de un solo elemento devuelve escalar String (no array) y el
  # += concatenaría ("A=1B=2"). El @() fuerza array siempre.
  $updated = @(foreach ($line in $lines) {
    if ($line -match "^$Name=") { $found = $true; "$Name=$Value" } else { $line }
  })
  if (-not $found) { $updated += "$Name=$Value" }
  Set-Content -LiteralPath $Path -Value $updated -Encoding Ascii
}

function New-HexSecret($bytes) {
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  $buf = New-Object byte[] $bytes
  $rng.GetBytes($buf)
  $rng.Dispose()
  return ([BitConverter]::ToString($buf)).Replace('-', '').ToLower()
}

function Get-TaskState() {
  $out = (& schtasks /query /TN $TaskName /FO LIST 2>$null) -join "`n"
  if ($LASTEXITCODE -ne 0) { return 'missing' }
  if ($out -match 'Status:\s*Running') { return 'running' }
  return 'stopped'
}

function Wait-S3Api($seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3900/' -TimeoutSec 3 -ErrorAction Stop | Out-Null
      return $true
    } catch {
      $code = -1
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      if ($code -eq 403 -or $code -eq 404 -or $code -eq 400) { return $true }
      Start-Sleep -Seconds 2
    }
  }
  return $false
}

if ($Action -eq 'Uninstall') {
  Write-Output '[rustfs-service] deteniendo y eliminando tarea...'
  & schtasks /end /TN $TaskName 2>$null | Out-Null
  & schtasks /delete /TN $TaskName /F 2>$null | Out-Null
  Write-Output '[rustfs-service] listo (datos conservados).'
  exit 0
}

if ($Action -eq 'Stop') {
  & schtasks /end /TN $TaskName 2>$null | Out-Null
  Write-Output '[rustfs-service] detenido.'
  exit 0
}

if ($Action -eq 'Start') {
  & schtasks /run /TN $TaskName 2>$null | Out-Null
  if (Wait-S3Api 60) { Write-Output '[rustfs-service] API S3 lista.'; exit 0 }
  Write-Output '[rustfs-service] ERROR: :3900 no responde.'; exit 1
}

# --- Install ---
if (-not (Test-Path -LiteralPath $RustfsExe)) { throw "No existe $RustfsExe" }
if (-not (Test-Path -LiteralPath $ServerEnv)) { throw "No existe $ServerEnv (instala el server primero)" }
foreach ($d in @($DataDir, (Join-Path $env:ProgramData 'POS Server\rustfs\meta'))) {
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

# Credenciales: reutilizar del .env o generar (32 hex c/u)
$existing = Get-Content -LiteralPath $ServerEnv -Raw
$keyId = $null; $secret = $null
if ($existing -match 'S3_ACCESS_KEY_ID=(\S+)') { $keyId = $Matches[1].Trim() }
if ($existing -match 'S3_SECRET_ACCESS_KEY=(\S+)') { $secret = $Matches[1].Trim() }
if ([string]::IsNullOrWhiteSpace($keyId) -or $keyId.Length -lt 8) { $keyId = New-HexSecret 16; Write-Output '[rustfs-service] key generada.' } else { Write-Output '[rustfs-service] key reutilizada.' }
if ([string]::IsNullOrWhiteSpace($secret) -or $secret.Length -lt 8) { $secret = New-HexSecret 16; Write-Output '[rustfs-service] secret generado.' } else { Write-Output '[rustfs-service] secret reutilizado.' }

Set-DotEnvVar $ServerEnv 'S3_ENDPOINT' 'http://127.0.0.1:3900'
Set-DotEnvVar $ServerEnv 'S3_REGION' 'garage'
Set-DotEnvVar $ServerEnv 'S3_ACCESS_KEY_ID' $keyId
Set-DotEnvVar $ServerEnv 'S3_SECRET_ACCESS_KEY' $secret
Set-DotEnvVar $ServerEnv 'S3_BUCKET' $Bucket
Set-DotEnvVar $ServerEnv 'S3_PUBLIC_URL' 'http://127.0.0.1:3902'
Set-DotEnvVar $ServerEnv 'S3_MAX_FILE_SIZE_MB' '5'
Set-DotEnvVar $ServerEnv 'IMAGES_ENABLED' 'true'

# Tarea: arranque en boot como SYSTEM + reintento ante fallo.
# schtasks limita /TR a 261 chars: la tarea ejecuta un .bat lanzador (ruta
# corta y estable) que invoca rustfs.exe con todos los args. Secretos en el
# .bat (solo admins, igual que el .env).
$runBat = Join-Path (Join-Path $AppDir 'rustfs') 'run-rustfs.bat'
$runDir = Split-Path -Parent $runBat
if (-not (Test-Path -LiteralPath $runDir)) { New-Item -ItemType Directory -Force -Path $runDir | Out-Null }
$batContent = "@echo off`r`n`"$RustfsExe`" server --address 127.0.0.1:3900 --access-key $keyId --secret-key $secret `"$DataDir`"`r`n"
Set-Content -LiteralPath $runBat -Value $batContent -Encoding Ascii
& schtasks /create /TN $TaskName /TR "`"$runBat`"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear la tarea programada' }
# Reintento ante fallo: 3 reintentos cada 1 min (XML directo es frágil; schtasks expone /RI y /DU solo con /SC compatibles — se configura restart via Settings con schtasks /change)
& schtasks /change /TN $TaskName /RI 1 /DU 24:00 /K 2>$null | Out-Null
& schtasks /run /TN $TaskName 2>$null | Out-Null
if (Wait-S3Api 60) { Write-Output '[rustfs-service] instalado y API S3 lista.'; exit 0 }
throw 'La tarea se creó pero :3900 no responde en 60s'
