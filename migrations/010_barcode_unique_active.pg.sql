-- 010 — La unicidad del barcode/sku es SOLO entre productos ACTIVOS (PostgreSQL).
--
-- Motivo: al borrar un producto se hace borrado lógico (is_active=false) y su
-- barcode/sku seguía ocupando la UNIQUE, bloqueando que el código se volviera
-- a usar (crear de nuevo, corregir un código equivocado o asignarlo a otro
-- producto) con un 409 "ya existe".
-- Con esta migración, un barcode/sku de un producto inactivo queda LIBRE: puede
-- asignarse a cualquier producto activo o a uno nuevo. Dos productos ACTIVOS
-- con el mismo código siguen prohibidos.
--
-- internal_code NO se toca: lo genera la BD (secuencia) y nunca se repite
-- entre filas, por lo que su UNIQUE (excluye solo NULL) ya es correcto.
--
-- La constraint viene de la creación de la tabla (esquema autoritativo); en
-- instalaciones existentes se DROPEA y se RECREA con la nueva condición parcial.

ALTER TABLE products DROP CONSTRAINT IF EXISTS uq_products_barcode;
ALTER TABLE products ADD CONSTRAINT uq_products_barcode
  UNIQUE (tenant_id, barcode) WHERE barcode IS NOT NULL AND is_active = true;

ALTER TABLE products DROP CONSTRAINT IF EXISTS uq_products_sku;
ALTER TABLE products ADD CONSTRAINT uq_products_sku
  UNIQUE (tenant_id, sku) WHERE sku IS NOT NULL AND is_active = true;