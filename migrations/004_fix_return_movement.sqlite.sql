-- ============================================================
-- MIGRACIÓN 004 — CORRECCIÓN MOVIMIENTO RETURN (SOLO SQLITE)
-- ============================================================
-- Corrige inventory_before/inventory_after del movimiento RETURN al
-- cancelar una venta. En la migración 003 el SELECT que construye el
-- movimiento lee p.stock DESPUÉS del UPDATE de restauración, así que
-- registraba before=stock+base y after=stock+2×base.
--
-- El movimiento OUT ya es correcto (before=stock original, after=stock-base).
-- Para que RETURN sea simétrico se usa la lectura del stock ya restaurado:
--   inventory_before = p.stock - base_quantity   (stock antes de restaurar)
--   inventory_after  = p.stock                   (stock ya restaurado)
--
-- NOTA: el trigger PG del esquema autoritativo tiene el mismo defecto
-- (p.stock, p.stock + base tras el UPDATE); aquí se replica la SEMÁNTICA
-- correcta del movimiento, no el bug de orden.
-- ============================================================

DROP TRIGGER IF EXISTS trg_sales_restore_stock;

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

    -- Movimiento de entrada por cancelación (RETURN) con before/after reales:
    -- p.stock ya quedó restaurado por el UPDATE anterior.
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
        'RETURN', si.base_quantity,
        p.stock - si.base_quantity, p.stock,
        'CANCEL', NEW.id, 'Cancelación de venta ' || NEW.folio_display,
        strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM sale_items si
    JOIN products p ON p.id = si.product_id
    WHERE si.sale_id = NEW.id;
END;
