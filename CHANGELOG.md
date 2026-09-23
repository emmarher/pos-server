# Changelog — pos-server (backend POS v4)

Todas las fechas son `YYYY-MM-DD`. Formato inspirado en
[Keep a Changelog](https://keepachangelog.com/es/1.0.0/).
El backend es un repositorio independiente (`pos-server/`).

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
