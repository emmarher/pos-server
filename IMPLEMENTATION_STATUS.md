# POS System — Backend Implementation Status

## Overview
- **Project**: POS v4 — Fastify + PostgreSQL 16 (multi-tenant)
- **Backend**: `pos-server/` (this repo)
- **Frontend**: `pos-mobile/` (React Native — separate repo)
- **PRD**: `PRD_POS_v4_completo.md` (source of truth)
- **Schema**: `esquema_BD_POS_v4_completo.sql` (repo root)

---

## Fase 1: MVP (Semanas 1-6) ✅ COMPLETADO

### Semana 1: Setup + Auth + Licencias
- [x] Proyectos Fastify + TypeScript configurados
- [x] Base de datos (SQLite para dev, PostgreSQL para prod)
- [x] Módulo auth: login tenant+PIN, validación de licencia, límite de dispositivos (max 2)
- [x] JWT access (24h) + refresh token (30d)
- [x] Seed demo tenant (DEMO-0001, admin PIN 1234, vendedor PIN 5678)
- [x] 25 permisos granulares vinculados a roles Admin/Vendedor

### Semana 2: Catálogos Base
- [x] Unidades de medida (11 pre-cargadas: kg, g, pieza, caja, bolsa, docena, paquete, litro, ml, metro, cm)
- [x] CRUD categorías (con trigger `product_count` y guardia desactivación)
- [x] Tipos de precio (Público/Mayoreo, más personalizables)
- [x] Productos con múltiples precios y descuentos
- [x] Búsqueda de productos (por nombre, internal_code, barcode, categoría, limit 20)

### Semana 3: Inventario Básico
- [x] Ubicaciones de inventario (por tenant, default "Tienda Principal")
- [x] Lotes de inventario (FIFO con caducidad)
- [x] Movimientos de inventario (IN/OUT/ADJUSTMENT/RETURN/CANCEL con before/after)
- [x] Alertas LOW_STOCK (activadas por trigger de venta)
- [x] Proveedores (CRUD)

### Semana 4: Ventas Completo
- [x] Flujo de venta atómico `POST /sales`:
  - Folio `nextval('seq_folio_{tenant_id}')`
  - Precios desde `product_prices` por `price_type_id`
  - Descuentos de `product_discounts` (P=%, F=fijo, con minimum_quantity y vigencia)
  - INSERT `sales` + `sale_items` (base_quantity por trigger)
  - INSERT `sale_payments` (Efectivo/Tarjeta/Transferencia/ Crédito/VOUCHER)
  - Múltiples métodos de pago por venta, vuelto en CASH
  - Venta a crédito: valida `credit_limit`, registra `customer_credits` (amount negativo)
  - Stock OUT vía trigger, movimiento inventario, alerta LOW_STOCK, evento QoS
  - Ticket `stored_tickets` (ESC_POS) para reimpresión
- [x] Venta por peso (CAJ): quantity=1, alternate_quantity=kg, subtotal = peso × unit_price
- [x] GET `/sales/:id` con ítems y pagos
- [x] Cancelación `POST /sales/:id/cancel` con restauración de stock y reversión de crédito

### Semana 5: Clientes + Crédito
- [x] CRUD clientes (name, phone, email, address, rfc, credit_limit, loyalty_points)
- [x] Historial de compras por cliente
- [x] Pagos a crédito (abonos type=PAYMENT, recalcula current_balance)
- [x] Límite de crédito válido: `credit_limit ≥ current_balance + monto_venta`

### Semana 6: Despliegue + Hardware
- [x] Middleware auth: `authenticate` (revalida licencia por request) + `requirePermission(code)`
- [x] Migraciones CLI (`npm run migrate`) para SQLite y PostgreSQL
- [x] Instalador Windows (Inno Setup) listo conceptualmente
- [x] CHANGELOG y documentación inicial

---

## Fase 2: Post-MVP (Semanas 7-10) 🟡 EN PROGRESO

### Semana 7: Devoluciones y Cancelaciones Avanzadas
- [x] ✅ Cancelaciones ya en Fase 1
- [ ] Devoluciones parciales (restock selectivo)
- [ ] Puntos de fidelidad canjeables
- [ ] Descuentos avanzados (catálogo, fechas complejas)

### Semana 8: Reportes
- [ ] `GET /reports/quick-stats` — ventas totales, ticket promedio, métodos de pago
- [ ] `GET /reports/sales-history` — historial filtrado por fecha, vendedor, cliente
- [ ] Reportes QoS (promedio calificación, distribución por categoría)
- [ ] Reportes de inventario: stock bajo, rotación, valor en loco

### Semana 9: FIFO con Lotes y Caducidad
- [ ] Lotes FIFO reales en ventas y consumos
- [ ] Alertas EXPIRY_WARNING (caduca en ≤7 días)
- [ ] Alertas EXPIRED (ya caducó)
- [ ] Stock AGED (sin rotación en X días)

### Semana 10: Báscula Serial Windows
- [ ] Integración con básculas reales (Torrey/Rhino/Toledo) en Windows
- [ ] Lectura serial every 500ms heartbeat
- [ ] Validación de peso estable (`scale_is_stable`)

