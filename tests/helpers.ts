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
import { randomUUID } from 'node:crypto'
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
