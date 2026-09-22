/**
  * src/types/license.ts — Tipos del sistema de licencias firmadas (Ed25519).
  *
  * ────────────────────────────────────────────────────────────────────────
  * El .lic es `base64url(payload_json).base64url(firma_Ed25519)`.
  * El payload contiene los metadatos de la licencia (lic_id, customer,
  * seats, expires, features, hw_fingerprint). La firma garantiza integridad
  * e integridad del origen: si el cliente modifica el .lic, la verificación
  * de Ed25519 falla y el servidor entra en modo degradado.
  * ────────────────────────────────────────────────────────────────────────
  */

/* Schema version del formato de licencia (PRD §2.1). */
export const LICENSE_SCHEMA_VERSION = 1 as const

/* Gracias en días (PRD §3 checklist, pasos 6-7). */
export const CLOCK_ROLLBACK_GRACE_DAYS = 7 as const
export const FINGERPRINT_GRACE_DAYS = 15 as const

/* TTL de heartbeat de asientos (segundos). */
export const HEARTBEAT_TTL_SECONDS = 90 as const

/* Avisos de vencimiento (días). */
export const EXPIRY_WARNING_DAYS = 30 as const
export const EXPIRY_CRITICAL_DAYS = 7 as const

/** Payload decodificado del .lic (lo que está firmado). */
export interface LicensePayload {
  /** Versión del formato (1 = Ed25519). */
  schema: number
  /** ID único de la licencia: LIC-YYYY-NNNNNN. */
  lic_id: string
  /** license_key del tenant al que se asigna la licencia. */
  license_key: string
  /** Nombre del cliente. */
  customer: string
  /** Sucursal (branch) que autoriza. */
  branch: string
  /** Número de asientos/dispositivos. */
  seats: number
  /** Features habilitados (inventory, garage, reports…). */
  features: string[]
  /** Fecha de emisión ISO-8601. */
  issued: string
  /** Fecha de vencimiento ISO-8601. */
  expires: string
  /** Hardware fingerprint (null = sin binding). */
  hw_fingerprint: string | null
}

/** Resultado de la verificación criptográfica (pasos 2-3). */
export interface LicenseVerification {
  /** true si la firma Ed25519 verifica contra la public key. */
  valid: boolean
  /** Payload decodificado (null si la firma falla — no revelar detalles). */
  payload: LicensePayload | null
  /** Mensaje interno de error (no se expone al cliente). */
  error?: string
}

/** Estado interno del checklist (8 pasos). Solo para logs/auditoria, no se expone tal cual. */
export type LicenseStatus =
  | 'active'
  | 'expired'
  | 'grace_clock'
  | 'grace_fingerprint'
  | 'expired_grace_clock'
  | 'expired_grace_fingerprint'
  | 'invalid'
  | 'invalid_signature'
  | 'unsupported_schema'
  | 'missing'

/** Estado externo que ve el cliente (API). Canonico para todos los contratos (auth, license, mobile). */
export type LicenseApiStatus = 'active' | 'expired' | 'grace'

/** Estado de la licencia tal como se expone a los clientes. Canonico: usado por auth, license y mobile. */
export interface LicenseInfo {
  status: LicenseApiStatus
  expires_at: string
  max_devices: number
  lic_id: string | null
  customer: string | null
  features: string[]
  warning_level: 'none' | 'warning' | 'critical' | null
  /** Si status==='grace', motivo de la gracia (clock=retroceso, fingerprint=HW). */
  grace_reason?: 'clock' | 'fingerprint' | null
  /** ISO-8601 de cuando termina la gracia (null si no hay gracia). */
  grace_expires_at?: string | null
}

/** Resultado del anti-rollback (checklist paso 6). */
export interface ClockRollbackStatus {
  /** true si se detectó retroceso de reloj o manipulación de BD. */
  rollbackDetected: boolean
  /** true si sigue dentro del período de gracia de 7 días. */
  inGracePeriod: boolean
  /** ISO-8601 de cuándo termina la gracia (null si no hay gracia). */
  graceExpiresAt: string | null
}

/** Row de license_state (tabla interna). */
export interface LicenseStateRow {
  tenant_id: string
  lic_id: string
  schema_version: number
  license_key: string
  customer: string
  branch: string
  seats: number
  features: string
  issued_at: string
  expires_at: string
  hw_fingerprint: string | null
  signature_base64: string
  payload_base64: string
  is_valid: number
  validated_at: string
  updated_at: string
}

/** Row de license_anti_rollback (tabla interna). */
export interface AntiRollbackRow {
  tenant_id: string
  counter: number
  counter_hmac: string
  last_sale_at: string
  clock_rollback_grace_until: string | null
  created_at: string
  updated_at: string
}

/** Info de auditoría para la UI / logs. */
export interface LicenseAuditInfo {
  status: LicenseStatus
  lic_id: string | null
  customer: string | null
  expires_at: string
  seats: number
  features: string[]
  warning_level: 'none' | 'warning' | 'critical' | null
  clockRollbackGraceUntil: string | null
}

/** Nivel de aviso previo a vencimiento (30/7 días). */
export type ExpiryWarning = 'none' | 'warning' | 'critical'
