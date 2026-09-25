<#
  installer/windows/bin/garage-init.ps1 — Bootstrap idempotente de Garage en sucursal.

  Qué hace (seguro re-ejecutar):
    1. Levanta el contenedor (docker compose up -d) y espera la API :3900.
    2. Layout single-node: si versión = 0, asigna el nodo (zona dc1, 10G) y aplica v1.
    3. Bucket `pos-images`: lo crea si no está listado.
    4. Key `pos-server`: la reutiliza (key info --show-secret) o la crea + permite
       lectura/escritura en el bucket.
    5. Escribe/refresca S3_* + IMAGES_ENABLED=true en el .env del server.

  Uso: garage-init.bat (o) powershell -NoProfile -ExecutionPolicy Bypass -File garage-init.ps1
  Requiere: Docker Desktop corriendo. No toca Program Files fuera de {app}.

  NOTA PowerShell 5.1: sintaxis compatible (sin ?? ni ternarios).
#>
[CmdletBinding()]
param(
  [string]$AppDir = (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
)

$ErrorActionPreference = 'Stop'

$GarageDir = Join-Path $AppDir 'garage'
$ServerEnv = Join-Path $AppDir '.env'
$Bucket = 'pos-images'
$KeyName = 'pos-server'

function Invoke-Garage($Arguments) {
  # stdout del CLI (los logs INFO van a stderr y se descartan aquí)
  $out = & docker exec garage_s3 /garage $Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { throw "garage $Arguments falló (exit $LASTEXITCODE)" }
  return $out
}

function Set-DotEnvVar($Path, $Name, $Value) {
  $lines = @()
  if (Test-Path -LiteralPath $Path) { $lines = @(Get-Content -LiteralPath $Path) }
  $found = $false
  $updated = foreach ($line in $lines) {
    if ($line -match "^$Name=") { $found = $true; "$Name=$Value" } else { $line }
  }
  if (-not $found) { $updated += "$Name=$Value" }
  Set-Content -LiteralPath $Path -Value $updated -Encoding Ascii
}

# 0) Docker disponible
try { & docker --version 2>$null | Out-Null } catch { throw 'Docker no está disponible. Instala Docker Desktop y reintenta.' }
if ($LASTEXITCODE -ne 0) { throw 'Docker no está disponible. Instala Docker Desktop y reintenta.' }

# 1) Contenedor arriba + API lista
Write-Output '[garage-init] levantando contenedor...'
& docker compose -f (Join-Path $GarageDir 'docker-compose.yml') up -d | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'docker compose up -d falló' }
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3900/' -TimeoutSec 3 -ErrorAction Stop
    # Cualquier respuesta (incluso 403 sin firma) = API viva
    $ready = $true
    break
  } catch {
    $code = -1
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 403) { $ready = $true; break }
    Start-Sleep -Seconds 2
  }
}
if (-not $ready) { throw 'La API S3 :3900 no respondió tras 60s' }
Write-Output '[garage-init] API S3 lista.'

# 2) Layout single-node (solo si versión = 0)
$layout = (Invoke-Garage @('layout', 'show')) -join "`n"
$ver = 0
if ($layout -match 'Current cluster layout version:\s*(\d+)') { $ver = [int]$Matches[1] }
if ($ver -eq 0) {
  $status = (Invoke-Garage @('status')) -join "`n"
  $nodeId = $null
  foreach ($line in ($status -split "`n")) {
    if ($line -match '^\s*([0-9a-f]{16,})\s') { $nodeId = $Matches[1]; break }
  }
  if (-not $nodeId) { throw 'No se encontró el ID de nodo en `garage status`' }
  Write-Output "[garage-init] asignando nodo $nodeId (dc1, 10G)..."
  Invoke-Garage @('layout', 'assign', '-z', 'dc1', '-c', '10G', $nodeId) | Out-Null
  Invoke-Garage @('layout', 'apply', '--version', '1') | Out-Null
  Write-Output '[garage-init] layout v1 aplicado.'
} else {
  Write-Output "[garage-init] layout v$ver ya aplicado, se omite."
}

# 3) Bucket (idempotente)
$buckets = (Invoke-Garage @('bucket', 'list')) -join "`n"
if ($buckets -notmatch [regex]::Escape($Bucket)) {
  Write-Output "[garage-init] creando bucket $Bucket..."
  Invoke-Garage @('bucket', 'create', $Bucket) | Out-Null
} else {
  Write-Output "[garage-init] bucket $Bucket ya existe."
}

# 4) Key (reutiliza si existe; si no, crea + permite RW)
$keyId = $null
$secret = $null
try {
  $info = (Invoke-Garage @('key', 'info', $KeyName, '--show-secret')) -join "`n"
  if ($info -match 'Key ID:\s*(\S+)') { $keyId = $Matches[1] }
  if ($info -match 'Secret key:\s*(\S+)') { $secret = $Matches[1] }
} catch {
  $keyId = $null
}
if (-not $keyId -or -not $secret) {
  Write-Output "[garage-init] creando key $KeyName..."
  $created = (Invoke-Garage @('key', 'create', $KeyName)) -join "`n"
  if ($created -match 'Key ID:\s*(\S+)') { $keyId = $Matches[1] }
  if ($created -match 'Secret key:\s*(\S+)') { $secret = $Matches[1] }
  if (-not $keyId -or -not $secret) { throw 'No se pudo leer Key ID/Secret de `key create`' }
  Invoke-Garage @('bucket', 'allow', '--read', '--write', $Bucket, '--key', $KeyName) | Out-Null
} else {
  Write-Output "[garage-init] key $KeyName reutilizada."
  # Re-aplicar permisos por si el bucket se recreó
  Invoke-Garage @('bucket', 'allow', '--read', '--write', $Bucket, '--key', $KeyName) | Out-Null
}

# 5) .env del server
if (-not (Test-Path -LiteralPath $ServerEnv)) { throw "No existe $ServerEnv (instala el server primero)" }
Set-DotEnvVar $ServerEnv 'S3_ENDPOINT' 'http://127.0.0.1:3900'
Set-DotEnvVar $ServerEnv 'S3_REGION' 'garage'
Set-DotEnvVar $ServerEnv 'S3_ACCESS_KEY_ID' $keyId
Set-DotEnvVar $ServerEnv 'S3_SECRET_ACCESS_KEY' $secret
Set-DotEnvVar $ServerEnv 'S3_BUCKET' $Bucket
Set-DotEnvVar $ServerEnv 'S3_PUBLIC_URL' 'http://127.0.0.1:3902'
Set-DotEnvVar $ServerEnv 'S3_MAX_FILE_SIZE_MB' '5'
Set-DotEnvVar $ServerEnv 'IMAGES_ENABLED' 'true'

Write-Output '[garage-init] listo. Reinicia el servidor para activar imágenes.'
