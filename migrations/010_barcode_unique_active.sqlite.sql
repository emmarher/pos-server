-- 010 — La unicidad del barcode/sku es SOLO entre productos ACTIVOS (SQLite).
--
-- Motivo: al borrar un producto se hace borrado lógico (is_active=0) y su
-- barcode/sku seguía ocupando el índice único, bloqueando que el código se
-- volviera a usar (crear de nuevo, corregir un código equivocado o asignarlo
-- a otro producto) con un 409 "ya existe".
-- Con esta migración, un barcode/sku de un producto inactivo queda LIBRE:
-- puede asignarse a cualquier producto activo o a uno nuevo. Dos productos
-- ACTIVOS con el mismo código siguen prohibidos.
--
-- internal_code NO se toca: lo genera la BD (secuencia) y nunca se repite
-- entre filas, por lo que su índice único (excluye solo NULL) ya es correcto.
DROP INDEX IF EXISTS uq_products_barcode;
CREATE UNIQUE INDEX uq_products_barcode ON products(tenant_id, barcode)
  WHERE barcode IS NOT NULL AND is_active = 1;

DROP INDEX IF EXISTS uq_products_sku;
CREATE UNIQUE INDEX uq_products_sku ON products(tenant_id, sku)
  WHERE sku IS NOT NULL AND is_active = 1;