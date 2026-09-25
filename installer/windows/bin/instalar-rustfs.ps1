<#
  installer/windows/bin/instalar-rustfs.ps1 — Instala Docker + RustFS con un doble clic.

  Fases (ver README-INSTALADOR.md §8):
    0-chequeos → 1-wsl → 2-docker → 3-rustfs → 4-verificar → listo
  Estado persistente: %ProgramData%\POS Server\rustfs\install-state.txt
  Log:                %ProgramData%\POS Server\rustfs\install-rustfs.log
  Reanudación: ante reinicio requerido se registra en HKCU RunOnce y la PC se
  reinicia; al volver a entrar, el script continúa solo en la fase guardada.

  Códigos de salida (para soporte: "¿en qué paso se quedó?"):
    0 listo | 10 sin admin | 11 sin internet/espacio | 12 WSL falló |
    13 Docker falló | 14 daemon sin arrancar | 15 rustfs-init falló |
    20 reinicio programado (vuelve solo)

  Uso: instalar-rustfs.bat  (o)  instalar-rustfs.ps1 [-Silent]
  PowerShell 5.1 compatible. Requiere internet (descarga Docker ~600MB).
#>
[CmdletBinding()]
param(
  [switch]$Silent,           # sin pausa inicial (modo desatendido)
  [string]$AppDir = ''       # carpeta {app}; default = dos niveles arriba del script
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($AppDir)) {
  $AppDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
$DataRoot = Join-Path $env:ProgramData 'POS Server\rustfs'
$StateFile = Join-Path $DataRoot 'install-state.txt'
$LogFile = Join-Path $DataRoot 'install-rustfs.log'
$DockerUrl = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'
$DockerSetup = Join-Path $env:TEMP 'DockerDesktopInstaller.exe'
$RustFSDir = Join-Path $AppDir 'rustfs'

$PHASES = @('chequeos', 'wsl', 'docker', 'rustfs', 'verificar', 'listo')

function Write-Step($msg) {
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
  Write-Output $line
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding Ascii } catch {}
}

function Get-Phase() {
  if (Test-Path -LiteralPath $StateFile) {
    $p = (Get-Content -LiteralPath $StateFile -TotalCount 1).Trim()
    if ($PHASES -contains $p) { return $p }
  }
  return 'chequeos'
}

function Set-Phase($phase) {
  if (-not (Test-Path -LiteralPath $DataRoot)) {
    New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
  }
  Set-Content -LiteralPath $StateFile -Value $phase -Encoding Ascii
  Write-Step "— fase: $phase —"
}

function Register-Resume() {
  # Reanudar solo al entrar (RunOnce se auto-borra al ejecutarse).
  $cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
  Set-ItemProperty -LiteralPath $key -Name 'POSRustfsInstall' -Value $cmd
  Write-Step 'Reinicio programado: al volver a entrar continúa solo.'
}

function Test-Administrator() {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
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
      if ($code -eq 403) { return $true } # 403 sin firma = API viva
      Start-Sleep -Seconds 2
    }
  }
  return $false
}

# ── Arranque ──────────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $DataRoot)) {
  New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
}
Write-Step '=== Instalador de imágenes (RustFS) ==='

if (-not (Test-Administrator)) {
  Write-Step 'ERROR: se requieren permisos de administrador.'
  Write-Output 'Clic derecho → Ejecutar como administrador y reintenta.'
  exit 10
}

$phase = Get-Phase
Write-Step "Continuando en fase: $phase"

if ((-not $Silent) -and ($phase -eq 'chequeos')) {
  Write-Output ''
  Write-Output 'Este asistente instalará, en orden:'
  Write-Output '  1. WSL (subsistema Linux, puede pedir reinicio)'
  Write-Output '  2. Docker Desktop ~600MB (descarga de internet, puede pedir reinicio)'
  Write-Output '  3. RustFS (almacén de fotos) + configuración automática'
  Write-Output 'Si la PC se reinicia, el asistente CONTINÚA SOLO al volver a entrar.'
  Write-Output ''
  $resp = Read-Host 'Enter para empezar (o Ctrl+C para salir)'
}

# ── Fase 0: chequeos previos (sin cambios) ────────────────────────────────
if ($phase -eq 'chequeos') {
  Write-Step '[1/4] Chequeos previos...'
  try { Invoke-WebRequest -UseBasicParsing -Uri 'https://download.docker.com/' -Method Head -TimeoutSec 15 -ErrorAction Stop | Out-Null }
  catch { Write-Step 'ERROR: sin internet (no se pudo contactar download.docker.com).'; exit 11 }
  $drive = (Get-Item $env:SystemDrive).Name
  $freeGB = ((Get-PSDrive $drive.TrimEnd(':')).Free / 1GB)
  if ($freeGB -lt 2) { Write-Step ("ERROR: espacio libre insuficiente ({0:N1} GB, mínimo 2 GB)." -f $freeGB); exit 11 }
  Write-Step ("Internet OK, espacio OK ({0:N1} GB libres)." -f $freeGB)
  Set-Phase 'wsl'
  $phase = 'wsl'
}

