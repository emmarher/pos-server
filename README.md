# POS Server — Backend del Sistema POS v4

Backend del punto de venta multiplataforma: **Fastify 5 + PostgreSQL 16** (multi-tenant,
fuente única de verdad). Los clientes (tablets Android / PCs Windows) se comunican vía HTTP
con este servidor; no tienen base de datos local.

Repositorio independiente del frontend (`pos-mobile/`). El PRD
(`PRD_POS_v4_completo.md`) y el esquema autoritativo (`esquema_BD_POS_v4_completo.sql`)
viven en la raíz del proyecto, fuera de este repo.

---

## Requisitos

| Requisito | Versión |
|-----------|---------|
| **Node.js** | `>= 20` (desarrollado y probado con Node 22) |
| **PostgreSQL** | 16 (solo en producción; dev puede usar SQLite) |
| **npm** | 10+ (incluido con Node) |

> ⚠️ **better-sqlite3** es un módulo nativo: si cambias de versión de Node, recompílalo con
> `npm rebuild better-sqlite3` (de lo contrario el arranque falla con `NODE_MODULE_VERSION` mismatch).

---

## Instalación

```bash
cd pos-server
npm install
cp .env.example .env      # luego edita JWT_SECRET (obligatorio) y DB_PROVIDER
```

> `JWT_SECRET` es **obligatorio** — sin él el servidor no arranca. Genera uno con:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

## Configuración (`.env`)

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto HTTP del API (los clientes POS se conectan aquí) |
| `HOST` | `0.0.0.0` | Host de escucha (0.0.0.0 para que la LAN alcance al servidor) |
| `DB_PROVIDER` | `postgres` | `postgres` (producción) o `sqlite` (dev, misma estructura) |
| `DATABASE_URL` | `postgres://pos:pos@127.0.0.1:5432/pos` | Solo con `DB_PROVIDER=postgres` |
| `SQLITE_PATH` | `./data/pos.sqlite` | Solo con `DB_PROVIDER=sqlite` |
| `JWT_SECRET` | — | **Obligatorio.** Firma de access (24h) + refresh (30d) |
| `JWT_EXPIRES_IN` | `86400` | Vigencia del access token en segundos (24h) |
| `JWT_REFRESH_EXPIRES_IN` | `2592000` | Vigencia del refresh token en segundos (30d) |
| `DEVICE_LIMIT_DEFAULT` | `3` | Máximo de dispositivos por tenant (RF-AU-004) |
| `LOG_LEVEL` | `info` | Nivel de log de Fastify/pino |
| `PUBLIC_KEY_PATH` | — | Ruta (relativa a `pos-server/`) de la clave **pública** Ed25519 que se embebe en el build. Vacío = búsqueda automática (ver abajo) |
| `TRIAL_PUBLIC_KEY_PATH` | — | Igual, para la familia de claves *trial* (licencias trial de 1 día) |
| `LICENSE_FILE_PATH` | `~/.pos/license.lic` | Ruta del `.lic` firmado que el server verifica al arrancar |
| `LICENSE_STRICT` | `false` | `true` = sin `.lic` válido el tenant queda bloqueado (login 403). En producción el instalador lo fija en `true` |
| `TRIAL_ENABLED` | `true` | `false` = `POST /license/trial` responde 403. El instalador de Windows lo fija en `false` |
| `TRIAL_PRIVATE_KEY_PATH` | — | Ruta de la clave privada **trial** (solo si el server emite trials). No lapongas junto al `.lic` del cliente |
| `TRIAL_PASS` | — | Passphrase con la que se descifra `TRIAL_PRIVATE_KEY_PATH` (si el PEM está cifrado) |
| `LICENSE_DEV_MODE` | — | **No la pongas en `.env`.** La inyecta `npm run dev` / `npm test` (ver *Modo desarrollo*) |
| `LICENSE_DEV_DAYS` | `365` | Días de vigencia que se extiende la licencia en modo desarrollo |

### Claves de licencias (Ed25519)

El server **no recibe la clave pública por `.env` en runtime**: se embebe en el binario
en el build (`npm run build:keys` → `src/keys/publicKey.ts`, gitignored) para que un
cliente no pueda sustituirla por una propia y aceptar licencias falsificadas.

El generador busca la clave **pública** en este orden:

