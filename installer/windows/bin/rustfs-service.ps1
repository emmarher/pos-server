<#
  installer/windows/bin/rustfs-service.ps1 - RustFS nativo como tarea programada.

  Por que tarea y no servicio sc.exe: rustfs.exe no implementa la API de
  servicios Windows y no hay binario envoltorio (NSSM/WinSW) en el paquete.
  Una tarea programada arranca en boot como SYSTEM, sin dependencias extra.

  Acciones: Install | Start | Stop | Restart | Status | Uninstall
    Install   : crea dirs, reutiliza/genera credenciales S3, escribe .env,
                crea el lanzador con reintento y la tarea POSRustFS, y arranca.
    Start     : arranca la tarea POSRustFS y espera :3900. Si la tarea falta
                (desinstalacion o upgrade fallido) la reinstala sola.
    Stop      : detiene la tarea y mata cualquier rustfs/cmd huerfano.
    Restart   : Stop + Start.
    Status    : reporta tarea, puerto y proceso.
    Uninstall : detiene y elimina la tarea (datos en ProgramData se conservan).

  Credenciales: archivos access.key/secret.key en ProgramData con ACL solo
  SYSTEM/Administradores. El .env del server recibe las mismas variables S3_*.

  PowerShell 5.1 compatible (sin ?? ni ternarios). Ejecutar como administrador.
#>
[CmdletBinding()]
param(
  [ValidateSet('Install', 'Start', 'Stop', 'Restart', 'Status', 'Uninstall')]
  [string]$Action = 'Install',
  [string]$AppDir = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($AppDir)) {
  $AppDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}

$TaskName  = 'POSRustFS'
$RustfsDir = Join-Path $AppDir 'rustfs'
$RustfsExe = Join-Path $RustfsDir 'rustfs.exe'
# OJO: RustFS 1.0.0 parte la ruta del volumen por espacios y aborta con
# "distinct physical disks". Por eso los datos NO pueden vivir en
# "...\POS Server\rustfs": se usa una raiz sin espacios.
$DataRoot  = Join-Path $env:ProgramData 'POSRustFS'
$DataDir   = Join-Path $DataRoot 'data'
$KeyFile   = Join-Path $DataRoot 'access.key'
$SecretFile = Join-Path $DataRoot 'secret.key'
$RunBat    = Join-Path $RustfsDir 'run-rustfs.bat'
$LogDir    = Join-Path $env:ProgramData 'POS Server\logs'
$LogFile   = Join-Path $LogDir 'rustfs.log'
$ServerEnv = Join-Path $AppDir '.env'
$Bucket    = 'pos-images'
$Port      = 3900

function Set-DotEnvVar($Path, $Name, $Value) {
  $lines = @()
  if (Test-Path -LiteralPath $Path) { $lines = @(Get-Content -LiteralPath $Path) }
  $found = $false
  # OJO: foreach de un solo elemento devuelve escalar String (no array) y el
  # += concatenaria ("A=1B=2"). El @() fuerza array siempre.
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

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-Task {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  return ($null -ne $task)
}

function Get-TaskState {
  try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if (-not $task) { return 'missing' }
    if ([string]$task.State -eq 'Running') { return 'running' }
    return 'stopped'
  } catch {
    # Sin admin la consulta da "Access denied": no confundirlo con ausente.
    if ("$($_.Exception.Message)" -match 'denied|denegado|Acceso') { return 'sin permisos (admin)' }
    return 'missing'
  }
}

