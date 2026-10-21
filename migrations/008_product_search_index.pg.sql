-- 008 — Índice de búsqueda de productos (PostgreSQL)
--
-- CONTEXTO
--   El buscador de productos filtra con:
--       (p.name LIKE '%termino%' OR p.internal_code = :t OR p.barcode = :t)
--
--   Los dos.matches exactos (internal_code, barcode) YA tienen índice b-tree
--   compuesto con tenant_id (ver migración 001). El problema es el LIKE con
--   % inicial: un índice b-tree no lo puede usar, así que PostgreSQL recorre
--   la tabla entera en cada búsqueda.
--
--   Con la extensión pg_trgm + un índice GIN la búsqueda se resuelve por
--   trigramas y deja de ser un escaneo completo.
--
-- SEGURIDAD DE LA MIGRACIÓN
--   Crear la extensión `pg_trgm` requiere privilegios de superusuario. En
--   muchas instalaciones el usuario de la aplicación NO los tiene. Por eso
--   todo va dentro de un DO $$ $$ con un EXCEPTION handler: si la extensión no
--   se puede crear, la migración termina OK y el índice simplemente no existe.
--   El índice es una OPTIMIZIZACIÓN, nunca un requisito — la búsqueda sigue
--   siendo correcta sin él (solo más lenta con catálogos muy grandes).
--
--   Este bloque NO puede fallar la instalación del servidor.

DO $do$
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pg_trgm no disponible (%). Se omite el indice de busqueda de productos.', SQLERRM;
        RETURN;
    END;

    -- Búsqueda por nombre con comodines (%termino%).
    CREATE INDEX IF NOT EXISTS idx_products_name_trgm
        ON products USING gin (name gin_trgm_ops);

    RAISE NOTICE 'Indice de busqueda de productos creado (pg_trgm + GIN).';
END
$do$;
