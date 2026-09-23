-- ============================================================
-- MIGRACIÓN 007 — PIN INICIAL OBLIGATORIO (F-I2b instalador)
-- ============================================================
-- Añade users.must_change_pin: 1 = el usuario debe cambiar su PIN
-- en el próximo login (POST /auth/login responde 403 MUST_CHANGE_PIN).
-- El seed demo lo pone en 1 (forzar cambio de PINs 1234/5678 en
-- instalaciones frescas); el default 0 no afecta filas existentes.
-- Adaptación SQLite: BOOLEAN → INTEGER 0/1 (convención migración 001).
-- ============================================================

ALTER TABLE users ADD COLUMN must_change_pin INTEGER NOT NULL DEFAULT 0;