1. `PUBLIC_KEY_PATH` / `TRIAL_PUBLIC_KEY_PATH` (variable de entorno o entrada en `.env`)
2. `pos-server/keys/`
3. `tools/keys/` (ruta canónica del toolkit de licencias)
4. `tools-posky/keys/` (repo hermano donde vive el toolkit en este workspace)

Las claves las emite el repo hermano `tools-posky/` (herramienta de issuance):

```bash
node tools-posky/generate-keys.js          # par principal (pública + privada cifrada)
node tools-posky/generate-trial-keys.js    # familia trial (1 día)
node tools-posky/issue-license.js "Cliente" sucursal DEMO-0001 3   # emite un .lic
```

> Sin clave embebida el build falla (`npm run build:keys` sale con código 1). Con
> `ALLOW_MISSING_LICENSE_KEY=1` genera un build **degradado**: el server arranca pero
> rechaza todo `.lic` y, con `LICENSE_STRICT=true`, bloquea el tenant. Solo para CI.

> `npm test` usa una clave de prueba: el `global-setup` la embebe temporalmente y la
> **restaura al terminar** (el `teardown` de Vitest), de modo que un `npm start`
> posterior nunca arranca con la clave de prueba.

### Renovación de licencia y sello anti-rollback

El contador anti-rollback (`license_anti_rollback.counter`) es monotónico: sube con cada
venta y su sello HMAC ata el valor a la licencia que lo emitió (`secret + lic_id`).

- Al **cambiar de licencia** (renovación, `POST /license/upload`, `POST /license/trial`) el
  sello se **re-liga al `lic_id` nuevo conservando el contador**. Si no, el arranque
  siguiente lo leería como *"posible manipulación de BD"* y desactivaría el tenant
  (login 403 + ventas bloqueadas) con una licencia perfectamente válida.
- Si el tenant quedó **desactivado** por un arranque previo, al arrancar con un `.lic`
  válido en disco **se reactiva solo** (no hace falta tocar la BD).
- Si el sello quedó atado a una licencia **anterior** (estados heredados de 0.2.6), se
  re-liga solo: se demuestra que el sello es auténtico porque valida contra un `lic_id`
  histórico del mismo tenant registrado en `license_audit`. Queda anotado en la auditoría.
  Un sello que no valida contra ninguna licencia del tenant sigue tratándose como
  manipulación de BD y bloquea el tenant.

### Modo desarrollo (`LICENSE_DEV_MODE`)

El `.env` queda **siempre en modo producción** (`LICENSE_STRICT=true`). El modo
desarrollo lo activa **el script de npm**, no una variable del `.env`:

```bash
npm run dev     # → cross-env LICENSE_DEV_MODE=true tsx watch src/server.ts
npm test        # → cross-env LICENSE_DEV_MODE=true vitest run
npm start       # → sin la bandera: comportamiento estricto (producción)
```

Con `LICENSE_DEV_MODE` la licencia **nunca bloquea al tenant**: si quedara inactivo o
vencido se reactiva solo con vigencia extendida (`LICENSE_DEV_DAYS`, 365 por defecto) y
el middleware de autenticación no devuelve 403 por expiración. El monitor que desactiva
tenants vencidos tampoco corre. En producción la bandera se ignora: `NODE_ENV=production`
la anula siempre.

> `LICENSE_DEV_MODE` **no** es una variable de `.env`: si la pones ahí, el `.env` deja de
> estar en modo producción. Usa siempre `npm run dev`.

### Licencias trial

`POST /license/trial` emite una licencia de **1 día** firmada con la familia de claves
*trial* (servidor-side). Para que un equipo de pruebas la use:

- el server necesita la clave privada trial (`TRIAL_PRIVATE_KEY_PATH` + `TRIAL_PASS`),
- y `TRIAL_ENABLED` debe estar en `true` (lo está por defecto; el instalador de Windows
  lo pone en `false`).

Cuando `TRIAL_ENABLED=false` **o** el server está en modo estricto/producción, la ruta
responde `403` y **nadie puede auto-activar una licencia trial** sin un `.lic` firmado.
La clave privada trial ya no se busca en la carpeta de datos ni junto al `.lic` del
cliente: solo en `TRIAL_PRIVATE_KEY_PATH`, en la carpeta de la clave pública y en
`tools/keys/` / `tools-posky/keys/`.

