# Changelog — pos-server (backend POS v4)

Todas las fechas son `YYYY-MM-DD`. Formato inspirado en
[Keep a Changelog](https://keepachangelog.com/es/1.0.0/).
El backend es un repositorio independiente (`pos-server/`).

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

- **Ventas**: `POST /sales` (transacción atómica con folio por `nextval` de
  `seq_folio_{tenant}`, CAJ, triggers de stock/QoS), cancelación y pagos.
- **Inventario**: entradas de mercancía, lotes FIFO, movimientos y alertas.
- **Clientes a crédito**, **cortes de caja**, **impresión delegada**
  (`print_jobs` + polling 2s), **báscula** (heartbeat 500ms), **sync**
  (PUSH/PULL/ACK) y **reportes** (`/reports/quick-stats`, `/reports/sales-history`).
