/**
 * tests/helpers.ts — Utilidades compartidas por la suite.
 *
 * ────────────────────────────────────────────────────────────────────────
 * - `login()`: POST /auth/login contra la app real (app.inject) y
 *   devuelve el access_token listo para `Authorization: Bearer …`.
 * - `createTenantFixture()`: siembra un tenant secundario (usuario admin
 *   con TODOS los permisos) directamente en BD para pruebas de
 *   aislamiento multi-tenant.
 * ────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { createPrivateKey, sign } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { db } from '../src/database/client.js'

/** Resultado mínimo del login para las pruebas. */
export interface TestSession {
  token: string
  tenantId: string
  userId: string
  deviceId: string
}

/** Hace login contra /auth/login (flujo real: valida licencia, PIN, device). */
export async function login(
  app: FastifyInstance,
  tenantCode = 'DEMO-0001',
  pin = '1234',
): Promise<TestSession> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      tenant_code: tenantCode,
      pin,
      device_id: `test-device-${tenantCode}`,
      device_name: 'Test Runner',
      device_type: 'DESKTOP',
    },
  })
  if (res.statusCode !== 200) {
    throw new Error(`login(${tenantCode}) falló: ${res.statusCode} ${res.body}`)
  }
  const body = res.json()
  return {
    token: body.data.access_token as string,
    tenantId: body.data.tenant.id as string,
    userId: body.data.user.id as string,
    deviceId: body.data.device.id as string,
  }
}

/** Crea un tenant con usuario admin (todos los permisos) y hace login. */
export async function createTenantFixture(
  app: FastifyInstance,
  licenseKey: string,
): Promise<TestSession> {
  const now = new Date().toISOString()
  const tenantId = randomUUID().replace(/-/g, '')
  const userId = randomUUID()
  const roleId = randomUUID()

  await db.query(
    `INSERT INTO tenants (id, name, license_key, license_expires_at, max_devices, max_branches, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 2, 1, 1, $5, $5)`,
    [tenantId, `Tenant ${licenseKey}`, licenseKey, '2099-12-31T00:00:00Z', now],
  )
  await db.query(
    `INSERT INTO roles (id, tenant_id, name, is_default, is_active, created_at, updated_at)
     VALUES ($1, $2, 'Administrador', 1, 1, $3, $3)`,
    [roleId, tenantId, now],
  )
  /* Admin → TODOS los permisos del catálogo global */
  await db.query(
    `INSERT INTO role_permissions (role_id, permission_id, created_at)
     SELECT $1, id, $2 FROM permissions`,
    [roleId, now],
  )
  await db.query(
    `INSERT INTO users (id, tenant_id, name, pin_hash, is_active, created_at, updated_at)
     VALUES ($1, $2, 'Admin Test', $3, 1, $4, $4)`,
    [userId, tenantId, bcrypt.hashSync('1234', 10), now],
  )
  await db.query(
    `INSERT INTO user_roles (user_id, role_id, created_at) VALUES ($1, $2, $3)`,
    [userId, roleId, now],
  )

  return login(app, licenseKey)
}

/* ── Helpers para tests de licencias ─────────────────────────────────────── */

/** Firma un payload con la clave privada de test (tests/test-private.pem).
 *  Devuelve `base64url(payload).base64url(signature)` — el formato .lic. */
export function signTestLicense(payload: Record<string, unknown>): string {
  const privatePem = readFileSync('tests/test-private.pem', 'utf8')
  const privateKey = createPrivateKey({ key: privatePem, format: 'pem' })
  const data = Buffer.from(JSON.stringify(payload))
  const signature = sign(null, data, privateKey)
  return `${data.toString('base64url')}.${signature.toString('base64url')}`
}

/** Inserta license_state y license_anti_rollback para un tenant de test. */
export async function setupLicenseState(
  tenantId: string,
  payload: Record<string, unknown>,
  signatureB64: string,
): Promise<void> {
  const dataB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO license_state
       (tenant_id, lic_id, schema_version, license_key, customer, branch,
        seats, features, issued_at, expires_at, hw_fingerprint,
        signature_base64, payload_base64, is_valid, validated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, $14)
     ON CONFLICT (tenant_id) DO UPDATE SET
       lic_id = EXCLUDED.lic_id, signature_base64 = EXCLUDED.signature_base64,
       payload_base64 = EXCLUDED.payload_base64, is_valid = EXCLUDED.is_valid,
       validated_at = EXCLUDED.validated_at, updated_at = EXCLUDED.updated_at`,
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
      payload.hw_fingerprint ?? null,
      signatureB64,
      dataB64,
      now,
    ],
  )
  await initAntiRollback(tenantId, payload.lic_id as string)
}

/** Inicializa el contador anti-rollback para un tenant. */
export async function initAntiRollback(tenantId: string, licId: string): Promise<void> {
  const { createHmac } = await import('node:crypto')
  const hmac = createHmac('sha256', process.env.JWT_SECRET + licId)
    .update('0')
    .digest('hex')
  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO license_anti_rollback
       (tenant_id, counter, counter_hmac, last_sale_at, created_at, updated_at)
     VALUES ($1, 0, $2, $3, $3, $3)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, hmac, now],
  )
}