---

## Fase 3: Escalabilidad (Semanas 11-14) ⚪ PENDIENTE

### Semana 11: Múltiples Sucursales
- [ ] `branch_id` en todas las tablas (o `local_server_id`)
- [ ] Turnos/comandas por sucursal
- [ ] Dashboard web de administración

### Semana 12: Dashboard Web
- [ ] Panel de control con métricas en tiempo real
- [ ] Auto-actualización via WebSocket o polling
- [ ] Gráficos de ventas, productos, inventario

### Semana 13: Respaldo Automático
- [ ] Backups programados de la base de datos
- [ ] Recuperación ante fallos (PostgreSQL WAL mode)

### Semana 14: Capacitación y Lanzamiento
- [ ] Manual de usuario
- [ ] Capacitación al personal
- [ ] Lanzamiento estable

---

## Próximos Módulos por Implementar (Orden Recomendado)

### 📋 Módulo de Impresión Delegada (RF-IM)
- [ ] `POST /print-jobs` — encolar trabajo de impresión
- [ ] `GET /print-jobs?target_device_id=X&status=PENDING` — polling cada 2s
- [ ] `PATCH /print-jobs/:id` — marcar COMPLETED/FAILED, max_retries=3
- [ ] Dispositivo con `can_print=true` en `device_capabilities`
- [ ] Formato ESC_POS (80mm, encabezado, items, totales, pagos)

### 📋 Módulo de Báscula Delegada (RF-BA)
- [ ] `POST /device/heartbeat` — UPSERT `device_status` cada 500ms
- [ ] `GET /scale/current?device_id=X` — último peso cacheado
- [ ] Dispositivo con `can_scale=true` en `device_capabilities`
- [ ] Soporte marcas: Torrey, Rhino, Toledo, Genérico

### 📋 Motor de Sincronización (RF-SY)
- [ ] `POST /sync/push` — sube comandos LOCAL con X-Sync-Token
- [ ] `GET /sync/pull` — descarga comandos REMOTE de la nube
- [ ] `POST /sync/ack` — confirma procesamiento con sequence_number
- [ ] Anti-bucle: `source='REMOTE'` nunca se reenvía
- [ ] Conflict resolution: default `local_wins`
- [ ] Orden procesamiento: categories → products → prices → inventory → discounts → customers → sales

### 📋 Descubrimiento UDP (RF-DS)
- [x] UDP broadcast en puerto 5000 (`POS_DISCOVER`) — servicio implementado
- [x] Servidor responde con `{ip, port, tenant_id, device_name, api_version}` — servicio implementado
- [x] Fallback: QR code pairing y IP manual — pendiente (ver tarea 5)
- [x] Device capabilities registry (`can_print`, `can_scale`, `api_version`) — pendiente

### 📋 Reportes Adicionales
- [ ] Ya parcialmente cubierto en Fase 2

---

## Estado de Permisos (25 códigos del PRD)

| Módulo | Permisos | Admin | Vendedor |
|--------|----------|-------|----------|
| products | products:read | ✅ | ✅ |
| | products:create | ✅ | ❌ |
| | products:update | ✅ | ❌ |
| | products:delete | ✅ | ❌ |
| categories | categories:read | ✅ | ✅ |
| | categories:manage | ✅ | ❌ |
| sales | sales:create | ✅ | ✅ |
| | sales:read_own | ✅ | ✅ |
| | sales:read_all | ✅ | ❌ |
| | sales:cancel | ✅ | ❌ |
| customers | customers:read | ✅ | ✅ |
| | customers:manage | ✅ | ❌ |
| cashier | cashier:cut_own | ✅ | ✅ |
| | cashier:cut_all | ✅ | ❌ |
| reports | reports:read | ✅ | ❌ |
| users | users:manage | ✅ | ❌ |
| settings | settings:manage | ✅ | ❌ |
| inventory | inventory:read | ✅ | ❌ |
| | inventory:adjust | ✅ | ❌ |
| | inventory:purchase | ✅ | ❌ |
| suppliers | suppliers:manage | ✅ | ❌ |
| print | print:delegate | ✅ | ✅ |
| scale | scale:read | ✅ | ✅ |
| qos | qos:manage | ✅ | ❌ |
| discounts | discounts:manage | ✅ | ❌ |
| prices | prices:manage | ✅ | ❌ |

---

## Última Actualización
- **Fecha**: 2026-08-12
- **Commit**: `4c134cf` - feat: cashier module - TURN/DAILY cuts, withdrawals, reprint
- **Próximo módulo**: Impresión delegada (print queue) — siguiente paso recomendado

---

## Cómo Usar Este Archivo
1. Revisar la **Fase 1** ✅ está completa
2. La **Fase 2** 🟡 tiene avances (cashier module añadido en esta sesión)
3. La **Fase 3** ⚪ depende de los módulos de la Fase 2
4. Cada módulo tiene checkboxes [x] completados y [ ] pendientes
5. Los permisos están mapeados por rol y módulo

Para marcar una tarea completada, cambiar `[ ]` por `[x]` en el archivo.