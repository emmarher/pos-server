# Plan Instalador Windows — pos-server

> Guardado: 2026-09-18. Fuente de verdad para la próxima sesión de implementación.
> Alcance acordado: solo `pos-server`, `Setup.exe` con wizard (Inno Setup 6),
> Node portable incluido, sin exigir Node previo.

## 1. Decisión de BD: SQLite local por sucursal (producción local)

- **Sucursal → SQLite embebido** (`DB_PROVIDER=sqlite`).
  - Motivo: 1–5 cajas concurrentes, 1 venta a la vez. El adaptador ya lo soporta:
    `src/database/sqlite.ts` (WAL + `busy_timeout=5000` + pool 1 writer serializado
    con cola + 2–4 readers + `BEGIN IMMEDIATE`).
  - Operativa: 1 archivo `pos.sqlite`, backup = copiar archivo, cero servicios.
  - Ruta instalada: `%ProgramData%\POS Server\data\pos.sqlite`
    (mapea `SQLITE_PATH` de `.env.example` y `src/config/env.ts`).
- **Nube central (futuro) → PostgreSQL multi-tenant.**
  - Solo para consolidar sucursales vía sync por comandos
    (`IMPLEMENTATION_STATUS.md`: `sync/push-pull/ack`, orden
    categories → products → prices → inventory → discounts → customers → sales).
  - No embeber PG ni Garage en el instalador v1.
- Excepción: si una sucursal supera ~5 escritores sostenidos + reportes pesados
  concurrentes, evaluar PG local. No es el caso típico.

### No hacer (acordado)
- No `pkg / SEA / exe único`: se rompe con nativos `better-sqlite3` + `sharp`.
- No embeber PostgreSQL ni Garage/S3 en v1 (`IMAGES_ENABLED=false` por defecto;
  endpoints responden 503 controlado según `src/config/env.ts:loadImagesEnv`).
- No sidecar Tauri: `pos-desktop` ya genera su propio `msi/nsis`
  (`pos-desktop/src-tauri/tauri.conf.json:bundle.targets`).

## 2. Estructura objetivo

```text
pos-server/
  installer/
    windows/
      PLAN_INSTALADOR.md      # este archivo
      pos-server.iss          # script Inno Setup 6 (pendiente)
      bin/
        start-server.bat      # node.exe ..\dist\server.js
        start-server.vbs      # arranque sin ventana (Startup)
        stop-server.bat
        backup.bat            # copia pos.sqlite + -wal a backups\%date%
        healthcheck.bat       # curl http://127.0.0.1:3000/health
      env.template            # plantilla .env (pendiente)
      README-INSTALADOR.md    # manual operador/tienda (pendiente)
    stage/                    # (ignorado por git) artefacto intermedio
    output/                   # (ignorado por git) Setup_POS-Server-*.exe final
```

Puertos (ver `README.md` + `src/server.ts`):
- `3000/TCP` API Fastify, `5000/UDP` discovery `POS_DISCOVER` → responde `{ip, port, tenant_id, device_name, api_version}`.
- PG `5432` no aplica en v1 (solo SQLite).

## 3. Pasos de implementación (próxima sesión)

### 3.1 Preparar artefacto
1. `cd pos-server && npm run build` → `dist/` (`package.json: scripts.build/start`).
2. Crear `installer/stage/` con: `dist/`, `migrations/*.sqlite.sql`,
   `package.json`, `package-lock.json`.
   Excluir: `src/`, `tests/`, `scripts/` dev, `data/*.sqlite*`, `.env`, `node_modules/` dev.
3. En stage: `npm ci --omit=dev` + `npm rebuild better-sqlite3 sharp` contra el
   Node portable exacto (evita `NODE_MODULE_VERSION mismatch`, ver `README.md`).
4. Descargar Node 22 LTS portable (`node-v22.x-win-x64.zip`) → `stage/node/node.exe`.
   Fijar versión exacta y documentarla aquí.

### 3.2 Wizard Inno Setup (`installer/windows/pos-server.iss`)
- Destino: `C:\Program Files\POS Server`. Datos: `%ProgramData%\POS Server\data`.
- Páginas: puerto API (default `3000`, var `PORT`), `HOST=0.0.0.0` fijo,
  toggle imágenes (default `false`).
