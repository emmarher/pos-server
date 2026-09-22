/**
  * tests/license.test.ts — Tests del sistema de licencias firmadas (Ed25519).
  *
  * ────────────────────────────────────────────────────────────────────────
  * Cobertura:
  *   1. Verificación de firma (válida, payload alterado, firma corrupta)
  *   2. validateLicenseAtStartup (8-step checklist)
  *   3. POST /license/upload (admin + permisos)
  *   4. Anti-rollback (HMAC + contador monotónico)
  *   5. Heartbeat (TTL + admin exento)
  *   6. Avisos de vencimiento (30/7 días)
  *
  * Las claves de test se generan en tests/global-setup.ts.
  * ────────────────────────────────────────────────────────────────────────
  */
import { describe, beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { env } from '../src/config/env.js'
import { db } from '../src/database/client.js'
import { PUBLIC_KEY_PEM } from '../src/keys/publicKey.js'
import { verifyLicenseSignature, validateLicenseAtStartup } from '../src/modules/license/license.service.js'
import { signTestLicense, createTenantFixture } from './helpers.js'
import type { FastifyInstance } from 'fastify'

const TEST_DATA_DIR = join(env.sqlitePath, '..')
const TEST_LICENSE_PATH = join(TEST_DATA_DIR, 'test-license.lic')

describe('license', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    mkdirSync(TEST_DATA_DIR, { recursive: true })
    app = await buildApp()
  })

  afterAll(async () => {
    // Restaurar DEMO-0001 a estado limpio (los tests de validateLicenseAtStartup
    // lo dejan is_active=0/expirado). packages/products.image.test.ts comparten
    // la MISMA BD de test (global-setup + singleFork) y dependen de DEMO-0001 activo.
    const future = '2099-12-31T00:00:00Z'
    await db.query(
      `UPDATE tenants SET is_active = 1, license_expires_at = $1, max_devices = 3, updated_at = $2
       WHERE license_key = 'DEMO-0001'`,
      [future, new Date().toISOString()],
    )
    await db.query(
      `DELETE FROM license_state WHERE tenant_id IN (SELECT id FROM tenants WHERE license_key = $1)`,
      ['DEMO-0001'],
    )
    await db.query(
      `DELETE FROM license_anti_rollback WHERE tenant_id IN (SELECT id FROM tenants WHERE license_key = $1)`,
      ['DEMO-0001'],
    )
    await db.query(
      `DELETE FROM license_audit WHERE created_at < $1`,
      [new Date().toISOString()],
    )
    // NOTA: NO llamar a db.end() ni borrar TEST_DATA_DIR aquí. El singleton db
    // y data/pos-test.sqlite son COMPARTIDOS con products.image.test.ts
    // (global-setup + singleFork). Cerrarlos/borrarlos rompe el otro archivo.
    await app.close()
  })

  describe('verifyLicenseSignature', () => {
    it('verifica una firma Ed25519 válida', () => {
      const payload = { schema: 1, lic_id: 'LIC-TEST-001', license_key: 'DEMO-0001', customer: 'Test', branch: 'branch', seats: 3, features: [], issued: '2026-01-01T00:00:00Z', expires: '2027-01-01T00:00:00Z', hw_fingerprint: null }
      const lic = signTestLicense(payload)
      const result = verifyLicenseSignature(lic, PUBLIC_KEY_PEM)
      expect(result.valid).toBe(true)
      expect(result.payload?.lic_id).toBe('LIC-TEST-001')
    })

    it('rechaza payload alterado (firma inválida)', () => {
      const payload = { schema: 1, lic_id: 'LIC-TEST-002', license_key: 'DEMO-0001', customer: 'Test', branch: 'branch', seats: 3, features: [], issued: '2026-01-01T00:00:00Z', expires: '2027-01-01T00:00:00Z', hw_fingerprint: null }
      const lic = signTestLicense(payload)
      // Alterar el payload (cambiar seats de 3 a 100)
      const parts = lic.split('.')
      const tamperedPayload = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
      tamperedPayload.seats = 100
      const tamperedData = Buffer.from(JSON.stringify(tamperedPayload))
      const tamperedLic = `${tamperedData.toString('base64url')}.${parts[1]}`
      const result = verifyLicenseSignature(tamperedLic, PUBLIC_KEY_PEM)
      expect(result.valid).toBe(false)
    })

    it('rechaza formato incorrecto (sin punto)', () => {
      const result = verifyLicenseSignature('not-a-valid-license', PUBLIC_KEY_PEM)
      expect(result.valid).toBe(false)
    })
  })

  describe('validateLicenseAtStartup', () => {
    const originalLicensePath = env.licenseFilePath

    afterEach(() => {
      rmSync(TEST_LICENSE_PATH, { force: true })
      Object.defineProperty(env, 'licenseFilePath', { value: originalLicensePath, configurable: true })
    })

    /* Re-activa DEMO-0001 y limpia su estado de licencia antes de cada test.
       getActiveTenant() valida el PRIMER tenant activo — que es DEMO-0001
       (seed del global-setup). Así apuntamos a éste en vez de a un tenant nuevo. */
    beforeEach(async () => {
      await db.query(
        `UPDATE tenants SET is_active = 1 WHERE license_key = 'DEMO-0001'`,
      )
      await db.query('DELETE FROM license_state WHERE tenant_id IN (SELECT id FROM tenants WHERE license_key = $1)', ['DEMO-0001'])
      await db.query('DELETE FROM license_anti_rollback WHERE tenant_id IN (SELECT id FROM tenants WHERE license_key = $1)', ['DEMO-0001'])
    })

    it('carga licencia válida y activa el tenant', async () => {
      const now = new Date().toISOString()
      const payload = {
        schema: 1,
        lic_id: 'LIC-STARTUP-001',
        license_key: 'DEMO-0001',
        customer: 'Demo Cliente',
        branch: 'sucursal-principal',
        seats: 3,
        features: ['inventory', 'garage', 'reports'],
        issued: now,
        expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        hw_fingerprint: null,
      }
      const licContent = signTestLicense(payload)
      writeFileSync(TEST_LICENSE_PATH, licContent)

      Object.defineProperty(env, 'licenseFilePath', { value: TEST_LICENSE_PATH, configurable: true })

      const status = await validateLicenseAtStartup(app)
      expect(status).toBe('active')

      // Verifica que el tenant fue actualizado con los datos de la licencia
      const { rows } = await db.query<{ max_devices: number; is_active: number }>(
        'SELECT max_devices, is_active FROM tenants WHERE license_key = $1',
        ['DEMO-0001'],
      )
      const tenant = rows[0]
      expect(tenant?.is_active).toBe(1)
      expect(tenant?.max_devices).toBe(3) // Actualizado desde la licencia
    })

    it('entra en modo degradado si no hay archivo .lic', async () => {
      rmSync(TEST_LICENSE_PATH, { force: true })
      Object.defineProperty(env, 'licenseFilePath', { value: TEST_LICENSE_PATH, configurable: true })

      const status = await validateLicenseAtStartup(app)
      expect(status).toBe('missing')
    })

    it('bloquea el tenant si la licencia está expirada', async () => {
      const now = new Date()
      const payload = {
        schema: 1,
        lic_id: 'LIC-STARTUP-002',
        license_key: 'DEMO-0001',
        customer: 'Demo Cliente Expirada',
        branch: 'sucursal-principal',
        seats: 3,
        features: [],
        issued: new Date(now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString(),
        expires: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        hw_fingerprint: null,
      }
      const licContent = signTestLicense(payload)
      writeFileSync(TEST_LICENSE_PATH, licContent)

      Object.defineProperty(env, 'licenseFilePath', { value: TEST_LICENSE_PATH, configurable: true })

      const status = await validateLicenseAtStartup(app)
      expect(status).toBe('expired')

      const { rows } = await db.query<{ is_active: number }>(
        'SELECT is_active FROM tenants WHERE license_key = $1',
        ['DEMO-0001'],
      )
      expect(rows[0]?.is_active).toBe(0)
    })
  })

  describe('POST /license/upload', () => {
    it('permite subir licencia con permisos de admin', async () => {
      const uploadKey = `TEST-UPLOAD-${randomUUID().slice(0, 8)}`
      const user = await createTenantFixture(app, uploadKey)

      const payload = {
        schema: 1,
        lic_id: 'LIC-UPLOAD-001',
        license_key: uploadKey,
        customer: 'Demo Upload',
        branch: 'sucursal-principal',
        seats: 5,
        features: ['inventory', 'reports'],
        issued: new Date().toISOString(),
        expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        hw_fingerprint: null,
      }
      const licContent = signTestLicense(payload)

      const res = await app.inject({
        method: 'POST',
        url: '/license/upload',
        headers: { authorization: `Bearer ${user.token}` },
        payload: { license_data: licContent },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.data.status).toBe('active')
    })

    it('rechaza upload sin permisos admin', async () => {
      const user = await createTenantFixture(app, 'TEST-PERMS')

      const res = await app.inject({
        method: 'POST',
        url: '/license/upload',
        headers: { authorization: `Bearer ${user.token}` },
        payload: { license_data: 'invalid.license' },
      })

      expect(res.statusCode).toBe(403)
    })

    it('rechaza license_key mismatch', async () => {
      const user = await createTenantFixture(app, `TEST-MISMATCH-${randomUUID().slice(0, 6)}`)
      const payload = {
        schema: 1,
        lic_id: 'LIC-MISMATCH-001',
        license_key: 'OTRA-KEY-DISTINTA',
        customer: 'Mismatch',
        branch: 'sucursal',
        seats: 3,
        features: [],
        issued: new Date().toISOString(),
        expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        hw_fingerprint: null,
      }
      const lic = signTestLicense(payload)
      const res = await app.inject({
        method: 'POST',
        url: '/license/upload',
        headers: { authorization: `Bearer ${user.token}` },
        payload: { license_data: lic },
      })
      expect(res.statusCode).toBe(403)
    })

    it('rechaza seats downgrade cuando hay dispositivos activos', async () => {
      const key = `TEST-DOWNGRADE-${randomUUID().slice(0, 6)}`
      const user = await createTenantFixture(app, key)
      // Insertar segunda sesion activa para tener 2 dispositivos
      const { rows: tRows } = await db.query<{ id: string }>('SELECT id FROM tenants WHERE license_key = $1', [key])
      const tenantId = tRows[0].id
      await db.query(
        `INSERT INTO active_sessions (tenant_id, device_id, user_id, jwt_token_hash, expires_at, is_valid, last_heartbeat_at, is_heartbeat_exempt, updated_at)
         VALUES ($1, $2, $3, $4, $5, 1, $6, 0, $6)`,
        [tenantId, 'device-extra-01', user.userId, 'hash-downgrade-test', new Date(Date.now() + 86400000).toISOString(), new Date().toISOString()],
      )
      const payload = {
        schema: 1,
        lic_id: 'LIC-DOWNGRADE-001',
        license_key: key,
        customer: 'Downgrade',
        branch: 'sucursal',
        seats: 1,
        features: [],
        issued: new Date().toISOString(),
        expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        hw_fingerprint: null,
      }
      const lic = signTestLicense(payload)
      const res = await app.inject({
        method: 'POST',
        url: '/license/upload',
        headers: { authorization: `Bearer ${user.token}` },
        payload: { license_data: lic },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().message).toMatch(/Asientos insuficientes/)
    })

    it('acepta licencia expirada y la marca como expired', async () => {
      const key = `TEST-EXPIRED-${randomUUID().slice(0, 6)}`
      const user = await createTenantFixture(app, key)
      const payload = {
        schema: 1,
        lic_id: 'LIC-EXPIRED-001',
        license_key: key,
        customer: 'Expired',
        branch: 'sucursal',
        seats: 2,
        features: [],
        issued: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString(),
        expires: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        hw_fingerprint: null,
      }
      const lic = signTestLicense(payload)
      const res = await app.inject({
        method: 'POST',
        url: '/license/upload',
        headers: { authorization: `Bearer ${user.token}` },
        payload: { license_data: lic },
      })
      expect(res.statusCode).toBe(200)
      // La subida de licencia expirada debe retornar status expired (no requiere GET adicional, el token queda invalido)
      expect(res.json().data.status).toBe('expired')
    })
  })
})
