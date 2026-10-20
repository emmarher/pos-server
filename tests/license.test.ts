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
import { join, resolve, dirname } from 'node:path'
import { buildApp } from '../src/app.js'
import { env } from '../src/config/env.js'
import { db } from '../src/database/client.js'
import { PUBLIC_KEY_PEM } from '../src/keys/publicKey.js'
import { verifyLicenseSignature, validateLicenseAtStartup, keyToolDirs } from '../src/modules/license/license.service.js'
import { signTestLicense, createTenantFixture, login } from './helpers.js'
import type { FastifyInstance } from 'fastify'

const TEST_DATA_DIR = join(env.sqlitePath, '..')
const TEST_LICENSE_PATH = join(TEST_DATA_DIR, 'test-license.lic')

describe('license', () => {
  let app: FastifyInstance
  const originalDevMode = env.licenseDevMode

  /* licenseDevMode es estado global: cada test que lo cambia lo restaura
     (salvo los que verifican explícitamente el comportamiento de dev). */
  afterEach(() => {
    Object.defineProperty(env, 'licenseDevMode', { value: originalDevMode, configurable: true })
  })

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
    const originalDevMode = env.licenseDevMode

    afterEach(() => {
      rmSync(TEST_LICENSE_PATH, { force: true })
      Object.defineProperty(env, 'licenseFilePath', { value: originalLicensePath, configurable: true })
      Object.defineProperty(env, 'licenseDevMode', { value: originalDevMode, configurable: true })
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
      // Comportamiento ESTRICTO (producción): sin el flag de desarrollo la
      // licencia vencida SÍ bloquea el tenant.
      Object.defineProperty(env, 'licenseDevMode', { value: false, configurable: true })
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

    /* Regresión: al RENOVAR la licencia (nuevo lic_id) el sello HMAC del
       contador anti-rollback quedaba atado al lic_id anterior. El arranque
       siguiente leía "HMAC mismatch: posible manipulación de BD" → el tenant
       se desactivaba (login 403 + ventas bloqueadas) aun con licencia válida.
       El sello debe RE-LIGARSE al nuevo lic_id conservando el contador. */
    it('re-liga el sello anti-rollback al renovar la licencia (no bloquea el tenant)', async () => {
      const base = {
        schema: 1,
        license_key: 'DEMO-0001',
        customer: 'Demo Renovacion',
        branch: 'sucursal-principal',
        seats: 3,
        features: [],
        issued: new Date().toISOString(),
        expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        hw_fingerprint: null,
      }
      Object.defineProperty(env, 'licenseFilePath', { value: TEST_LICENSE_PATH, configurable: true })

      // Arranque 1: licencia original
      writeFileSync(TEST_LICENSE_PATH, signTestLicense({ ...base, lic_id: 'LIC-RENEW-001' }))
      expect(await validateLicenseAtStartup(app)).toBe('active')

      // Arranque 2: el tenant RENUEVA (lic_id nuevo)
      writeFileSync(TEST_LICENSE_PATH, signTestLicense({ ...base, lic_id: 'LIC-RENEW-002' }))
      expect(await validateLicenseAtStartup(app)).toBe('active')

      // Arranque 3: el sello debe seguir siendo válido con la licencia nueva.
      // Antes del fix este arranque devolvía 'grace_clock' y desactivaba el tenant.
      expect(await validateLicenseAtStartup(app)).toBe('active')

      const { rows } = await db.query<{ is_active: number; lic_id: string; counter: number }>(
        `SELECT t.is_active AS is_active, ls.lic_id AS lic_id, ar.counter AS counter
         FROM tenants t
         JOIN license_state ls ON ls.tenant_id = t.id
         JOIN license_anti_rollback ar ON ar.tenant_id = t.id
         WHERE t.license_key = 'DEMO-0001'`,
      )
      expect(rows[0]?.is_active).toBe(1)
      expect(rows[0]?.lic_id).toBe('LIC-RENEW-002')
      // El contador NO se reinicia al re-ligar el sello
      expect(rows[0]?.counter).toBe(0)
    })

    /* Un tenant desactivado por un arranque previo (gracia expirada, licencia
       vencida) queda bloqueado para siempre: getActiveTenant() no lo devuelve
       y la validación se salta. Con un .lic válido en disco el tenant debe
       reactivarse solo. */
    it('reactiva un tenant desactivado si hay una licencia válida en disco', async () => {
      const payload = {
        schema: 1,
        lic_id: 'LIC-REACTIVA-001',
        license_key: 'DEMO-0001',
        customer: 'Demo Reactivacion',
        branch: 'sucursal-principal',
        seats: 3,
        features: [],
        issued: new Date().toISOString(),
        expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        hw_fingerprint: null,
      }
      writeFileSync(TEST_LICENSE_PATH, signTestLicense(payload))
      Object.defineProperty(env, 'licenseFilePath', { value: TEST_LICENSE_PATH, configurable: true })

      // Simula el arranque previo que desactivó el tenant
      await db.query(`UPDATE tenants SET is_active = 0 WHERE license_key = 'DEMO-0001'`)

      const status = await validateLicenseAtStartup(app)
      expect(status).toBe('active')

      const { rows } = await db.query<{ is_active: number }>(
        'SELECT is_active FROM tenants WHERE license_key = $1',
        ['DEMO-0001'],
      )
      expect(rows[0]?.is_active).toBe(1)
    })

    /* Estados dejados por versiones anteriores (0.2.6): el sello anti-rollback
       quedó atado al lic_id ANTERIOR mientras license_state ya guardaba el
       nuevo → "HMAC mismatch" → tenant desactivado. Si el sello valida contra
       un lic_id histórico (prueba de que es auténtico, no una manipulación),
       se re-liga al vigente y el tenant vuelve a operar. */
    it('repara un sello anti-rollback atado a una licencia anterior', async () => {
      const base = {
        schema: 1,
        license_key: 'DEMO-0001',
        customer: 'Demo Herencia',
        branch: 'sucursal-principal',
        seats: 3,
        features: [],
        issued: new Date().toISOString(),
        expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        hw_fingerprint: null,
      }
      Object.defineProperty(env, 'licenseFilePath', { value: TEST_LICENSE_PATH, configurable: true })

      // Arranque 1: licencia LIC-LEGACY-001 (deja el sello atado a este lic_id
      // y un rastro en license_audit)
      writeFileSync(TEST_LICENSE_PATH, signTestLicense({ ...base, lic_id: 'LIC-LEGACY-001' }))
      expect(await validateLicenseAtStartup(app)).toBe('active')

      // Simula el estado roto de 0.2.6: license_state apunta al lic_id NUEVO
      // pero el sello sigue atado al anterior.
      await db.query(
        `UPDATE license_state SET lic_id = 'LIC-LEGACY-002' WHERE tenant_id IN (SELECT id FROM tenants WHERE license_key = 'DEMO-0001')`,
      )
      writeFileSync(TEST_LICENSE_PATH, signTestLicense({ ...base, lic_id: 'LIC-LEGACY-002' }))

      const status = await validateLicenseAtStartup(app)
      expect(status).toBe('active')

      const { rows } = await db.query<{ is_active: number; lic_id: string }>(
        `SELECT t.is_active AS is_active, ls.lic_id AS lic_id
         FROM tenants t
         JOIN license_state ls ON ls.tenant_id = t.id
         WHERE t.license_key = 'DEMO-0001'`,
      )
      expect(rows[0]?.is_active).toBe(1)
      expect(rows[0]?.lic_id).toBe('LIC-LEGACY-002')
    })
  })

  /* ── Modo desarrollo (LICENSE_DEV_MODE) ──────────────────────────────
     Lo activa `npm run dev` / `npm test` (nunca el .env). En modo dev la
     licencia NUNCA bloquea al tenant: si está vencida o inválida se
     reactiva con vigencia extendida. */
  describe('modo desarrollo (LICENSE_DEV_MODE)', () => {
    const originalLicensePath = env.licenseFilePath

    beforeEach(async () => {
      Object.defineProperty(env, 'licenseDevMode', { value: true, configurable: true })
      await db.query(`UPDATE tenants SET is_active = 1 WHERE license_key = 'DEMO-0001'`)
      await db.query('DELETE FROM license_state WHERE tenant_id IN (SELECT id FROM tenants WHERE license_key = $1)', ['DEMO-0001'])
      await db.query('DELETE FROM license_anti_rollback WHERE tenant_id IN (SELECT id FROM tenants WHERE license_key = $1)', ['DEMO-0001'])
    })

    afterEach(() => {
      rmSync(TEST_LICENSE_PATH, { force: true })
      Object.defineProperty(env, 'licenseFilePath', { value: originalLicensePath, configurable: true })
    })

    it('no bloquea el tenant con una licencia vencida y extiende la vigencia', async () => {
      const now = new Date()
      const payload = {
        schema: 1,
        lic_id: 'LIC-DEV-EXPIRED-001',
        license_key: 'DEMO-0001',
        customer: 'Demo Dev',
        branch: 'sucursal-principal',
        seats: 3,
        features: [],
        issued: new Date(now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString(),
        expires: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        hw_fingerprint: null,
      }
      writeFileSync(TEST_LICENSE_PATH, signTestLicense(payload))
      Object.defineProperty(env, 'licenseFilePath', { value: TEST_LICENSE_PATH, configurable: true })

      const status = await validateLicenseAtStartup(app)
      expect(status).toBe('active')

      const { rows } = await db.query<{ is_active: number; license_expires_at: string }>(
        'SELECT is_active, license_expires_at FROM tenants WHERE license_key = $1',
        ['DEMO-0001'],
      )
      expect(rows[0]?.is_active).toBe(1)
      // La vigencia se extiende hacia adelante (nunca al pasado).
      expect(new Date(rows[0]!.license_expires_at).getTime()).toBeGreaterThan(Date.now())
    })

    it('reactiva un tenant bloqueado aunque la licencia falte', async () => {
      rmSync(TEST_LICENSE_PATH, { force: true })
      Object.defineProperty(env, 'licenseFilePath', { value: TEST_LICENSE_PATH, configurable: true })
      await db.query(
        `UPDATE tenants SET is_active = 0, license_expires_at = $1 WHERE license_key = 'DEMO-0001'`,
        [new Date(Date.now() - 86400000).toISOString()],
      )

      const status = await validateLicenseAtStartup(app)
      expect(status).toBe('missing') // sin .lic sigue siendo 'missing' (no bloquea)

      const { rows } = await db.query<{ is_active: number }>(
        'SELECT is_active FROM tenants WHERE license_key = $1',
        ['DEMO-0001'],
      )
      expect(rows[0]?.is_active).toBe(1)
    })

    it('el middleware de auth NO bloquea con licencia vencida en modo dev', async () => {
      const key = `TEST-DEV-AUTH-${randomUUID().slice(0, 6)}`
      const user = await createTenantFixture(app, key)
      // Se vence la licencia del tenant recien creado
      await db.query(
        `UPDATE tenants SET is_active = 0, license_expires_at = $1 WHERE license_key = $2`,
        [new Date(Date.now() - 86400000).toISOString(), key],
      )

      // POST /auth/heartbeat usa `authenticate` → valida la licencia en cada request
      const res = await app.inject({
        method: 'POST',
        url: '/auth/heartbeat',
        headers: { authorization: `Bearer ${user.token}` },
      })
      expect(res.statusCode).toBe(200)
    })

    it('GET /license/status reporta active en modo dev', async () => {
      const key = `TEST-DEV-STATUS-${randomUUID().slice(0, 6)}`
      const user = await createTenantFixture(app, key)
      await db.query(
        `UPDATE tenants SET is_active = 0, license_expires_at = $1 WHERE license_key = $2`,
        [new Date(Date.now() - 86400000).toISOString(), key],
      )

      const res = await app.inject({
        method: 'GET',
        url: '/license/status',
        headers: { authorization: `Bearer ${user.token}` },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().data.status).toBe('active')
    })
  })

  /* ── D1: el trial no está disponible en producción ────────────────── */
  describe('POST /license/trial', () => {
    const originalTrialEnabled = env.trialEnabled

    afterEach(() => {
      Object.defineProperty(env, 'trialEnabled', { value: originalTrialEnabled, configurable: true })
    })

    it('rechaza el trial cuando TRIAL_ENABLED=false (instalador de producción)', async () => {
      Object.defineProperty(env, 'trialEnabled', { value: false, configurable: true })
      const res = await app.inject({ method: 'POST', url: '/license/trial' })
      expect(res.statusCode).toBe(403)
      expect(res.json().message).toMatch(/trial no están disponibles/i)
    })
  })

  /* ── D2: la clave trial privada NO se busca en la carpeta de datos ── */
  describe('keyToolDirs (D2)', () => {
    it('excluye la carpeta de datos y la carpeta del .lic', () => {
      const dirs = keyToolDirs()
      const dataFolder = resolve(env.sqlitePath, '..')
      const licenseFolder = dirname(env.licenseFilePath)
      expect(dirs).not.toContain(dataFolder)
      expect(dirs).not.toContain(licenseFolder)
      expect(dirs.some((d) => d.endsWith('tools/keys') || d.endsWith('tools-posky/keys'))).toBe(true)
    })
  })

  /* ── La respuesta PÚBLICA no expone datos del cliente en producción ── */
  describe('GET /license/status (público)', () => {
    const originalDevMode = env.licenseDevMode

    afterEach(() => {
      Object.defineProperty(env, 'licenseDevMode', { value: originalDevMode, configurable: true })
    })

    it('redacta lic_id/customer/features sin token en producción', async () => {
      Object.defineProperty(env, 'licenseDevMode', { value: false, configurable: true })
      // La petición anónima resuelve el PRIMER tenant activo → DEMO-0001.
      const user = await login(app, 'DEMO-0001', '1234')
      const payload = {
        schema: 1,
        lic_id: 'LIC-REDACT-001',
        license_key: 'DEMO-0001',
        customer: 'Cliente Secreto',
        branch: 'sucursal',
        seats: 3,
        features: ['inventory', 'reports'],
        issued: new Date().toISOString(),
        expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        hw_fingerprint: null,
      }
      const lic = signTestLicense(payload)
      await app.inject({
        method: 'POST',
        url: '/license/upload',
        headers: { authorization: `Bearer ${user.token}` },
        payload: { license_data: lic },
      })

      // Sin token → datos del cliente redactados
      const anon = await app.inject({ method: 'GET', url: '/license/status' })
      expect(anon.statusCode).toBe(200)
      expect(anon.json().data.lic_id).toBeNull()
      expect(anon.json().data.customer).toBeNull()
      expect(anon.json().data.features).toEqual([])
      expect(anon.json().data.status).toBe('active')

      // Con token → detalle completo
      const authed = await app.inject({
        method: 'GET',
        url: '/license/status',
        headers: { authorization: `Bearer ${user.token}` },
      })
      expect(authed.json().data.lic_id).toBe('LIC-REDACT-001')
      expect(authed.json().data.customer).toBe('Cliente Secreto')
    })

    it('en modo dev la respuesta pública sí muestra el detalle', async () => {
      Object.defineProperty(env, 'licenseDevMode', { value: true, configurable: true })
      const user = await login(app, 'DEMO-0001', '1234')
      const payload = {
        schema: 1,
        lic_id: 'LIC-REDACT-DEV-001',
        license_key: 'DEMO-0001',
        customer: 'Cliente Dev',
        branch: 'sucursal',
        seats: 3,
        features: ['inventory'],
        issued: new Date().toISOString(),
        expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        hw_fingerprint: null,
      }
      await app.inject({
        method: 'POST',
        url: '/license/upload',
        headers: { authorization: `Bearer ${user.token}` },
        payload: { license_data: signTestLicense(payload) },
      })

      const anon = await app.inject({ method: 'GET', url: '/license/status' })
      expect(anon.json().data.lic_id).toBe('LIC-REDACT-DEV-001')
      expect(anon.json().data.customer).toBe('Cliente Dev')
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

    it('adopta el license_key del .lic (el .lic manda)', async () => {
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
      // El .lic es la fuente de verdad: el tenant ADOPTA su license_key (200).
      expect(res.statusCode).toBe(200)
      const { rows } = await db.query<{ c: number }>(
        'SELECT COUNT(*) AS c FROM tenants WHERE license_key = $1',
        ['OTRA-KEY-DISTINTA'],
      )
      expect(rows[0]?.c).toBe(1)
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
      // Comportamiento ESTRICTO (producción): el estado reportado es 'expired'.
      Object.defineProperty(env, 'licenseDevMode', { value: false, configurable: true })
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
