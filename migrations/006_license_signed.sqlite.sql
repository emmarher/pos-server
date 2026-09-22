-- ============================================================
-- MIGRACIÓN 006 — SISTEMA DE LICENCIAS FIRMADAS (ED25519)
-- ============================================================
-- Añade las tablas para el sistema de licencias firmadas con Ed25519:
--   1) license_state          — estado de la licencia verificada
--   2) license_anti_rollback  — contador monotónico + HMAC contra rollback de reloj
--   3) license_audit          — log de eventos de licencia
-- También extiende active_sessions con columnas de heartbeat para gestión de asientos.
--
-- Adaptaciones SQLite (siguen la convención de la migración 001):
--   TIMESTAMP WITH TIME ZONE →  TEXT (ISO-8601)
--   UUID                     →  TEXT
--   BOOLEAN                  →  INTEGER 0/1
--   JSONB                    →  TEXT
-- ============================================================

-- 1) license_state: almacena la licencia firmada verificada al arranque
--    y al subir una nueva vía POST /license/upload.
CREATE TABLE license_state (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    lic_id VARCHAR(100) NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    license_key VARCHAR(255),
    customer VARCHAR(255),
    branch VARCHAR(255),
    seats INTEGER NOT NULL DEFAULT 2,
    features TEXT NOT NULL DEFAULT '[]',
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    hw_fingerprint TEXT,
    signature_base64 TEXT NOT NULL,
    payload_base64 TEXT NOT NULL,
    is_valid INTEGER NOT NULL DEFAULT 1,
    validated_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 2) license_anti_rollback: contador monotónico + HMAC + última venta
--    Detecta retroceso de reloj y manipulación de la BD.
--    La clave HMAC se deriva de jwtSecret + lic_id (única por tenant).
CREATE TABLE license_anti_rollback (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    counter INTEGER NOT NULL DEFAULT 0,
    counter_hmac TEXT NOT NULL,
    last_sale_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    clock_rollback_grace_until TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 3) license_audit: log de eventos de licencia (soporte + auditoría)
CREATE TABLE license_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL CHECK (
        event_type IN ('LOADED', 'VALIDATED', 'EXPIRED', 'SUSPENDED',
                       'RENEWED', 'UPGRADED', 'UPLOADED',
                       'CLOCK_ROLLBACK', 'FINGERPRINT_MISMATCH', 'INVALID_SIGNATURE')
    ),
    message TEXT,
    severity VARCHAR(10) CHECK (severity IN ('INFO', 'WARN', 'ERROR')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 4) Extensión de active_sessions con heartbeat para gestión de asientos
--    El cliente envía POST /auth/heartbeat cada 30s; sesiones sin heartbeat
--    en 90s se invalidan (liberan asientos). Admin exento (is_heartbeat_exempt=1).
ALTER TABLE active_sessions ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE active_sessions ADD COLUMN is_heartbeat_exempt INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_license_audit_tenant ON license_audit(tenant_id, created_at);
CREATE INDEX idx_license_anti_rollback_counter ON license_anti_rollback(tenant_id, counter);
