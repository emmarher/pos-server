/**
 * tests/products.image.test.ts — Pruebas de imágenes de producto.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Cobertura (Tarea 8 del plan):
 *   - POST /products/:id/image   → happy path + errores de validación
 *   - DELETE /products/:id/image → limpia BD + bucket
 *   - GET /images/:tenant/:file  → proxy con key válida/inválida
 *   - Aislamiento multi-tenant   → tenant B NO puede tocar producto de A
 *
 * El storage S3 (Garage) se MOCKEA: las pruebas no requieren Garage
 * corriendo ni tocan objetos reales. La BD es un SQLite dedicado
 * (`data/pos-test.sqlite`) montado por global-setup.
 * ────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { TestSession } from './helpers.js'

/* Mock del storage S3: se conservan los helpers puros (keyFromUrl). */
vi.mock('../src/services/storage.service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/services/storage.service.js')>()
  return {
    ...actual,
    uploadProductImage: vi.fn(async (tenantId: string) => {
      const file = `${randomUUID()}`
      return {
        key: `${tenantId}/prod_${file}.webp`,
        url: `/images/${tenantId}/prod_${file}.webp`,
      }
    }),
    deleteImage: vi.fn(async () => {}),
    getImageStream: vi.fn(async () => {
      const body = new PassThrough()
      body.end(Buffer.from('fake-webp-bytes'))
      return { body, contentType: 'image/webp' }
    }),
  }
})

const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/database/client.js')
const { deleteImage } = await import('../src/services/storage.service.js')
const { login, createTenantFixture } = await import('./helpers.js')
const { setProductImageUrl } = await import(
  '../src/modules/products/products.service.js'
)

/* ── Helpers locales ─────────────────────────────────────────────────── */

/** Construye un cuerpo multipart/form-data con un solo archivo. */
function multipartFile(
  mime: string,
  content: Buffer,
  filename = 'foto.png',
): { payload: Buffer; contentType: string } {
  const boundary = '----vitestimageboundary'
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, content, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

/** Inserta un producto mínimo directamente en BD y devuelve su id. */
async function createProductFixture(tenantId: string): Promise<string> {
  const id = randomUUID()
  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO products
       (id, tenant_id, name, base_unit_id, sale_unit_id, price, cost, stock,
        created_at, updated_at)
     VALUES ($1, $2, 'Producto Test',
             (SELECT id FROM measurement_units LIMIT 1),
             (SELECT id FROM measurement_units LIMIT 1),
             10, 5, 100, $3, $3)`,
    [id, tenantId, now],
  )
  return id
}

/* ── Suite ───────────────────────────────────────────────────────────── */

describe('Imágenes de producto', () => {
  let app: FastifyInstance
  let sessionA: TestSession
  let sessionB: TestSession
  let productA: string

  beforeAll(async () => {
    app = buildApp()
    sessionA = await login(app, 'DEMO-0001')
    sessionB = await createTenantFixture(app, 'TEST-B-0001')
    productA = await createProductFixture(sessionA.tenantId)
  })

  it('sube imagen (happy path) y queda reflejada en el producto', async () => {
    const file = multipartFile('image/png', Buffer.from('png-bytes'))
    const res = await app.inject({
      method: 'POST',
      url: `/products/${productA}/image`,
      headers: {
        authorization: `Bearer ${sessionA.token}`,
        'content-type': file.contentType,
      },
      payload: file.payload,
    })
    expect(res.statusCode).toBe(200)
    const url = res.json().data.imagen_url as string
    expect(url).toMatch(
      new RegExp(
        `^/images/${sessionA.tenantId}/prod_[0-9a-f-]{36}\\.webp$`,
      ),
    )

    /* El catálogo expone la URL */
    const detail = await app.inject({
      method: 'GET',
      url: `/products/${productA}`,
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    expect(detail.json().data.imagen_url).toBe(url)
  })

  it('sirve la imagen por el proxy GET /images con Content-Type webp', async () => {
    /* Fija una URL conocida y pídela por el proxy */
    const url = `/images/${sessionA.tenantId}/prod_11111111-2222-3333-4444-555555555555.webp`
    await setProductImageUrl(sessionA.tenantId, productA, url)

    const res = await app.inject({
      method: 'GET',
      url,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/webp')
    expect(res.headers['cache-control']).toContain('immutable')
    expect(res.body).toBe('fake-webp-bytes')
  })

  it('rechaza MIME inválido con 400', async () => {
    const file = multipartFile('text/plain', Buffer.from('no-soy-imagen'))
    const res = await app.inject({
      method: 'POST',
      url: `/products/${productA}/image`,
      headers: {
        authorization: `Bearer ${sessionA.token}`,
        'content-type': file.contentType,
      },
      payload: file.payload,
    })
    expect(res.statusCode).toBe(400)
  })

  it('rechaza JSON sin multipart con 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/products/${productA}/image`,
      headers: {
        authorization: `Bearer ${sessionA.token}`,
        'content-type': 'application/json',
      },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('proxy responde 404 para keys inválidas (fuera del patrón)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/images/${sessionA.tenantId}/secreto.txt`,
    })
    expect(res.statusCode).toBe(404)
  })

  it('aislamiento multi-tenant: tenant B no puede tocar producto de A', async () => {
    const file = multipartFile('image/png', Buffer.from('intruso'))
    const res = await app.inject({
      method: 'POST',
      url: `/products/${productA}/image`,
      headers: {
        authorization: `Bearer ${sessionB.token}`,
        'content-type': file.contentType,
      },
      payload: file.payload,
    })
    expect(res.statusCode).toBe(404)

    /* El producto de A conserva SU imagen intacta */
    const detail = await app.inject({
      method: 'GET',
      url: `/products/${productA}`,
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    expect(detail.json().data.imagen_url).toBe(
      `/images/${sessionA.tenantId}/prod_11111111-2222-3333-4444-555555555555.webp`,
    )
  })

  it('DELETE quita la imagen: BD en null y objeto borrado del bucket', async () => {
    vi.mocked(deleteImage).mockClear()
    const res = await app.inject({
      method: 'DELETE',
      url: `/products/${productA}/image`,
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.imagen_url).toBeNull()
    expect(vi.mocked(deleteImage)).toHaveBeenCalledTimes(1)

    const detail = await app.inject({
      method: 'GET',
      url: `/products/${productA}`,
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    expect(detail.json().data.imagen_url).toBeNull()
  })

  it('producto inexistente → 404', async () => {
    const file = multipartFile('image/png', Buffer.from('x'))
    const res = await app.inject({
      method: 'POST',
      url: `/products/${randomUUID()}/image`,
      headers: {
        authorization: `Bearer ${sessionA.token}`,
        'content-type': file.contentType,
      },
      payload: file.payload,
    })
    expect(res.statusCode).toBe(404)
  })

  it('sin token → 401', async () => {
    const file = multipartFile('image/png', Buffer.from('x'))
    const res = await app.inject({
      method: 'POST',
      url: `/products/${productA}/image`,
      headers: { 'content-type': file.contentType },
      payload: file.payload,
    })
    expect(res.statusCode).toBe(401)
  })
})