function Test-Port {
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  return ($listeners.Count -gt 0)
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

# Ultimas lineas de rustfs.log: sin esto el error solo decia "no respondio" y
# la causa real (p. ej. ruta con espacios) quedaba invisible.
function Get-LogTail($lineCount) {
  if (-not (Test-Path -LiteralPath $LogFile)) { return '' }
  try {
    return (@(Get-Content -LiteralPath $LogFile -Tail $lineCount -ErrorAction Stop) -join "`n")
  } catch {
    return ''
  }
}

# Migracion unica desde la ruta vieja (con espacios). En una instalacion nueva
# no existe y no hace nada.
function Move-LegacyData {
  $legacyRoot = Join-Path $env:ProgramData 'POS Server\rustfs'
  if (-not (Test-Path -LiteralPath $legacyRoot)) { return }
  foreach ($name in @('data', 'access.key', 'secret.key')) {
    $src = Join-Path $legacyRoot $name
    $dst = Join-Path $DataRoot $name
    if (-not (Test-Path -LiteralPath $src)) { continue }
    if (Test-Path -LiteralPath $dst) { continue }
    try {
      if (-not (Test-Path -LiteralPath $DataRoot)) {
        New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
      }
      Move-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop
      Write-Output "[rustfs-service] migrado: $src -> $dst"
    } catch {
      Write-Output ("[rustfs-service] AVISO: no se pudo migrar {0}: {1}" -f $src, $_.Exception.Message)
    }
  }
}

function Stop-Rustfs {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300

  $pids = New-Object System.Collections.Generic.List[int]

  # 1) cmd del lanzador: si sobrevive, relanzaria rustfs en 5 s.
  try {
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine -like '*run-rustfs.bat*' } |
      ForEach-Object { $pids.Add([int]$_.ProcessId) }
  } catch {}

  # 2) rustfs de esta instalacion. ExecutablePath puede venir vacio si corre
  #    elevado; en ese caso se acepta el nombre (solo POS usa rustfs.exe).
  try {
    Get-CimInstance Win32_Process -Filter "Name='rustfs.exe'" -ErrorAction Stop |
      Where-Object { -not $_.ExecutablePath -or $_.ExecutablePath -eq $RustfsExe } |
      ForEach-Object { $pids.Add([int]$_.ProcessId) }
  } catch {}

  # 3) dueno del puerto 3900, solo si es rustfs (no matar Docker/WSL).
  try {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
      ForEach-Object {
        $owner = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
        if ($owner -and $owner.ProcessName -eq 'rustfs') { $pids.Add([int]$_.OwningProcess) }
      }
  } catch {}

  foreach ($procId in ($pids | Sort-Object -Unique)) {
    if ($procId -and $procId -ne $PID) {
      try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch {}
    }
  }

  for ($i = 0; $i -lt 10; $i++) {
    if (-not (Test-Port)) { return }
    Start-Sleep -Seconds 1
  }
}

function Start-Rustfs {
  # Si ya esta escuchando (p. ej. arranco en boot), no hace falta tocar la tarea.
  if (Test-Port) { return }
  if (-not (Test-Task)) {
    # Auto-reparacion: la tarea pudo perderse (desinstalacion, limpieza o un
    # upgrade fallido). Reinstalarla es barato y evita mandar al usuario a
    # ejecutar rustfs-init a mano. Install-Rustfs reutiliza claves y .env.
    if (-not (Test-Path -LiteralPath $RustfsExe)) {
      throw "La tarea $TaskName no existe y falta $RustfsExe. Reinstala POS Server."
    }
    if (-not (Test-Admin)) {
      throw "La tarea $TaskName no existe. Ejecuta como administrador (UAC) para repararla."
    }
    Write-Output '[rustfs-service] tarea ausente: reinstalando (auto-reparacion).'
    Install-Rustfs
    return
  }
  try {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  } catch {
    # Si ya estaba arrancando/en ejecucion, igual esperamos el puerto.
  }
  if (Wait-S3Api 60) { return }
  $tail = Get-LogTail 15
  $msg = "RustFS no respondio en http://127.0.0.1:$Port (revisa $LogFile)."
  if ($tail) { $msg += "`n--- ultimas lineas de rustfs.log ---`n$tail" }
  throw $msg
}