> `GET /license/status` es público. En producción **redacta** `lic_id`, `customer` y
> `features` (solo devuelve `status` y `expires_at`); con token autenticado o en modo
> desarrollo devuelve el detalle completo.

### La licencia en desarrollo: no hace falta emitir ninguna

El entorno local **no necesita** un `.lic`. Sin archivo de licencia en disco el server
arranca en **modo degradado** y usa los campos de la BD (`license_state` /
`license_expires_at`), que la semilla deja en 365 días:

```
~/.pos/            ← vacío: sin license.lic
data/pos.sqlite    ← license_state vigente → el server reactiva el tenant solo
```

La licencia **trial de 1 día** es para probar el flujo de *activación* (wizard de primer
arranque en `pos-desktop`), no para el día a día. Si la emite, al vencer vuelve a dejar el
tenant bloqueado (hay que borrarla: `rm ~/.pos/license.lic`).

> `npm run seed` es **idempotente**: si el tenant ya existe no toca `license_expires_at`.
> Para reponer la vigencia: `posky issue` (toolkit) o `LICENSE_DEV_MODE`.

---

## Comandos

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Arranca en desarrollo con hot-reload (`tsx watch src/server.ts`) — **inyecta `LICENSE_DEV_MODE=true`** |
| `npm test` | Vitest — **inyecta `LICENSE_DEV_MODE=true`** |
| `npm run build` | Compila TypeScript a `dist/` (`tsc`) — el `prebuild` regenera la clave pública embebida |
| `npm run build:keys` | Embebe la clave pública Ed25519 en `src/keys/publicKey.ts` (y la trial) |
| `npm start` | Ejecuta el build (`node dist/server.js`) — requiere `npm run build` antes |
| `npm run typecheck` | Verifica tipos (`tsc --noEmit`) — debe dar 0 errores |
| `npm run lint` | ESLint sobre `src/` — debe dar 0 errores |
| `npm run migrate` | Aplica migraciones `migrations/*.sqlite.sql` o `*.pg.sql` según `DB_PROVIDER` |
| `npm run seed` | Crea el tenant demo + usuarios + permisos (idempotente) |

### Flujo típico (dev con SQLite)

```bash
cp .env.example .env
# edita .env:  DB_PROVIDER=sqlite  y  JWT_SECRET=<secreto generado>
npm run migrate
npm run seed
npm run dev
```

### Flujo típico (producción con PostgreSQL)

```bash
# PostgreSQL 16 en 127.0.0.1:5432 (nunca expuesto a la red — RNF-003)
DB_PROVIDER=postgres npm run migrate
DB_PROVIDER=postgres npm run seed
npm run build && npm start
```

---

## Puertos

| Puerto | Protocolo | Uso |
|--------|-----------|-----|
| `3000` | HTTP | API Fastify — todos los clientes POS |
| `5000` | UDP | Descubrimiento de servidor (`POS_DISCOVER`, RF-DS-001) |
| `5432` | TCP | PostgreSQL — solo `127.0.0.1` (nunca expuesto) |

---

## Descubrimiento UDP (RF-DS-001)

El servidor escucha broadcast UDP en el puerto `5000`. Una tablet/PC envía el mensaje
`POS_DISCOVER` y el servidor responde **al puerto de origen** del cliente:

```bash
# Enviar el broadcast (Node)
node -e "
const dgram = require('dgram');
const c = dgram.createSocket('udp4');
c.on('message', (r) => { console.log(r.toString()); c.close(); process.exit(0); });
c.send(Buffer.from('POS_DISCOVER'), 0, 11, 5000, '<IP_DEL_SERVIDOR>');
"
```

**Respuesta** (JSON, `utf8`):

```json
{
  "ip": "192.168.1.10",
  "port": 3000,
  "tenant_id": "8572b35f154b18105ab36d0ae3c0a428",
  "device_name": "POS-Server-Tenant Demo",
  "api_version": "4.0.0"
}
```

| Campo | Descripción |
|-------|-------------|
| `ip` | IP desde la que llegó el broadcast (la tablet responde ahí) |
| `port` | Puerto del **API HTTP** (3000) — donde la tablet debe conectarse |
| `tenant_id` | Tenant activo (primer tenant activo de la BD) |
| `device_name` | Nombre del servidor para mostrarlo en el cliente |
| `api_version` | Versión de API soportada (`4.0.0`) |

