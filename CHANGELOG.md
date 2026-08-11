# Changelog — pos-server (backend POS v4)

Todas las fechas son `YYYY-MM-DD`. Formato inspirado en
[Keep a Changelog](https://keepachangelog.com/es/1.0.0/).
El backend es un repositorio independiente (`pos-server/`).

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
