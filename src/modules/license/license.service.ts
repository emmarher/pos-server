/**
 * src/modules/license/license.service.ts — Servicio de licencias firmadas (Ed25519).
 *
 * ─────────────────────────────────────────────────────────────────────
 * Qué hace este módulo (checklist de los 8 pasos del PRD):
 *
 *   Verificación en arranque (validateLicenseAtStartup):
 *     1. ¿Existe el archivo .lic?            → missing (degraded)
 *     2. ¿Formato correcto (payload.sig)?    → invalid (RECHAZAR)
 *     3. ¿Firma verifica con clave pública?  → invalid (RECHAZAR)
 *     4. ¿Schema soportado?                  → unsupported_schema (aviso)
 *     5. ¿Fecha expirada?                     → expired (degraded: bloquea ventas)
 *     6. ¿Retroceso de reloj?                → grace_clock (7 días + log)
 *     7. ¿Fingerprint no coincide?           → grace_fingerprint (15 días)
 *     8. ✅ Operación normal
 *
 * Regla crítica: pasos 2-3 (firma) son fatales → no se revela el error al
 * cliente, solo "Licencia inválida. Contacte a soporte." Los pasos 5-7
 * (fecha/hardware/reloj) son degradados — nunca se pierden los datos.
 *
 * Seguridad por capas (PRD §4):
 *   - Criptográfica: Ed25519, clave privada cifrada AES-256-CBC, fuera del repo
 *   - Anti-rollback: contador monotónico + HMAC + última venta en license_anti_rollback
 *   - Asientos: heartbeat 30s + TTL 90s en active_sessions (admin exento)
 *
 * El .lic se valida al arranque y su payload actualiza los campos de `tenants`
 * (license_expires_at, max_devices, is_active) — la validación de login y el
 * middleware authenticate continúan leyendo de la BD como siempre.
 * ─────────────────────────────────────────────────────────────────────
 */
import { verify, createHmac, createHash, createPublicKey, sign, createPrivateKey } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import type { FastifyInstance } from 'fastify'
import { env } from '../../config/env.js'
import { db, type DbClient } from '../../database/client.js'
import { HttpError } from '../../types/errors.js'
import { PUBLIC_KEY_PEM, IS_TEST_KEY } from '../../keys/publicKey.js'
import { TRIAL_PUBLIC_KEY_PEM } from '../../keys/trialPublicKey.js'
import type {
  LicensePayload,
  LicenseVerification,
  LicenseStatus,
  LicenseInfo,
  ClockRollbackStatus,
} from '../../types/license.js'
import {
  LICENSE_SCHEMA_VERSION,
  CLOCK_ROLLBACK_GRACE_DAYS,
  FINGERPRINT_GRACE_DAYS,
  EXPIRY_WARNING_DAYS,
  EXPIRY_CRITICAL_DAYS,
  TRIAL_LICENSE_DAYS,
} from '../../types/license.js'

/* ── Helpers internos ────────────────────────────────────────────── */

/** Datos del tenant + license_state para el checklist. */
interface ActiveTenantRow {
  id: string
  license_key: string
  name: string
  is_active: number
  license_expires_at: string
  max_devices: number
}

/** Fila de license_state para anti-rollback + status. (no usada directo: se lee via tipos license.ts) */

/** Fila de anti-rollback. */
interface AntiRollbackRow {
  counter: number
  counter_hmac: string
  last_sale_at: string
  clock_rollback_grace_until: string | null
}

/** Directorio de datos persistentes (al lado del .lic y de la BD). */
function dataDir(): string {
  return dirname(env.licenseFilePath)
}

/**
 * Registra un evento en license_audit.
 * severity: INFO (inofensivo), WARN (requiere atención), ERROR (crítico).
 */
