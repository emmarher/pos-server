-- ============================================================
-- MIGRACIÓN 002 — TRIGGERS DE CATÁLOGO (SOLO SQLITE/PRUEBAS)
-- ============================================================
-- Replica en SQLite la lógica que en PostgreSQL vive en el esquema
-- autoritativo (esquema_BD_POS_v4_completo.sql). NO se reimplementa en
-- JS: la API solo inserta filas y el trigger hace el trabajo, igual que
-- en producción.
--
-- Triggers replicados (equivalentes SQLite):
--   trg_products_generate_code        → internal_code = prefix + 4 dígitos
--   trg_products_validate_scale       → is_scale_enabled requiere sale_unit MASS
--   trg_products_category_count       → product_count por categoría
--   trg_categories_prevent_deactivate → no desactivar categoría con productos activos
--
-- ADAPTACIÓN SQLite (documentada):
--   - PG usa una SEQUENCE por categoría (seq_prod_{category_id}) y modifica
--     NEW.internal_code en un trigger BEFORE INSERT. SQLite NO soporta
--     asignar NEW en triggers, así que se usa un trigger AFTER INSERT que
--     hace UPDATE del registro recién insertado con el siguiente código
--     (MAX(internal_code)+1 por categoría). Resultado idéntico.
--   - El código manual (internal_code proporcionado) NUNCA se sobrescribe.
-- ============================================================

-- ── internal_code automático (AFTER INSERT + UPDATE, ver nota) ─────────
CREATE TRIGGER trg_products_generate_code
AFTER INSERT ON products
FOR EACH ROW
WHEN NEW.internal_code IS NULL
BEGIN
    UPDATE products
    SET internal_code = (
        SELECT c.prefix || printf(
            '%04d',
            COALESCE(
                MAX(CAST(SUBSTR(p.internal_code, LENGTH(c.prefix) + 1) AS INTEGER)),
                0
            ) + 1
        )
        FROM categories c
        LEFT JOIN products p
               ON p.category_id = c.id
              AND p.internal_code IS NOT NULL
              AND p.id != NEW.id
        WHERE c.id = NEW.category_id
    )
    WHERE id = NEW.id;
END;

-- ── Validación: báscula solo con unidad de venta MASS (BEFORE INSERT) ──
CREATE TRIGGER trg_products_validate_scale_insert
BEFORE INSERT ON products
FOR EACH ROW
WHEN NEW.is_scale_enabled = 1
BEGIN
    SELECT RAISE(ABORT, 'Solo los productos con unidad de venta tipo MASA pueden usar báscula')
    WHERE NOT EXISTS (
        SELECT 1 FROM measurement_units
        WHERE id = NEW.sale_unit_id AND unit_type = 'MASS'
    );
END;

-- Misma validación al ACTUALIZAR (el esquema PG la tiene en BEFORE UPDATE).
CREATE TRIGGER trg_products_validate_scale_update
BEFORE UPDATE OF is_scale_enabled, sale_unit_id ON products
FOR EACH ROW
WHEN NEW.is_scale_enabled = 1
BEGIN
    SELECT RAISE(ABORT, 'Solo los productos con unidad de venta tipo MASA pueden usar báscula')
    WHERE NOT EXISTS (
        SELECT 1 FROM measurement_units
        WHERE id = NEW.sale_unit_id AND unit_type = 'MASS'
    );
END;

-- ── product_count de la categoría (INSERT/UPDATE/DELETE de productos) ──
CREATE TRIGGER trg_products_category_count_insert
AFTER INSERT ON products
FOR EACH ROW
BEGIN
    UPDATE categories
    SET product_count = (
        SELECT COUNT(*) FROM products
        WHERE category_id = NEW.category_id AND is_active = 1
    )
    WHERE id = NEW.category_id;
END;

CREATE TRIGGER trg_products_category_count_update
AFTER UPDATE OF category_id, is_active ON products
FOR EACH ROW
BEGIN
    UPDATE categories
    SET product_count = (
        SELECT COUNT(*) FROM products
        WHERE category_id = OLD.category_id AND is_active = 1
    )
    WHERE id = OLD.category_id;

    UPDATE categories
    SET product_count = (
        SELECT COUNT(*) FROM products
        WHERE category_id = NEW.category_id AND is_active = 1
    )
    WHERE id = NEW.category_id;
END;

CREATE TRIGGER trg_products_category_count_delete
AFTER DELETE ON products
FOR EACH ROW
BEGIN
    UPDATE categories
    SET product_count = (
        SELECT COUNT(*) FROM products
        WHERE category_id = OLD.category_id AND is_active = 1
    )
    WHERE id = OLD.category_id;
END;

-- ── Guardia: no desactivar categoría con productos activos ─────────────
CREATE TRIGGER trg_categories_prevent_deactivate
BEFORE UPDATE OF is_active ON categories
FOR EACH ROW
WHEN NEW.is_active = 0 AND OLD.is_active = 1
BEGIN
    SELECT RAISE(ABORT, 'No se puede desactivar la categoría porque tiene productos activos')
    WHERE EXISTS (
        SELECT 1 FROM products
        WHERE category_id = OLD.id AND is_active = 1
    );
END;
