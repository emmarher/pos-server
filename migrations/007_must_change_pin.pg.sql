-- ============================================================
-- MIGRACIÓN 007 — PIN INICIAL OBLIGATORIO (F-I2b instalador)
-- PostgreSQL (producción / nube)
-- ============================================================
-- Réplica de 007_must_change_pin.sqlite.sql con tipos nativos PG.
-- ============================================================

ALTER TABLE users ADD COLUMN must_change_pin BOOLEAN NOT NULL DEFAULT false;
