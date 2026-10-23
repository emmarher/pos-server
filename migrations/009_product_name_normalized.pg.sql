-- 009_product_name_normalized.pg.sql — Búsqueda sin acentos ni mayúsculas.
--
-- ────────────────────────────────────────────────────────────────────────
-- Réplica en PostgreSQL de 009_product_name_normalized.sqlite.sql.
--
-- PROBLEMA
--   `p.name LIKE '%termino%'` en PostgreSQL es sensible a MAYÚSCULAS y a
--   acentos: escribir "arroz" no encontraba "Arroz Verde Valle" y "azucar"
--   no encontraba "Azúcar".
--
-- SOLUCIÓN
--   Columna `name_normalized` (minúsculas y sin acentos) mantenida por la BD
--   mediante un trigger BEFORE INSERT/UPDATE, igual que el esquema
--   autoritativo mantiene `internal_code`.
--
--   Se usa `replace()` encadenado (no la extensión `unaccent`) para que
--   funcione sin privilegios de superusuario y dé el MISMO resultado en
--   SQLite y PostgreSQL.
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE products ADD COLUMN name_normalized VARCHAR(255);

-- Backfill de los productos existentes.
UPDATE products
   SET name_normalized = lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(name,'á','a'),'é','e'),'í','i'),'ó','o'),'ú','u'),'ü','u'),'ñ','n'),'ç','c'),'Á','a'),'É','e'),'Í','i'),'Ó','o'),'Ú','u'),'Ü','u'),'Ñ','n'),'Ç','c'))
 WHERE name IS NOT NULL;

-- ── Trigger: normaliza en cada alta y en cada cambio de nombre ──────────
CREATE OR REPLACE FUNCTION pos_normalize_product_name() RETURNS trigger AS $$
BEGIN
    NEW.name_normalized := lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(NEW.name,'á','a'),'é','e'),'í','i'),'ó','o'),'ú','u'),'ü','u'),'ñ','n'),'ç','c'),'Á','a'),'É','e'),'Í','i'),'Ó','o'),'Ú','u'),'Ü','u'),'Ñ','n'),'Ç','c'));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_name_normalized ON products;
CREATE TRIGGER trg_products_name_normalized
BEFORE INSERT OR UPDATE OF name ON products
FOR EACH ROW EXECUTE FUNCTION pos_normalize_product_name();

-- ── Índice de trigramas (opcional, nunca falla la instalación) ──────────
-- Mismo patrón que la migración 008: si pg_trgm no está disponible, se
-- omite y la búsqueda sigue siendo correcta (solo más lenta).
DO $do$
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pg_trgm no disponible (%). Se omite el indice name_normalized.', SQLERRM;
        RETURN;
    END;

    CREATE INDEX IF NOT EXISTS idx_products_name_normalized_trgm
        ON products USING gin (name_normalized gin_trgm_ops);

    RAISE NOTICE 'Indice name_normalized creado (pg_trgm + GIN).';
END
$do$;
