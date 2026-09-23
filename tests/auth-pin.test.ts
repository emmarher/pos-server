/**
 * tests/auth-pin.test.ts — PIN inicial obligatorio (F-I2b instalador).
 *
 * Cobertura:
 *   1. Login con must_change_pin=1 → 403 MUST_CHANGE_PIN (sin tokens).
 *   2. POST /auth/change-pin happy path → 200 + login OK con el PIN nuevo.
 *   3. change-pin con PIN actual erróneo → 401.
 *   4. change-pin con new_pin igual al actual → 400.
 *   5. change-pin con formato inválido → 400 (schema).
 *   6. Login normal (flag=0) no afectado → 200.
 *
 * Usa tenant fixture propio (clave única por corrida): los suites corren en
 * workers paralelos sobre la MISMA BD de test, así que NUNCA se mutan los
 * usuarios DEMO compartidos (eso tumbaba a products.image.test.ts).
 */
import { describe, beforeAll, afterAll, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { db } from '../src/database/client.js'
import { createTenantFixture, login } from './helpers.js'

const TENANT_CODE = `PINTEST-${randomUUID().slice(0, 8).toUpperCase()}`
const CURRENT_PIN = '1234'
const NEW_PIN = '4321'
const DEVICE = 'test-device-pin'

async function postLogin(app: FastifyInstance, pin: string) {
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      tenant_code: TENANT_CODE,
      pin,
      device_id: DEVICE,
      device_name: 'Test PIN',
      device_type: 'DESKTOP',
    },
  })
}

describe('auth-pin', () => {
  let app: FastifyInstance
  let tenantId: string

  beforeAll(async () => {
    app = buildApp()
    // Fixture con admin (todos los permisos) + login OK; luego activamos el flag.
    const session = await createTenantFixture(app, TENANT_CODE)
    tenantId = session.tenantId
    await db.query('UPDATE users SET must_change_pin = 1 WHERE tenant_id = $1', [tenantId])
  })

  afterAll(async () => {
    await app.close()
  })

  it('6. login normal (flag=0) no afectado → 200', async () => {
    await db.query('UPDATE users SET must_change_pin = 0 WHERE tenant_id = $1', [tenantId])
    const session = await login(app, TENANT_CODE, CURRENT_PIN)
    expect(session.token).toBeTruthy()
    // Re-armar el flag para los siguientes tests
    await db.query('UPDATE users SET must_change_pin = 1 WHERE tenant_id = $1', [tenantId])
  })

  it('1. login con must_change_pin=1 → 403 sin tokens', async () => {
    await db.query('UPDATE users SET must_change_pin = 1 WHERE tenant_id = $1', [tenantId])
    const res = await postLogin(app, CURRENT_PIN)
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.message).toMatch(/PIN/i)
    expect(body.data).toEqual([])
  })

  it('2. change-pin happy path → 200 y login OK con PIN nuevo', async () => {
    const change = await app.inject({
      method: 'POST',
      url: '/auth/change-pin',
      payload: { tenant_code: TENANT_CODE, pin: CURRENT_PIN, new_pin: NEW_PIN },
    })
    expect(change.statusCode).toBe(200)
    expect(change.json().data).toEqual({ changed: true })

    const retry = await postLogin(app, NEW_PIN)
    expect(retry.statusCode).toBe(200)

    // El PIN viejo ya no sirve
    const stale = await postLogin(app, CURRENT_PIN)
    expect(stale.statusCode).toBe(401)
  })

  it('3. change-pin con PIN actual erróneo → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-pin',
      payload: { tenant_code: TENANT_CODE, pin: '0000', new_pin: '5678' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('4. change-pin con new_pin igual → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-pin',
      payload: { tenant_code: TENANT_CODE, pin: NEW_PIN, new_pin: NEW_PIN },
    })
    expect(res.statusCode).toBe(400)
  })

  it('5. change-pin con formato inválido → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-pin',
      payload: { tenant_code: TENANT_CODE, pin: NEW_PIN, new_pin: 'abc' },
    })
    expect(res.statusCode).toBe(400)
  })
})
