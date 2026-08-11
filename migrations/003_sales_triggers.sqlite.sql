-- ============================================================
-- MIGRACIÓN 003 — TRIGGERS DE VENTA (SOLO SQLITE/PRUEBAS)
-- ============================================================
-- Replica en SQLite la lógica que en PostgreSQL vive en el esquema
-- autoritativo (esquema_BD_POS_v4_completo.sql). NO se reimplementa en
-- JS: la API solo inserta filas y el trigger hace el trabajo, igual que
-- en producción.
--
-- Triggers replicados (equivalentes SQLite):
--   trg_sale_items_calc_base     → base_quantity = quantity × unit_conversion
--   trg_sale_items_deduct_stock  → stock -= base_quantity, movimiento OUT,
--                                  alerta LOW_STOCK
--   trg_sales_restore_stock      → al CANCELAR: stock += base_quantity,
--                                  movimiento RETURN (POST /sales/:id/cancel)
--   trg_sales_create_qos         → evento QoS PENDING por venta COMPLETED
--
-- ADAPTACIONES SQLite (documentadas):
--   1) FOLIOS: PG usa una SEQUENCE por tenant (seq_folio_{tenant_id}) creada
--      por trigger al insertar el tenant y consumida con nextval() DENTRO de
--      la transacción de venta. SQLite NO tiene sequences; se replica con la
--      tabla de infraestructura `folio_sequences` (equivalente 1:1 a la
--      sequence PG: tenant_id → last_value) y un UPSERT atómico:
--        INSERT ... ON CONFLICT(tenant_id) DO UPDATE SET last_value = last_value + 1
--      La fila se crea/avanza en la MISMA transacción de la venta, y el
--      constraint uq_sales_folio (tenant, prefix, folio) protege la unicidad.
--   2) base_quantity: PG asigna NEW.base_quantity en un trigger BEFORE INSERT;
--      SQLite no puede modificar NEW, así que se recalcula en AFTER INSERT
--      (UPDATE del registro recién insertado). El trigger de descuento de
--      stock LEE el valor ya recalculado (subselect), no NEW.
--   3) inventory_movements.location_id es NOT NULL en ambos. El trigger PG
--      toma la ubicación del primer lote activo; si no hay lotes (stock
--      global MVP, RF-IN-002), se usa la primera ubicación activa del tenant
--      (el seed crea "Tienda Principal" STORE).
-- ============================================================

-- ── Infraestructura de folios por tenant (equivalente a seq_folio_*) ────
CREATE TABLE IF NOT EXISTS folio_sequences (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    last_value INTEGER NOT NULL DEFAULT 0
);

-- ── base_quantity = quantity × unit_conversion (AFTER INSERT, ver nota 2) ──
CREATE TRIGGER trg_sale_items_calc_base
AFTER INSERT ON sale_items
FOR EACH ROW
BEGIN
    UPDATE sale_items
    SET base_quantity = ROUND(
        NEW.quantity * COALESCE(
            (SELECT unit_conversion FROM products WHERE id = NEW.product_id),
            1
        ),
        3
    )
    WHERE id = NEW.id;
END;

-- ── Descontar stock al vender + movimiento OUT + alerta LOW_STOCK ────────
CREATE TRIGGER trg_sale_items_deduct_stock
AFTER INSERT ON sale_items
FOR EACH ROW
BEGIN
    -- Descontar stock global del producto (lee base_quantity YA recalculado)
    UPDATE products
    SET stock = stock - (
            SELECT base_quantity FROM sale_items WHERE id = NEW.id
        ),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = NEW.product_id;

    -- Movimiento de inventario OUT (ver nota 3 para la ubicación)
    INSERT INTO inventory_movements (
        tenant_id, product_id, location_id, lot_id, movement_type,
        quantity, inventory_before, inventory_after, reference_type, reference_id, created_at
    )
    SELECT
        p.tenant_id, p.id,
        COALESCE(
            il.location_id,
            (SELECT id FROM inventory_locations
              WHERE tenant_id = p.tenant_id AND is_active = 1 LIMIT 1)
        ),
        il.id, 'OUT',
        (SELECT base_quantity FROM sale_items WHERE id = NEW.id),
        p.stock + (SELECT base_quantity FROM sale_items WHERE id = NEW.id),
        p.stock, 'SALE', NEW.sale_id,
        strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM products p
    LEFT JOIN inventory_lots il
           ON il.product_id = p.id AND il.is_active = 1
    WHERE p.id = NEW.product_id
    LIMIT 1;

    -- Alerta de stock bajo si aplica (igual que PG: sin dedupe, cada venta)
    INSERT INTO inventory_alerts (
        tenant_id, product_id, alert_type, severity, message, created_at
    )
    SELECT tenant_id, id, 'LOW_STOCK', 'HIGH',
           'Stock bajo: ' || CAST(stock AS TEXT) || ' unidades restantes',
           strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM products
    WHERE id = NEW.product_id AND stock <= min_stock;
END;

-- ── Restaurar stock al cancelar venta (POST /sales/:id/cancel) ──────────
CREATE TRIGGER trg_sales_restore_stock
AFTER UPDATE OF status ON sales
FOR EACH ROW
WHEN NEW.status = 'CANCELLED' AND OLD.status = 'COMPLETED'
BEGIN
    -- Restaurar stock global por cada ítem de la venta
    UPDATE products
    SET stock = stock + (
            SELECT COALESCE(SUM(si.base_quantity), 0) FROM sale_items si
            WHERE si.sale_id = NEW.id AND si.product_id = products.id
        ),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id IN (SELECT product_id FROM sale_items WHERE sale_id = NEW.id);

    -- Movimiento de entrada por cancelación (RETURN)
    INSERT INTO inventory_movements (
        tenant_id, product_id, location_id, movement_type,
        quantity, inventory_before, inventory_after, reference_type, reference_id, notes, created_at
    )
    SELECT
        p.tenant_id, p.id,
        COALESCE(
            (SELECT location_id FROM inventory_lots
              WHERE product_id = p.id AND is_active = 1 LIMIT 1),
            (SELECT id FROM inventory_locations
              WHERE tenant_id = p.tenant_id AND is_active = 1 LIMIT 1)
        ),
        'RETURN', si.base_quantity, p.stock, p.stock + si.base_quantity,
        'CANCEL', NEW.id, 'Cancelación de venta ' || NEW.folio_display,
        strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM sale_items si
    JOIN products p ON p.id = si.product_id
    WHERE si.sale_id = NEW.id;
END;

-- ── Generar evento QoS al completar venta (sale_id UNIQUE → INSERT OR IGNORE) ──
CREATE TRIGGER trg_sales_create_qos
AFTER INSERT ON sales
FOR EACH ROW
WHEN NEW.status = 'COMPLETED'
BEGIN
    INSERT OR IGNORE INTO service_quality_events (
        tenant_id, sale_id, customer_id, status, expires_at
    )
    VALUES (
        NEW.tenant_id, NEW.id, NEW.customer_id, 'PENDING',
        strftime('%Y-%m-%dT%H:%M:%fZ','now', '+5 minutes')
    );
END;
