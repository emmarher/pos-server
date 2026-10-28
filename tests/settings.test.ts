/**
 * tests/settings.test.ts — Configuración del comercio y logo.
 *
 * Cubre GET/PATCH /settings/tenant y POST/DELETE /settings/logo.
 * El storage S3 se mockea (no requiere RustFS).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { TestSession } from './helpers.js'

vi.mock('../src/services/storage.service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/services/storage.service.js')>()
  return {
    ...actual,
    uploadMerchantLogo: vi.fn(async (tenantId: string) => {
      const file = randomUUID()
      return {
        key: `${tenantId}/logo_${file}.webp`,
        url: `/images/${tenantId}/logo_${file}.webp`,
      }
    }),
    deleteImage: vi.fn(async () => {}),
  }
})

const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/database/client.js')
const { deleteImage } = await import('../src/services/storage.service.js')
const { login } = await import('./helpers.js')

/** Construye un multipart/form-data con un archivo. */
function multipartFile(mime: string, content: Buffer): { payload: Buffer; contentType: string } {
  const boundary = '----vitestsettingsboundary'
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="logo.png"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, content, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

describe('Configuración del comercio', () => {
  let app: FastifyInstance
  let session: TestSession

  beforeAll(async () => {
    app = buildApp()
    session = await login(app, 'DEMO-0001')
  })

  function auth() {
    return { authorization: `Bearer ${session.token}` }
  }

  it('1) GET devuelve la configuración y el nombre resuelto', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings/tenant', headers: auth() })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(typeof data.display_name).toBe('string')
    expect(data.logo_url).toBeNull()
  })

  it('2) el nombre de la licencia tiene prioridad sobre business_name', async () => {
    const now = new Date().toISOString()
    await db.query(
      `INSERT INTO license_state
         (tenant_id, lic_id, schema_version, license_key, customer, branch, seats,
          features, issued_at, expires_at, signature_base64, payload_base64,
          is_valid, validated_at, updated_at)
       VALUES ($1, 'LIC-TEST', 1, 'DEMO-0001', 'Abarrotes La Esquina', 'centro', 2,
               '[]', $2, '2099-12-31T00:00:00Z', 'sig', 'payload', 1, $2, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET customer = 'Abarrotes La Esquina'`,
      [session.tenantId, now],
    )

    const res = await app.inject({ method: 'GET', url: '/settings/tenant', headers: auth() })
    expect(res.json().data.display_name).toBe('Abarrotes La Esquina')
  })

  it('3) PATCH actualiza dirección, teléfono y pie de ticket', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/tenant',
      headers: auth(),
      payload: {
        address: 'Av. Principal 123',
        phone: '555-1234',
        receipt_footer: 'Vuelva pronto',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.address).toBe('Av. Principal 123')
    expect(res.json().data.phone).toBe('555-1234')
    expect(res.json().data.receipt_footer).toBe('Vuelva pronto')
  })

  it('4) POST /settings/logo guarda la ruta y DELETE la quita', async () => {
    const file = multipartFile('image/png', Buffer.from('png-bytes'))
    const up = await app.inject({
      method: 'POST',
      url: '/settings/logo',
      headers: { ...auth(), 'content-type': file.contentType },
      payload: file.payload,
    })
    expect(up.statusCode).toBe(200)
    const url = up.json().data.logo_url as string
    expect(url).toMatch(new RegExp(`^/images/${session.tenantId}/logo_[0-9a-f-]{36}\\.webp$`))

    const get = await app.inject({ method: 'GET', url: '/settings/tenant', headers: auth() })
    expect(get.json().data.logo_url).toBe(url)

    const del = await app.inject({ method: 'DELETE', url: '/settings/logo', headers: auth() })
    expect(del.statusCode).toBe(200)
    expect(del.json().data.logo_url).toBeNull()
    expect(deleteImage).toHaveBeenCalled()
  })

  it('5) rechaza un MIME no permitido', async () => {
    const file = multipartFile('text/plain', Buffer.from('no-es-imagen'))
    const res = await app.inject({
      method: 'POST',
      url: '/settings/logo',
      headers: { ...auth(), 'content-type': file.contentType },
      payload: file.payload,
    })
    expect(res.statusCode).toBe(400)
  })
})
