/**
 * tests/sales.ticket.test.ts — Encabezado del ticket.
 *
 * El nombre viene de la licencia (D1) y dirección/teléfono de tenant_settings.
 * Sin licencia, cae a business_name y luego al nombre del tenant.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { TestSession } from './helpers.js'

const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/database/client.js')
const { loadTicketHeader } = await import('../src/modules/sales/sales.service.js')
const { login, createTenantFixture } = await import('./helpers.js')

describe('Encabezado del ticket', () => {
  let app: FastifyInstance
  let session: TestSession

  beforeAll(async () => {
    app = buildApp()
    await app.ready()
    session = await login(app, 'DEMO-0001')
  })

  it('usa el nombre de la licencia y los datos de contacto', async () => {
    const now = new Date().toISOString()
    await db.query(
      `INSERT INTO tenant_settings (tenant_id, business_address, business_phone, created_at, updated_at)
       VALUES ($1, 'Av. Principal 123', '555-1234', $2, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET
         business_address = EXCLUDED.business_address,
         business_phone = EXCLUDED.business_phone`,
      [session.tenantId, now],
    )
    await db.query(
      `INSERT INTO license_state
         (tenant_id, lic_id, schema_version, license_key, customer, branch, seats,
          features, issued_at, expires_at, signature_base64, payload_base64,
          is_valid, validated_at, updated_at)
       VALUES ($1, 'LIC-T', 1, 'DEMO-0001', 'Abarrotes La Esquina', 'centro', 2,
               '[]', $2, '2099-12-31T00:00:00Z', 'sig', 'payload', 1, $2, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET customer = 'Abarrotes La Esquina'`,
      [session.tenantId, now],
    )

    const header = await loadTicketHeader(db, session.tenantId)
    expect(header.businessName).toBe('Abarrotes La Esquina')
    expect(header.businessAddress).toBe('Av. Principal 123')
    expect(header.businessPhone).toBe('555-1234')
  })

  it('sin licencia cae al nombre del tenant', async () => {
    const other = await createTenantFixture(app, 'SIN-LIC-0001')
    const header = await loadTicketHeader(db, other.tenantId)
    expect(header.businessName).toBe(`Tenant SIN-LIC-0001`)
  })
})
