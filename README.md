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
| `DEVICE_LIMIT_DEFAULT` | `2` | Máximo de dispositivos por tenant (RF-AU-004) |
| `LOG_LEVEL` | `info` | Nivel de log de Fastify/pino |

---

## Comandos

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Arranca en desarrollo con hot-reload (`tsx watch src/server.ts`) |
| `npm run build` | Compila TypeScript a `dist/` (`tsc`) |
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
    "license": { "status": "active", "expires_at": "...", "max_devices": 2 }
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
| GET | `/products` | `products:read` | Listar/buscar (q, category_id, limit 20) |
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
| Límite de dispositivos | 2 |
| Tipos de precio | Público (default), Mayoreo |
| Permisos | 25 códigos del PRD (mapa en IMPLEMENTATION_STATUS.md) |

---

## Estructura del proyecto

```
pos-server/
├── src/
│   ├── app.ts              # buildApp(): Fastify + JWT + CORS + módulos + error handler
│   ├── server.ts           # Arranque + UDP discovery + apagado ordenado
│   ├── config/env.ts       # Variables de entorno validadas y tipadas
│   ├── database/           # Cliente unificado (client.ts, pool.ts, sqlite.ts) + migrate/seed
│   ├── middleware/auth.ts  # authenticate + requirePermission
│   ├── modules/            # auth, products, sales, inventory, customers, cashier
│   │                       #   (print, scale, sync, reports — pendientes)
│   ├── services/           # udp-discovery.ts (+ print-queue, scale-reader, sync-engine futuros)
│   └── types/              # auth, customers, products, sales, inventory, response, errors
├── migrations/             # 001_init … 004 (sqlite) — aplicar con npm run migrate
├── tests/                  # (pendiente)
├── data/                   # SQLite de dev (ignorado por git)
├── IMPLEMENTATION_STATUS.md  # Estado por fase (fuente de verdad del avance)
└── CHANGELOG.md              # Historial de versiones
```

## Estado actual

- **Fase 1 (MVP)**: completa — auth+licencias, catálogos, inventario, ventas, clientes/crédito, cortes de caja, UDP discovery.
- **Compilación**: `tsc --noEmit` y `eslint` en 0 errores.
- **Pendiente**: impresión delegada (print queue), báscula delegada (heartbeat), sync command-based, reportes.
- Detalle por fase en `IMPLEMENTATION_STATUS.md` y `CHANGELOG.md`.