Endpoints de utilidad (sin autenticación):

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Healthcheck: `{ status, service, db, version, timestamp }` |
| GET | `/discovery/status` | Estado del servicio UDP: `{ isRunning, port, message, tenant_id, tenant_name }` |
| GET | `/discovery/config` | Configuración para fallbacks QR/IP manual |

---

## Contrato de respuestas

Toda respuesta del API usa el **envoltorio homogéneo** (`src/types/response.ts`):

```json
{
  "statusCode": 200,
  "message": "Servidor operativo",
  "data": { }
}
```

- `statusCode`: HTTP status real.
- `message`: texto legible (español, vocabulario POS).
- `data`: payload. En **errores siempre es `[]`**:

```json
{
  "statusCode": 404,
  "message": "Recurso no encontrado",
  "data": []
}
```

Cada ruta declara `schema.response` con JSON Schema (draft-07, validado por AJV vía Fastify);
el servidor valida la respuesta real contra el contrato antes de enviarla.

---

## Autenticación (RF-AU)

### `POST /auth/login`

Body:

```json
{
  "tenant_code": "DEMO-0001",
  "pin": "1234",
  "device_id": "tablet-caja-01",
  "device_name": "Tablet Caja 1",
  "device_type": "android"
}
```

Valida licencia activa (`LICENSE_EXPIRED` → 403), límite de dispositivos
(`DEVICE_LIMIT` → 403), registra el dispositivo y devuelve:

```json
{
  "statusCode": 200,
  "message": "Inicio de sesión exitoso",
  "data": {
    "access_token": "<jwt 24h>",
    "refresh_token": "<jwt 30d>",
    "token_type": "Bearer",
    "expires_in": 86400,
    "user": { "id": "...", "tenant_id": "...", "name": "Administrador", "role_name": "Administrador", "permissions": ["products:read", "..."] },
    "tenant": { "id": "...", "tenant_id": "...", "business_name": "Tenant Demo", "address": null, "phone": "555-1234", "receipt_footer": null },
    "device": { "device_id": "tablet-caja-01", "tenant_id": "...", "device_name": "Tablet Caja 1", "device_type": "android", "can_print": false, "can_scale": false },
    "license": { "status": "active", "expires_at": "...", "max_devices": 3 }
  }
}
```

### `POST /auth/refresh`

```json
{ "refresh_token": "<refresh jwt>" }
```

Devuelve el mismo contrato de `data` con tokens renovados.

### Middleware

- `authenticate`: verifica el JWT (`Authorization: Bearer <token>`) y **revalida la licencia
  en cada request** (licencia vencida → 403 `LICENSE_EXPIRED`, bloqueo total).
- `requirePermission(code)`: exige un permiso del rol (incrustado en el JWT como `permissions`).
- El tenant **siempre** sale del JWT (`request.user.tenant_id`), nunca del body/query.

### Payload del JWT

```json
{
  "sub": "<user_id>",
  "tenant_id": "<tenant_id>",
  "device_id": "<device_id>",
  "role_name": "Administrador",
  "permissions": ["products:read", "sales:create", "..."],
  "typ": "access",
  "iat": 1786568000,
  "exp": 1786654400
}
```

---

## Endpoints

### Catálogos (products)

| Método | Ruta | Permiso | Descripción |
|--------|------|---------|-------------|
| GET | `/products` | `products:read` | Listar/buscar (`q`, `category_id`, `limit` 1–1000, `offset`) |
| POST | `/products` | `products:create` | Crear producto |
| GET | `/products/:id` | `products:read` | Detalle |
| PATCH | `/products/:id` | `products:update` | Actualizar |
| DELETE | `/products/:id` | `products:delete` | Borrado lógico |
| GET | `/products/:id/prices` | `products:read` | Precios por tipo |
| GET | `/categories` | `categories:read` | Listar categorías |
| POST | `/categories` | `categories:manage` | Crear categoría |
| PATCH | `/categories/:id` | `categories:manage` | Actualizar |
| GET | `/measurement-units` | `products:read` | Unidades (11 de sistema) |
| GET | `/price-types` | `products:read` | Tipos de precio (Público/Mayoreo) |

