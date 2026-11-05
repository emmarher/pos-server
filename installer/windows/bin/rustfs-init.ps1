<#
  installer/windows/bin/rustfs-init.ps1 - Bootstrap idempotente de RustFS.

  Produccion (binario nativo rustfs.exe presente):
    1. Si la tarea POSRustFS no existe, la instala (rustfs-service.ps1 -Install).
       Si existe, la arranca (-Start).
    2. Espera http://127.0.0.1:3900 y falla con codigo != 0 si no responde.
    3. rustfs-service escribe S3_* + IMAGES_ENABLED=true en el .env del server.

  Desarrollo (sin binario, con docker-compose.yml):
    1. Genera/reutiliza credenciales S3 y las escribe en el .env del server
       y en rustfs/.env.
    2. Levanta el contenedor con docker compose y espera :3900.

  Uso: rustfs-init.bat (admin) o powershell -File rustfs-init.ps1
  PowerShell 5.1 compatible (sin ?? ni ternarios).
#>
[CmdletBinding()]
param(
  [string]$AppDir = ''
)

$ErrorActionPreference = 'Stop'

# OJO: $PSCommandPath esta vacio al evaluarse en un valor por defecto de
# param() en PowerShell 5.1 -> "Cannot bind argument to parameter 'Path'".
# Por eso se calcula aqui, en el cuerpo.
if ([string]::IsNullOrWhiteSpace($AppDir)) {
  $AppDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}

$RustfsDir     = Join-Path $AppDir 'rustfs'
$RustfsExe     = Join-Path $RustfsDir 'rustfs.exe'
$ServerEnv     = Join-Path $AppDir '.env'
$ServiceScript = Join-Path (Join-Path $AppDir 'bin') 'rustfs-service.ps1'
$Bucket        = 'pos-images'
$Port          = 3900

function Set-DotEnvVar($Path, $Name, $Value) {
  $lines = @()
  if (Test-Path -LiteralPath $Path) { $lines = @(Get-Content -LiteralPath $Path) }
  $found = $false
  $updated = @(foreach ($line in $lines) {
    if ($line -match "^$Name=") { $found = $true; "$Name=$Value" } else { $line }
  })
  if (-not $found) { $updated += "$Name=$Value" }
  Set-Content -LiteralPath $Path -Value $updated -Encoding Ascii
}

function Get-EnvValue($Name) {
  if (-not (Test-Path -LiteralPath $ServerEnv)) { return '' }
  $m = Select-String -LiteralPath $ServerEnv -Pattern "^$Name=(.+)$" | Select-Object -First 1
  if (-not $m) { return '' }
  return $m.Matches[0].Groups[1].Value.Trim().Trim('"')
}

function New-HexSecret($bytes) {
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  $buf = New-Object byte[] $bytes
  $rng.GetBytes($buf)
  $rng.Dispose()
  return ([BitConverter]::ToString($buf)).Replace('-', '').ToLower()
}

function Wait-S3Api($seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -TimeoutSec 2 -ErrorAction Stop | Out-Null
      return $true
    } catch {
      if ($_.Exception.Response) {
        $code = [int]$_.Exception.Response.StatusCode
        if ($code -eq 400 -or $code -eq 403 -or $code -eq 404) { return $true }
      }
      Start-Sleep -Seconds 1
    }
  }
  return $false
}

if (-not (Test-Path -LiteralPath $ServerEnv)) {
  throw "No existe $ServerEnv (instala el server primero)."
}

# -- Produccion: binario nativo + tarea POSRustFS ---------------------------
if (Test-Path -LiteralPath $RustfsExe) {
  if (-not (Test-Path -LiteralPath $ServiceScript)) {
    throw "No existe $ServiceScript (reinstala POS Server)."
  }

  $task = Get-ScheduledTask -TaskName 'POSRustFS' -ErrorAction SilentlyContinue
  $taskExists = ($null -ne $task)

  if ($taskExists) {
    Write-Output '[rustfs-init] binario nativo detectado: arrancando tarea POSRustFS.'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ServiceScript -Action Start 2>&1
  } else {
    Write-Output '[rustfs-init] binario nativo detectado y tarea ausente: instalando POSRustFS.'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ServiceScript -Action Install 2>&1
  }
  if ($LASTEXITCODE -ne 0) {
    throw "rustfs-service fallo (codigo $LASTEXITCODE). Revisa $env:ProgramData\POS Server\logs\rustfs.log"
  }

  if (-not (Wait-S3Api 60)) {
    throw "La API S3 http://127.0.0.1:$Port no responde. Revisa $env:ProgramData\POS Server\logs\rustfs.log"
  }
  Write-Output '[rustfs-init] API S3 :3900 lista. Reinicia el POS Server si ya estaba corriendo.'
  exit 0
}

# -- Desarrollo: Docker compose ---------------------------------------------
$composeFile = Join-Path $RustfsDir 'docker-compose.yml'
if (-not (Test-Path -LiteralPath $composeFile)) {
  throw "No hay rustfs.exe ni docker-compose.yml en $RustfsDir. Reinstala POS Server."
}

$keyId = Get-EnvValue 'S3_ACCESS_KEY_ID'
$secret = Get-EnvValue 'S3_SECRET_ACCESS_KEY'
if ($keyId -eq '' -or $keyId.Length -lt 8) { $keyId = New-HexSecret 16; Write-Output '[rustfs-init] access key generada.' }
else { Write-Output '[rustfs-init] access key reutilizada.' }
if ($secret -eq '' -or $secret.Length -lt 8) { $secret = New-HexSecret 16; Write-Output '[rustfs-init] secret key generado.' }
else { Write-Output '[rustfs-init] secret key reutilizado.' }

Set-DotEnvVar $ServerEnv 'S3_ENDPOINT' "http://127.0.0.1:$Port"
Set-DotEnvVar $ServerEnv 'S3_REGION' 'garage'
Set-DotEnvVar $ServerEnv 'S3_ACCESS_KEY_ID' $keyId
Set-DotEnvVar $ServerEnv 'S3_SECRET_ACCESS_KEY' $secret
Set-DotEnvVar $ServerEnv 'S3_BUCKET' $Bucket
Set-DotEnvVar $ServerEnv 'S3_PUBLIC_URL' 'http://127.0.0.1:3902'
Set-DotEnvVar $ServerEnv 'S3_MAX_FILE_SIZE_MB' '5'
Set-DotEnvVar $ServerEnv 'IMAGES_ENABLED' 'true'

$rustfsEnv = Join-Path $RustfsDir '.env'
Set-DotEnvVar $rustfsEnv 'S3_ACCESS_KEY_ID' $keyId
Set-DotEnvVar $rustfsEnv 'S3_SECRET_ACCESS_KEY' $secret

Write-Output '[rustfs-init] levantando contenedor RustFS...'
& docker compose -f $composeFile up -d 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "docker compose up -d fallo (codigo $LASTEXITCODE). Verifica Docker Desktop."
}

if (-not (Wait-S3Api 60)) {
  throw "La API S3 http://127.0.0.1:$Port no responde. Revisa docker compose logs rustfs."
}
Write-Output '[rustfs-init] API S3 :3900 lista. Reinicia el POS Server si ya estaba corriendo.'
exit 0
