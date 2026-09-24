# Manual del operador — Instalador POS Server (Windows)

> Alcance v1: sucursal con SQLite local, sin Node previo, sin internet requerida
> (salvo descarga inicial del instalador). Imágenes (Garage/S3) desactivadas.

## 1) Requisitos

- Windows 10/11 x64 con cuenta de **administrador** para instalar.
- Puerto TCP **3000** libre (o el elegido en el wizard) + UDP **5000** en red privada.
- Archivo `.lic` de la sucursal (lo entrega el proveedor) — **no se opera sin activarlo**.

## 2) Instalar

1. Ejecuta `Setup_POS-Server-<versión>.exe` como administrador.
2. Elige carpeta (`C:\Program Files\POS Server`) y **puerto API** (default 3000).
3. El instalador hace todo solo:
   - genera `JWT_SECRET` + `LICENSE_HMAC_SECRET` aleatorios (`.env`),
   - abre firewall privado (TCP puerto API + UDP 5000 discovery),
   - aplica migraciones + seed demo (tenant `DEMO-0001`, admin PIN `1234`),
   - deja acceso de **auto-arranque** (inicia sin ventana al prender la PC).
4. Verifica: menú inicio → **Salud del servidor** → debe responder `{"statusCode":200,...,"service":"pos-server"}`.

> Nota: el auto-arranque se instala en el **Startup del usuario que ejecuta el
> Setup** (instalación admin). Si la caja opera con otro usuario de Windows,
> copia `POS Server.lnk` de ese Startup al `shell:startup` del usuario cajero,
> o ejecuta una vez `bin\start-server.vbs` con su sesión.

## 3) Activar licencia (obligatorio, primera vez)

La instalación fresca nace **vencida a propósito** (bootstrap): al abrir el POS
desktop aparece el **wizard de activación**.
1. Arrastra tu archivo `.lic`, o pégalo como texto, o pulsa **Activar licencia**.
2. El wizard confirma `Licencia activada: LIC-... — expira ...`.
3. Sin `.lic` válido el servidor **bloquea** (`LICENSE_STRICT=true`): login y ventas responden `403`.

Renovación/ampliar asientos: el proveedor te envía un `.lic` nuevo → súbelo desde
un admin o repite el wizard (sin reinstalar nada).

## 3b) Primer login: cambiar PIN inicial (obligatorio)

Los usuarios demo nacen con PIN `1234` (admin) / `5678` (vendedor) marcados como
**iniciales**: el login los rechaza con *"Debes cambiar tu PIN inicial"* hasta
crear uno nuevo de 4-6 dígitos en la misma pantalla. Hazlo antes de operar;
nadie debe vender con los PINs de fábrica.

## 4) Operación diaria

- **Iniciar/Detener**: accesos del menú inicio (fondo = sin ventana).
- **Salud**: acceso Salud o `curl http://127.0.0.1:3000/health`.
- **Respaldo**: acceso **Respaldo base de datos** (copia `pos.sqlite` + WAL a
  `%ProgramData%\POS Server\backups\pos-AAAAMMDD_HHMMSS.db`). Hazlo **a diario**
  y copia el `.db` a USB.
- **Restaurar**: detén el servidor, sustituye `%ProgramData%\POS Server\data\pos.sqlite`
  (y borra `-wal`/`-shm` si existen), arranca.

## 5) Reinstalar / cambiar de PC

1. Respaldo vigente (`.db`) + tu `.lic` a la mano.
2. Instala el Setup en la máquina nueva, detén el servidor, pega el `.db` en
   `%ProgramData%\POS Server\data\`, arranca, activa el `.lic` en el wizard.
3. Desinstalar **conserva** `%ProgramData%` a propósito (datos + licencia).

## 6) Problemas comunes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `Salud` no responde | servidor detenido o puerto ocupado | Iniciar (fondo); `netstat -ano \| findstr 3000` |
| Cajas no descubren el server | firewall / red pública | red en perfil **privado**; regla `POS Server Discovery` UDP 5000 |
| `403 LICENSE_EXPIRED` en todo | `.lic` vencido o ausente | renovar y subir `.lic` nuevo |
| `FALTA JWT_SECRET` en log | `.env` borrado | reinstalar (regenera secretos; **los tokens previos se invalidan**) |
| Ventas lentas / `SQLITE_BUSY` | >5 cajas escribiendo a la vez | contactar soporte (evaluar PG local) |