- Al instalar:
  1. Generar `JWT_SECRET` aleatorio 64-hex — obligatorio, hoy
     `src/config/env.ts:91-97` aborta si falta o es `change-me`.
     Comando ref: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
  2. Escribir `.env` desde `env.template` (vars: `PORT, HOST, DB_PROVIDER=sqlite,`
     `SQLITE_PATH, JWT_SECRET, JWT_EXPIRES_IN=86400, DEVICE_LIMIT_DEFAULT, LOG_LEVEL=info,`
     `IMAGES_ENABLED=false`).
  3. Firewall: `netsh advfirewall firewall add rule` → TCP 3000 inbound (perfil privado)
     + UDP 5000 inbound (discovery).
  4. Migrar + seed: `node.exe dist\...\migrate.js && seed.js && seed-catalog.js`
     (comandos `npm run migrate / seed / seed:catalog`, `package.json:16-20`).
     seed-catalog deja catálogo demo (decisión producto F-I2b).
     Si falla, mostrar el mensaje de `src/server.ts:assertSchemaReady`
     ("Ejecuta: npm run migrate && npm run seed").
  5. Accesos menú inicio: Iniciar / Detener / Salud / Backup / Desinstalar.
- Auto-arranque v1: acceso en shell `Startup` → `start-server.vbs` (sin consola).
  v2 opcional: servicio real con WinSW/NSSM (respetar apagado ordenado
  `SIGINT/SIGTERM` de `src/server.ts:63-77`: cierra HTTP + UDP + `db.end()` + checkpoint WAL).

### 3.3 Scripts `bin/` (pendientes)
- `start-server.bat`: `"%~dp0..\node\node.exe" "%~dp0..\dist\server.js"`.
- `backup.bat`: detener lógico → `copy pos.sqlite backups\pos-%date%.db`
  (incluir `-wal/-shm` si existen) → arrancar. Backups en `%ProgramData%\POS Server\backups`.
- `healthcheck.bat`: `curl -s http://127.0.0.1:%PORT%/health`.

### 3.4 `.gitignore` (pendiente en próxima sesión)
Agregar:
```gitignore
# ── Instalador Windows (artefactos locales) ──
installer/stage/
installer/output/
installer/windows/node/
*.exe
```

## 4. Verificación en VM limpia (sin Node)
1. Instalar `Setup_POS-Server-*.exe` con wizard.
2. `GET http://127.0.0.1:3000/health` → `{ status, service, db, version }`.
3. Login demo: `tenant_code=DEMO-0001`, PIN `1234` → tokens + `tenant/device/license`.
4. Discovery: enviar `POS_DISCOVER` a UDP 5000 → respuesta JSON con `port: 3000`.
5. Reiniciar PC → auto-arranque sin ventana, API responde.
6. Carga: 3 clientes vendiendo en loop 5 min → cero `SQLITE_BUSY`.
7. Desinstalar → sin restos (salvo `%ProgramData%` si el wizard ofrece conservar datos).

## 5. Versionado
- `pos-server/package.json: version` ↔ nombre `Setup_POS-Server-<version>.exe` ↔ tag git.
- Anotar la versión de Node portable usada en cada release (compatibilidad nativos).

## 6. Estado actual / pendientes
- [x] Plan acordado y guardado (este archivo).
- [x] `pos-server.iss` + `env.template` + `bin/*.bat|vbs` (rama `installer`, F-I2).
- [x] `README-INSTALADOR.md` (manual tienda: instalar, firewall, backup, reinstalar).
- [x] Entrada `.gitignore` para `stage/output/node/*.exe`.
- [x] Node portable v22.12.0 descargado a `installer/stage/node/` (manual, ~30MB).
- [x] `iscc pos-server.iss` compila sin errores (F-I3a; solo warning conocido Startup).
- [x] Garage opcional vía Docker (G2/G3): `garage/` (compose+toml.template),
  `bin/garage-init.{bat,ps1}` idempotente, toggle en wizard + prereq Docker,
  `ensureBucket()` en arranque (G1).
- [ ] Build de prueba + checklist VM limpia (§4, con imágenes ON y OFF).
