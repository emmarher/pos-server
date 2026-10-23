-- 009_product_name_normalized.sqlite.sql — Búsqueda sin acentos ni mayúsculas.
--
-- ────────────────────────────────────────────────────────────────────────
-- PROBLEMA
--   El buscador filtraba con `p.name LIKE '%termino%'`. SQLite solo ignora
--   mayúsculas en ASCII, así que escribir "azucar" no encontraba "Azúcar"
--   ni "pina" encontraba "Piña".
--
-- SOLUCIÓN
--   Columna `name_normalized` = nombre en minúsculas y sin acentos,
--   mantenida por la BD (backfill + triggers), igual que `internal_code`.
--   La API solo consulta `name_normalized LIKE '%azucar%'`.
--
--   Cubre el español en minúsculas y mayúsculas: á é í ó ú ü ñ ç.
--   `lower()` de SQLite solo convierte ASCII, por eso las vocales
--   acentuadas en mayúscula se mapean explícitamente antes del `lower()`.
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE products ADD COLUMN name_normalized TEXT;

-- Backfill de los productos existentes.
UPDATE products
   SET name_normalized = lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(name,'á','a'),'é','e'),'í','i'),'ó','o'),'ú','u'),'ü','u'),'ñ','n'),'ç','c'),'Á','a'),'É','e'),'Í','i'),'Ó','o'),'Ú','u'),'Ü','u'),'Ñ','n'),'Ç','c'))
 WHERE name IS NOT NULL;

-- Índice de apoyo (multi-tenant). El LIKE '%…%' no lo usa, pero sí las
-- búsquedas por prefijo y el ORDER BY.
CREATE INDEX IF NOT EXISTS idx_products_name_normalized
    ON products(tenant_id, name_normalized);

-- ── Trigger: altas ─────────────────────────────────────────────────────
-- SQLite no permite asignar NEW en un trigger BEFORE, así que se recalcula
-- con un UPDATE del propio registro (mismo patrón que trg_products_generate_code).
-- El UPDATE solo toca name_normalized, por lo que NO vuelve a disparar los
-- triggers de UPDATE OF name / category_id / is_active.
CREATE TRIGGER trg_products_name_norm_insert
AFTER INSERT ON products
FOR EACH ROW
BEGIN
    UPDATE products
       SET name_normalized = lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(NEW.name,'á','a'),'é','e'),'í','i'),'ó','o'),'ú','u'),'ü','u'),'ñ','n'),'ç','c'),'Á','a'),'É','e'),'Í','i'),'Ó','o'),'Ú','u'),'Ü','u'),'Ñ','n'),'Ç','c'))
     WHERE id = NEW.id;
END;

-- ── Trigger: cambios de nombre ─────────────────────────────────────────
CREATE TRIGGER trg_products_name_norm_update
AFTER UPDATE OF name ON products
FOR EACH ROW
BEGIN
    UPDATE products
       SET name_normalized = lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(NEW.name,'á','a'),'é','e'),'í','i'),'ó','o'),'ú','u'),'ü','u'),'ñ','n'),'ç','c'),'Á','a'),'É','e'),'Í','i'),'Ó','o'),'Ú','u'),'Ü','u'),'Ñ','n'),'Ç','c'))
     WHERE id = NEW.id;
END;