async function logLicenseAudit(
  tenantId: string,
  eventType: string,
  message: string | null,
  severity: 'INFO' | 'WARN' | 'ERROR',
  client: DbClient = db,
): Promise<void> {
  // IMPORTANTE: usar `client`, NO `db` global. Si esta función se llama DENTRO
  // de una db.transaction y usara db.query (conexión separada), en SQLite
  // intentaría adquirir el lock de escritura que ya sostiene la transacción →
  // SQLITE_BUSY / deadlock. El caller pasa `tx` cuando está en transacción.
  await client.query(
    `INSERT INTO license_audit (tenant_id, event_type, message, severity)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, eventType, message, severity],
  )
}

/* ── 1) Verificación de firma Ed25519 ─────────────────────────────── */

/**
 * Verifica la firma Ed25519 de una licencia y decodifica el payload.
 * Implementa los steps 2-3 del checklist (formato + firma).
 *
 * @param licContent  String "base64url(payload).base64url(signature)"
 * @param publicKeyPem Clave pública PEM (default: la embebida en build)
 * @returns LicenseVerification con { valid, payload, error }
 */
export function verifyLicenseSignature(
  licContent: string,
  publicKeyPem?: string,
): LicenseVerification {
  // Step 2: Formato correcto (payload.signature)
  if (typeof licContent !== 'string') {
    return { valid: false, payload: null, error: 'Input is not a string' }
  }

  const parts = licContent.split('.')
  if (parts.length !== 2) {
    return { valid: false, payload: null, error: 'Invalid format: expected payload.signature' }
  }

  const [payloadB64, signatureB64] = parts
  if (!payloadB64 || !signatureB64) {
    return { valid: false, payload: null, error: 'Empty payload or signature' }
  }

  let data: Buffer
  let signature: Buffer
  try {
    data = Buffer.from(payloadB64, 'base64url')
    signature = Buffer.from(signatureB64, 'base64url')
  } catch {
    return { valid: false, payload: null, error: 'Base64url decode error' }
  }

  // Step 3: Verificar firma Ed25519. Prueba familia main y luego trial (aisladas).
  const candidates: string[] = []
  if (publicKeyPem) {
    candidates.push(publicKeyPem)
  } else {
    if (PUBLIC_KEY_PEM) candidates.push(PUBLIC_KEY_PEM)
    if (TRIAL_PUBLIC_KEY_PEM) candidates.push(TRIAL_PUBLIC_KEY_PEM)
  }
  if (candidates.length === 0) {
    return { valid: false, payload: null, error: 'No public key embedded' }
  }

  let isValid = false
  for (const pem of candidates) {
    try {
      const publicKey = createPublicKey({ key: pem, type: 'spki' })
      if (verify(null, data, publicKey, signature)) {
        isValid = true
        break
      }
    } catch {
      // PEM inválido → probar siguiente candidato
    }
  }
  if (!isValid) {
    // NO revelar el error específico al cliente (regla crítica del PRD §3)
    return { valid: false, payload: null, error: 'Ed25519 signature verification failed' }
  }

  try {
    const payload = JSON.parse(data.toString('utf8')) as LicensePayload
    return { valid: true, payload }
  } catch {
    return { valid: false, payload: null, error: 'Payload is not valid JSON' }
  }
}

/* ── 2) Carga del archivo .lic ────────────────────────────────────── */

/**
 * Lee el archivo .lic desde el disco (step 1 del checklist).
 * Devuelve null si no existe → modo degradado.
 */
export function loadLicenseFile(): string | null {
  try {
    if (!existsSync(env.licenseFilePath)) {
      return null
    }
    return readFileSync(env.licenseFilePath, 'utf8').trim()
  } catch {
    return null
  }
}

/* ── 3) Resolución del tenant ─────────────────────────────────────── */

/**
 * Obtiene el tenant activo (el servidor es single-tenant en la sucursal).
 * Devuelve null si no hay tenant activo (instalación fresh).
 */
async function getActiveTenant(): Promise<ActiveTenantRow | null> {
  const { rows } = await db.query<ActiveTenantRow>(
    `SELECT id, license_key, name, is_active, license_expires_at, max_devices
     FROM tenants
     WHERE is_active = 1
     LIMIT 1`,
  )
  return rows[0] ?? null
}

/**
 * Resuelve el tenant INACTIVO al que pertenece un .lic con firma válida.
 *
 * Por qué: si un arranque previo desactivó el tenant (licencia vencida o
 * gracia expirada), `getActiveTenant()` ya no lo devuelve y la validación
 * del arranque se salta → el tenant queda bloqueado para siempre (login 403)
 * aunque haya un .lic válido en disco. Con este fallback la licencia firmada
 * vuelve a mandar: si su firma es válida, el tenant se reactiva.
 */
async function findTenantByLicenseKey(licenseKey: string): Promise<ActiveTenantRow | null> {
  const { rows } = await db.query<ActiveTenantRow>(
    `SELECT id, license_key, name, is_active, license_expires_at, max_devices
     FROM tenants
     WHERE license_key = $1
     LIMIT 1`,
    [licenseKey],
  )
  return rows[0] ?? null
}

/** Trae un tenant por su id (activo o inactivo). */
async function getTenantById(tenantId: string): Promise<ActiveTenantRow | null> {
  const { rows } = await db.query<ActiveTenantRow>(
    `SELECT id, license_key, name, is_active, license_expires_at, max_devices
     FROM tenants
     WHERE id = $1
     LIMIT 1`,
    [tenantId],
  )
  return rows[0] ?? null
}

/* ── 4) Aplicar licencia al tenant ────────────────────────────────── */

/**
 * Actualiza los campos de `tenants` desde el payload verificado.
 * La licencia firmada es la fuente de verdad: license_expires_at, max_devices
 * e is_active se sincronizan desde el .lic al arranque y al subir uno nuevo.
 *
 * MODO DEV (LICENSE_DEV_MODE): la licencia NUNCA bloquea al tenant. Si el
 * payload está vencido (o es inválido) se extiende la vigencia y el tenant
 * queda operativo. En producción esta rama nunca se ejecuta.
 */
async function applyLicenseToTenant(
  tx: DbClient,
  tenantId: string,
  payload: LicensePayload,
  isActive: boolean,
): Promise<void> {
  const nowIso = new Date().toISOString()
  let expires = payload.expires
  let active = isActive

  if (env.licenseDevMode) {
    active = true
    const expMs = new Date(expires).getTime()
    if (!expires || !Number.isFinite(expMs) || expMs <= Date.now()) {
      expires = devLicenseExpiry()
    }
  }

  await tx.query(
    `UPDATE tenants
     SET license_expires_at = $1,
         max_devices = $2,
         is_active = $3,
         updated_at = $4
     WHERE id = $5`,
    [expires, payload.seats, active ? 1 : 0, nowIso, tenantId],
  )
}

/**
 * Vigencia de la licencia cuando el modo dev tiene que extenderla.
 * `now + LICENSE_DEV_DAYS` (default 365 días).
 */
function devLicenseExpiry(): string {
  return new Date(Date.now() + env.licenseDevDays * 24 * 60 * 60 * 1000).toISOString()
}

/* ── 5) Almacenar estado de licencia ──────────────────────────────── */

/**
 * UPSERT en license_state: guarda el payload completo + firma verificada.
 * Sirve para auditoría, UI (lic_id, customer, features) y anti-rollback.
 */
async function storeLicenseState(
  tx: DbClient,
  tenantId: string,
  payload: LicensePayload,
  licContent: string,
  isValid: boolean,
): Promise<void> {
  const [payloadB64, signatureB64] = licContent.split('.')
  const nowIso = new Date().toISOString()
  // La firma ya fue verificada por el caller (validateLicenseAtStartup / uploadLicense).
  // No se re-verifica aqui para evitar doble costo y errores genericos.

  // Si la licencia RENUEVA (cambia el lic_id), el sello HMAC del contador
  // anti-rollback debe re-ligarse a la nueva lic_id (el CONTADOR no se
  // reinicia). Se hace ANTES del upsert para poder comparar con el lic_id
  // vigente. Si no se re-liga, el arranque siguiente lee
  // "HMAC mismatch: posible manipulación de BD" y DESACTIVA el tenant
  // (login 403 + ventas bloqueadas) pese a tener una licencia válida.
  const { rows: prevStateRows } = await tx.query<{ lic_id: string }>(
    'SELECT lic_id FROM license_state WHERE tenant_id = $1',
    [tenantId],
  )
  await rebindAntiRollbackIfLicenseChanged(
    tx,
    tenantId,
    prevStateRows[0]?.lic_id,
    payload.lic_id,
  )

  await tx.query(
    `INSERT INTO license_state (
       tenant_id, lic_id, schema_version, license_key, customer, branch,
       seats, features, issued_at, expires_at, hw_fingerprint,
       signature_base64, payload_base64, is_valid, validated_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (tenant_id) DO UPDATE SET
       lic_id = excluded.lic_id,
       schema_version = excluded.schema_version,
       license_key = excluded.license_key,
       customer = excluded.customer,
       branch = excluded.branch,
       seats = excluded.seats,
       features = excluded.features,
       issued_at = excluded.issued_at,
       expires_at = excluded.expires_at,
       hw_fingerprint = excluded.hw_fingerprint,
       signature_base64 = excluded.signature_base64,
       payload_base64 = excluded.payload_base64,
       is_valid = excluded.is_valid,
       validated_at = excluded.validated_at,
       updated_at = excluded.updated_at`,
    [
      tenantId,
      payload.lic_id,
      payload.schema,
      payload.license_key,
      payload.customer,
      payload.branch,
      payload.seats,
      JSON.stringify(payload.features),
      payload.issued,
      payload.expires,
      payload.hw_fingerprint,
      signatureB64 ?? '',
      payloadB64 ?? '',
      isValid ? 1 : 0,
      nowIso,
      nowIso,
    ],
  )
}

/* ── 6) Anti-rollback ─────────────────────────────────────────────── */

/**
 * Inicializa la fila de license_anti_rollback si no existe.
 * counter=0, HMAC=HMAC(0, jwtSecret+lic_id), last_sale_at=NOW().
 *
 * NO re-liga el sello de una fila existente a propósito: el sello atado a otra
 * lic_id es la señal de que la licencia cambió (renovación) y se resuelve
 * con rebindAntiRollbackIfLicenseChanged(). Así una manipulación real del
 * contador (misma licencia) sigue detectándose.
 */
async function initAntiRollback(
  tx: DbClient,
  tenantId: string,
  licId: string,
): Promise<void> {
  const nowIso = new Date().toISOString()
  const hmac = computeCounterHmac(0, licId)
  await tx.query(
    `INSERT INTO license_anti_rollback (tenant_id, counter, counter_hmac, last_sale_at, created_at, updated_at)
     VALUES ($1, 0, $2, $3, $3, $3)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, hmac, nowIso],
  )
}

/**
 * Re-liga el sello HMAC del contador anti-rollback cuando el tenant RENUEVA la
 * licencia (nuevo `lic_id`). El CONTADOR NO se reinicia: la protección real
 * es el contador monotónico; el sello solo ata el contador a la licencia que
 * lo emitió (deriva de `LICENSE_HMAC_SECRET + lic_id`).
 *
 * Sin esto, al cargar la licencia nueva el sello seguía atado a la lic_id
 * anterior → "HMAC mismatch: posible manipulación de BD" en el arranque
 * siguiente → tenant desactivado (login 403 + ventas bloqueadas).
 *
 * Solo se re-liga si el `lic_id` de `license_state` CAMBIÓ realmente: con la
 * misma licencia el sello no se toca y una manipulación del contador sigue
 * detectándose.
 */