function Install-Rustfs {
  if (-not (Test-Path -LiteralPath $RustfsExe)) { throw "No existe $RustfsExe" }
  if (-not (Test-Path -LiteralPath $ServerEnv)) { throw "No existe $ServerEnv (instala el server primero)" }

  Move-LegacyData

  foreach ($d in @($DataRoot, $DataDir, $LogDir)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  }

  # Reutilizar credenciales del .env, de los archivos o generar 32 hex.
  $keyId = Get-EnvValue 'S3_ACCESS_KEY_ID'
  $secret = Get-EnvValue 'S3_SECRET_ACCESS_KEY'
  if (($keyId -eq '' -or $keyId.Length -lt 8) -and (Test-Path -LiteralPath $KeyFile)) {
    $keyId = ([System.IO.File]::ReadAllText($KeyFile)).Trim()
  }
  if (($secret -eq '' -or $secret.Length -lt 8) -and (Test-Path -LiteralPath $SecretFile)) {
    $secret = ([System.IO.File]::ReadAllText($SecretFile)).Trim()
  }
  if ($keyId -eq '' -or $keyId.Length -lt 8) { $keyId = New-HexSecret 16; Write-Output '[rustfs-service] access key generada.' }
  else { Write-Output '[rustfs-service] access key reutilizada.' }
  if ($secret -eq '' -or $secret.Length -lt 8) { $secret = New-HexSecret 16; Write-Output '[rustfs-service] secret key generado.' }
  else { Write-Output '[rustfs-service] secret key reutilizado.' }

  # Archivos de credenciales (sin salto de linea) y ACL solo SYSTEM/Admins.
  [System.IO.File]::WriteAllText($KeyFile, $keyId, [System.Text.Encoding]::ASCII)
  [System.IO.File]::WriteAllText($SecretFile, $secret, [System.Text.Encoding]::ASCII)
  & icacls.exe $KeyFile /inheritance:r /grant:r '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' 2>&1 | Out-Null
  & icacls.exe $SecretFile /inheritance:r /grant:r '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' 2>&1 | Out-Null

  # Variables que lee pos-server al arrancar (env.ts exige las cuatro).
  Set-DotEnvVar $ServerEnv 'S3_ENDPOINT' "http://127.0.0.1:$Port"
  Set-DotEnvVar $ServerEnv 'S3_REGION' 'garage'
  Set-DotEnvVar $ServerEnv 'S3_ACCESS_KEY_ID' $keyId
  Set-DotEnvVar $ServerEnv 'S3_SECRET_ACCESS_KEY' $secret
  Set-DotEnvVar $ServerEnv 'S3_BUCKET' $Bucket
  Set-DotEnvVar $ServerEnv 'S3_PUBLIC_URL' 'http://127.0.0.1:3902'
  Set-DotEnvVar $ServerEnv 'S3_MAX_FILE_SIZE_MB' '5'
  Set-DotEnvVar $ServerEnv 'IMAGES_ENABLED' 'true'
  Write-Output '[rustfs-service] variables S3_* escritas en el .env del server.'

  # Lanzador con reintento: si rustfs.exe cae, el bucle lo relanza en 5 s.
  # Las credenciales van en archivos, no en la linea de comandos.
  $batLines = @(
    '@echo off',
    'setlocal',
    ':loop',
    ('"{0}" server --address 127.0.0.1:{1} --access-key-file "{2}" --secret-key-file "{3}" "{4}" >> "{5}" 2>&1' -f $RustfsExe, $Port, $KeyFile, $SecretFile, $DataDir, $LogFile),
    'ping -n 6 127.0.0.1 >nul',
    'goto loop'
  )
  [System.IO.File]::WriteAllText($RunBat, (($batLines -join "`r`n") + "`r`n"), [System.Text.Encoding]::ASCII)

  # Recrear la tarea siempre: corrige instalaciones donde nunca se creo.
  Stop-Rustfs
  if (Test-Port) {
    $ownerName = 'otro proceso'
    try {
      $conn = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)[0]
      $owner = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
      if ($owner) { $ownerName = $owner.ProcessName }
    } catch {}
    throw "El puerto $Port sigue ocupado por $ownerName. Deten ese servicio (por ejemplo Docker) y reintenta."
  }
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $RunBat + '"')
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
  } catch {
    throw "No se pudo crear la tarea POSRustFS: $($_.Exception.Message)"
  }
  Write-Output "[rustfs-service] tarea $TaskName creada (ONSTART, SYSTEM, sin limite de tiempo)."

  try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { }
  if (Wait-S3Api 60) {
    Write-Output '[rustfs-service] instalado y API S3 lista.'
    return
  }
  $tail = Get-LogTail 15
  $msg = "La tarea se creo pero http://127.0.0.1:$Port no responde. Revisa $LogFile."
  if ($tail) { $msg += "`n--- ultimas lineas de rustfs.log ---`n$tail" }
  throw $msg
}

