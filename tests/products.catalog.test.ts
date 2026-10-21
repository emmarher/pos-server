/**
 * tests/products.catalog.test.ts — Pruebas del catálogo de productos.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Contexto: el catálogo se truncaba a 50 productos y el buscador de la UI
 * filtraba EN MEMORIA sobre esos 50 → cualquier producto creado cuyo nombre
 * ordenara después de la "Z" era invisible ("no lo agrega").
 *
 * Causa raíz (pos-server):
 *   - products.service.ts → `Math.min(..., 50)` recortaba la página en
 *     silencio, ignorando el `limit` pedido (el schema solo permitía hasta 100).
 *   - El N+1 de precios (3 queries POR producto) hacía inviable traer todos.
 *
 * Cobertura:
 *   1) `limit` real: pide 120 → devuelve 120 (no 50).
 *   2) `limit` fuera de rango → 400 (schema maximum = 1000).
 *   3) `total` = conteo real, no el tamaño de la página.
 *   4) Paginación: offset + limit recorren todo sin repetir ni saltar.
 *   5) Búsqueda `q`: por nombre (LIKE), internal_code y barcode (exacto).
 *   6) Precios: el batch devuelve EXACTAMENTE lo mismo que GET /products/:id.
 *   7) Precios: cuando hay historial, gana el VIGENTE (start_date más nuevo).
 *   8) Aislamiento multi-tenant: el catálogo de A no ve productos de B.
 * ────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { TestSession } from './helpers.js'

const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/database/client.js')
const { createTenantFixture } = await import('./helpers.js')

/* ── Helpers locales ─────────────────────────────────────────────────── */

/** Inserta un producto mínimo y devuelve su id. */
async function insertProduct(
  tenantId: string,
  name: string,
  extra: {
    barcode?: string
    internal_code?: string
    sku?: string
    price?: number
    stock?: number
    is_active?: number
    category_id?: string
  } = {},
): Promise<string> {
  const id = randomUUID()
  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO products
       (id, tenant_id, category_id, name, barcode, internal_code, sku,
        base_unit_id, sale_unit_id, price, cost, stock, is_active,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             (SELECT id FROM measurement_units LIMIT 1),
             (SELECT id FROM measurement_units LIMIT 1),
             $8, 5, $9, $10, $11, $11)`,
    [
      id,
      tenantId,
      extra.category_id ?? null,
      name,
      extra.barcode ?? null,
      extra.internal_code ?? null,
      extra.sku ?? null,
      extra.price ?? 10,
      extra.stock ?? 100,
      extra.is_active ?? 1,
      now,
    ],
  )
  return id
}

/** Inserta un tipo de precio para el tenant. */
async function insertPriceType(
  tenantId: string,
  name: string,
  code: string,
  isDefault = 0,
): Promise<string> {
  const id = randomUUID()
  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO price_types (id, tenant_id, name, code, is_default, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $6)`,
    [id, tenantId, name, code, isDefault, now],
  )
  return id
}

/** Inserta un precio específico de un producto para un tipo de precio. */
async function insertProductPrice(
  tenantId: string,
  productId: string,
  priceTypeId: string,
  price: number,
  startDate: string,
): Promise<string> {
  const id = randomUUID()
  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO product_prices
       (id, tenant_id, product_id, price_type_id, price, min_quantity,
        start_date, end_date, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, NULL, 1, $7, $7)`,
    [id, tenantId, productId, priceTypeId, price, startDate, now],
  )
  return id
}

/** Inserta una categoría para el tenant. */
async function insertCategory(tenantId: string, name: string): Promise<string> {
  const id = randomUUID()
  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO categories (id, tenant_id, name, prefix, display_order, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 0, 1, $5, $5)`,
    [id, tenantId, name, 'CAT', now],
  )
  return id
}

/* ── Suite ───────────────────────────────────────────────────────────── */