async function rebindAntiRollbackIfLicenseChanged(
  client: DbClient,
  tenantId: string,
  prevLicId: string | null | undefined,
  newLicId: string,
): Promise<void> {
  if (!prevLicId || prevLicId === newLicId) return
  const { rows } = await client.query<{ counter: number }>(
    `SELECT counter FROM license_anti_rollback WHERE tenant_id = $1`,
    [tenantId],
  )
  const row = rows[0]
  if (!row) return
  const hmac = computeCounterHmac(row.counter, newLicId)
  await client.query(
    `UPDATE license_anti_rollback SET counter_hmac = $1, updated_at = $2 WHERE tenant_id = $3`,
    [hmac, new Date().toISOString(), tenantId],
  )
}

/**
 * HMAC-SHA256 del contador. La clave deriva de licenseHmacSecret + lic_id
 * (si no se fija LICENSE_HMAC_SECRET, cae a JWT_SECRET por compatibilidad).
 */
function computeCounterHmac(counter: number, licId: string): string {
  return createHmac('sha256', env.licenseHmacSecret + licId)
    .update(counter.toString())
    .digest('hex')
}

/**
 * Extrae los `lic_id` mencionados en los últimos mensajes de auditoría del
 * tenant. Sirve para PROBAR que un sello anti-rollback pertenece a una
 * licencia ANTERIOR del mismo tenant (renovación) y no a una manipulación de
 * BD: si el sello valida contra un lic_id histórico, es auténtico (hace falta
 * el secreto para calcularlo).
 */
