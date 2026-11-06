/**
 * tests/auth-refresh.test.ts — Regresión: /auth/refresh debe conservar permisos.
 *
 * Bug original: refresh() re-firmaba el access token con el payload del
 * refresh token, que a propósito viaja con `permissions: []`. El token
 * refrescado quedaba sin permisos y todo `requirePermission` respondía 403
 * (productos, categorías…) hasta cerrar y volver a iniciar sesión.
 *
 * Cobertura:
 *   1) El refresh devuelve los mismos permisos que el login.
 *   2) El access token refrescado sirve para GET /products (200, no 403).
 *   3) El refresh token rota: el anterior queda inválido y el nuevo sirve.
 * ────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'

const { buildApp } = await import('../src/app.js')
const { createTenantFixture } = await import('./helpers.js')

interface SessionTokens {
  access: string
  refresh: string
  permissions: string[]
}

const TENANT_CODE = 'REF-A-0001'

/** Login real (mismo device_id) y devuelve tokens + permisos resueltos. */
async function loginTokens(app: FastifyInstance): Promise<SessionTokens> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      tenant_code: TENANT_CODE,
      pin: '1234',
      device_id: `test-device-${TENANT_CODE}`,
      device_name: 'Test Runner',
      device_type: 'DESKTOP',
    },
  })
  if (res.statusCode !== 200) {
    throw new Error(`login falló: ${res.statusCode} ${res.body}`)
  }
  const data = res.json().data
  return {
    access: data.access_token as string,
    refresh: data.refresh_token as string,
    permissions: data.user.permissions as string[],
  }
}

describe('POST /auth/refresh — permisos', () => {
  let app: FastifyInstance
  let tokens: SessionTokens

  beforeAll(async () => {
    app = buildApp()
    await app.ready()
    await createTenantFixture(app, TENANT_CODE)
  })

  beforeEach(async () => {
    // Token fresco por prueba: el refresh rota y revoca el anterior.
    tokens = await loginTokens(app)
  })

  it('1) el refresh conserva los permisos del login', async () => {
    expect(tokens.permissions).toContain('products:read')

    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: tokens.refresh },
    })
    expect(res.statusCode).toBe(200)

    const data = res.json().data
    expect([...data.user.permissions].sort()).toEqual(
      [...tokens.permissions].sort(),
    )
    expect(data.user.role_name).toBe('Administrador')
  })

  it('2) el access token refrescado permite leer productos', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: tokens.refresh },
    })
    const accessToken = res.json().data.access_token as string

    const products = await app.inject({
      method: 'GET',
      url: '/products',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(products.statusCode).toBe(200)
  })

  it('3) rota el refresh: el anterior ya no sirve', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: tokens.refresh },
    })
    expect(first.statusCode).toBe(200)
    const newRefresh = first.json().data.refresh_token as string

    const replay = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: tokens.refresh },
    })
    expect(replay.statusCode).toBe(401)

    const rotated = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: newRefresh },
    })
    expect(rotated.statusCode).toBe(200)
  })
})
