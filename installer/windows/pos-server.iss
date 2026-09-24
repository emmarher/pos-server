; installer/windows/pos-server.iss — Wizard Inno Setup 6 para POS Server.
;
; Compilar con Inno Setup 6 (iscc.exe) DESPUES de preparar el stage:
;   1. cd pos-server && npm run build          -> dist/
;   2. armar installer/stage/ con: dist/, migrations/*.sqlite.sql,
;      package.json, package-lock.json y (si imágenes) garage/ con:
;      docker-compose.yml + garage.toml.template (de installer/windows/garage/)
;   3. en stage: npm ci --omit=dev + npm rebuild better-sqlite3
;   4. descargar Node portable EXACTO y descomprimir a installer/stage/node/
;      Version fijada: v22.12.0 win-x64  (node-v22.12.0-win-x64.zip)
;      Compatible con "engines" de package.json (^20.19.0 || >=22.12.0).
;   5. iscc installer/windows/pos-server.iss  -> installer/output/Setup_POS-Server-<ver>.exe
;
; Destino programa:  C:\Program Files\POS Server   (requiere admin)
; Datos (writable):  %ProgramData%\POS Server\{data,backups}
; .env con secretos queda en {app}\.env (solo lectura en runtime).
;
; Mantener AppVersion sincronizada con pos-server/package.json "version".

#define AppName "POS Server"
#define AppVersion "0.1.0"
#define AppPublisher "POS"
#define DataDir "{commonappdata}\\POS Server\\data"

[Setup]
AppId={{B2E8C4A1-5F3D-4A7B-9C1E-POSSERVER01}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\POS Server
DefaultGroupName=POS Server
PrivilegesRequired=admin
Compression=lzma2/max
SolidCompression=yes
OutputDir=..\output
OutputBaseFilename=Setup_POS-Server-{#AppVersion}
ArchitecturesAllowed=x64compatible
MinVersion=10.0

[Files]
; Programa compilado + migraciones + manifests (stage preparado a mano, ver cabecera)
Source: "..\stage\dist\*"; DestDir: "{app}\dist"; Flags: ignoreversion recursesubdirs
Source: "..\stage\migrations\*.sqlite.sql"; DestDir: "{app}\migrations"; Flags: ignoreversion
Source: "..\stage\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\stage\node\node.exe"; DestDir: "{app}\node"; Flags: ignoreversion
; node_modules de prod (instaladas en stage con npm ci --omit=dev + rebuild nativos)
Source: "..\stage\node_modules\*"; DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs
; Scripts operativos (+ init de imágenes si el wizard lo activa)
Source: "bin\*.bat"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "bin\*.vbs"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "bin\*.ps1"; DestDir: "{app}\bin"; Flags: ignoreversion
; Garage (solo si el wizard activa imágenes; release copia
; installer/windows/garage/* a stage/garage/ antes de compilar)
Source: "..\stage\garage\docker-compose.yml"; DestDir: "{app}\garage"; Flags: ignoreversion; Check: UseImages
Source: "..\stage\garage\garage.toml.template"; DestDir: "{app}\garage"; Flags: ignoreversion; Check: UseImages

[Dirs]
Name: "{#DataDir}"; Permissions: users-modify
Name: "{commonappdata}\POS Server\backups"; Permissions: users-modify

[Icons]
Name: "{group}\Iniciar POS Server"; Filename: "{app}\bin\start-server.bat"
Name: "{group}\Iniciar POS Server (fondo)"; Filename: "{app}\bin\start-server.vbs"
Name: "{group}\Detener POS Server"; Filename: "{app}\bin\stop-server.bat"
Name: "{group}\Salud del servidor"; Filename: "{app}\bin\healthcheck.bat"
Name: "{group}\Respaldo base de datos"; Filename: "{app}\bin\backup.bat"
Name: "{group}\Configurar imágenes (Garage)"; Filename: "{app}\bin\garage-init.bat"; Check: UseImages
Name: "{group}\Desinstalar POS Server"; Filename: "{uninstallexe}"
; Auto-arranque v1: acceso en Startup del usuario (sin ventana via .vbs)
Name: "{userstartup}\POS Server"; Filename: "{app}\bin\start-server.vbs"

[Run]
; Migrar + seed demo (crea tenant DEMO + admin; licencia demo nace vencida por
; SEED_DEMO_LICENSE_DAYS=0 -> la instalacion fresca arranca en bootstrap).
; Si falla, el operador ve el error de assertSchemaReady en el log del server.
Filename: "{app}\node\node.exe"; Parameters: "{app}\dist\database\migrate.js"; WorkingDir: "{app}"; StatusMsg: "Aplicando migraciones de base de datos..."; Flags: runhidden waituntilterminated
Filename: "{app}\node\node.exe"; Parameters: "{app}\dist\database\seed.js"; WorkingDir: "{app}"; StatusMsg: "Creando datos iniciales..."; Flags: runhidden waituntilterminated
; Catálogo demo (productos demo para vender de inmediato — decisión producto F-I2b)
Filename: "{app}\node\node.exe"; Parameters: "{app}\dist\database\seed-catalog.js"; WorkingDir: "{app}"; StatusMsg: "Cargando catálogo demo..."; Flags: runhidden waituntilterminated
; Bootstrap de imágenes (solo si el wizard las activó; garage-init es idempotente)
Filename: "{app}\bin\garage-init.bat"; WorkingDir: "{app}\bin"; StatusMsg: "Configurando almacenamiento de imágenes..."; Flags: waituntilterminated; Check: UseImages

[UninstallDelete]
Type: files; Name: "{app}\.env"

[Code]
var
  PortPage: TInputQueryWizardPage;
  ImagesPage: TInputOptionWizardPage;

{ Página wizard: puerto API + toggle de imágenes }
procedure InitializeWizard;
begin
  PortPage := CreateInputQueryPage(wpSelectDir,
    'Puerto de la API', '¿En qué puerto TCP escuchará POS Server?',
    'Las cajas se conectan a este puerto. Debe estar libre y permitido en el firewall privado.');
  PortPage.Add('Puerto API:', False);
  PortPage.Values[0] := '3000';

  ImagesPage := CreateInputOptionPage(PortPage.ID,
    'Imágenes de productos', '¿Activar almacenamiento de imágenes (Garage)?',
    'Requiere Docker Desktop instalado. Si se omite, el servidor opera sin ' +
    'imágenes (se puede activar después con "Configurar imágenes (Garage)").',
    False, False);
  ImagesPage.Add('Incluir Garage (fotos de productos)');
  ImagesPage.Values[0] := False;
end;

{ True si el wizard activó imágenes. Lo usan Check: de [Files]/[Icons]/[Run]. }
function UseImages(): Boolean;
begin
  Result := ImagesPage.Values[0];
end;

{ Verifica Docker Desktop (solo si imágenes). Abort con mensaje claro si falta. }
function CheckDocker(): Boolean;
var
  Res: Integer;
begin
  Result := Exec('docker', '--version', '', SW_HIDE, ewWaitUntilTerminated, Res) and (Res = 0);
  if not Result then
  begin
    MsgBox('Activaste imágenes pero Docker Desktop no está instalado o no está en el PATH.' + #13#10 +
      'Instálalo y reintenta, o desmarca la casilla para instalar sin imágenes.', mbError, MB_OK);
  end;
end;

{ Genera 64-hex con el propio node portable (crypto aleatorio del SO),
  capturando stdout a archivo temporal. }
function GenHexSecret(const NodeExe: String): String;
var
  TmpFile: String;
  Lines: TArrayOfString;
  Res: Integer;
begin
  Result := '';
  TmpFile := ExpandConstant('{tmp}\secret.txt');
  if Exec('cmd.exe', '/c ""' + NodeExe + '" -e "console.log(require(''crypto'').randomBytes(32).toString(''hex''))" > "' + TmpFile + '""',
    '', SW_HIDE, ewWaitUntilTerminated, Res) and (Res = 0) then
  begin
    if LoadStringsFromFile(TmpFile, Lines) and (GetArrayLength(Lines) > 0) then
      Result := Trim(Lines[0]);
  end;
  DeleteFile(TmpFile);
end;

{ Escribe el .env en la carpeta de programa desde env.template, sustituyendo marcas. Falla si no hay secretos. }
function WriteEnvFile(): Boolean;
var
  { LoadStringFromFile exige AnsiString en su parámetro var }
  Template: AnsiString;
  Content, DataDir, Jwt, Hmac, Port: String;
begin
  Result := False;
  if not LoadStringFromFile(ExpandConstant('{src}\env.template'), Template) then
  begin
    MsgBox('No se pudo leer env.template junto al instalador.', mbError, MB_OK);
    Exit;
  end;
  Port := PortPage.Values[0];
  if (StrToIntDef(Port, 0) <= 0) or (StrToIntDef(Port, 0) > 65535) then
  begin
    MsgBox('Puerto inválido. Usa 1-65535 (default 3000).', mbError, MB_OK);
    Exit;
  end;
  Jwt := GenHexSecret(ExpandConstant('{app}\node\node.exe'));
  Hmac := GenHexSecret(ExpandConstant('{app}\node\node.exe'));
  if (Length(Jwt) <> 64) or (Length(Hmac) <> 64) then
  begin
    MsgBox('No se pudieron generar los secretos. Revisa que node.exe exista en {app}\node.', mbError, MB_OK);
    Exit;
  end;
  { Rutas con doble backslash para .env (dotenv las lee tal cual en Windows) }
  DataDir := ExpandConstant('{commonappdata}\POS Server\data');
  StringChangeEx(DataDir, '\', '\\', True);
  Content := Template;
  StringChangeEx(Content, '{{PORT}}', Port, True);
  StringChangeEx(Content, '{{JWT_SECRET}}', Jwt, True);
  StringChangeEx(Content, '{{HMAC_SECRET}}', Hmac, True);
  StringChangeEx(Content, '{{SQLITE_PATH}}', DataDir + '\\pos.sqlite', True);
  StringChangeEx(Content, '{{LICENSE_FILE}}', DataDir + '\\pos.lic', True);
  if UseImages() then
    StringChangeEx(Content, '{{IMAGES_ENABLED}}', 'true', True)
  else
    StringChangeEx(Content, '{{IMAGES_ENABLED}}', 'false', True);
  Result := SaveStringToFile(ExpandConstant('{app}\.env'), Content, False);
  if not Result then
    MsgBox('No se pudo escribir {app}\.env', mbError, MB_OK);
end;

{ Genera garage/garage.toml (rpc_secret aleatorio) y garage/.env (rutas de
  datos en ProgramData, con slashes para docker compose). Solo si imágenes. }
function WriteGarageFiles(): Boolean;
var
  Tpl: AnsiString;
  Content, GarageData, Secret: String;
begin
  Result := False;
  if not LoadStringFromFile(ExpandConstant('{app}\garage\garage.toml.template'), Tpl) then
  begin
    MsgBox('No se pudo leer garage.toml.template.', mbError, MB_OK);
    Exit;
  end;
  Secret := GenHexSecret(ExpandConstant('{app}\node\node.exe'));
  if Length(Secret) <> 64 then
  begin
    MsgBox('No se pudo generar el secreto de Garage.', mbError, MB_OK);
    Exit;
  end;
  Content := Tpl;
  StringChangeEx(Content, '{{RPC_SECRET}}', Secret, True);
  if not SaveStringToFile(ExpandConstant('{app}\garage\garage.toml'), Content, False) then
  begin
    MsgBox('No se pudo escribir garage.toml.', mbError, MB_OK);
    Exit;
  end;
  GarageData := ExpandConstant('{commonappdata}\POS Server\garage');
  StringChangeEx(GarageData, '\', '/', True);
  Content := 'GARAGE_DATA_DIR=' + GarageData + '/data' + #13#10 +
    'GARAGE_META_DIR=' + GarageData + '/meta' + #13#10;
  Result := SaveStringToFile(ExpandConstant('{app}\garage\.env'), Content, False);
  if not Result then
    MsgBox('No se pudo escribir garage/.env.', mbError, MB_OK);
end;

{ Regla de firewall TCP puerto API + UDP discovery, perfil privado. }
procedure AddFirewallRules(Port: String);
var
  Res: Integer;
begin
  Exec('netsh.exe', 'advfirewall firewall delete rule name="POS Server API"', '', SW_HIDE, ewWaitUntilTerminated, Res);
  Exec('netsh.exe', 'advfirewall firewall delete rule name="POS Server Discovery"', '', SW_HIDE, ewWaitUntilTerminated, Res);
  Exec('netsh.exe', 'advfirewall firewall add rule name="POS Server API" dir=in action=allow protocol=TCP localport=' + Port + ' profile=private', '', SW_HIDE, ewWaitUntilTerminated, Res);
  Exec('netsh.exe', 'advfirewall firewall add rule name="POS Server Discovery" dir=in action=allow protocol=UDP localport=5000 profile=private', '', SW_HIDE, ewWaitUntilTerminated, Res);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not WriteEnvFile() then
      Abort;
    AddFirewallRules(PortPage.Values[0]);
    if UseImages() then
    begin
      { Docker es requisito: sin él no hay Garage que configurar }
      if not CheckDocker() then
        Abort;
      if not WriteGarageFiles() then
        Abort;
    end;
  end;
end;

{ Al desinstalar: quitar reglas de firewall (datos en %ProgramData% se conservan a propósito). }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Res: Integer;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Exec('netsh.exe', 'advfirewall firewall delete rule name="POS Server API"', '', SW_HIDE, ewWaitUntilTerminated, Res);
    Exec('netsh.exe', 'advfirewall firewall delete rule name="POS Server Discovery"', '', SW_HIDE, ewWaitUntilTerminated, Res);
    { Detener Garage si se instaló (los datos en ProgramData se conservan).
      No falla si Docker ya no existe: Exec ignora el error. }
    Exec('docker', 'compose -f "' + ExpandConstant('{app}\garage\docker-compose.yml') + '" down', '', SW_HIDE, ewWaitUntilTerminated, Res);
  end;
end;