async function findHistoricalLicIds(
  tenantId: string,
  client: DbClient = db,
  limit = 100,
): Promise<string[]> {
  const { rows } = await client.query<{ message: string | null }>(
    `SELECT message FROM license_audit
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [tenantId, limit],
  )
  const ids = new Set<string>()
  for (const r of rows) {
    const matches = (r.message ?? '').match(/\b(?:LIC|TRIAL)-[A-Za-z0-9._-]+/g)
    if (matches) for (const m of matches) ids.add(m)
  }
  return [...ids]
}

/**
 * Verifica el contador anti-rollback antes de una venta (checklist step 6).
 *  a) HMAC del contador (detecta manipulación de BD)
 *  b) Última venta no en el futuro (detecta retroceso de reloj)
 * Si el rollback se detecta y la gracia de 7 días expiró → HttpError.
 * Si la gracia sigue activa → deja pasar (con log).
 */
export async function checkAntiRollback(
  tenantId: string,
  client: DbClient = db,
): Promise<ClockRollbackStatus> {
  const { rows } = await client.query<AntiRollbackRow>(
    `SELECT counter, counter_hmac, last_sale_at, clock_rollback_grace_until
     FROM license_anti_rollback
     WHERE tenant_id = $1`,
    [tenantId],
  )
  const row = rows[0]
  if (!row) {
    // No hay estado anti-rollback (dev/test sin license_state)
    return { rollbackDetected: false, inGracePeriod: false, graceExpiresAt: null }
  }

  // Obtiene lic_id de license_state para derivar la clave HMAC
  const { rows: lsRows } = await client.query<{ lic_id: string }>(
    'SELECT lic_id FROM license_state WHERE tenant_id = $1',
    [tenantId],
  )
  const licId = lsRows[0]?.lic_id ?? ''

  // a) Verificar HMAC (detiene manipulación de BD)
  const expectedHmac = computeCounterHmac(row.counter, licId)
  if (expectedHmac !== row.counter_hmac) {
    /* El sello no corresponde al lic_id vigente. Antes de acusar "manipulación
       de BD" se comprueba si corresponde a una licencia ANTERIOR del mismo
       tenant (renovación mal re-ligada por versiones previas a 0.2.7). Si el
       sello valida contra un lic_id histórico es AUTÉNTICO (hace falta el
       secreto para calcularlo) → se re-sella con el lic_id vigente y el
       contador se conserva. Si no valida contra ninguno → manipulación real. */
    const historical = await findHistoricalLicIds(tenantId, client)
    const legacyLicId = historical.find(
      (id) => id !== licId && computeCounterHmac(row.counter, id) === row.counter_hmac,
    )
    if (legacyLicId) {
      await client.query(
        `UPDATE license_anti_rollback
         SET counter_hmac = $1, updated_at = $2
         WHERE tenant_id = $3`,
        [expectedHmac, new Date().toISOString(), tenantId],
      )
      await logLicenseAudit(
        tenantId,
        'VALIDATED',
        `Sello anti-rollback re-ligado de ${legacyLicId} a ${licId} (renovación) — contador conservado`,
        'WARN',
        client,
      )
    } else {
      await logLicenseAudit(
        tenantId,
        'CLOCK_ROLLBACK',
        `HMAC mismatch: counter=${row.counter}, posible manipulación de BD`,
        'ERROR',
        client,
      )
      return { rollbackDetected: true, inGracePeriod: false, graceExpiresAt: null }
    }
  }

  // b) Verificar retroceso de reloj (last_sale_at en el futuro)
  const now = new Date()
  const lastSale = new Date(row.last_sale_at)
  // Tolerancia de 5 minutos para ajustes NTP legítimos
  const toleranceMs = 5 * 60 * 1000
  if (now.getTime() < lastSale.getTime() - toleranceMs) {
    const graceEnd = row.clock_rollback_grace_until
      ? new Date(row.clock_rollback_grace_until)
      : null

    if (graceEnd && now.getTime() > graceEnd.getTime()) {
      // Gracia expiró → bloquear
      await logLicenseAudit(
        tenantId,
        'CLOCK_ROLLBACK',
        `Retroceso de reloj: last_sale_at=${row.last_sale_at}, gracia expirada`,
        'ERROR',
        client,
      )
      return { rollbackDetected: true, inGracePeriod: false, graceExpiresAt: null }
    }

    if (!graceEnd) {
      // Primera detección: establecer gracia de 7 días
      const graceUntil = new Date(
        now.getTime() + CLOCK_ROLLBACK_GRACE_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString()
      await client.query(
        `UPDATE license_anti_rollback
         SET clock_rollback_grace_until = $1, updated_at = $2
         WHERE tenant_id = $3`,
        [graceUntil, now.toISOString(), tenantId],
      )
      await logLicenseAudit(
        tenantId,
        'CLOCK_ROLLBACK',
        `Retroceso de reloj detectado. Gracia ${CLOCK_ROLLBACK_GRACE_DAYS}d hasta ${graceUntil}`,
        'WARN',
        client,
      )
      return { rollbackDetected: true, inGracePeriod: true, graceExpiresAt: graceUntil }
    }

    // Dentro de la gracia activa → permitir con warning
    return { rollbackDetected: true, inGracePeriod: true, graceExpiresAt: graceEnd.toISOString() }
  }

  return { rollbackDetected: false, inGracePeriod: false, graceExpiresAt: null }
}

/**
 * Incrementa el contador anti-rollback tras una venta exitosa.
 * Recalcula el HMAC y actualiza last_sale_at.
 */
export async function updateAntiRollbackCounter(
  tenantId: string,
  saleTimestamp: string,
  client: DbClient = db,
): Promise<void> {
  const nowIso = new Date().toISOString()

  // Obtiene lic_id de license_state para derivar la clave HMAC
  const { rows: lsRows } = await client.query<{ lic_id: string }>(
    'SELECT lic_id FROM license_state WHERE tenant_id = $1',
    [tenantId],
  )
  const licId = lsRows[0]?.lic_id ?? ''

  // Leer counter actual + incrementar atómicamente
  const { rows } = await client.query<AntiRollbackRow>(
    `SELECT counter FROM license_anti_rollback WHERE tenant_id = $1`,
    [tenantId],
  )
  const row = rows[0]
  if (!row) {
    // Inicializar si no existe (caso de prueba)
    await initAntiRollback(client, tenantId, licId)
    return
  }

  const newCounter = row.counter + 1
  const newHmac = computeCounterHmac(newCounter, licId)

  await client.query(
    `UPDATE license_anti_rollback
     SET counter = $1, counter_hmac = $2, last_sale_at = $3, updated_at = $4
     WHERE tenant_id = $5`,
     [newCounter, newHmac, saleTimestamp, nowIso, tenantId],
  )
}

/* ── 7) Gestión de asientos (heartbeat + TTL) ─────────────────────── */

/**
 * Actualiza last_heartbeat_at de la sesión activa (POST /auth/heartbeat).
 * El cliente llama cada 30s; la limpieza cada 60s invalida sesiones sin
 * heartbeat en 90s (liberando asientos).
 */
export async function recordHeartbeat(deviceId: string, tenantId: string): Promise<void> {
  const nowIso = new Date().toISOString()
  await db.query(
    `UPDATE active_sessions
     SET last_heartbeat_at = $1, updated_at = $2
     WHERE tenant_id = $3 AND device_id = $4 AND is_valid = 1`,
    [nowIso, nowIso, tenantId, deviceId],
  )
}

/**
 * Limpieza periódica: invalida sesiones sin heartbeat en 90s.
 * Las sesiones de admin (is_heartbeat_exempt=1) están exentas.
 * Se ejecuta cada 60s desde license-monitor.ts.
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 90 * 1000).toISOString()
  // RETURNING devuelve los tenant_id reales afectados → se loguea con un
  // tenant válido (license_audit.tenant_id es FK). No usar un UUID fake.
  const { rows, rowCount } = await db.query<{ tenant_id: string }>(
    `UPDATE active_sessions
     SET is_valid = 0
     WHERE is_heartbeat_exempt = 0
       AND is_valid = 1
       AND (last_heartbeat_at IS NULL OR last_heartbeat_at < $1)
     RETURNING tenant_id`,
    [cutoff],
  )
  if (rowCount > 0) {
    const tenantIds = rows.map((r) => r.tenant_id)
    const uniqueTenants = [...new Set(tenantIds)]
    for (const tid of uniqueTenants) {
      await logLicenseAudit(
        tid,
        'LOADED',
        `${rowCount} sesiones expiradas por TTL de heartbeat`,
        'WARN',
      )
    }
  }
  return rowCount
}

/* ── 8) Hardware fingerprint ──────────────────────────────────────── */

/**
 * Calcula un fingerprint del hardware: MAC de la primera interfaz
 * IPv4 no interna + un machine-id persistente (data/machine-id).
 * Estable entre reinicios; cambia si se mueve la carpeta de datos.
 */
export function computeHardwareFingerprint(): string {
  // 1. MAC address de la primera interfaz no interna IPv4
  const interfaces = os.networkInterfaces()
  let mac = '00:00:00:00:00:00'
  outer: for (const iface of Object.values(interfaces)) {
    if (!iface) continue
    for (const addr of iface) {
      if (!addr.internal && addr.family === 'IPv4') {
        mac = addr.mac
        break outer
      }
    }
  }

  // 2. Machine ID persistente (o genera uno nuevo)
  const machineIdPath = join(dataDir(), 'machine-id')
  let machineId: string
  try {
    if (existsSync(machineIdPath)) {
      machineId = readFileSync(machineIdPath, 'utf8').trim()
    } else {
      machineId = randomUUID()
      mkdirSync(dataDir(), { recursive: true })
      writeFileSync(machineIdPath, machineId, 'utf8')
    }
  } catch {
    machineId = 'unknown'
  }

  // 3. Hash combinado (no revela la MAC directamente)
  return createHash('sha256').update(mac + ':' + machineId).digest('hex')
}

/* ── 8b) Bootstrap detection + Trial helpers ──────────────────────── */

/**
 * Detecta si el servidor está en modo bootstrap (sin licencia válida).
 * Se usa en las rutas para permitir POST /license/upload|/trial sin JWT
 * solo cuando realmente falta una licencia válida (evita bypass en prod).
 */
export async function isBootstrapNeeded(): Promise<boolean> {
  const tenant = await getActiveTenant()
  if (!tenant) return true
  // Si la licencia ya está activa en BD, no es bootstrap
  if (tenant.is_active === 1) {
    const exp = new Date(tenant.license_expires_at).getTime()
    if (Number.isFinite(exp) && exp > Date.now()) {
      // Revisar license_state también (si falta pero tenant dice activo, aún no es bootstrap limpio)
      const { rows } = await db.query<{ is_valid: number }>(
        'SELECT is_valid FROM license_state WHERE tenant_id = $1',
        [tenant.id],
      )
      if (rows[0]?.is_valid === 1) return false
      // Sin state pero con file válido → bootstrap no necesario, dejar que validate lo resuelva
      const lic = loadLicenseFile()
      if (lic) {
        const v = verifyLicenseSignature(lic)
        if (v.valid) return false
      }
    }
  }
  return true
}

/**
 * Carpetas donde puede estar el toolkit de claves (privada trial).
 * Cubre el layout del workspace: la clave pública y la privada trial viven
 * en el MISMO repo de herramientas (tools/keys o tools-posky/keys).
 *
 * SEGURIDAD: la carpeta de datos del servidor y la carpeta del archivo .lic
 * quedan EXCLUIDAS a propósito. La clave trial privada (`trial_private.pem`)
 * no está cifrada, así que no debe ser localizable dentro de
 * %ProgramData%\POS Server\data del cliente final.
 *
 * Exportada para poder verificar en los tests que la carpeta de datos y la
 * carpeta del .lic NUNCA son candidatas.
 */
export function keyToolDirs(): string[] {
  const dirs: string[] = []
  const push = (p: string | undefined | null) => {
    if (p && !dirs.includes(p)) dirs.push(p)
  }
  // 1) Carpeta de la clave pública embebida (mismo repo de herramientas).
  const pubPath = env.publicKeyPath?.trim()
  if (pubPath) push(dirname(isAbsolute(pubPath) ? pubPath : resolve(process.cwd(), pubPath)))
  // 2) Layout canónico del workspace.
  push(resolve(process.cwd(), '../tools/keys'))
  push(resolve(process.cwd(), '../tools-posky/keys'))
  return dirs
}

/**
 * Resuelve la ruta al PEM privado trial.
 * Solo se consideran rutas relativas a la RAÍZ de pos-server o absolutas:
 * nunca la carpeta del .lic ni la carpeta de datos del cliente.
 */
function resolveTrialPrivatePath(): string {
  const p = env.trialPrivateKeyPath?.trim()
  if (!p) return resolve(process.cwd(), '../tools-posky/keys/trial_private.pem')
  if (isAbsolute(p)) return p
  // Relativo a la raíz de pos-server (p. ej. ../tools-posky/keys/trial_private.pem)
  return resolve(process.cwd(), p)
}

function loadTrialPrivateKey() {
  const candidates = new Set<string>()
  candidates.add(resolveTrialPrivatePath())
  for (const dir of keyToolDirs()) {
    candidates.add(join(dir, 'trial_private.pem'))
    candidates.add(join(dir, 'trial_private.enc.pem'))
  }
  const tried: string[] = []
  for (const p of candidates) {
    tried.push(p)
    if (!existsSync(p)) continue
    try {
      const pem = readFileSync(p, 'utf8')
      if (pem.includes('ENCRYPTED')) {
        const pass = env.trialPrivateKeyPassphrase
        if (!pass) continue
        return createPrivateKey({ key: pem, passphrase: pass })
      }
      return createPrivateKey({ key: pem })
    } catch {
      // passphrase incorrect o PEM corrupto → probar siguiente
    }
  }
  throw new HttpError(
    'FORBIDDEN',
    `No se pudo cargar la clave trial privada (probado: ${tried.join(', ')}). Configure TRIAL_PRIVATE_KEY_PATH/TRIAL_PASS o genere con tools-posky/generate-trial-keys.js`,
  )
}

function signPayload(payload: LicensePayload, privateKey: ReturnType<typeof createPrivateKey>): string {
  const data = Buffer.from(JSON.stringify(payload))
  const sig = sign(null, data, privateKey)
  return `${data.toString('base64url')}.${sig.toString('base64url')}`
}

/**
 * Emite una licencia trial de 1 día firmada server-side (familia trial aislada).
 * Usa el tenant activo; si ya existe una trial vigente no se re-emite dentro de 23h
 * (previene abuso del endpoint sin bloquear el flujo del wizard).
 */
export async function issueTrialLicense(tenantId?: string): Promise<LicenseInfo> {
  const tenant = tenantId
    ? (await db.query<ActiveTenantRow>('SELECT id, license_key, name, is_active, license_expires_at, max_devices FROM tenants WHERE id = $1', [tenantId])).rows[0]
    : await getActiveTenant()
  if (!tenant) throw new HttpError('NOT_FOUND', 'No hay tenant para emitir trial')

  // Throttle: si ya hay trial vigente (>12h restantes), no re-emitir (evita spam)
  const { rows: lsRows } = await db.query<{ expires_at: string; lic_id: string }>(
    'SELECT expires_at, lic_id FROM license_state WHERE tenant_id = $1',
    [tenant.id],
  )
  const existing = lsRows[0]
  if (existing?.lic_id?.startsWith('TRIAL-')) {
    const leftMs = new Date(existing.expires_at).getTime() - Date.now()
    if (leftMs > 12 * 60 * 60 * 1000) {
      throw new HttpError('FORBIDDEN', 'Ya existe una licencia trial vigente. Espere a que expire para generar otra.')
    }
  }

  const now = new Date()
  const expires = new Date(now.getTime() + TRIAL_LICENSE_DAYS * 24 * 60 * 60 * 1000)
  const payload: LicensePayload = {
    schema: LICENSE_SCHEMA_VERSION,
    lic_id: `TRIAL-${now.getFullYear()}-${String(Date.now()).slice(-6)}`,
    license_key: tenant.license_key,
    customer: tenant.name || 'Trial',
    branch: 'trial',
    seats: Math.max(tenant.max_devices, 2),
    features: ['inventory', 'reports'],
    issued: now.toISOString(),
    expires: expires.toISOString(),
    hw_fingerprint: null,
  }

  const privateKey = loadTrialPrivateKey()
  const licContent = signPayload(payload, privateKey)

  // Persistir archivo .lic en licenseFilePath para que validateLicenseAtStartup lo vea al reiniciar
  try {
    mkdirSync(dirname(env.licenseFilePath), { recursive: true })
    writeFileSync(env.licenseFilePath, licContent, 'utf8')
  } catch {
    // No fatal — igual guardamos en BD
  }

  await db.transaction(async (tx) => {
    await storeLicenseState(tx, tenant.id, payload, licContent, true)
    await applyLicenseToTenant(tx, tenant.id, payload, true)
    await initAntiRollback(tx, tenant.id, payload.lic_id)
    await logLicenseAudit(tenant.id, 'LOADED', `Trial ${payload.lic_id} expira ${payload.expires}`, 'INFO', tx)
  })

  return getLicenseStatus(tenant.id)
}

/* ── 9) Validación completa del checklist (8 pasos) ───────────────── */

/**
 * Valida la licencia al arranque del servidor (checklist de 8 pasos).
 * Si la licencia es válida, actualiza los campos de `tenants` y almacena
 * el estado en `license_state` + `license_anti_rollback`.
 * Si es inválida/expirada, desactiva el tenant (is_active=0).
 * Si falta el archivo, entra en modo degradado (usa los campos BD existentes).
 *
 * MODO DEV (LICENSE_DEV_MODE, lo activa `npm run dev` / `npm test`):
 * la licencia NUNCA bloquea al tenant — si quedara bloqueado se reactiva con
 * vigencia extendida. En producción esta rama no se ejecuta.
 *
 * @returns LicenseStatus para logging en server.ts
 */
export async function validateLicenseAtStartup(app: FastifyInstance): Promise<LicenseStatus> {
  // `ctx.tenantId` guarda el tenant sobre el que se evaluó la licencia, para
  // que el modo dev reactive ESE tenant y no otro cualquiera.
  const ctx: { tenantId?: string | null } = {}
  const status = await validateLicenseCore(app, ctx)

  if (!env.licenseDevMode) return status

  // MODO DEV: la licencia NUNCA deja el server bloqueado. Si el tenant quedó
  // inactivo o vencido se reactiva con vigencia extendida y el server opera
  // como si la licencia fuera válida. En producción esta rama no se ejecuta.
  await ensureDevTenantUsable(app, status, ctx.tenantId ?? null)

  // 'missing' (sin .lic → modo degradado) no es un bloqueo: se mantiene el
  // estado para que el log siga mostrando la realidad del archivo.
  if (status === 'missing') return 'missing'
  return 'active'
}

/**
 * MODO DEV: garantiza que el tenant quede utilizable.
 * Solo actúa si el tenant está realmente bloqueado (inactivo o vencido).
 *
 * @param tenantId tenant evaluado por validateLicenseCore (si se conoce).
 */
async function ensureDevTenantUsable(
  app: FastifyInstance,
  status: LicenseStatus,
  tenantId: string | null,
): Promise<void> {
  const tenant = tenantId
    ? await getTenantById(tenantId)
    : await resolveInstallationTenant();
  if (!tenant) return;
  const expMs = new Date(tenant.license_expires_at).getTime()
  const blocked = tenant.is_active !== 1 || !Number.isFinite(expMs) || expMs <= Date.now()
  if (!blocked) return

  const expires = devLicenseExpiry()
  await db.query(
    'UPDATE tenants SET is_active = 1, license_expires_at = $1, updated_at = $2 WHERE id = $3',
    [expires, new Date().toISOString(), tenant.id],
  )
  app.log.warn(
    `[dev] Modo desarrollo (LICENSE_DEV_MODE): tenant ${tenant.license_key} reactivado ` +
      `hasta ${expires} (estado de licencia: ${status})`,
  )
}

/**
 * Resuelve el tenant que POSEE esta instalación, de forma DETERMINISTA.
 *
 * Por qué: `getActiveTenant()` usaba `LIMIT 1` sin `ORDER BY` → con más de un
 * tenant en la BD (tests, o un servidor con varias sucursales) la licencia se
 * validaba contra un tenant ARBITRARIO, y el modo dev reactivaba ese tenant en
 * vez del que estaba bloqueado. Orden de resolución:
 *   1. el tenant que tiene fila en `license_state` (el ya licenciado);
 *   2. el más antiguo (el que sembró el seed al instalar).
 */
async function resolveInstallationTenant(): Promise<ActiveTenantRow | null> {
  const { rows: licensed } = await db.query<ActiveTenantRow>(
    `SELECT t.id, t.license_key, t.name, t.is_active, t.license_expires_at, t.max_devices
     FROM tenants t
     WHERE EXISTS (SELECT 1 FROM license_state ls WHERE ls.tenant_id = t.id)
     ORDER BY t.created_at ASC
     LIMIT 1`,
  )
  if (licensed[0]) return licensed[0]
  const { rows } = await db.query<ActiveTenantRow>(
    `SELECT id, license_key, name, is_active, license_expires_at, max_devices
     FROM tenants
     ORDER BY created_at ASC
     LIMIT 1`,
  )
  return rows[0] ?? null
}

async function validateLicenseCore(
  app: FastifyInstance,
  ctx: { tenantId?: string | null } = {},
): Promise<LicenseStatus> {
  // Check prod con clave de prueba (P8): si LICENSE_STRICT y la clave embebida
  // es la de test (la generan los tests), advertir loudly.
  if (env.licenseStrict && IS_TEST_KEY) {
    app.log.error('Clave publica de PRUEBA en modo estricto — reemplace con la clave de produccion (tools/keys/mipos_public.pem) y ejecute npm run build:keys')
  }
  if (!PUBLIC_KEY_PEM) {
    app.log.warn('Sin PUBLIC_KEY_PEM embebida — verificacion Ed25519 deshabilitada (modo degradado)')
  }
  const licContent = loadLicenseFile()
  let preverified: LicensePayload | null = null
  let tenant: ActiveTenantRow | null = null

  /* Resolución DETERMINISTA del tenant dueño de la instalación.
     Antes se usaba `getActiveTenant()` (LIMIT 1 sin ORDER BY) → con más de un
     tenant en la BD la licencia se validaba contra un tenant ARBITRARIO (y el
     modo dev reactivaba ese en vez del que estaba bloqueado). Ahora:
       1. si hay un .lic con firma válida → su license_key identifica al tenant;
       2. si no, el tenant que tiene license_state (el ya licenciado);
       3. si no, el más antiguo (el que sembró el seed al instalar). */
  if (licContent) {
    const verification = verifyLicenseSignature(licContent)
    if (verification.valid && verification.payload) {
      const candidate = await findTenantByLicenseKey(verification.payload.license_key)
      if (candidate) {
        if (candidate.is_active !== 1) {
          app.log.warn(
            `Tenant ${candidate.license_key} inactivo — re-validando su licencia en disco`,
          )
        }
        tenant = candidate
        preverified = verification.payload
      }
    } else {
      // Firma inválida: si no hay ningún tenant al que aplicarla, se bloquea.
      const active = await getActiveTenant()
      if (!active) {
        app.log.error(
          `Licencia inválida (firma) en ${env.licenseFilePath} y sin tenant activo — servidor bloqueado`,
        )
        return 'invalid'
      }
    }
  }

  if (!tenant) {
    tenant = await resolveInstallationTenant()
  }

  if (!tenant) {
    app.log.warn('No hay tenant activo — sin licencia que validar')
    return 'missing'
  }

  ctx.tenantId = tenant.id

  const { id: tenantId, license_key: tenantLicenseKey } = tenant

  // Step 1: ¿Existe el archivo .lic?
  if (!licContent) {
    // Respetar una licencia ya aplicada en BD (p. ej. subida por el wizard en
    // una versión previa): si license_state es válida y vigente, NO desactivar
    // el tenant aunque falte el archivo. Evita el 403 fantasma en login.
    const { rows: stateRows } = await db.query<{ is_valid: number; expires_at: string }>(
      'SELECT is_valid, expires_at FROM license_state WHERE tenant_id = $1',
      [tenantId],
    )
    const st = stateRows[0]
    if (st && st.is_valid === 1 && new Date(st.expires_at).getTime() > Date.now()) {
      // Reactivar: el tenant pudo quedar inactivo por un arranque previo sin
      // archivo (o por una versión que no persistía el .lic).
      await db.query(
        `UPDATE tenants SET is_active = 1, license_expires_at = $1, updated_at = $2 WHERE id = $3`,
        [st.expires_at, new Date().toISOString(), tenantId],
      )
      app.log.warn(
        `Sin archivo .lic en ${env.licenseFilePath}, pero license_state válido — tenant reactivado`,
      )
      return 'active'
    }
    if (env.licenseStrict) {
      app.log.error(
        `Sin archivo .lic en ${env.licenseFilePath} — LICENSE_STRICT=true, bloqueando tenant`,
      )
      await db.transaction(async (tx) => {
        await applyLicenseToTenant(tx, tenantId, {
          schema: 0,
          lic_id: '',
          license_key: tenantLicenseKey,
          customer: '',
          branch: '',
          seats: tenant.max_devices,
          features: [],
          issued: new Date().toISOString(),
          expires: new Date(0).toISOString(),
          hw_fingerprint: null,
        }, false)
        await logLicenseAudit(tenantId, 'INVALID_SIGNATURE', 'Archivo .lic no encontrado — modo estricto', 'ERROR', tx)
      })
      return 'invalid'
    }
    app.log.warn(
      `Sin archivo .lic en ${env.licenseFilePath} — modo degradado (usa campos BD)`,
    )
    await logLicenseAudit(tenantId, 'LOADED', 'Archivo .lic no encontrado — modo degradado', 'WARN')
    return 'missing'
  }

  // Step 2-3: ¿Formato + firma válida con Ed25519?
  // (Si el tenant estaba inactivo y se resolvió por el .lic, ya está verificado.)
  const verification: LicenseVerification = preverified
    ? { valid: true, payload: preverified, error: undefined }
    : verifyLicenseSignature(licContent)
  if (!verification.valid || !verification.payload) {
    app.log.error(
      `Licencia inválida (firma) para tenant ${tenantLicenseKey}. ` +
        `El cliente verá "Licencia inválida. Contacte a soporte."`,
    )
    // RECHAZAR: desactivar tenant bloquea todo (login + API)
    await db.transaction(async (tx) => {
      await applyLicenseToTenant(tx, tenantId, {
        schema: 0,
        lic_id: '',
        license_key: tenantLicenseKey,
        customer: '',
        branch: '',
        seats: tenant.max_devices,
        features: [],
        issued: new Date().toISOString(),
        expires: new Date(0).toISOString(),
        hw_fingerprint: null,
      }, false)
      // Guardar estado inválido para auditoría
      const nowIso = new Date().toISOString()
      await tx.query(
        `INSERT INTO license_state (
           tenant_id, lic_id, schema_version, license_key, customer, branch,
           seats, features, issued_at, expires_at, hw_fingerprint,
           signature_base64, payload_base64, is_valid, validated_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $14, $14)
         ON CONFLICT (tenant_id) DO UPDATE SET
           is_valid = 0, signature_base64 = excluded.signature_base64,
           payload_base64 = excluded.payload_base64, validated_at = excluded.validated_at,
           updated_at = excluded.updated_at`,
        [
          tenantId,
          '',
          0,
          tenantLicenseKey,
          null,
          null,
          tenant.max_devices,
          '[]',
          nowIso,
          nowIso,
          null,
          '',
          '',
          nowIso,
        ],
      )
      await logLicenseAudit(
        tenantId,
        'INVALID_SIGNATURE',
        `Firma inválida: ${verification.error}`,
        'ERROR',
        tx,
      )
    })
    return 'invalid'
  }

  const payload = verification.payload

  // El .lic es la fuente de verdad del código de tenant: si su license_key
  // difiere, el tenant la ADOPTA (EXE genérico + licencia con el código).
  if (payload.license_key !== tenantLicenseKey) {
    app.log.warn(
      `Adoptando license_key del .lic: "${tenantLicenseKey}" -> "${payload.license_key}"`,
    )
    await db.query(
      'UPDATE tenants SET license_key = $1, updated_at = $2 WHERE id = $3',
      [payload.license_key, new Date().toISOString(), tenantId],
    )
    await logLicenseAudit(
      tenantId,
      'LOADED',
      `license_key adoptada del .lic: "${tenantLicenseKey}" -> "${payload.license_key}"`,
      'WARN',
    )
  }

  // Step 4: ¿Schema soportado?
  if (payload.schema > LICENSE_SCHEMA_VERSION) {
    app.log.warn(
      `Schema de licencia ${payload.schema} no soportado (máximo ${LICENSE_SCHEMA_VERSION}). Actualice el server.`,
    )
    await logLicenseAudit(
      tenantId,
      'LOADED',
      `Schema ${payload.schema} no soportado. Actualice el server.`,
      'WARN',
    )
    return 'unsupported_schema'
  }

  // Determinar estado: activa o expirada
  const now = new Date()
  const isExpired = new Date(payload.expires).getTime() <= now.getTime()

  // Step 5: ¿Expirada? → modo degradado (bloquea ventas, mantiene datos)
  if (isExpired) {
    app.log.warn(`Licencia ${payload.lic_id} EXPIRADA el ${payload.expires}`)
    await db.transaction(async (tx) => {
      await storeLicenseState(tx, tenantId, payload, licContent, false)
      await applyLicenseToTenant(tx, tenantId, payload, false)
      await initAntiRollback(tx, tenantId, payload.lic_id)
      await logLicenseAudit(tenantId, 'EXPIRED', `Licencia vencida: ${payload.expires}`, 'WARN', tx)
    })
    return 'expired'
  }

  // Step 6: ¿Retroceso de reloj detectado?
  const rollbackStatus = await checkAntiRollback(tenantId)
  if (rollbackStatus.rollbackDetected && !rollbackStatus.inGracePeriod) {
    app.log.error('Retroceso de reloj detectado y gracia expirada — bloqueando ventas')
    await db.transaction(async (tx) => {
      await storeLicenseState(tx, tenantId, payload, licContent, true)
      await applyLicenseToTenant(tx, tenantId, payload, false)
      await logLicenseAudit(
        tenantId,
        'CLOCK_ROLLBACK',
        'Gracia de retroceso de reloj expirada — tenant desactivado',
        'ERROR',
        tx,
      )
    })
    return 'grace_clock'
  }

  // Step 7: ¿Fingerprint no coincide? Gracia 15 días, luego bloqueo.
  if (payload.hw_fingerprint) {
    const currentFingerprint = computeHardwareFingerprint()
    if (currentFingerprint !== payload.hw_fingerprint) {
      // Asegurar columna de gracia fingerprint existe (SQLite/PG compatible)
      try {
        await db.exec('ALTER TABLE license_anti_rollback ADD COLUMN fingerprint_grace_until TEXT')
      } catch {}
      try {
        await db.exec('ALTER TABLE license_anti_rollback ADD COLUMN fingerprint_grace_until TIMESTAMPTZ')
      } catch {}
      const { rows: fpRows } = await db.query<{ fingerprint_grace_until: string | null }>(
        'SELECT fingerprint_grace_until FROM license_anti_rollback WHERE tenant_id = $1',
        [tenantId],
      )
      const existingGrace = fpRows[0]?.fingerprint_grace_until
        ? new Date(fpRows[0].fingerprint_grace_until as string)
        : null
      const now = new Date()
      if (existingGrace && now.getTime() > existingGrace.getTime()) {
        app.log.error('Fingerprint gracia expirada (15d) — bloqueando tenant')
        await db.transaction(async (tx) => {
          await storeLicenseState(tx, tenantId, payload, licContent, true)
          await applyLicenseToTenant(tx, tenantId, payload, false)
          await logLicenseAudit(tenantId, 'FINGERPRINT_MISMATCH', 'Gracia fingerprint expirada — tenant desactivado', 'ERROR', tx)
        })
        return 'grace_fingerprint'
      }
      const graceUntil = existingGrace
        ? existingGrace.toISOString()
        : new Date(now.getTime() + FINGERPRINT_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString()
      if (!existingGrace) {
        await db.query(
          'UPDATE license_anti_rollback SET fingerprint_grace_until = $1, updated_at = $2 WHERE tenant_id = $3',
          [graceUntil, now.toISOString(), tenantId],
        )
      }
      app.log.warn(`Fingerprint no coincide — gracia ${FINGERPRINT_GRACE_DAYS}d hasta ${graceUntil}`)
      await db.transaction(async (tx) => {
        await storeLicenseState(tx, tenantId, payload, licContent, true)
        await applyLicenseToTenant(tx, tenantId, payload, true)
        await initAntiRollback(tx, tenantId, payload.lic_id)
        await logLicenseAudit(tenantId, 'FINGERPRINT_MISMATCH', `Hardware fingerprint no coincide. Gracia ${FINGERPRINT_GRACE_DAYS}d hasta ${graceUntil}`, 'WARN', tx)
      })
      return 'grace_fingerprint'
    }
  }

  // Step 8: ✅ Operación normal
  app.log.info(`Licencia ${payload.lic_id} válida — servidor operativo`)
  await db.transaction(async (tx) => {
    await storeLicenseState(tx, tenantId, payload, licContent, true)
    await applyLicenseToTenant(tx, tenantId, payload, true)
    await initAntiRollback(tx, tenantId, payload.lic_id)
    await logLicenseAudit(tenantId, 'VALIDATED', `Licencia activa: ${payload.lic_id}`, 'INFO', tx)
  })
  return 'active'
}

/* ── 10) Estado de licencia para la API ─────────────────────────────── */

/**
 * Nivel de advertencia de vencimiento (30/7 días).
 * - > 30 días → 'none'
 * - 8-30 días → 'warning'
 * - ≤ 7 días  → 'critical'
 */
export function checkExpiryWarnings(expiresAt: string): 'none' | 'warning' | 'critical' {
  const now = new Date()
  const expires = new Date(expiresAt)
  const daysLeft = (expires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)

  if (daysLeft <= EXPIRY_CRITICAL_DAYS) return 'critical'
  if (daysLeft <= EXPIRY_WARNING_DAYS) return 'warning'
  return 'none'
}

/**
 * Obtiene el estado de la licencia para el tenant (GET /license/status).
 * Lee license_state + tenants y calcula el warning level.
 *
 * MODO DEV (LICENSE_DEV_MODE): el estado se reporta 'active' aunque la
 * licencia firmada esté vencida, porque el server está operando. La
 * vigencia mostrada es la extendida del tenant.
 */
export async function getLicenseStatus(tenantId: string): Promise<LicenseInfo> {
  const info = await computeLicenseStatus(tenantId)
  if (!env.licenseDevMode) return info

  const { rows } = await db.query<{ license_expires_at: string | null }>(
    'SELECT license_expires_at FROM tenants WHERE id = $1',
    [tenantId],
  )
  const expires = rows[0]?.license_expires_at || info.expires_at
  return {
    ...info,
    status: 'active',
    expires_at: expires,
    warning_level: expires ? checkExpiryWarnings(expires) : 'none',
    grace_reason: null,
    grace_expires_at: null,
  }
}

async function computeLicenseStatus(tenantId: string): Promise<LicenseInfo> {
  const { rows } = await db.query<{
    lic_id: string
    customer: string | null
    features: string
    seats: number
    expires_at: string
    is_valid: number
    license_expires_at: string
    max_devices: number
    is_active: number
  }>(
    `SELECT ls.lic_id, ls.customer, ls.features, ls.seats, ls.expires_at, ls.is_valid,
            t.license_expires_at, t.max_devices, t.is_active
     FROM license_state ls
     JOIN tenants t ON t.id = ls.tenant_id
     WHERE ls.tenant_id = $1`,
    [tenantId],
  )

  const row = rows[0]
  if (!row) {
    // Sin license_state (dev/test): usar campos de tenants directamente
    const tRows = await db.query<{
      license_expires_at: string
      max_devices: number
      is_active: number
    }>('SELECT license_expires_at, max_devices, is_active FROM tenants WHERE id = $1', [tenantId])
    const t = tRows.rows[0]
    if (!t) {
      return {
        status: 'expired',
        expires_at: '',
        max_devices: 0,
        lic_id: null,
        customer: null,
        features: [],
        warning_level: null,
        grace_reason: null,
        grace_expires_at: null,
      }
    }
    const isExpired = t.is_active !== 1 || new Date(t.license_expires_at).getTime() <= Date.now()
    return {
      status: isExpired ? 'expired' : 'active',
      expires_at: t.license_expires_at,
      max_devices: t.max_devices,
      lic_id: null,
      customer: null,
      features: [],
      warning_level: isExpired ? null : checkExpiryWarnings(t.license_expires_at),
      grace_reason: null,
      grace_expires_at: null,
    }
  }

  const features = safeParseJsonArray(row.features)
  const isExpired = row.is_valid !== 1 || new Date(row.expires_at).getTime() <= Date.now()
  if (isExpired) {
    return {
      status: 'expired',
      expires_at: row.expires_at,
      max_devices: row.seats,
      lic_id: row.lic_id,
      customer: row.customer,
      features,
      warning_level: null,
      grace_reason: null,
      grace_expires_at: null,
    }
  }
  // Detectar gracias activas (clock / fingerprint) para exponer 'grace'
  try {
    const { rows: graceRows } = await db.query<{
      clock_rollback_grace_until: string | null
      fingerprint_grace_until: string | null
    }>(
      'SELECT clock_rollback_grace_until, fingerprint_grace_until FROM license_anti_rollback WHERE tenant_id = $1',
      [tenantId],
    )
    const g = graceRows[0]
    if (g?.clock_rollback_grace_until && new Date(g.clock_rollback_grace_until).getTime() > Date.now()) {
      return {
        status: 'grace',
        expires_at: row.expires_at,
        max_devices: row.seats,
        lic_id: row.lic_id,
        customer: row.customer,
        features,
        warning_level: checkExpiryWarnings(row.expires_at),
        grace_reason: 'clock',
        grace_expires_at: g.clock_rollback_grace_until,
      }
    }
    if (g?.fingerprint_grace_until && new Date(g.fingerprint_grace_until).getTime() > Date.now()) {
      return {
        status: 'grace',
        expires_at: row.expires_at,
        max_devices: row.seats,
        lic_id: row.lic_id,
        customer: row.customer,
        features,
        warning_level: checkExpiryWarnings(row.expires_at),
        grace_reason: 'fingerprint',
        grace_expires_at: g.fingerprint_grace_until,
      }
    }
    // Fallback: hw_fingerprint mismatch sin columna aun -> detectar directo
    const currentFp = computeHardwareFingerprint()
    const { rows: lsRows } = await db.query<{ hw_fingerprint: string | null }>(
      'SELECT hw_fingerprint FROM license_state WHERE tenant_id = $1',
      [tenantId],
    )
    if (lsRows[0]?.hw_fingerprint && lsRows[0].hw_fingerprint !== currentFp) {
      return {
        status: 'grace',
        expires_at: row.expires_at,
        max_devices: row.seats,
        lic_id: row.lic_id,
        customer: row.customer,
        features,
        warning_level: checkExpiryWarnings(row.expires_at),
        grace_reason: 'fingerprint',
        grace_expires_at: null,
      }
    }
  } catch {}
  return {
    status: 'active',
    expires_at: row.expires_at,
    max_devices: row.seats,
    lic_id: row.lic_id,
    customer: row.customer,
    features,
    warning_level: checkExpiryWarnings(row.expires_at),
    grace_reason: null,
    grace_expires_at: null,
  }
}

/* ── 11) Subir licencia (POST /license/upload) ─────────────────────── */

/**
 * Verifica y aplica una nueva licencia subida por el admin.
 * Ejecuta los steps 2-7 del checklist (sin step 1: el archivo ya existe).
 * Si la licencia es inválida → lanza HttpError (cliente ve "Licencia inválida").
 */
export async function uploadLicense(
  licContent: string,
  tenantId: string,
): Promise<LicenseInfo> {
  // Verificar firma (steps 2-3)
  const verification = verifyLicenseSignature(licContent)
  if (!verification.valid || !verification.payload) {
    await logLicenseAudit(tenantId, 'INVALID_SIGNATURE', 'Upload: firma inválida', 'ERROR')
    throw new HttpError('LICENSE_EXPIRED', 'Licencia inválida. Contacte a soporte.')
  }

  const payload = verification.payload

  // Verificar que la license_key coincide con el tenant
  const { rows: tenantRows } = await db.query<{ license_key: string }>(
    'SELECT license_key FROM tenants WHERE id = $1',
    [tenantId],
  )
  const tenant = tenantRows[0]
  if (!tenant) {
    await logLicenseAudit(tenantId, 'INVALID_SIGNATURE', 'Upload: tenant no encontrado', 'ERROR')
    throw new HttpError('LICENSE_EXPIRED', 'Licencia inválida. Contacte a soporte.')
  }
  // El .lic es la fuente de verdad del código de tenant: si su license_key
  // difiere, el tenant la ADOPTA. Permite distribuir un EXE genérico y que la
  // licencia traiga el código (cliente/sucursal) sin posibilidad de mismatch.
  if (payload.license_key !== tenant.license_key) {
    await db.query(
      'UPDATE tenants SET license_key = $1, updated_at = $2 WHERE id = $3',
      [payload.license_key, new Date().toISOString(), tenantId],
    )
    await logLicenseAudit(
      tenantId,
      'UPLOADED',
      `license_key adoptada del .lic: "${tenant.license_key}" -> "${payload.license_key}"`,
      'INFO',
    )
  }

  // Step 4: Schema soportado
  if (payload.schema > LICENSE_SCHEMA_VERSION) {
    throw new HttpError('FORBIDDEN', 'Esta licencia requiere una versión más nueva del servidor.')
  }

  // Validar que los asientos no sean inferiores a sesiones activas
  const { rows: activeRows } = await db.query<{ c: number }>(
    'SELECT COUNT(*) as c FROM active_sessions WHERE tenant_id = $1 AND is_valid = 1',
    [tenantId],
  )
  const activeDevices = activeRows[0]?.c ?? 0
  if (payload.seats < activeDevices) {
    throw new HttpError(
      'FORBIDDEN',
      `Asientos insuficientes: ${activeDevices} dispositivos activos, la licencia solo permite ${payload.seats}. Desvincule dispositivos primero.`,
    )
  }

  // Step 5: No se rechaza por expiración en upload (se aplica y el middleware
  //        bloqueará). Pero si la licencia está expirada, se desactiva el tenant.
  const isExpired = new Date(payload.expires).getTime() <= Date.now()

  await db.transaction(async (tx) => {
    await storeLicenseState(tx, tenantId, payload, licContent, !isExpired)
    await applyLicenseToTenant(tx, tenantId, payload, !isExpired)
    await initAntiRollback(tx, tenantId, payload.lic_id)

    const eventType = isExpired ? 'SUSPENDED' : 'UPLOADED'
    const severity = isExpired ? 'WARN' : 'INFO'
    await logLicenseAudit(
      tenantId,
      eventType,
      `Licencia ${payload.lic_id} subida. Expira: ${payload.expires}`,
      severity,
      tx,
    )
  })

  // Persistir el .lic en disco: validateLicenseAtStartup lo lee al arrancar y,
  // sin archivo (con LICENSE_STRICT=true), volvería a desactivar el tenant en el
  // próximo reinicio → login 403 aunque la licencia siga válida en BD.
  try {
    mkdirSync(dirname(env.licenseFilePath), { recursive: true })
    writeFileSync(env.licenseFilePath, licContent, 'utf8')
  } catch (err) {
    await logLicenseAudit(
      tenantId,
      'UPLOADED',
      `No se pudo persistir el .lic en ${env.licenseFilePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      'WARN',
    )
  }

  return getLicenseStatus(tenantId)
}

/* ── Helpers ──────────────────────────────────────────────────────── */

/** Parsea JSON array de forma segura (fallback []). */
function safeParseJsonArray(s: string | null | undefined): string[] {
  if (!s) return []
  try {
    const parsed = JSON.parse(s)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
