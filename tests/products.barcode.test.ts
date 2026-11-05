/**
 * tests/products.barcode.test.ts — Reutilización del código de barras tras borrar.
 *
 * ------------------------------------------------------------------------
 * Bug: al borrar un producto se hace borrado LÓGICO (is_active=0) pero su
 * barcode seguía ocupando el índice único, así que el código no se podía volver
 * a usar (crear de nuevo, corregir un error, asignarlo a otro producto) → 409.
 *
 * Fix (migración 010): la UNIQUE de barcode/sku es SOLO entre productos
 * ACTIVOS (`WHERE ... AND is_active = 1`). Un barcode de un producto inactivo
 * queda libre; dos productos ACTIVOS con el mismo código siguen prohibidos.
 *
 * Cobertura:
 *   1) Dos productos ACTIVOS con el mismo barcode → la BD rechaza (UNIQUE).
 *   2) Tras desactivar A, crear un producto ACTIVO nuevo con el mismo barcode
 *      → la BD lo acepta (el código quedó liberado).
 *   3) Tras desactivar A, asignarle su barcode a OTRO producto activo
 *      (corregir un código equivocado) → la BD lo acepta.
 * ------------------------------------------------------------------------
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { TestSession } from './helpers.js'

const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/database/client.js')
const { createTenantFixture } = await import('./helpers.js')
const { deactivateProduct } = await import('../src/modules/products/products.service.js')

/** Inserta un producto mínimo y devuelve su id. */
async function insertProduct(
  tenantId: string,
  name: string,
  barcode?: string,
  isActive = 1,
): Promise<string> {
  const id = randomUUID()
  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO products
       (id, tenant_id, category_id, name, barcode, base_unit_id, sale_unit_id,
        price, cost, stock, is_active, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $4,
             (SELECT id FROM measurement_units LIMIT 1),
             (SELECT id FROM measurement_units LIMIT 1),
             10, 5, 100, $5, $6, $6)`,
    [id, tenantId, name, barcode ?? null, isActive, now],
  )
  return id
}

describe('Reutilizar un código de barras de un producto borrado', () => {
  let app: FastifyInstance
  let tenant: TestSession

  beforeAll(async () => {
    app = await buildApp()
    // Tenant limpio y aislado: no choca con el catálogo del seed DEMO-0001.
    tenant = await createTenantFixture(app, 'BARCODE-FIX')
  })

  it('dos productos ACTIVOS con el mismo barcode -> la BD lo rechaza (UNIQUE)', async () => {
    await insertProduct(tenant.tenantId, 'Activo A', 'X-0001', 1)
    await expect(
      insertProduct(tenant.tenantId, 'Activo B', 'X-0001', 1),
    ).rejects.toThrow(/UNIQUE/i)
  })

  it('tras desactivar A, crear un producto ACTIVO nuevo con el mismo barcode -> acepta', async () => {
    const a = await insertProduct(tenant.tenantId, 'A a borrar', 'X-0002', 1)
    // Borrado lógico vía el servicio (mismo flujo que la API "borrar").
    await deactivateProduct(tenant.tenantId, a)

    // El código quedó liberado: un producto nuevo ACTIVO lo puede usar.
    const nuevo = await insertProduct(tenant.tenantId, 'Nuevo con codigo', 'X-0002', 1)
    expect(nuevo).toBeTruthy()
  })

  it('tras desactivar A, asignarle su barcode a OTRO producto activo -> acepta', async () => {
    const a = await insertProduct(tenant.tenantId, 'A a borrar', 'X-0003', 1)
    await deactivateProduct(tenant.tenantId, a)

    // Corregir el código de un producto activo B al valor que solo usa el inactivo A.
    const b = await insertProduct(tenant.tenantId, 'B', undefined, 1)
    await db.query(
      `UPDATE products SET barcode = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, b, 'X-0003', new Date().toISOString()],
    )
    const { rows } = await db.query<{ barcode: string | null }>(
      'SELECT barcode FROM products WHERE tenant_id = $1 AND id = $2',
      [tenant.tenantId, b],
    )
    expect(rows[0].barcode).toBe('X-0003')
  })

  it("eliminar el barcode de un producto activo ('' -> NULL) lo libera", async () => {
    const p = await insertProduct(tenant.tenantId, 'Con codigo', 'X-0004', 1)
    await db.query(
      `UPDATE products SET barcode = NULL, updated_at = $3
       WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, p, new Date().toISOString()],
    )
    const { rows } = await db.query<{ barcode: string | null }>(
      'SELECT barcode FROM products WHERE tenant_id = $1 AND id = $2',
      [tenant.tenantId, p],
    )
    expect(rows[0].barcode).toBeNull()
    // Una vez NULL, otro producto puede tomar el código.
    const otro = await insertProduct(tenant.tenantId, 'Nuevo', 'X-0004', 1)
    expect(otro).toBeTruthy()
  })
})