function Show-Status {
  $taskState = Get-TaskState
  $portState = 'down'
  if (Test-Port) { $portState = 'LISTEN' }

  $imagesFlag = 'false'
  if (Test-Path -LiteralPath $ServerEnv) {
    $mImg = Select-String -LiteralPath $ServerEnv -Pattern '^IMAGES_ENABLED=(.+)$' | Select-Object -First 1
    if ($mImg) { $imagesFlag = $mImg.Matches[0].Groups[1].Value.Trim() }
  }

  Write-Output "[rustfs-service] tarea ${TaskName}: $taskState"
  Write-Output "[rustfs-service] API 127.0.0.1:${Port}: $portState"
  Write-Output "[rustfs-service] IMAGES_ENABLED: $imagesFlag"
  Write-Output "[rustfs-service] rustfs.exe: $(if (Test-Path -LiteralPath $RustfsExe) { 'si' } else { 'NO' })"
  if (Test-Path -LiteralPath $LogFile) {
    Write-Output "[rustfs-service] log: $LogFile"
  }
}

# Crear/detener la tarea SYSTEM exige elevacion. Mejor un mensaje claro que
# una traza de "Access is denied" a mitad de la operacion. Excepcion: en el
# arranque de sesion (no elevado) Start solo comprueba el puerto; si ya esta
# listo no hay nada que hacer y no debe registrar un error en cada login.
if ($Action -ne 'Status' -and -not (Test-Admin)) {
  if ($Action -eq 'Start' -and (Test-Port)) {
    Write-Output '[rustfs-service] API S3 ya esta escuchando.'
    exit 0
  }
  Write-Output '[rustfs-service] ERROR: se requieren permisos de administrador.'
  exit 1
}

switch ($Action) {
  'Uninstall' {
    Write-Output '[rustfs-service] deteniendo y eliminando tarea...'
    Stop-Rustfs
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output '[rustfs-service] listo (datos conservados).'
    exit 0
  }
  'Stop' {
    Stop-Rustfs
    Write-Output '[rustfs-service] detenido.'
    exit 0
  }
  'Start' {
    try {
      Start-Rustfs
      Write-Output '[rustfs-service] API S3 lista.'
      exit 0
    } catch {
      Write-Output ("[rustfs-service] ERROR: {0}" -f $_.Exception.Message)
      exit 1
    }
  }
  'Restart' {
    try {
      Write-Output '[rustfs-service] reiniciando...'
      Stop-Rustfs
      Start-Rustfs
      Write-Output '[rustfs-service] API S3 lista.'
      exit 0
    } catch {
      Write-Output ("[rustfs-service] ERROR: {0}" -f $_.Exception.Message)
      exit 1
    }
  }
  'Status' {
    Show-Status
    exit 0
  }
  'Install' {
    # Log propio: Inno ejecuta esto con "runhidden" y no ve el codigo de
    # salida; sin este archivo un fallo de instalacion era invisible.
    $installLog = Join-Path $LogDir 'rustfs-install.log'
    if (-not (Test-Path -LiteralPath $LogDir)) {
      New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    }
    $transcript = $false
    try {
      Start-Transcript -LiteralPath $installLog -Force | Out-Null
      $transcript = $true
    } catch { }

    $code = 0
    try {
      Install-Rustfs
    } catch {
      $code = 1
      Write-Output ("[rustfs-service] ERROR: {0}" -f $_.Exception.Message)
    } finally {
      if ($transcript) { try { Stop-Transcript | Out-Null } catch { } }
    }

    if ($code -ne 0) {
      Write-Output "[rustfs-service] detalle en: $installLog"
    }
    exit $code
  }
}