describe('Catálogo de productos', () => {
  let app: FastifyInstance
  let sessionA: TestSession
  let sessionB: TestSession

  /* Productos del tenant A: 130 con nombre "Prod Axxx" (ordenan al inicio)
     + 3 con nombres "Z…", "Cebolla" y "Test" para probar la búsqueda. */
  const catalogCount = 130
  const productIds: string[] = []
  let cebollaId = ''
  let zzzId = ''
  let barcodeId = ''
  let codeId = ''
  let productB = ''

  /* Precios: tipo "Público" (default) y "Mayoreo" */
  let priceTypePublic = ''
  let priceTypeMayoreo = ''
  let productWithPrices = ''

  beforeAll(async () => {
    app = buildApp()
    sessionA = await createTenantFixture(app, 'CAT-A-0001')
    sessionB = await createTenantFixture(app, 'CAT-B-0001')

    priceTypePublic = await insertPriceType(sessionA.tenantId, 'Público', 'PUB', 1)
    priceTypeMayoreo = await insertPriceType(sessionA.tenantId, 'Mayoreo', 'MAY')

    /* 130 productos */
    for (let i = 0; i < catalogCount; i++) {
      const name = `Prod A${String(i).padStart(4, '0')}`
      productIds.push(await insertProduct(sessionA.tenantId, name, { price: 10 + i }))
    }

    /* Productos con nombres que ordenan al FINAL (el bug original) */
    cebollaId = await insertProduct(sessionA.tenantId, 'Cebolla', { price: 25 })
    await insertProduct(sessionA.tenantId, 'Test', { price: 30 })
    zzzId = await insertProduct(sessionA.tenantId, 'Zzz Ultimo', { price: 35 })

    /* Búsqueda por código y por barcode */
    codeId = await insertProduct(sessionA.tenantId, 'Producto Con Codigo', {
      internal_code: 'COD-777',
      price: 40,
    })
    barcodeId = await insertProduct(sessionA.tenantId, 'Producto Con Barcode', {
      barcode: 'BAR-999',
      price: 45,
    })

    /* Producto con precios propios (para comparar batch vs. detalle) */
    productWithPrices = await insertProduct(sessionA.tenantId, 'Producto Con Precios', {
      price: 100,
    })
    await insertProductPrice(sessionA.tenantId, productWithPrices, priceTypePublic, 100, '2026-01-01')
    await insertProductPrice(sessionA.tenantId, productWithPrices, priceTypeMayoreo, 80, '2026-01-01')

    /* Producto con historial de precios: el VIGENTE (start_date más nuevo) debe ganar */
    const histProduct = await insertProduct(sessionA.tenantId, 'Producto Historial', { price: 500 })
    await insertProductPrice(sessionA.tenantId, histProduct, priceTypePublic, 500, '2025-01-01')
    await insertProductPrice(sessionA.tenantId, histProduct, priceTypePublic, 300, '2026-06-01')

    /* Un producto del tenant B, para comprobar el aislamiento */
    productB = await insertProduct(sessionB.tenantId, 'Prod B0001', { price: 99 })
  })

  /** Cuenta los productos activos del tenant directamente en la BD. */
  async function countProducts(tenantId: string): Promise<number> {
    const { rows } = await db.query<{ total: number }>(
      'SELECT COUNT(*) AS total FROM products WHERE tenant_id = $1 AND is_active = 1',
      [tenantId],
    )
    return rows[0]?.total ?? 0
  }

  /* ── 1) El límite se respeta (ya no hay recorte silencioso a 50) ────── */

  it('devuelve TODOS los productos pedidos (limit=120 → 120 items, no 50)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products?limit=120',
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    expect(res.statusCode).toBe(200)
    const data = res.json().data as { items: unknown[]; total: number }
    expect(data.items.length).toBe(120)
    expect(data.total).toBeGreaterThanOrEqual(130)
  })

  it('devuelve 1000 items cuando se piden (el máximo del schema)', async () => {
    /* Se insertan 130 → 130 < 1000, pero lo importante es que NO se recorta a 50. */
    const res = await app.inject({
      method: 'GET',
      url: '/products?limit=1000',
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    expect(res.statusCode).toBe(200)
    const data = res.json().data as { items: unknown[]; total: number }
    expect(data.items.length).toBeGreaterThan(120)
    expect(data.items.length).toBe(await countProducts(sessionA.tenantId))
  })

  it('rechaza limit por encima del máximo con 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products?limit=2000',
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rechaza limit=0 y limit negativo con 400', async () => {
    for (const limit of ['0', '-5']) {
      const res = await app.inject({
        method: 'GET',
        url: `/products?limit=${limit}`,
        headers: { authorization: `Bearer ${sessionA.token}` },
      })
      expect(res.statusCode).toBe(400)
    }
  })

  /* ── 2) `total` y paginación ───────────────────────────────────────── */

  it('total refleja el conteo real, no el tamaño de la página', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products?limit=10',
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    const data = res.json().data as { items: unknown[]; total: number }
    expect(data.items.length).toBe(10)
    expect(data.total).toBe(await countProducts(sessionA.tenantId))
  })

  it('la paginación recorre todo el catálogo sin repetir ni saltar', async () => {
    const all = await app.inject({
      method: 'GET',
      url: '/products?limit=1000',
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    const allIds = (all.json().data as { items: { id: string }[] }).items.map((p) => p.id)

    const paged: string[] = []
    for (const offset of [0, 50, 100]) {
      const res = await app.inject({
        method: 'GET',
        url: `/products?limit=50&offset=${offset}`,
        headers: { authorization: `Bearer ${sessionA.token}` },
      })
      expect(res.statusCode).toBe(200)
      paged.push(...(res.json().data as { items: { id: string }[] }).items.map((p) => p.id))
    }

    expect(paged.length).toBe(allIds.length)
    expect(new Set(paged).size).toBe(paged.length) // sin repetidos
    expect(paged).toEqual(allIds) // mismo orden, sin saltos
  })

  /* ── 3) Búsqueda real contra la BD ────────────────────────────────── */

  it('busca por nombre (LIKE) y encuentra lo que antes era invisible', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products?q=Cebolla',
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    expect(res.statusCode).toBe(200)
    const data = res.json().data as { items: { id: string; name: string }[]; total: number }
    expect(data.total).toBe(1)
    expect(data.items[0].id).toBe(cebollaId)
  })

  it('busca por internal_code exacto', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products?q=COD-777',
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    const data = res.json().data as { items: { id: string }[]; total: number }
    expect(data.total).toBe(1)
    expect(data.items[0].id).toBe(codeId)
  })

  it('busca por barcode exacto', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products?q=BAR-999',
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    const data = res.json().data as { items: { id: string }[]; total: number }
    expect(data.total).toBe(1)
    expect(data.items[0].id).toBe(barcodeId)
  })

  it('la búsqueda ignora mayúsculas/espacios y filtra por categoría', async () => {
    const catId = await insertCategory(sessionA.tenantId, 'Bebidas')
    const conCat = await insertProduct(sessionA.tenantId, 'Refresco Cola', {
      category_id: catId,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/products?q=%20refresco%20&category_id=' + catId,
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    const data = res.json().data as { items: { id: string }[]; total: number }
    expect(data.total).toBe(1)
    expect(data.items[0].id).toBe(conCat)
  })

  /* ── 4) Precios ────────────────────────────────────────────────────── */

  it('los precios del listado coinciden EXACTAMENTE con GET /products/:id', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/products?q=Producto Con Precios&limit=10`,
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    const item = (list.json().data as { items: { id: string; prices: { price_type_id: string; price: number }[] }[] })
      .items[0]
    expect(item.prices.length).toBe(2)

    const detail = await app.inject({
      method: 'GET',
      url: `/products/${item.id}`,
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    const detailPrices = (detail.json().data as { prices: { price_type_id: string; price: number }[] })
      .prices

    const norm = (arr: { price_type_id: string; price: number }[]) =>
      arr.map((p) => ({ price_type_id: p.price_type_id, price: p.price })).sort((a, b) =>
        a.price_type_id.localeCompare(b.price_type_id),
      )
    expect(norm(item.prices)).toEqual(norm(detailPrices))
  })

  it('el precio específico de un tipo gana sobre el precio base', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products?q=Producto%20Con%20Precios&limit=10',
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    const item = (res.json().data as { prices: { price_type_id: string; price: number }[] }).items[0]
    const mayoreo = item.prices.find((p) => p.price_type_id === priceTypeMayoreo)
    const publico = item.prices.find((p) => p.price_type_id === priceTypePublic)
    expect(mayoreo?.price).toBe(80)
    expect(publico?.price).toBe(100)
  })

  it('con historial de precios gana el VIGENTE (start_date más reciente)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products?q=Producto%20Historial&limit=10',
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    const item = (res.json().data as { prices: { price_type_id: string; price: number }[] }).items[0]
    const publico = item.prices.find((p) => p.price_type_id === priceTypePublic)
    /* 300 (2026-06-01) es el vigente; 500 (2025-01-01) es histórico */
    expect(publico?.price).toBe(300)
  })

  it('un producto sin precios específicos cae al precio base', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products?q=Cebolla&limit=10',
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    const item = (res.json().data as { price: number; prices: { price_type_id: string; price: number }[] })
      .items[0]
    expect(item.prices.length).toBe(2)
    for (const p of item.prices) expect(p.price).toBe(item.price)
  })

  /* ── 5) Aislamiento multi-tenant ───────────────────────────────────── */

  it('el catálogo del tenant A no incluye productos del tenant B', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products?limit=1000',
      headers: { authorization: `Bearer ${sessionA.token}` },
    })
    const ids = (res.json().data as { items: { id: string }[] }).items.map((p) => p.id)
    expect(ids).toContain(zzzId)
    expect(ids).toContain(cebollaId)
    expect(ids).not.toContain(productB)
    expect(ids.length).toBe(new Set(ids).size)
  })
})
