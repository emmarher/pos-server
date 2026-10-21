/**
 * tests/customers.test.ts — Pruebas del módulo de clientes y crédito (RF-VE-005).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Contexto: el módulo de clientes estaba roto de punta a punta y NUNCA se
 * había ejecutado (no hay pantalla de clientes en pos-desktop ni pos-mobile).
 * Los 500 que devolvía el listado y el alta no eran de los datos, sino del
 * código:
 *
 *   - `whereSql` se armaba como `'AND c.is_active = 1 AND' + ' c.tenant_id…'`
 *     → la consulta quedaba `WHERE AND …` → «near "AND": syntax error».
 *   - Los placeholders de la búsqueda ($2/$3) se corrían uno cuando el
 *     filtro de activos empujaba un valor → el `q` comparaba contra el 1
 *     del `is_active` y no contra el texto buscado.
 *   - El COUNT llevaba `GROUP BY c.id` → `total` devolvía 1 siempre.
 *   - `customers.description` no existe en `esquema_BD_POS_v4_completo.sql`
 *     (la tabla no la tiene) → el SELECT/INSERT reventaba con
 *     «table customers has no column named description».
 *   - El INSERT tenía 14 columnas y 13 placeholders, y el balance/loyalty
 *     recibían el valor de `credit_limit` en vez de 0.
 *   - `created_at`/`updated_at` se guardaban con el texto literal 'now'.
 *
 * Cobertura:
 *   1) GET /customers responde 200 y devuelve la lista con `total` real.
 *   2) Búsqueda `q` por nombre y por RFC, y `activeOnly=false` (todos).
 *   3) Paginación: limit + offset recorren sin repetir ni saltar.
 *   4) Aislamiento multi-tenant: A no ve clientes de B.
 *   5) POST /customers crea el cliente con los valores correctos.
 *   6) GET /customers/:id devuelve el detalle con el balance.
 *   7) PATCH /customers/:id actualiza y conserva lo no enviado.
 *   8) POST /customers/:id/credit registra el cargo y actualiza el balance.
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

/** Inserta un cliente mínimo y devuelve su id. */
async function insertCustomer(
  tenantId: string,
  name: string,
  extra: { rfc?: string; credit_limit?: number; is_active?: number } = {},
): Promise<string> {
  const id = randomUUID()
  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO customers
       (id, tenant_id, name, phone, email, address, rfc,
        credit_limit, current_balance, loyalty_points, loyalty_points_value,
        is_active, created_at, updated_at)
     VALUES ($1, $2, $3, '555-0000', 'qa@example.com', 'Calle QA', $4,
             $5, 0, 0, 0, $6, $7, $7)`,
    [
      id,
      tenantId,
      name,
      extra.rfc ?? null,
      extra.credit_limit ?? 0,
      extra.is_active ?? 1,
      now,
    ],
  )
  return id
}

/* ── Suite ────────────────────────────────────────────────────────────── */

describe('Módulo de clientes (RF-VE-005)', () => {
  let app: FastifyInstance
  let tenantA: TestSession
  let tenantB: TestSession
  const idsA: string[] = []

  beforeAll(async () => {
    app = buildApp()
    await app.ready()
    tenantA = await createTenantFixture(app, 'CUS-A-0001')
    tenantB = await createTenantFixture(app, 'CUS-B-0001')

    for (let i = 0; i < 12; i++) {
      idsA.push(
        await insertCustomer(tenantA.tenantId, `Cliente Alpha ${i}`, {
          rfc: `RFC${i}`,
          credit_limit: 1000,
        }),
      )
    }
    idsA.push(
      await insertCustomer(tenantA.tenantId, 'Cliente Alfa Zeta', { rfc: 'RFCZZ', credit_limit: 1000 }),
    )
    idsA.push(
      await insertCustomer(tenantA.tenantId, 'Cliente Inactivo', { is_active: 0, credit_limit: 1000 }),
    )
    await insertCustomer(tenantB.tenantId, 'Cliente De Otro Tenant')
  })

  /** GET /customers con el token del tenant A. */
  async function list(query = '', token = tenantA.token) {
    const res = await app.inject({
      method: 'GET',
      url: `/customers${query}`,
      headers: { authorization: `Bearer ${token}` },
    })
    return res
  }

  it('1) GET /customers responde 200 con items y total real', async () => {
    const res = await list()
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.data.items)).toBe(true)
    // 14 clientes activos del tenant A (12 + Alfa Zeta; el inactivo no cuenta)
    expect(body.data.total).toBe(13)
    expect(body.data.items.length).toBe(13)
  })

  it('2) busca por nombre (LIKE) y por RFC', async () => {
    const porNombre = await list('?q=Alpha')
    expect(porNombre.statusCode).toBe(200)
    expect(porNombre.json().data.total).toBe(12)
    expect(
      porNombre.json().data.items.every((c: { name: string }) => c.name.includes('Alpha')),
    ).toBe(true)

    const porRfc = await list('?q=RFCZZ')
    expect(porRfc.statusCode).toBe(200)
    expect(porRfc.json().data.total).toBe(1)
    expect(porRfc.json().data.items[0].name).toBe('Cliente Alfa Zeta')
  })

  it('2b) active_only=false incluye también los inactivos', async () => {
    const res = await list('?active_only=false')
    expect(res.statusCode).toBe(200)
    expect(res.json().data.total).toBe(14)
    expect(
      res.json().data.items.some((c: { name: string }) => c.name === 'Cliente Inactivo'),
    ).toBe(true)
  })

  it('3) pagina con limit + offset sin repetir ni saltar', async () => {
    const p1 = await list('?limit=5&offset=0')
    const p2 = await list('?limit=5&offset=5')
    expect(p1.statusCode).toBe(200)
    expect(p2.statusCode).toBe(200)
    expect(p1.json().data.items.length).toBe(5)
    expect(p2.json().data.items.length).toBe(5)
    const ids1 = p1.json().data.items.map((c: { id: string }) => c.id)
    const ids2 = p2.json().data.items.map((c: { id: string }) => c.id)
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0)
    expect(p1.json().data.total).toBe(13)
  })

  it('4) aísla los clientes por tenant', async () => {
    const res = await list('', tenantA.token)
    expect(res.json().data.items.every((c: { name: string }) => c.name !== 'Cliente De Otro Tenant')).toBe(true)
    const resB = await list('', tenantB.token)
    expect(resB.statusCode).toBe(200)
    expect(resB.json().data.total).toBe(1)
    expect(resB.json().data.items[0].name).toBe('Cliente De Otro Tenant')
  })

  it('5) POST /customers crea el cliente con los valores correctos', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/customers',
      headers: { authorization: `Bearer ${tenantA.token}` },
      payload: {
        name: '  Cliente Nuevo QA  ',
        phone: '555-1111',
        email: 'nuevo@example.com',
        address: 'Av. Nueva 123',
        rfc: 'RFCNEW01',
        credit_limit: 1500,
      },
    })
    expect(res.statusCode).toBe(200)
    const created = res.json().data
    expect(created.name).toBe('Cliente Nuevo QA') // recortado
    expect(created.phone).toBe('555-1111')
    expect(created.rfc).toBe('RFCNEW01')
    expect(created.credit_limit).toBe(1500)
    // El balance arranca en 0 (no hereda credit_limit)
    expect(created.current_balance).toBe(0)
    expect(created.loyalty_points).toBe(0)
    expect(created.loyalty_points_value).toBe(0)
    expect(created.is_active).toBe(true)
    // created_at / updated_at son timestamps ISO, no el texto 'now'
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(created.created_at).not.toBe('now')

    // Y el cliente ya aparece en el listado
    const listed = await list('?q=RFCNEW01')
    expect(listed.json().data.total).toBe(1)
  })

  it('6) GET /customers/:id devuelve el detalle con el balance', async () => {
    const id = idsA[0]
    const res = await app.inject({
      method: 'GET',
      url: `/customers/${id}`,
      headers: { authorization: `Bearer ${tenantA.token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.id).toBe(id)
    expect(typeof res.json().data.current_balance).toBe('number')
  })

  it('7) PATCH /customers/:id actualiza y conserva lo no enviado', async () => {
    const id = idsA[1]
    const res = await app.inject({
      method: 'PATCH',
      url: `/customers/${id}`,
      headers: { authorization: `Bearer ${tenantA.token}` },
      payload: { name: 'Cliente Alpha 1 Renombrado' },
    })
    expect(res.statusCode).toBe(200)
    const updated = res.json().data
    expect(updated.name).toBe('Cliente Alpha 1 Renombrado')
    // phone/rfc/credit_limit no enviados → conservan el valor previo
    expect(updated.phone).toBe('555-0000')
    expect(updated.rfc).toBe('RFC1')
    expect(updated.email).toBe('qa@example.com')
  })

  it('8) POST /customers/:id/credit registra el cargo y actualiza el balance', async () => {
    const id = idsA[2]
    const res = await app.inject({
      method: 'POST',
      url: `/customers/${id}/credit`,
      headers: { authorization: `Bearer ${tenantA.token}` },
      payload: { customer_id: id, amount: 250, reason: 'Compra a crédito' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.new_balance).toBe(250)
    expect(res.json().data.exceeded_limit).toBe(false)

    // El movimiento quedó registrado en customer_credits
    const { rows } = await db.query<{ amount: number; type: string }>(
      `SELECT amount, type FROM customer_credits WHERE customer_id = $1`,
      [id],
    )
    expect(rows.length).toBe(1)
    expect(rows[0].amount).toBe(250)
    expect(rows[0].type).toBe('ADJUSTMENT')

    // Y el saldo del cliente quedó actualizado
    const detail = await app.inject({
      method: 'GET',
      url: `/customers/${id}`,
      headers: { authorization: `Bearer ${tenantA.token}` },
    })
    expect(detail.json().data.current_balance).toBe(250)
  })

  it('8b) un cargo que excede el límite de crédito se rechaza', async () => {
    const id = idsA[3]
    const res = await app.inject({
      method: 'POST',
      url: `/customers/${id}/credit`,
      headers: { authorization: `Bearer ${tenantA.token}` },
      payload: { customer_id: id, amount: 5000, reason: 'Cargo imposible' },
    })
    expect(res.statusCode).toBe(409)
  })
})