#### Paginación y búsqueda del catálogo

`GET /products` devuelve `{ items, total }`. `total` es el **conteo real** de la consulta
(antes de paginar) → sirve para saber cuántas páginas hay.

- `limit`: **1 a 1000** (default 20). Antes el tope era 50 y el schema 100: pedir más
  devolvía 50 en silencio o un 400.
- `offset`: desplazamiento, para paginar.
- `q`: busca por `name` **sin importar acentos ni mayúsculas** (`azucar` → "Azúcar",
  `pina` → "Piña", `AZUCAR` → "Azúcar"), por `internal_code` exacto (ignora
  mayúsculas) y por `barcode` exacto.
- `category_id`: filtra por categoría.
- Orden: `name ASC` (alfabético) — es el orden en el que se muestran los productos.
- Con ~1.000 productos, `limit=1000` responde en ~50 ms: los precios de la página se
  cargan con **2 queries en total** (no una por producto).

> **Búsqueda sin acentos (migración `009`).** `products.name_normalized` guarda el
> nombre en minúsculas y sin acentos (`á é í ó ú ü ñ ç` → `a e i o u u n c`), mantenido
> por triggers al insertar y al renombrar. El término del usuario se normaliza igual
> (`normalizeSearchText()` en `src/modules/products/product-text.ts`) y se compara con
> `name_normalized LIKE '%…%'`. Si se agregan caracteres al mapa, hay que actualizar
> **la migración y** `normalizeSearchText()` a la vez.

> La búsqueda por texto en PostgreSQL usa un índice GIN con `pg_trgm` (migración `008`)
> y otro sobre `name_normalized` (migración `009`). La extensión se crea solo si el
> usuario de BD tiene permisos; si no, la migración avisa por NOTICE y sigue — el
> buscador funciona igual, solo que con seq scan.
>
> En SQLite no hay trigramas: las migraciones `008`/`009` son un no-op en ese sentido y
> la búsqueda es un LIKE secuencial (suficiente para el volumen de una tienda).

### Ventas (sales)

| Método | Ruta | Permiso | Descripción |
|--------|------|---------|-------------|
| POST | `/sales` | `sales:create` | Venta atómica (folio, items, pagos, stock) |
| GET | `/sales/:id` | `sales:read_own` | Detalle con items y pagos |
| POST | `/sales/:id/cancel` | `sales:cancel` | Cancelar (restaura stock, revierte crédito) |

### Inventario (inventory)

| Método | Ruta | Permiso | Descripción |
|--------|------|---------|-------------|
| GET | `/inventory/locations` | `inventory:read` | Ubicaciones |
| POST | `/inventory/locations` | `inventory:adjust` | Crear ubicación |
| PATCH | `/inventory/locations/:id` | `inventory:adjust` | Actualizar ubicación |
| GET | `/inventory/lots` | `inventory:read` | Lotes (filtro product_id, movement_type) |
| POST | `/inventory/lots` | `inventory:adjust` | Alta de lote |
| GET | `/inventory/movements` | `inventory:read` | Trazabilidad (paginada) |
| POST | `/inventory/adjustments` | `inventory:adjust` | Ajuste manual con motivo |
| GET | `/purchase-orders` | `inventory:read` | Órdenes de compra |
| POST | `/purchase-orders` | `inventory:purchase` | Entrada de mercancía |
| GET | `/purchase-orders/:id` | `inventory:read` | Detalle con ítems y lotes |
| GET | `/inventory/alerts` | `inventory:read` | Bandeja de alertas LOW_STOCK |
| PATCH | `/inventory/alerts/:id` | `inventory:adjust` | Resolver alerta |
| GET | `/suppliers` | `inventory:read` | Proveedores |
| POST | `/suppliers` | `suppliers:manage` | Crear proveedor |

### Clientes (customers)

| Método | Ruta | Permiso | Descripción |
|--------|------|---------|-------------|
| GET | `/customers` | `customers:read` | Listar (q, active_only, limit, offset) |
| POST | `/customers` | `customers:manage` | Crear cliente |
| GET | `/customers/:id` | `customers:read` | Detalle con balance |
| PATCH | `/customers/:id` | `customers:manage` | Actualizar |
| POST | `/customers/:id/credit` | `customers:manage` | Cargo/abono al crédito |
| POST | `/customers/:id/payment` | `customers:manage` | Pago a crédito |

