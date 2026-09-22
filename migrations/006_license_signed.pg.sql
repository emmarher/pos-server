-- ============================================================
-- MIGRACIÓN 006 — SISTEMA DE LICENCIAS FIRMADAS (ED25519)
-- PostgreSQL (producción / nube)
-- ============================================================
-- Replica la migración SQLite 006 con tipos nativos de PostgreSQL:
--   UUID, TIMESTAMPTZ, BOOLEAN, BIGINT, JSONB
-- Vease la migración .sqlite.sql para la documentación completa.
-- ============================================================

-- 1) license_state: almacena la licencia firmada verificada al arranque
CREATE TABLE license_state (
    tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    lic_id VARCHAR(100) NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    license_key VARCHAR(255),
    customer VARCHAR(255),
    branch VARCHAR(255),
    seats INTEGER NOT NULL DEFAULT 2,
    features JSONB NOT NULL DEFAULT '[]'::jsonb,
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    hw_fingerprint TEXT,
    signature_base64 TEXT NOT NULL,
    payload_base64 TEXT NOT NULL,
    is_valid BOOLEAN NOT NULL DEFAULT true,
    validated_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) license_anti_rollback: contador monotónico + HMAC + última venta
CREATE TABLE license_anti_rollback (
    tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    counter BIGINT NOT NULL DEFAULT 0,
    counter_hmac TEXT NOT NULL,
    last_sale_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    clock_rollback_grace_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) license_audit: log de eventos de licencia
CREATE TABLE license_audit (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL CHECK (
        event_type IN ('LOADED', 'VALIDATED', 'EXPIRED', 'SUSPENDED',
                       'RENEWED', 'UPGRADED', 'UPLOADED',
                       'CLOCK_ROLLBACK', 'FINGERPRINT_MISMATCH', 'INVALID_SIGNATURE')
    ),
    message TEXT,
    severity VARCHAR(10) CHECK (severity IN ('INFO', 'WARN', 'ERROR')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4) Extensión de active_sessions con heartbeat
ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS is_heartbeat_exempt BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_license_audit_tenant ON license_audit(tenant_id, created_at);
CREATE INDEX idx_license_anti_rollback_counter ON license_anti_rollback(tenant_id, counter);
