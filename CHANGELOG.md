# Changelog — pos-server (backend POS v4)

Todas las fechas son `YYYY-MM-DD`. Formato inspirado en
[Keep a Changelog](https://keepachangelog.com/es/1.0.0/).
El backend es un repositorio independiente (`pos-server/`).

## [0.2.11] — 2026-10-23 — El catálogo demo ahora es solo de abarrotes

### Cambiado

- **`npm run seed:catalog` ya no siembra ~800 productos sintéticos en 16 categorías.**
  Ahora crea **una sola categoría (`Abarrotes`, prefijo `ABR`)** con **102 productos
  reales** de abarrotes, sin variantes `v1/v2`. Cada producto conserva sus 3 precios:
  Público (RETAIL), Mayoreo (WHOLESALE −10 %) y Especial (SPECIAL +15 %).
- La **idempotencia ahora es por nombre dentro de `Abarrotes`** (antes cortaba con
  "si ya hay ≥800 productos activos", por lo que el catálogo nunca se actualizaba).
  Se puede re-ejecutar y solo inserta los productos que falten.
- El `barcode` se deriva del nombre (hash FNV-1a con prefijo `750`), así que reejecutar
  el seed produce el mismo código y no hay colisiones entre productos.

### Añadido

- **`npm run seed:catalog:reset`** (`src/database/reset-catalog.ts`): limpieza
  destructiva para dev/demo que deja el tenant `DEMO-0001` con:
  - **0 ventas** (borra `sales` y, por cascada, `sale_items`, `sale_payments`,
    `stored_tickets`, `service_quality_events` y `cashier_cut_sales`),
  - **0 movimientos de inventario** y 0 renglones de pedidos,
  - **0 productos** (cascada a `product_prices`, `product_discounts`, `inventory_lots`
    e `inventory_alerts`),
  - **solo la categoría `Abarrotes`**,
  - el **folio de ventas en 0** (la siguiente venta es `V-000001`).
  Imprime las filas borradas por paso. **Aborta si `DB_PROVIDER=postgres`** salvo que se
  pase `--force` (solo dev).

### Notas

- `tests/global-setup.ts` sigue llamando a `seedCatalog()`; las pruebas del catálogo
  crean sus propios 130 productos en tenants fixture, así que el cambio no las afecta
  (66/66 en verde).

## [0.2.10] — 2026-10-21 — El módulo de clientes vuelve a funcionar

### Corregido

El módulo de clientes (RF-VE-005) estaba roto **de punta a punta** y nunca se había
ejecutado en vivo (no hay pantalla de clientes en pos-desktop ni pos-mobile): `GET /customers`
devolvía **500 `near "AND": syntax error`** y `POST /customers` devolvía **500
`table customers has no column named description`**.

- **El `WHERE` se armaba con un `AND` inicial**: `whereSql` empezaba por
  `'AND c.is_active = 1 AND'` → la consulta quedaba `WHERE AND …` → error de sintaxis
  en SQLite y PostgreSQL. Ahora las condiciones se arman con placeholders correlativos
  (`conditions.join(' AND ')`), igual que `searchProducts()`.
- **Los placeholders de la búsqueda iban corridos**: con el filtro de activos activo, el
  `q` comparaba contra el `1` del `is_active` en vez de contra el texto buscado. Ahora
  `q` y `active_only` van con su índice real.
- **`total` devolvía siempre 1**: el `COUNT(*)` llevaba `GROUP BY c.id` (necesario para
  el `SUM` del `LEFT JOIN`, no para el conteo) → una fila por grupo y se leía la primera.
  Ahora el conteo es `SELECT COUNT(*) … WHERE …` sin `GROUP BY`.
- **`customers.description` no existe**: la columna no está en
  `esquema_BD_POS_v4_completo.sql` (la tabla `customers` no la tiene) pero el código la
  leía y la insertaba. Se eliminó de `Customer`/`CustomerInput`, del SELECT, del INSERT,
  del UPDATE y del JSON Schema de la API (el PRD tampoco la pide).
- **El `INSERT` tenía 14 columnas y 13 placeholders** y mapeaba `credit_limit` en
  `current_balance`, `loyalty_points` y `loyalty_points_value`. Ahora son 13 columnas,
  13 placeholders y los tres contadores arrancan en 0.
- **`created_at`/`updated_at` se guardaban con el texto literal `'now'`** (no es una
  fecha). Ahora se usa `new Date().toISOString()`, como el resto del servidor.
- **`active_only` nunca llegaba al servicio**: el route leía `query.activeOnly`
  (camelCase) mientras el schema declara `active_only` (snake_case, como en
  `/products`) → AJV eliminaba el parámetro y el filtro nunca se aplicaba.

### Corregido (licencias)

- **La validación de la licencia se aplicaba a un tenant arbitrario**: `getActiveTenant()`
  usaba `LIMIT 1` sin `ORDER BY` → con más de un tenant en la BD la licencia se validaba
  contra el primero que saliera, y el modo dev reactivaba **ese** tenant en vez del que
  estaba bloqueado (el servidor quedaba con el tenant de la instalación deshabilitado).
  Ahora el tenant se resuelve de forma determinista: (1) el `license_key` del `.lic`
  válido, (2) el tenant con fila en `license_state`, (3) el más antiguo.

### Añadido

- `tests/customers.test.ts` — 10 pruebas del módulo de clientes (listado, búsqueda por
  nombre y RFC, `active_only=false`, paginación, aislamiento multi-tenant, alta, detalle,
  edición, cargo de crédito y rechazo por límite excedido).
- `tests/global-setup.ts` borra `data/test-license.lic` **al arrancar** la corrida (no
  solo al terminarla): si quedaba uno de la corrida anterior, el estado inicial del
  tenant dependía de la corrida previa.

### Tests

- **66 en verde** (antes 56): 41 previos + 15 del catálogo + 10 de clientes.
- Nota: `tests/auth-pin.test.ts` y `tests/products.image.test.ts` dependen del orden de
  sus propios casos (fallan solo con `--sequence.shuffle`, que nadie usa en CI).

## [0.2.9] — 2026-10-20 — El catálogo ya no se corta en 50 productos

### Corregido

- **El catálogo de productos se truncaba a 50 sin avisar**: `searchProducts()` aplicaba
  `Math.min(Math.max(limit ?? 20, 1), 50)`, así que pedir 100 devolvía 50 y el `total`
  (805 productos) quedaba escondido detrás de un corte **alfabético** (`ORDER BY name`).
  Cualquier producto cuyo nombre no empezara con "A" **no aparecía nunca** en el
  inventario ni en el terminal de venta — el usuario lo veía como "el producto se creó
  pero no aparece".
  - El tope sube a **1000** (`MAX_PRODUCT_PAGE_SIZE`) y el schema acepta hasta 1000
    (antes `maximum: 100` → HTTP 400 al pedir más).
  - Con `limit=1000` sobre 805 productos: **805 items en ~50 ms**.
- **N+1 de precios**: `searchProducts()` hacía `Promise.all(rows.map(loadPrices))` →
  **3 queries por producto** (~2.400 queries por request con 805 productos). Ahora son
  **2 queries en total** por página, sin importar el tamaño (`attachPrices()`), y `getProduct()`
  reutiliza el precio base de la fila.
- **El precio vigente era el equivocado**: con historial de precios por tipo
  (`UNIQUE(product_id, price_type_id, start_date)`), el `Map` se armaba con el **último**
  registro (el más antiguo) en lugar del **más reciente**. Ahora gana el vigente
  (`ORDER BY start_date DESC`, primer registro de cada tipo).
- `date('now')` en el filtro de vigencia de precios **rompía en PostgreSQL** (es una función
  de SQLite) → ahora usa `CURRENT_DATE`, portable en ambos motores.

### Añadido

- **Migración `008_product_search_index`**: índice GIN con `pg_trgm` sobre `products.name`
  para que la búsqueda `LIKE '%x%'` no haga seq scan.
  - En PostgreSQL la extensión se intenta crear dentro de un `BEGIN/EXCEPTION`: **si el
    usuario no tiene permisos de superusuario, la migración no falla** (solo un NOTICE) y
    el instalador sigue. Verificado con un PostgreSQL 16 real: con superusuario crea el
    índice; sin él, sale con código 0.
  - En SQLite es un no-op documentado (no hay trigramas; FTS5 no sirve para `LIKE '%x%'`).
  - El planner lo elige solo cuando la tabla crece (`Bitmap Index Scan` verificado con
    20.000 filas).
- **15 tests nuevos** (`tests/products.catalog.test.ts`): límite 120 → 120 items, límite
  1000 → todo, límite 2000/0/-5 → 400, `total` = conteo real, paginación con `offset` sin
  repetidos ni saltos, búsqueda por nombre / `internal_code` / `barcode`, precios del listado
  idénticos a `GET /products/:id`, el precio específico gana sobre el base, con historial gana
  el vigente, producto sin precios cae al precio base y **aislamiento multi-tenant**.

## [0.2.8] — 2026-10-20 — Modo desarrollo, cierre del trial y redacción del estado

### Añadido

- **`LICENSE_DEV_MODE`**: en modo desarrollo la licencia **nunca bloquea al tenant**.
  - Si el tenant quedó inactivo o vencido se **reactiva solo** con vigencia extendida
    (`LICENSE_DEV_DAYS`, 365 días por defecto); el middleware de autenticación deja de
    devolver 403 por expiración y el monitor que desactiva tenants vencidos no corre.
  - La bandera **la inyecta el script de npm**, no el `.env`:
    `npm run dev` y `npm test` → `cross-env LICENSE_DEV_MODE=true`.
    El `.env` queda **siempre en modo producción** (`LICENSE_STRICT=true`) y `npm start`
    arranca con comportamiento estricto. `NODE_ENV=production` anula la bandera.
- **`TRIAL_ENABLED`** (default `true`, el instalador de Windows lo pone en `false`):
  cuando está en `false` **o** el server está en modo estricto/producción,
  `POST /license/trial` responde `403` y nadie puede auto-activar una licencia trial de
  1 día sin un `.lic` firmado.
- **Redacción de `GET /license/status`**: la ruta es pública. En producción, sin token,
  ahora solo devuelve `status` y `expires_at` (se ocultan `lic_id`, `customer` y
  `features`). Con token autenticado o en modo desarrollo mantiene el detalle completo.
- `LICENSE_DEV_DAYS` (default `365`) y documentación de `TRIAL_PRIVATE_KEY_PATH` / `TRIAL_PASS`
  en `.env.example` (ya se leían, pero no estaban documentadas).

### Corregido

- **La clave privada trial era localizable dentro de la instalación del cliente**:
  `keyToolDirs()` buscaba en `dataDir()` y junto al `.lic` (`%ProgramData%\POS Server\data`).
  Ahora solo se busca en `TRIAL_PRIVATE_KEY_PATH`, en la carpeta de la clave pública y en
  `tools/keys/` / `tools-posky/keys/`.
- El instalador de Windows genera `TRIAL_ENABLED=false` en el `.env` (antes dependía solo de
  que `tools-posky/` no se empaquetara).
- **`/health` reportaba una versión hardcodeada** (`0.2.6`) que quedó desactualizada tras
  dos releases. Ahora la lee de `package.json`, así que no vuelve a pasar.

### Tests

- 41 tests en verde (antes 33). Nuevos: modo desarrollo (4), `POST /license/trial` bloqueado
  (1), `keyToolDirs` sin la carpeta de datos (1) y redacción de `GET /license/status` (2).
  Los tests de comportamiento estricto desactivan explícitamente `LICENSE_DEV_MODE`.

### Entorno de desarrollo

- El entorno local dejó de depender de la **licencia trial de 1 día**: se borró
  `~/.pos/license.lic` y el tenant `DEMO-0001` quedó con 365 días de vigencia. Sin `.lic` en
  disco el server arranca en **modo degradado** (usa los campos de la BD) y no se bloquea.
  La trial queda para probar el flujo de **activación** (wizard de primer arranque), no para
  el día a día.
- `npm run seed` sigue siendo **idempotente**: si el tenant ya existe no toca
  `license_expires_at` (para reponerlo hay que usar `posky issue` o el modo desarrollo).
- Versión del paquete: `0.2.6` → `0.2.8`.

## [0.2.7] — 2026-10-19 — Build de licencias: la clave pública se encuentra siempre

### Corregido

- **La renovación de licencia bloqueaba el negocio (login 403 + ventas bloqueadas)**: el sello
  HMAC del contador anti-rollback (`license_anti_rollback.counter_hmac`) está atado al
  `lic_id` de la licencia que lo emitió, pero **no se re-ligaba al cambiar la licencia**
  (renovación o trial). Al arrancar con la licencia nueva, el chequeo leía
  *"HMAC mismatch: counter=0, posible manipulación de BD"* → `rollbackDetected` sin gracia →
  **tenant desactivado**, aunque la licencia fuera válida.
  - El sello ahora **se re-liga al `lic_id` vigente conservando el contador** (la protección
    real es el contador monotónico, no el sello). El re-ligado ocurre dentro de
    `storeLicenseState()`, es decir, en el único punto donde el `lic_id` cambia: vale para
    el arranque, `POST /license/upload` y `POST /license/trial`.
  - Solo se re-liga si el `lic_id` **cambió de verdad**: con la misma licencia el sello no se
    toca y una manipulación real del contador sigue detectándose.
- **Un tenant desactivado quedaba bloqueado para siempre**: `getActiveTenant()` solo devuelve
  tenants activos, así que tras una desactivación la validación del arranque se saltaba y el
  tenant no podía volver a operar (ni con un `.lic` válido en disco). Ahora, si no hay tenant
  activo pero hay un `.lic` con **firma válida**, se resuelve su tenant y se re-valida →
  **el tenant se reactiva solo**.
- **Reparación de sellos heredados de 0.2.6**: los tenants que quedaron con el sello atado a
  una licencia anterior se recuperan solos. La prueba es criptográfica: si el sello valida
  contra un `lic_id` **histórico del mismo tenant** (extraído de `license_audit`), es
  auténtico —hace falta el secreto para calcularlo— y se re-liga al `lic_id` vigente
  (queda registrado en la auditoría). Si no valida contra ninguno, se sigue tratando como
  manipulación de BD y el tenant se bloquea.
- **El build fallaba con "No se encontró la clave pública de licencias"**: el generador
  (`scripts/generatePublicKey.js`) solo buscaba en `tools/keys/`, pero el toolkit de licencias
  vive en el repo hermano `tools-posky/`. Ahora la clave se busca en orden:
  `PUBLIC_KEY_PATH` (env o `.env`) → `pos-server/keys/` → `tools/keys/` → `tools-posky/keys/`.
  Además el generador **ya lee el `.env`** (antes `PUBLIC_KEY_PATH` en `.env` se ignoraba,
  pese a que el mensaje de error lo sugería como solución).
- **La variable `PUBLIC_KEY_PATH` apuntando a un archivo inexistente ya no cae en silencio**
  a las rutas por defecto: se reporta como error explícito.
- **`POST /license/trial` no encontraba la clave privada trial** (mismo desfase
  `tools/` vs `tools-posky/`): ahora se busca en la carpeta de la clave pública embebida,
  `tools/keys/`, `tools-posky/keys/` y la carpeta de datos.
- **Los tests contaminaban el entorno real**:
  - `npm test` dejaba la **clave de PRUEBA embebida** en `src/keys/publicKey.ts`
    (un `npm start` posterior arrancaba con una clave que rechaza todas las licencias
    reales). Ahora se guarda la clave de producción y se **restaura en el teardown**.
  - `POST /license/upload` (tests) escribía el `.lic` en **`~/.pos/license.lic`** (la ruta
    real de producción) y el server de dev adoptaba ese `license_key`, dejando el tenant
    desactivado y el login bloqueado (403). Ahora los tests usan
    `data/test-license.lic` y borran el archivo al terminar.
  - El marker de "clave de prueba" en `LICENSE_STRICT` estaba **hardcodeado a una clave
    vieja** → la advertencia nunca saltaba. Se sustituyó por el flag `IS_TEST_KEY`
    que emite el propio generador.
- **`bonjour-service` faltaba en `node_modules`** (dependencia declarada pero no
  instalada) → `tsc` fallaba con `TS2307` y el build no completaba.

### Tests

- `tests/license.test.ts`: 3 pruebas nuevas de regresión — (1) renovar la licencia y
  arrancar dos veces más **no bloquea el tenant** (falla con `grace_clock` sin el fix),
  (2) un tenant desactivado **se reactiva** con un `.lic` válido en disco,
  (3) un sello atado a una licencia anterior **se re-liga** al vigente.

### Nota

- `npm run build:keys` requiere **Node 20.19+ / 22.12+** (`engines`): con Node 18 el
  módulo nativo `better-sqlite3` falla con `NODE_MODULE_VERSION`.

## [0.2.6] — 2026-10-07 — La licencia manda: el server adopta el código del tenant

### Cambiado

- **El `.lic` es la fuente de verdad del código de tenant**: al arrancar con un `.lic` o al
  subirlo por `/license/upload`, el server **adopta su `license_key`** (renombra el tenant)
  en vez de rechazar por "mismatch". Así se distribuye **un EXE genérico** y la licencia
  trae el código (cliente/sucursal); imposible el error "Licencia inválida" por un código
  distinto al de la licencia.

### Corregido

- **Instalar/desinstalar detiene el server**: el instalador lo detiene antes de copiar
  (upgrade) y el desinstalador lo detiene antes de borrar → ya no quedan `node.exe`
  corriendo ni archivos bloqueados.

### Versión

- `0.2.5` → **`0.2.6`**.

## [0.2.5] — 2026-10-06 — Login 403 tras reinicio (persistir el .lic al subirlo)

### Corregido

- **`POST /license/upload` no persistía el archivo `.lic`**: la licencia quedaba
  aplicada en BD pero, al reiniciar el server con `LICENSE_STRICT=true` y sin archivo,
  `validateLicenseAtStartup` **desactivaba el tenant** → `POST /auth/login` devolvía
  **403 "Licencia vencida"** aunque `/license/status` (que lee `license_state`) siguiera
  diciendo `active`. El desktop mostraba el wizard, lo cerraba y caía al login sin mensaje.
  Ahora el upload **escribe el `.lic` en `LICENSE_FILE_PATH`** (igual que el trial).
- **Arranque consistente**: si no hay archivo `.lic` pero existe un `license_state`
  válido y vigente, `validateLicenseAtStartup` **no desactiva y REACTIVA** el tenant
  (corrige el 403 fantasma de instalaciones que subieron la licencia por el wizard en
  versiones previas).
- **Instalador — permisos de `logs`**: `%ProgramData%\POS Server\logs` no se creaba con
  permiso de escritura para usuarios; el server (a veces elevado) creaba el log como admin
  y un arranque **no elevado** fallaba con **"Access is denied"** al redirigir la salida →
  el server no levantaba ("Iniciar POS Server" no hacía nada). Ahora se crea con
  `users-modify` y se re-aplica `icacls … Users:(OI)(CI)M` a toda la carpeta de datos.
- **`start-server.bat`**: el nombre del log usaba `%date:~6,4%…` (dependiente del formato
  de fecha local) → en algunos locales generaba una ruta inválida y el server no arrancaba.
  Ahora la fecha se obtiene de forma robusta. `start-server.vbs`: `cmd /s /c` para un manejo
  de comillas determinista.

### Versión

- `0.2.4` → **`0.2.5`** (package.json, `.iss`, `/health`).

## [0.2.4] — 2026-10-04 — Stock inicial al crear producto + stop-server fiable

### Añadido

- **Stock inicial al crear producto**: `POST /products` acepta `stock` y lo persiste
  (antes el `INSERT` lo fijaba en 0, así que el stock capturado en el alta se perdía).
  En `PATCH` se rechaza con mensaje claro: el stock se ajusta desde Inventario.

### Corregido

- **Detener POS Server** (`installer/windows/bin/stop-server.bat` + `stop-server.ps1`):
  el script dependía de `WINDOWTITLE` (el server corre oculto vía `.vbs`, sin título) y de
  `wmic ExecutablePath` (obsoleto en Windows recientes y vacío para procesos elevados)
  → no detenía nada. Ahora ubica el proceso por el dueño del puerto TCP del API, el UDP 5000
  y la ruta del node de la instalación.

### Versión

- `0.2.3` → **`0.2.4`** (package.json, `.iss`, `/health`).

## [0.2.3] — 2026-10-01 — Discovery (puerto/IP + mDNS) y activación de licencia

### Corregido

- **UDP discovery anunciaba el puerto `3000` fijo** (`src/services/udp-discovery.ts`)
  aunque el server escuchara en otro puerto (p. ej. `3003` en una instalación
  real): el cliente probaba `http://<ip>:3000/health`, fallaba y **descartaba**
  el servidor. Ahora la respuesta usa `env.port`.
- **IP del server mal elegida**: `detectServerIp()` tomaba la primera IPv4
  no-interna; con adaptadores virtuales (VMware/Hyper-V/VirtualBox) podía
  anunciar una IP inalcanzable. Ahora se resuelve la interfaz en la misma
  subred `/24` del solicitante (fallback a la primera no-interna).
- **Diagnóstico con falso FAIL** (`installer/windows/bin/diagnostico.ps1`): el
  chequeo "proceso node del server corriendo" solo miraba `CommandLine`, que
  llega vacío si el proceso corre elevado/otro usuario. Ahora también valida el
  PID dueño del puerto en LISTEN (proceso `node`), sin falso negativo.
- **Build de licencias sin clave**: `scripts/generatePublicKey.js` ahora falla
  (`exit 1`) si falta `tools/keys/mipos_public.pem`, en vez de generar
  `PUBLIC_KEY_PEM` vacío (server que rechaza todo `.lic`). Escape hatch para
  CI/tests: `ALLOW_MISSING_LICENSE_KEY=1`.

### Añadido

- **Sucursal configurable en la instalación**: página "Sucursal" del wizard
  (campo nombre/código) que escribe `SEED_TENANT_CODE`/`SEED_TENANT_NAME` en el
  `.env`; `seed.ts`/`seed-catalog.ts` crean el tenant con ese código (antes fijo
  `DEMO-0001`). Ese código es el **usuario de login** y debe coincidir con el
  `license_key` del `.lic` emitido por el proveedor.
- **mDNS**: el server ya anunciaba `_pos-server._tcp.local`; se documenta como
  capa de discovery en el desktop (resolución vía `mdns_discover`).

### Versión

- `0.2.2` → **`0.2.3`** (package.json, `.iss`, `/health`).

## [0.2.2] — 2026-10-01 — Fixes instalación real (rama installer)

### Corregido

- **CreateProcess 193 al arrancar**: `[Run]` lanzaba el `.vbs` directo (no es
  ejecutable Win32) → ahora vía `wscript.exe`. Era la causa de que el server
  jamás quedara corriendo post-instalación (HTTP 000).
- **Instalaba en `Program Files (x86)`**: faltaba
  `ArchitecturesInstallIn64BitMode` → `{autopf}` resolvía a x86 igual. Ahora
  instala en `C:\Program Files\POS Server`.
- **DB vacía silenciosa** (`no such table: tenants`): migrate/seed iban en
  `[Run]` sin chequear exit code. Ahora van por Pascal (`RunNodeScript`) con
  validación y log en `{app}\install-db.log`, abortando con mensaje si fallan.

### Versión

- `0.2.1` → **`0.2.2`** (package.json, `.iss`, `/health`).

## [0.2.1] — 2026-10-01 — Diagnóstico y arranque (rama installer)

### Añadido

- **Logs a archivo**: `start-server.bat/.vbs` redirigen a
  `%ProgramData%\POS Server\logs\server-AAAAMMDD.log` (un crash de arranque
  ya no es invisible: era la causa del HTTP 000).
- **`diagnostico.bat/.ps1`** (acceso en menú): chequeos OK/FAIL — archivos,
  proceso por línea de comando, puerto LISTEN, `/health` con cuerpo, UDP 5000,
  cola del log. Solo lectura; salida = nº de fallos.
- **Auto-arranque post-instalación**: `[Run]` lanza el server al terminar el
  wizard (antes solo quedaba Startup → exigía cerrar sesión).

### Versión

- `0.2.0` → **`0.2.1`** (package.json, `.iss`, `/health`) por cambios solo de
  instalador; `Setup_POS-Server-0.2.1.exe`.

## [0.2.0] — 2026-10-01 — Versión identificable (rama installer)

### Cambiado

- Versión `0.1.0` → **`0.2.0`** en `package.json`, `.iss AppVersion` (nombre del
  Setup) y `src/app.ts` (`/health` la reporta). El instalador sale como
  `Setup_POS-Server-0.2.0.exe` para distinguirlo del anterior.

## [Sin publicar] — Instalador: JWT 12h + .env inline + rutas robustas (rama installer)

### Cambiado

- **`JWT_EXPIRES_IN=43200` (12h)** en el `.env` generado (antes 24h): cubre turno
  completo; refresh 30d intacto.
- **`.env` generado inline en Pascal** (adiós `env.template` externo, causa del
  error "No se pudo leer env.template"): **guardia conservar-si-existe** — en
  reinstalación no se rota nada (protege sesiones y HMAC anti-rollback de la
  licencia, clave para renovar sin reinstalar).
- **`start-server.vbs` y `stop-server.bat`**: rutas derivadas del propio script
  (antes hardcode `%ProgramFiles%` → 80070002 al instalar en x86).

### Verificado

- `iscc` exit 0, `Setup_POS-Server-0.1.0.exe` fresco (~103 MB).

## [Sin publicar] — Fix crítico Set-DotEnvVar (rama installer)

### Corregido

- **Bug que corrompía el `.env`**: en PS 5.1, `foreach` de un solo elemento
  devuelve escalar `String` (no array) y el `+=` **concatena**
  (`A=1B=2`), perdiendo vars y pegando líneas. Afectaba a `rustfs-service.ps1`
  y `rustfs-init.ps1` (credenciales S3 + `IMAGES_ENABLED` quedaban inservibles
  en instalación real). Se fuerza array con `@(...)`. Reproducido y verificado
  con prueba aislada (3 vars, update-in-place OK).

## [Sin publicar] — Integración remota RustFS (rama installer)

### Recibido (pull fast-forward `9f48921`, sin conflictos)

- Migración Garage→RustFS: `storage.service` drop-in, `S3_REGION` compat,
  `installer/windows/rustfs/` (compose dev + binario nativo prod), wrappers
  legacy en `garage-init`/`instalar-garage`, tests y `.iss` pivotado a RustFS.
- Nuestros archivos Garage quedan como legacy en repo (wrappers delegan a
  rustfs con fallback a originales) — decisión registrada, sin duplicar lógica.

### Verificado local tras el pull

- `typecheck` limpio, suite 30/30, `iscc` exit 0 con payload rustfs
  (`Setup_POS-Server-0.1.0.exe` regenerado, gitignored).

## [Sin publicar] — Asistente Docker+Garage un clic (rama installer)

### Añadido

- **`bin/instalar-garage.{bat,ps1}`**: asistente por fases con progreso visible
  (chequeos → WSL → Docker ~600MB descarga bajo demanda → Garage → verificar),
  estado persistente, **auto-reanudación vía RunOnce** ante reinicios, log en
  ProgramData y códigos de salida por fase para soporte. Reutiliza
  `garage-init.ps1` (sin duplicar bootstrap). Acceso en menú inicio del `.iss`.
- Scripts `.ps1`/`.bat` con **BOM UTF-8** (sin ella, PS 5.1 maldecodifica
  acentos y el parser falla en cascada — detectado y corregido aquí).

### Verificado

- Parser PS sin errores en ambos scripts; `.iss` compila exit 0 con el acceso
  incluido. Ejecución real (descarga/reinicios) pendiente de VM limpia.

## [Sin publicar] — Layout de ticket para el corte (rama installer)

### Cambiado

- **`buildEscPosTicket`** (stored tickets → reimpresión): sin divisor inicial;
  cierre `GRACIAS POR SU COMPRA` → 9 blancas → `==============================`
  (30) → tienda en mayúsculas. Espejo del desktop para que venta y reimpresión
  salgan idénticas.

## [Sin publicar] — G2/G3 instalador: Garage opcional vía Docker (rama installer)

### Añadido

- **`installer/windows/garage/`**: `docker-compose.yml` (solo `127.0.0.1:3900`,
  volúmenes a ProgramData vía `.env` del compose, `restart: unless-stopped`) +
  `garage.toml.template` single-node (rpc_secret por instalador).
- **`bin/garage-init.{bat,ps1}`** idempotente: levanta contenedor, espera :3900,
  layout v1 si versión=0 (parsea node ID de `status`), crea bucket `pos-images`
  si falta, reutiliza o crea key `pos-server` (`key info --show-secret`),
  permite RW y escribe/refresca `S3_*` + `IMAGES_ENABLED=true` en el `.env`.
  Parseo verificado contra Garage real (ID, versión, buckets).
- **`.iss`**: página toggle imágenes (default off); `Check: UseImages` en
  `[Files]`/`[Icons]`/`[Run]`; prereq Docker con abort explicativo; genera
  `garage.toml` + compose `.env`; corre `garage-init` al final; `docker compose
  down` al desinstalar (datos conservados). Compila exit 0 (solo warning
  conocido Startup).
- Manual: instalación con imágenes, §7 re-configurar/desactivar, nota Startup.

### Verificado

- Sintaxis PS validada por parser; `iscc` compila con payload garage incluido.
- `garage-init` **no ejecutado aquí** (tocaría el Garage dev: crearía bucket/key
  reales) — pendiente VM limpia con instalador.

## [Sin publicar] — G1 instalador Garage: ensureBucket (rama installer)

### Añadido

- **`ensureImagesBucket()`** en `storage.service.ts`: con `IMAGES_ENABLED=true`
  verifica el bucket (`HeadBucket`) y lo crea si no existe (instalación fresca);
  credenciales/red fallidas → `'unavailable'` **sin tumbar el arranque** (la
  venta nunca depende de Garage; uploads responden 503 como antes).
- Arranque (`server.ts`): lo invoca tras `listen` y loguea
  `listo / desactivadas / no disponible`.
- **Tests `storage-bucket.test.ts`** (4 casos, S3 mockeado): existe→ready,
  inexistente→crea, 403→unavailable, flag off→disabled. Suite total: 30/30.

### Verificado

- `typecheck` limpio; suite 30/30 (auth-pin 6 + license 11 + images 9 + bucket 4).
- G0 previo: vía nativa NO-GO en esta máquina (WDAC bloquea todo binario nuevo,
  probado: .exe viejos corren, nuevos se bloquean); vía **Docker GO** (daemon
  activo, `dxflrs/garage:v1.0.1` sano, S3 :3900 responde).

## [Sin publicar] — F-I3a installer: Setup compilado (rama installer)

### Añadido

- **Primer `Setup_POS-Server-0.1.0.exe` compilado** (~34.5MB, Inno Setup 6,
  `installer/output/` — gitignored, artefacto de release, no versionado).
- Stage verificado: `dist/` fresco, migraciones 001-007 sqlite, `package.json`,
  `node_modules` prod (`npm ci --omit=dev`), Node portable **v22.12.0**,
  nativos `better-sqlite3`/`sharp` cargan OK bajo el portable (ABI 127, sin
  rebuild).
- Fixes del `.iss` tras compilación real: comentarios `{...}` no anidan
  (`{app}` dentro rompía el parser), `LoadStringFromFile` es procedimiento con
  `var AnsiString`, `{pf}` → `{autopf}`. Queda solo el warning conocido de
  áreas de usuario (auto-arranque Startup, documentado en el manual).

### Verificado

- `iscc` exit 0 determinista; log confirma payload (`server.js`,
  `migrate/seed/seed-catalog.js`, migraciones, `node.exe`, `bin/`).
- Simulación de instalado previa (F-I2) sigue válida: boot, bootstrap,
  403 sin licencia.

### Pendiente

- Instalar el Setup en **VM limpia** + checklist §4 (no hacerlo en dev: toca
  Program Files, firewall, Startup) + claves prod + `.lic` real (F-I0).

## [Sin publicar] — F-I2b installer: PIN inicial obligatorio (rama installer)

### Añadido

- **Migración `007_must_change_pin`** (sqlite+pg): `users.must_change_pin`
  (default 0; filas existentes intactas).
- **`POST /auth/change-pin`** (sin JWT): valida tenant+PIN actual, exige PIN
  nuevo 4-6 dígitos distinto, limpia el flag. Sin tokens (se reintenta login).
- **Login bloquea con 403 `MUST_CHANGE_PIN`** ("Debes cambiar tu PIN inicial…")
  cuando el flag está en 1 — antes de límite de dispositivos y tokens.
- **Seed**: `SEED_DEMO_MUST_CHANGE_PIN` (default 1; tests lo fijan en 0 en
  `setup-env.ts` **y** `global-setup.ts` — este último corre en proceso aparte
  y no hereda el primero). Instalaciones frescas fuerzan cambio de 1234/5678.
- **Tests `auth-pin.test.ts`** (6 casos, tenant fixture propio con clave única:
  los suites corren en paralelo sobre la misma BD y mutar DEMO tumbaba a
  products.image). Suite total: 26/26.
- **Instalador**: `[Run]` del `.iss` también ejecuta `seed-catalog.js`
  (catálogo demo en instalación fresca, decisión producto).

### Corregido

- `src/types/errors.ts`: tabla espejo `statusFor` suma `MUST_CHANGE_PIN` → 403
  (es la que manda para `HttpError`; sin esto caía a 500).

## [Sin publicar] — F-I2 installer: wizard Inno + .env + scripts (rama installer)

### Añadido

- **`installer/windows/pos-server.iss`** (Inno Setup 6): instala a
  `C:\Program Files\POS Server` (requiere admin), datos en
  `%ProgramData%\POS Server\{data,backups}`; página wizard de puerto API;
  genera `JWT_SECRET` + `LICENSE_HMAC_SECRET` (64-hex vía node portable);
  escribe `.env` desde `env.template`; firewall privado TCP API + UDP 5000;
  corre migrate+seed; accesos Inicio + auto-arranque Startup (`.vbs` sin ventana);
  al desinstalar limpia firewall y conserva `%ProgramData%`.
- **`installer/windows/env.template`**: fija prod (`LICENSE_STRICT=true`,
  `IMAGES_ENABLED=false`, `SEED_DEMO_LICENSE_DAYS=0`, rutas ProgramData).
- **`installer/windows/bin/`**: `start-server.bat/.vbs`, `stop-server.bat`,
  `backup.bat` (sqlite+WAL fechado), `healthcheck.bat`.
- **`installer/windows/README-INSTALADOR.md`**: manual tienda (instalar, activar
  `.lic`, operar, respaldo/restaurar, reinstalar, troubleshooting).
- `.gitignore`: `installer/stage/`, `installer/output/`, `installer/windows/node/`, `*.exe`.

### Verificado (simulación de instalado, sin Inno)

- Template→`.env` sin marcas restantes; `dist/` reconstruido (estaba
  pre-licencia y `/license/*` daba 404 genérico).
- Server real con ese `.env` (puerto 3444, BD temporal): `/health` 200 db up;
  `/license/status` → `expired` (seed nació vencido); login → 403
  "Licencia vencida". El flujo bootstrap→wizard queda probado.

### Pendiente

- Node portable v22.12.0 en `installer/stage/node/` + `iscc pos-server.iss`
  (requiere Inno Setup 6; no instalado aquí) + checklist VM limpia (§4 del plan).

## [Sin publicar] — F-I1 installer: seed demo con vigencia configurable (rama installer)

### Añadido

- **`SEED_DEMO_LICENSE_DAYS`** (default 365, dev/tests intactos): días de vigencia
  de la licencia del tenant demo al sembrar. El instalador prod la fijará en 0
  para que la instalación fresca nazca vencida → `/license/status` reporta
  `expired` → el wizard de activación aparece en vez de operar sin `.lic`.
  Verificado con BD temporal: `SEED_DEMO_LICENSE_DAYS=0` deja `DEMO-0001`
  ya vencida. Documentado en `.env.example`.

## [Sin publicar] — Integración Licencia Ed25519 (rama printer)

### Añadido (del remoto origin/printer)

- **Sistema de licencias firmadas Ed25519** (`c821a6c`): migración `006_license_signed`
  (sqlite+pg: `license_state`, `license_anti_rollback`, `license_audit`, heartbeat en
  `active_sessions`); módulo `src/modules/license/` (upload/status/heartbeat);
  `license-monitor.ts`; `scripts/generatePublicKey.js` + `build:keys`/`prebuild`;
  vars `LICENSE_FILE_PATH`, `PUBLIC_KEY_PATH`, `LICENSE_STRICT`, `LICENSE_HMAC_SECRET`.
- **Wizard bootstrap + trial 1 día** (`b9eba05`): `POST /license/upload` sin auth en
  bootstrap, `POST /license/trial` (familia de claves trial aislada),
  `GET /license/status` público con 404 `NO_LICENSE`; error `NO_LICENSE` en tipos.
- **Fix compat** (`9a3a404`): `engines` Node `^20.19.0||>=22.12.0`, enum auditoría `LOADED`.

### Corregido (local)

- `tests/global-setup.ts`: el `mkdirSync(tools/keys)` ahora corre antes de escribir
  `test-public.pem` (antes fallaba con ENOENT en entornos sin ese dir).

### Verificado

- `npm run build:keys` OK (degradado sin claves reales), `typecheck` limpio,
  migración `006` aplicada, `npm test` 20/20 (11 licencia + 9 imágenes),
  smoke `GET /license/status` → 200 con licencia seed vigente.

## [0.7.1] — 2026-08-12 — Compilación reparada + UDP Discovery conectado (RF-DS)

### Añadido

- **UDP Discovery conectado al servidor** (RF-DS-001): `server.ts` inicia
  `startDiscovery()` al arrancar (puerto 5000) y lo detiene en el apagado
  ordenado. `app.ts` registra las rutas `GET /discovery/status` y
  `GET /discovery/config` como plugin tipado.
- **Respuesta al broadcast corregida**: el servidor responde `POS_DISCOVER`
  al **puerto de origen** del cliente (`rinfo.port`) — antes enviaba al puerto
  5000 y el cliente nunca recibía la respuesta. El campo `port` de la respuesta
  ahora es el puerto del API (3000), como espera la tablet según el PRD.
- **Módulo de clientes registrado**: `customersRoutes` se registra en `app.ts`
  (estaba implementado pero nunca conectado → las rutas `/customers*` daban 404).
- **Paginación real en `GET /customers`**: `limit`/`offset` se calculaban pero
  nunca se aplicaban a la query; ahora usan `LIMIT $n OFFSET $n` con placeholders
  correctos (el COUNT no recibe parámetros extra).

### Corregido

- **`app.ts` compilaba con `cashierRoutes` sin importar** (TS2304) — import y
  registro agregados. El proyecto pasó de 104 errores de TypeScript a 0.
- **`customers.service.ts`**: tipos faltantes (`CustomerInput`,
  `CustomerCreditAdjustment`, `CustomerCreditResponse`, `CustomerPaymentPayload`)
  añadidos a `types/customers.ts`; queries de BD tipadas; `await` faltante en
  INSERT/UPDATE de crédito; bug de placeholders en `UPDATE customers`
  (`email = $5` escribía el teléfono); sintaxis `);` → `};` en el return de
  `makeCreditAdjustment`.
- **`cashier.service.ts`**: queries tipadas (`CashierCutRow`, `SalePaymentRow`,
  etc.); bug de runtime: el return de `endCut` usaba `card_amount`/`transfer_amount`/
  `credit_amount` (undefined) en vez de las variables reales; `total_sales` ahora
  recibe la suma de efectivo en lugar del contador de transacciones; `user_id`
  sin usar eliminado.
- **`cashier.routes.ts`**: `request.user.name` no existe en el JWT (el payload
  real es `role_name`) — se quitó de las firmas; `request.params` tipado con
  `ParamsWithId`; `ReprintTicketInput` → `ReprintCutInput`.
- **Schemas de params**: `{ id: {...} }` plano rompía el arranque de Fastify
  (`keyword "id" not supported`) en 4 rutas de `/customers/:id` — ahora usan
  `type: 'object'` + `properties`.
- **Lint limpio**: 27 errores resueltos (unused vars, `any`, async executor de
  Promise, handlers async sin await, assertion innecesaria).

## [0.7.0] — 2026-08-12 — Corte de caja (RF-CC)

### Añadido

- **`POST /cashier/turn-start`** — inicia un corte de turno (status OPEN) para el vendedor autenticado (permiso `cashier:cut_own`).
- **`POST /cashier/turn-end/:id`** — finaliza el corte: calcula totales por método (CASH/CARD/TRANSFER/CREDIT), compara efectivo contado vs esperado, calcula diferencia (faltante/sobrante), status CLOSED y congela ventas en `cashier_cut_sales` (permiso `cashier:cut_own`).
- **`POST /cashier/daily-start`** — inicia un corte diario (status OPEN) para administrador global (permiso `cashier:cut_all`).
- **`POST /cashier/daily-end/:id`** — finaliza el corte diario: incluye todas las ventas de todos los vendedores, mismo desglose que turn-end (permiso `cashier:cut_all`).
- **`POST /cashier/withdrawal/:id`** — registra un retiro de caja: verifica que el corte esté CLOSED, descuenta del `counted_cash`, registra en `cashier_withdrawals` (permiso `cashier:cut_all`).
- **`POST /cashier/reprint-ticket`** — obtiene el contenido formateado para reimpresión de un corte (resumen + items + pagos) (permiso `cashier:cut_all`).

### Corregido

- Lógica de cálculo de diferencia (faltante/sobrante) consistente entre `endCut` y `createWithdrawal`.
- Permisos correctamente asociados a roles: `cashier:cut_own` (solo vendedor propio) y `cashier:cut_all` (admin global).

## [0.5.0] — 2026-08-11 — Cancelación de ventas (RF-VE-006)

### Añadido

- **`POST /sales/:id/cancel`** — cancela una venta `COMPLETED` (permiso
  `sales:cancel`; el vendedor NO lo tiene, solo Administrador). Body
  `{ reason }` obligatorio (máx. 500 chars, espejo de `cancelSale` del móvil).
- **Efectos de la cancelación** (dentro de la misma transacción):
  - El trigger `trg_sales_restore_stock` restaura el stock y genera el
    movimiento `RETURN` automáticamente (no se reimplementa en JS).
  - Si la venta era a crédito (PENDING/PARTIAL), revierte el saldo del cliente
    con un `customer_credits` tipo `ADJUSTMENT` positivo (deshace el débito).
  - El evento QoS pendiente de la venta se marca `EXPIRED`.
  - Guardias: venta ya cancelada → 409, venta inexistente → 404, sin `reason`
    → 400, sin permiso → 403.

### Corregido

- **Movimiento RETURN con `inventory_before/after` reales**: la migración 003
  registraba `before=stock+base` y `after=stock+2×base` porque el SELECT leía
  el stock DESPUÉS del UPDATE de restauración. La migración
  `004_fix_return_movement.sqlite.sql` (DROP + CREATE del trigger) lo corrige:
  `before = stock restaurado − base`, `after = stock restaurado`. El OUT ya
  registraba los valores correctos.

## [0.4.0] — 2026-08-11 — Ventas (RF-VE)

### Añadido

- **`POST /sales`** — transacción atómica siguiendo el flujo del esquema
  autoritativo: folio dentro de la transacción → precios → descuentos → INSERT
  `sales` → `sale_items` → `sale_payments` → triggers automáticos (stock OUT,
  movimiento de inventario, alerta LOW_STOCK, evento QoS) → `stored_tickets` →
  COMMIT. Permiso `sales:create`.
- **Folio por tenant**: en PostgreSQL `nextval('seq_folio_{tenant_id}')`
  (guiones → guiones bajos, igual que el esquema); en SQLite UPSERT atómico en
  `folio_sequences` (adaptación documentada). `UNIQUE(tenant, prefix, folio)`
  protege la unicidad; probado con ventas concurrentes (folios V-000008..012).
- **Precios y descuentos recalculados desde la BD** (fuente de verdad): precio de
  `product_prices` vigente por `price_type_id` (fallback `products.price`) y
  descuentos de `product_discounts` (`discount_types`: P=porcentaje, F=monto
  fijo) con `minimum_quantity`, vigencia y filtro por tipo de precio.
- **CAJ (venta por peso)**: producto COUNT con `alternate_quantity` = kg de la
  báscula → `quantity=1`, subtotal = peso × precio; el stock se descuenta en
  `base_quantity` (quantity × unit_conversion, trigger). MASS por peso: el
  `quantity` es el peso real en kg.
- **Pagos (RF-VE-004/005)**: múltiples métodos por venta (CASH/CARD/TRANSFER/
  CREDIT/VOUCHER). CASH calcula el vuelto (`change_amount`); CARD/TRANSFER llevan
  `reference_code`. **Venta a crédito**: valida cliente activo y
  `credit_limit ≥ saldo + monto`, registra `customer_credits` (amount negativo),
  actualiza `current_balance` y marca `payment_state = PENDING/PARTIAL`.
- **`GET /sales/:id`** — venta completa con ítems y pagos (permiso
  `sales:read_own`).
- **`stored_tickets`**: se guarda el ticket ESC_POS de texto (negocio, folio,
  ítems, descuentos, totales, pagos, vuelto) para reimpresión.
- **Migración `003_sales_triggers.sqlite.sql`**: triggers SQLite equivalentes a
  PostgreSQL — `base_quantity` (quantity × unit_conversion), descuento de stock
  + movimiento OUT + alerta LOW_STOCK, restauración de stock al cancelar
  (RETURN), y evento QoS (PENDING, expira en 5 min). `folio_sequences` como
  equivalente de la sequence PG.

### Corregido

- Stock insuficiente → `INSUFFICIENT_STOCK` (422) validado DENTRO de la
  transacción (la venta se revierte completa: sin folio quemado ni filas
  huérfanas).
- Pagos que no cubren el total → `VALIDATION_ERROR` (400); el efectivo puede
  exceder y genera vuelto, los demás métodos no.

## [0.3.0] — 2026-08-11 — Catálogo de productos (RF-CA)

### Añadido

- **CRUD de productos** (`GET/POST /products`, `GET /products/:id`,
  `PATCH /products/:id`, `DELETE /products/:id` con borrado lógico) y
  `GET /products/:id/prices` — permisos `products:read/create/update/delete`.
- **Búsqueda de productos (RF-CA-006)**: por nombre (LIKE), `internal_code`,
  `barcode` y categoría. Límite default 20, `active_only` para administración.
- **Categorías (RF-CA-001)**: `GET/POST /categories`, `PATCH /categories/:id` —
  permisos `categories:read/manage`; `product_count` automático por trigger.
- **Catálogo base**: `GET /measurement-units` (11 unidades de sistema) y
  `GET /price-types` (Público/Mayoreo) para la venta.
- **Migración `002_products_triggers.sqlite.sql`**: triggers SQLite equivalentes
  a los de PostgreSQL — generación de `internal_code` (prefix + 4 dígitos por
  categoría), validación de báscula (solo `sale_unit` MASS), `product_count` y
  guardia "no desactivar categoría con productos activos".
- **Aislamiento multi-tenant** en todo el módulo: `tenant_id` siempre del JWT y
  referencias (categoría/unidades/tipos de precio) validadas contra el tenant.

### Corregido

- Errores de triggers/constraints de SQLite mapeados a `HttpError` legible
  (báscula → 400, barcode duplicado → 409, guardia de categoría → 409).

## [0.2.0] — 2026-08-11 — Autenticación (RF-AU)

### Añadido

- **`POST /auth/login`**: tenant por `license_key` + PIN (4–6 dígitos, bcrypt).
  Valida licencia activa (vencida → 403 `LICENSE_EXPIRED`) y límite de
  dispositivos (default 2, tercero → 403 `DEVICE_LIMIT`). Registra el dispositivo
  (UPSERT `device_registrations` + `device_capabilities`) y resuelve permisos del
  rol (`user_roles → roles → role_permissions → permissions`) incrustados en el JWT.
- **`POST /auth/refresh`**: rota el access token (24h) contra `active_sessions`
  (hash SHA-256 del refresh 30d).
- **Middleware `authenticate` + `requirePermission(code)`**: revalidan la licencia
  en cada request y exigen el permiso del módulo. Toda ruta no-auth los declara.
- **`HttpError`** con códigos de dominio (UNAUTHORIZED, FORBIDDEN, LICENSE_EXPIRED,
  DEVICE_LIMIT, CONFLICT…) mapeados a HTTP status en el error handler global.
- **Seed demo** (`npm run seed`): tenant `DEMO-0001` (admin PIN `1234`, vendedor
  PIN `5678`), 27 + 8 permisos, `price_types` Público (default) y Mayoreo.
- Script `seed` en `package.json`.

### Corregido

- Adaptador SQLite: los placeholders `$N` repetidos ahora ligan su valor en cada
  aparición (misma semántica que los parámetros nombrados de PostgreSQL); antes
  rompía consultas con `$N` duplicado ("Too few/too many parameter values").

## [0.1.0] — 2026-08-11 — Proyecto base + envoltorio + SQLite

### Añadido

- Proyecto **Fastify 5 + TypeScript estricto** con layout `src/modules/`,
  `src/services/`, `src/database/`, `src/middleware/`, `src/types/`,
  `migrations/` y `tests/` (según PRD).
- **Envoltorio de respuesta homogéneo** `{ statusCode, message, data }` con JSON
  Schema en `GET /health`, 404 y error handler global (los errores llevan
  `data: []`).
- **Cliente de base de datos unificado** (`src/database/client.ts`) con la misma
  interfaz para PostgreSQL (pool `pg`) y SQLite (mejor `better-sqlite3`) — el
  código de negocio se escribe en estilo PostgreSQL y el adaptador traduce los
  placeholders.
- **Runner de migraciones** (`npm run migrate`): aplica `migrations/*.sqlite.sql`
  o `*.pg.sql` según `DB_PROVIDER`, con ledger `schema_migrations`.
- Migración `001_init.sqlite.sql` con la estructura completa del esquema
  autoritativo (`esquema_BD_POS_v4_completo.sql`): 38 tablas, seeds de
  `measurement_units` (11) y permisos (25 códigos).

### Pendiente

- **Ventas**: cancelación (`POST /sales/:id/cancel` — el trigger de restauración
  de stock ya está en la migración 003) y reimpresión de ticket.
- **Inventario**: entradas de mercancía, lotes FIFO, movimientos y alertas.
- **Clientes a crédito**: abonos (pagos de crédito) y consulta de saldo.
- **Cortes de caja**, **impresión delegada** (`print_jobs` + polling 2s),
  **báscula** (heartbeat 500ms), **sync** (PUSH/PULL/ACK) y **reportes**
  (`/reports/quick-stats`, `/reports/sales-history`).

## [0.6.0] — 2026-08-11 — Inventario (RF-IN)

### Añadido

- **`GET /inventory/locations`** — lista ubicaciones del tenant (permiso
  `inventory:read`). La ubicación "STORE" se crea automáticamente al registrar
  el tenant.
- **`POST /inventory/locations`** — crea una nueva ubicación (permiso
  `inventory:adjust`; código único por tenant, rechazo 409 si ya existe).
- **`PATCH /inventory/locations/:id`** — actualiza nombre/estado de una ubicación.
- **`GET /inventory/lots`** — lista lotes con filtros por `product_id` y
  `movement_type` (permiso `inventory:read`).
- **`POST /inventory/lots`** — alta manual de lote (permiso `inventory:adjust`);
  permite `lot_number`, `quantity`, `expiry_date`.
- **`GET /inventory/movements`** — trazabilidad completa con filtros
  (`product_id`, `movement_type`), paginación y conteo total (permiso
  `inventory:read`).
- **`POST /inventory/adjustments`** — ajuste manual de stock con motivo
  obligatorio (permiso `inventory:adjust`). Rechaza ajustes que dejarían
  stock negativo (422 `INSUFFICIENT_STOCK`).
- **`GET /purchase-orders`** — lista órdenes de compra/entrada del tenant
  (permiso `inventory:read`).
- **`POST /purchase-orders`** — entrada transaccional de mercancía (permiso
  `inventory:purchase`): registra `purchase_orders` + `purchase_order_items`,
  aumenta `products.stock`, crea/actualiza `inventory_lots`, registra
  `inventory_movements` tipo `IN` con `before/after`, y actualiza el costo
  promedio ponderado: `new_cost = (old_cost × old_qty + unit_cost × qty) /
  (old_qty + qty)`.
- **`GET /purchase-orders/:id`** — detalle con ítems y lotes (permiso
  `inventory:read`).
- **`GET /inventory/alerts`** — bandeja de alertas `LOW_STOCK` (activadas
  por el trigger de venta cuando `stock ≤ min_stock`); filtro por
  `resolved` y `alert_type`; paginación (permiso `inventory:read`).
- **`PATCH /inventory/alerts/:id`** — marca alerta como resuelta
  (permiso `inventory:adjust`).
- **`GET /suppliers`** — lista proveedores del tenant (permiso
  `inventory:read`).
- **`POST /suppliers`** — crea proveedor (permiso `suppliers:manage`).

### Corregido

- Fórmula costo promedio ponderado actualizada: `new_cost = (old_cost × old_stock
  + unit_cost × qty) / (old_stock + qty)`. Protección contra división por cero:
  si `old_stock = 0`, el nuevo costo es simplemente `unit_cost`.

### Pendiente

- **Ventas**: cancelación (`POST /sales/:id/cancel` — el trigger de restauración
  de stock ya está en la migración 003) y reimpresión de ticket.
- **Inventario**: entradas de mercancía, lotes FIFO, movimientos y alertas.
- **Clientes a crédito**: abonos (pagos de crédito) y consulta de saldo.
- **Cortes de caja**, **impresión delegada** (`print_jobs` + polling 2s),
  **báscula** (heartbeat 500ms), **sync** (PUSH/PULL/ACK) y **reportes**
  (`/reports/quick-stats`, `/reports/sales-history`).