### Cortes de caja (cashier)

| Método | Ruta | Permiso | Descripción |
|--------|------|---------|-------------|
| POST | `/cashier/turn-start` | `cashier:cut_own` | Iniciar corte de turno |
| POST | `/cashier/turn-end/:id` | `cashier:cut_own` | Finalizar corte de turno |
| POST | `/cashier/daily-start` | `cashier:cut_all` | Iniciar corte diario |
| POST | `/cashier/daily-end/:id` | `cashier:cut_all` | Finalizar corte diario |
| POST | `/cashier/withdrawal/:id` | `cashier:cut_all` | Retiro de caja |
| POST | `/cashier/reprint-ticket` | `cashier:cut_all` | Reimprimir corte |

> Auth (`/auth/*`) y utilidades (`/health`, `/discovery/*`) no requieren token. Todo lo demás
> requiere `Authorization: Bearer <access_token>`.

---

## Datos demo (seed)

`npm run seed` crea un tenant idempotente:

| Dato | Valor |
|------|-------|
| Código de tenant (`tenant_code`) | `DEMO-0001` |
| Usuario **Administrador** | PIN `1234` |
| Usuario **Vendedor** | PIN `5678` |
| Límite de dispositivos | 3 |
| Tipos de precio | Público (default), Mayoreo |
| Permisos | 25 códigos del PRD (mapa en IMPLEMENTATION_STATUS.md) |

### Catálogo demo (solo abarrotes)

`npm run seed:catalog` siembra el catálogo de la tienda de ejemplo. Desde la
**0.2.11** solo crea la categoría **`Abarrotes`** con **102 productos reales**
(1 nombre = 1 producto, sin variantes sintéticas `v1/v2` ni categorías de otros
giros). Cada producto lleva sus 3 precios: Público (RETAIL), Mayoreo
(WHOLESALE −10 %) y Especial (SPECIAL +15 %).

Es **idempotente por nombre**: se puede correr varias veces y solo inserta los
productos que falten.

```bash
# sembrar / completar el catálogo de abarrotes
npm run seed:catalog

# DESTRUCTIVO (dev/demo): borra ventas, movimientos, productos y las demás
# categorías, reinicia el folio y vuelve a sembrar los abarrotes
npm run seed:catalog:reset
```

> `seed:catalog:reset` aborta si `DB_PROVIDER=postgres` (producción) salvo que se
> pase `--force`. Deja el tenant `DEMO-0001` con 0 ventas, 0 movimientos, solo la
> categoría `Abarrotes` y el folio en `V-000000`.

---

## Estructura del proyecto

```
pos-server/
├── src/
│   ├── app.ts              # buildApp(): Fastify + JWT + CORS + módulos + error handler
│   ├── server.ts           # Arranque + UDP discovery + apagado ordenado
│   ├── config/env.ts       # Variables de entorno validadas y tipadas
│   ├── database/           # Cliente unificado + migrate/seed/seed-catalog/reset-catalog
│   ├── middleware/auth.ts  # authenticate + requirePermission
│   ├── modules/            # auth, products, sales, inventory, customers, cashier
│   │                       #   (print, scale, sync, reports — pendientes)
│   ├── services/           # udp-discovery.ts, storage.service.ts (RustFS S3) (+ sync-engine futuro)
│   └── types/              # auth, customers, products, sales, inventory, response, errors
├── migrations/             # 001_init … 009 (sqlite + pg) — aplicar con npm run migrate
├── tests/                  # vitest (auth, licencias, catálogo, clientes, imágenes, storage)
├── data/                   # SQLite de dev (ignorado por git)
├── IMPLEMENTATION_STATUS.md  # Estado por fase (fuente de verdad del avance)
└── CHANGELOG.md              # Historial de versiones
```

## Estado actual

- **Fase 1 (MVP)**: completa — auth+licencias, catálogos, inventario, ventas, clientes/crédito, cortes de caja, UDP discovery.
- **Compilación**: `tsc --noEmit` y `eslint` en 0 errores.
- **Pendiente**: impresión delegada (print queue), báscula delegada (heartbeat), sync command-based, reportes.
- Detalle por fase en `IMPLEMENTATION_STATUS.md` y `CHANGELOG.md`.