# ── Fase 1: WSL ───────────────────────────────────────────────────────────
if ($phase -eq 'wsl') {
  Write-Step '[2/4] WSL...'
  $wslList = (& wsl --list --verbose 2>$null) -join "`n"
  if ($wslList -notmatch 'VERSION\s+2' -and $wslList -notmatch 'Ubuntu|Debian') {
    Write-Step 'Instalando WSL (wsl --install)...'
    & wsl --install
    Write-Step 'WSL instalado. Verificando si pide reinicio...'
    $wslList2 = (& wsl --list --verbose 2>$null) -join "`n"
    if ($wslList2 -notmatch 'VERSION\s+2') {
      Write-Step 'Se requiere reinicio para completar WSL.'
      Register-Resume
      shutdown /r /t 60 /c 'POS: reinicio para completar WSL. El instalador continúa solo.'
      Write-Output 'Reiniciando en 60s (shutdown /a para cancelar). Código 20.'
      exit 20
    }
  } else {
    Write-Step 'WSL ya presente. Actualizando (wsl --update)...'
    & wsl --update 2>$null
  }
  Set-Phase 'docker'
  $phase = 'docker'
}

# ── Fase 2: Docker Desktop (descarga bajo demanda) ─────────────────────────
if ($phase -eq 'docker') {
  Write-Step '[3/4] Docker Desktop...'
  $hasDocker = $false
  try { & docker --version 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $hasDocker = $true } } catch {}
  if (-not $hasDocker) {
    if (-not (Test-Path -LiteralPath $DockerSetup)) {
      Write-Step 'Descargando Docker Desktop (~600MB, puede tardar)...'
      try {
        $wc = New-Object System.Net.WebClient
        $wc.DownloadFile($DockerUrl, $DockerSetup)
      } catch { Write-Step ("ERROR descargando Docker: {0}" -f $_.Exception.Message); exit 13 }
    } else {
      Write-Step 'Instalador de Docker ya descargado, reutilizando.'
    }
    Write-Step 'Instalando Docker Desktop (silencioso, acepta licencia)...'
    $proc = Start-Process -FilePath $DockerSetup -ArgumentList 'install --quiet --accept-license --backend=wsl-2' -Wait -PassThru
    if ($proc.ExitCode -ne 0) { Write-Step ("ERROR: instalador Docker salió con código {0}." -f $proc.ExitCode); exit 13 }
    try { Remove-Item -LiteralPath $DockerSetup -Force -ErrorAction SilentlyContinue } catch {}
  } else {
    Write-Step 'Docker ya instalado.'
  }
  # Daemon arriba (Docker Desktop arranca con la sesión; lanzarlo si está apagado)
  Write-Step 'Verificando daemon Docker...'
  $up = $false
  for ($i = 0; $i -lt 60; $i++) {
    try { & docker version 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $up = $true; break } } catch {}
    if ($i -eq 0) {
      $dd = Join-Path ${env:ProgramFiles} 'Docker\Docker\Docker Desktop.exe'
      if (Test-Path -LiteralPath $dd) { Start-Process -FilePath $dd }
    }
    Start-Sleep -Seconds 5
  }
  if (-not $up) {
    Write-Step 'ERROR: el daemon Docker no arrancó (¿reinicio pendiente?). Reinicia e intenta de nuevo.'
    exit 14
  }
  Write-Step 'Docker listo.'
  Set-Phase 'rustfs'
  $phase = 'rustfs'
}

# ── Fase 3: RustFS (compose + bootstrap idempotente existente) ─────────────
if ($phase -eq 'rustfs') {
  Write-Step '[4/4] RustFS...'
  if (-not (Test-Path -LiteralPath (Join-Path $RustFSDir 'docker-compose.yml'))) {
    Write-Step ("ERROR: no existe {0} (reinstala POS Server)." -f (Join-Path $RustFSDir 'docker-compose.yml'))
    exit 15
  }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $AppDir 'bin\rustfs-init.ps1')
  if ($LASTEXITCODE -ne 0) { Write-Step 'ERROR: rustfs-init falló (ver mensajes arriba).'; exit 15 }
  Write-Step 'RustFS configurado.'
  Set-Phase 'verificar'
  $phase = 'verificar'
}

# ── Fase 4: verificación final ────────────────────────────────────────────
if ($phase -eq 'verificar') {
  Write-Step 'Verificación final...'
  $ok = Wait-S3Api 30
  if (-not $ok) { Write-Step 'ERROR: la API S3 :3900 no responde.'; exit 15 }
  $envOk = $false
  $serverEnv = Join-Path $AppDir '.env'
  if (Test-Path -LiteralPath $serverEnv) {
    $txt = Get-Content -LiteralPath $serverEnv -Raw
    if ($txt -match 'IMAGES_ENABLED=true' -and $txt -match 'S3_ACCESS_KEY_ID=\S+') { $envOk = $true }
  }
  if (-not $envOk) { Write-Step 'ERROR: el .env del server no tiene S3_* (¿falló rustfs-init?).'; exit 15 }
  Set-Phase 'listo'
  Write-Step ''
  Write-Step '=== IMÁGENES LISTAS ==='
  Write-Output 'RustFS corriendo (auto-arranque por Docker), bucket y key listos,'
  Write-Output 'server configurado. Reinicia el servidor para activar imágenes.'
  Write-Output ("Log completo: {0}" -f $LogFile)
  exit 0
}

Write-Step 'Estado final: listo.'
exit 0
