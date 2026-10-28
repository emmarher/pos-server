/**
 * tests/reports.top-products.test.ts — Reporte de productos más vendidos.
 *
 * Verifica el endpoint GET /reports/top-products:
 *   1) ranking por ingreso, unidades y tickets.
 *   2) filtro de fechas y límite.
 *   3) aislamiento multi-tenant.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { TestSession } from './helpers.js'

const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/database/client.js')
const { login, createTenantFixture } = await import('./helpers.js')

interface ProductRow {
  id: string
  name: string
  base_unit_id: string
  sale_unit_id: string
}

/** Inserta una venta COMPLETED y devuelve su id. */
async function insertSale(
  tenantId: string,
  sellerId: string,
  folio: number,
  createdAt: string,
): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO sales
       (id, tenant_id, device_id, seller_id, folio_number, folio_prefix,
        subtotal, total, status, payment_state, created_at, updated_at)
     VALUES ($1, $2, 'test-device', $3, $4, 'V', $5, $5, 'COMPLETED', 'PAID', $6, $6)`,
    [id, tenantId, sellerId, folio, 0, createdAt],
  )
  return id
}

/** Inserta un ítem de venta con base_quantity y subtotal dados. */
async function insertSaleItem(
  tenantId: string,
  saleId: string,
  product: ProductRow,
  units: number,
  subtotal: number,
  createdAt: string,
): Promise<void> {
  await db.query(
    `INSERT INTO sale_items
       (id, sale_id, tenant_id, product_id, product_name,
        product_base_unit_id, product_sale_unit_id, product_unit_conversion,
        quantity, base_quantity, unit_id, unit_price, subtotal, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8, $7, $9, $10, $11)`,
    [
      randomUUID(),
      saleId,
      tenantId,
      product.id,
      product.name,
      product.base_unit_id,
      product.sale_unit_id,
      units,
      subtotal / units,
      subtotal,
      createdAt,
    ],
  )
}

describe('GET /reports/top-products', () => {
  let app: FastifyInstance
  let session: TestSession
  let productA: ProductRow
  let productB: ProductRow

  beforeAll(async () => {
    app = buildApp()
    await app.ready()
    session = await login(app, 'DEMO-0001')

    const { rows } = await db.query<ProductRow>(
      `SELECT id, name, base_unit_id, sale_unit_id
       FROM products WHERE tenant_id = $1 AND is_active = 1
       ORDER BY name LIMIT 2`,
      [session.tenantId],
    )
    productA = rows[0]!
    productB = rows[1]!

    const now = new Date().toISOString()
    // Venta 1: A (3 unidades, $30) y B (5 unidades, $25)
    const saleA = await insertSale(session.tenantId, session.userId, 9001, now)
    await insertSaleItem(session.tenantId, saleA, productA, 3, 30, now)
    await insertSaleItem(session.tenantId, saleA, productB, 5, 25, now)
    // Venta 2: A (2 unidades, $20) → A acumula $50 y 5 unidades
    const saleB = await insertSale(session.tenantId, session.userId, 9002, now)
    await insertSaleItem(session.tenantId, saleB, productA, 2, 20, now)
  })

  it('1) ordena por ingreso y acumula unidades/tickets', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reports/top-products?limit=10',
      headers: { authorization: `Bearer ${session.token}` },
    })
    expect(res.statusCode).toBe(200)
    const items = res.json().data as {
      product_id: string
      units: number
      tickets: number
      revenue: number
    }[]
    const a = items.find((i) => i.product_id === productA.id)!
    const b = items.find((i) => i.product_id === productB.id)!
    expect(a.units).toBe(5)
    expect(a.tickets).toBe(2)
    expect(a.revenue).toBe(50)
    expect(b.units).toBe(5)
    expect(b.revenue).toBe(25)
    // A tiene mayor ingreso → primero
    expect(items[0].product_id).toBe(productA.id)
  })

  it('2) respeta el límite y el rango de fechas', async () => {
    const limited = await app.inject({
      method: 'GET',
      url: '/reports/top-products?limit=1',
      headers: { authorization: `Bearer ${session.token}` },
    })
    expect(limited.json().data).toHaveLength(1)
    expect(limited.json().data[0].product_id).toBe(productA.id)

    // Rango en el pasado → sin ventas
    const empty = await app.inject({
      method: 'GET',
      url: '/reports/top-products?from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z',
      headers: { authorization: `Bearer ${session.token}` },
    })
    expect(empty.statusCode).toBe(200)
    expect(empty.json().data).toHaveLength(0)
  })

  it('3) no mezcla datos de otros tenants', async () => {
    const other = await createTenantFixture(app, 'TOP-B-0001')
    // Tercer producto sembrado: solo se vende en el tenant B.
    const third = await db.query<ProductRow>(
      `SELECT id, name, base_unit_id, sale_unit_id
       FROM products WHERE tenant_id = $1 AND is_active = 1
       ORDER BY name LIMIT 1 OFFSET 2`,
      [session.tenantId],
    )
    const otherProduct = third.rows[0]!
    const now = new Date().toISOString()
    const otherSale = await insertSale(other.tenantId, other.userId, 1, now)
    await insertSaleItem(other.tenantId, otherSale, otherProduct, 9, 99, now)

    // A no ve el producto que solo se vendió en B
    const resA = await app.inject({
      method: 'GET',
      url: '/reports/top-products?limit=100',
      headers: { authorization: `Bearer ${session.token}` },
    })
    expect(resA.statusCode).toBe(200)
    expect(
      (resA.json().data as { product_id: string }[]).some(
        (i) => i.product_id === otherProduct.id,
      ),
    ).toBe(false)

    // B sí lo ve (el dato existe; el filtro tenant_id es el que lo oculta a A)
    const resB = await app.inject({
      method: 'GET',
      url: '/reports/top-products?limit=100',
      headers: { authorization: `Bearer ${other.token}` },
    })
    expect(resB.statusCode).toBe(200)
    expect(
      (resB.json().data as { product_id: string }[]).some(
        (i) => i.product_id === otherProduct.id,
      ),
    ).toBe(true)
  })
})
