<#
  installer/windows/bin/rustfs-init.ps1 — Bootstrap idempotente de RustFS en sucursal.

  Qué hace (seguro re-ejecutar, drop-in de garage-init):
    1. Si existe rustfs/docker-compose.yml → levanta contenedor (docker compose up -d) y espera :3900.
       Si no, asume binario nativo rustfs.exe --service (prod) ya instalado; solo verifica :3900.
    2. Genera o reutiliza credenciales S3 (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY) — 32 hex.
    3. Escribe/refresca S3_* + IMAGES_ENABLED=true en el .env del server.
       S3_REGION mantiene 'garage' por compat (RustFS acepta cualquier).
       El bucket 'pos-images' lo crea el server al arrancar (ensureImagesBucket).

  Uso: rustfs-init.bat (o) powershell -NoProfile -ExecutionPolicy Bypass -File rustfs-init.ps1
  No requiere Docker si el binario nativo está presente. No toca Program Files fuera de {app}.

  NOTA PowerShell 5.1: sintaxis compatible (sin ?? ni ternarios).
#>
[CmdletBinding()]
param(
  [string]$AppDir = (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
)

$ErrorActionPreference = 'Stop'

$RustfsDir = Join-Path $AppDir 'rustfs'
$ServerEnv = Join-Path $AppDir '.env'
$Bucket = 'pos-images'

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

function Gen-HexSecret($NodeExe) {
  $tmp = Join-Path $env:TEMP "rustfs-secret.txt"
  & cmd.exe /c "`"$NodeExe`" -e `"console.log(require('crypto').randomBytes(16).toString('hex'))`" > `"$tmp`"" | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tmp)) { throw "No se pudo generar secreto con $NodeExe" }
  $val = (Get-Content -LiteralPath $tmp -TotalCount 1).Trim()
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  if ($val.Length -ne 32) { throw "Secreto inválido: $val" }
  return $val
}

# 0) Resolver node portable para generar secretos
$NodeExe = Join-Path $AppDir 'node\node.exe'
if (-not (Test-Path -LiteralPath $NodeExe)) { $NodeExe = 'node' }

# 1) RustFS arriba (Docker) o verificación de binario
$composeFile = Join-Path $RustfsDir 'docker-compose.yml'
$hasCompose = Test-Path -LiteralPath $composeFile
$hasBinary = Test-Path -LiteralPath (Join-Path $RustfsDir 'rustfs.exe')

if ($hasCompose) {
  try { & docker --version 2>$null | Out-Null } catch { Write-Output '[rustfs-init] Docker no disponible, omitiendo compose up (prod binario).'; $hasCompose = $false }
  if ($hasCompose -and $LASTEXITCODE -eq 0) {
    Write-Output '[rustfs-init] levantando contenedor RustFS...'
    & docker compose -f $composeFile up -d | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning '[rustfs-init] docker compose up -d falló (continuando, el binario o ensureImagesBucket lo creará)' }
  }
}

# Espera API :3900 (best-effort, no aborta si aún no está — ensureImagesBucket reintenta)
$ready = $false
for ($i = 0; $i -lt 15; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3900/' -TimeoutSec 3 -ErrorAction Stop
    $ready = $true; break
  } catch {
    $code = -1
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 403 -or $code -eq 404 -or $code -eq 400) { $ready = $true; break }
    Start-Sleep -Seconds 2
  }
}
if ($ready) { Write-Output '[rustfs-init] API S3 :3900 lista.' } else { Write-Output '[rustfs-init] API :3900 aún no responde (el server la creará al arrancar).' }

# 2) Credenciales: reutilizar si existen en .env, si no generar
if (-not (Test-Path -LiteralPath $ServerEnv)) { throw "No existe $ServerEnv (instala el server primero)" }
$existing = Get-Content -LiteralPath $ServerEnv -Raw
$keyId = $null; $secret = $null
if ($existing -match 'S3_ACCESS_KEY_ID=(\S+)') { $keyId = $Matches[1].Trim() }
if ($existing -match 'S3_SECRET_ACCESS_KEY=(\S+)') { $secret = $Matches[1].Trim() }
# Filtrar placeholders vacíos
if ([string]::IsNullOrWhiteSpace($keyId) -or $keyId -eq '""' -or $keyId.Length -lt 8) { $keyId = $null }
if ([string]::IsNullOrWhiteSpace($secret) -or $secret -eq '""' -or $secret.Length -lt 8) { $secret = $null }

if (-not $keyId) { $keyId = Gen-HexSecret $NodeExe; Write-Output "[rustfs-init] key generada: $keyId" } else { Write-Output "[rustfs-init] key reutilizada: $keyId" }
if (-not $secret) { $secret = Gen-HexSecret $NodeExe; Write-Output '[rustfs-init] secret generado.' } else { Write-Output '[rustfs-init] secret reutilizado.' }

# 3) .env del server (idempotente)
Set-DotEnvVar $ServerEnv 'S3_ENDPOINT' 'http://127.0.0.1:3900'
Set-DotEnvVar $ServerEnv 'S3_REGION' 'garage'
Set-DotEnvVar $ServerEnv 'S3_ACCESS_KEY_ID' $keyId
Set-DotEnvVar $ServerEnv 'S3_SECRET_ACCESS_KEY' $secret
Set-DotEnvVar $ServerEnv 'S3_BUCKET' $Bucket
Set-DotEnvVar $ServerEnv 'S3_PUBLIC_URL' 'http://127.0.0.1:3902'
Set-DotEnvVar $ServerEnv 'S3_MAX_FILE_SIZE_MB' '5'
Set-DotEnvVar $ServerEnv 'IMAGES_ENABLED' 'true'

# Sincronizar credenciales para RustFS (Docker .env o servicio Windows env)
if ($hasCompose) {
  # Escribir env para compose (RUSTFS_* mapeados en docker-compose.yml)
  $rustfsEnv = Join-Path $RustfsDir '.env'
  Set-DotEnvVar $rustfsEnv 'S3_ACCESS_KEY_ID' $keyId
  Set-DotEnvVar $rustfsEnv 'S3_SECRET_ACCESS_KEY' $secret
}
if ($hasBinary) {
  Write-Output '[rustfs-init] binario nativo detectado — credenciales en .env del server serán usadas por el servicio.'
}

Write-Output '[rustfs-init] listo. Reinicia el servidor para activar imágenes (bucket se crea solo).'
