/**
 * src/database/reset-catalog.ts — Borra el catálogo demo y lo resiembra.
 *
 * ────────────────────────────────────────────────────────────────────────
 * DESTRUCTIVO (solo dev/demo). Deja el tenant DEMO-0001 con:
 *   - 0 ventas (borra tickets, pagos y eventos de calidad asociados)
 *   - 0 movimientos de inventario
 *   - solo la categoría "Abarrotes" y sus productos
 *   - el folio de ventas reiniciado en 0 (la próxima venta es V-000001)
 *
 * Después de borrar, llama a `seedCatalog()` para sembrar los abarrotes.
 *
 * Uso:  npm run seed:catalog:reset
 *
 * Seguridad: aborta si DB_PROVIDER=postgres (producción) salvo que se pase
 * `--force` explícitamente.
 * ────────────────────────────────────────────────────────────────────────
 */
import { env } from '../config/env.js'
import { db } from './client.js'
import { DEMO_TENANT_CODE } from './seed.js'
import { seedCatalog } from './seed-catalog.js'

const force = process.argv.includes('--force')

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query<{ c: number }>(sql, params)
  return rows[0]?.c ?? 0
}

async function main(): Promise<void> {
  if (env.dbProvider !== 'sqlite' && !force) {
    console.error(
      `ABORTADO: DB_PROVIDER=${env.dbProvider}. Este script borra datos y es solo para dev/demo.\n` +
        'Si de verdad quieres ejecutarlo, repite con --force.',
    )
    process.exit(1)
  }

  const tenantRows = await db.query<{ id: string }>(
    'SELECT id FROM tenants WHERE license_key = $1',
    [DEMO_TENANT_CODE],
  )
  const tenantId = tenantRows.rows[0]?.id
  if (!tenantId) {
    throw new Error(`Tenant ${DEMO_TENANT_CODE} no existe — corre npm run seed primero`)
  }

  const before = {
    ventas: await count('SELECT COUNT(*) AS c FROM sales WHERE tenant_id = $1', [tenantId]),
    productos: await count('SELECT COUNT(*) AS c FROM products WHERE tenant_id = $1', [tenantId]),
    categorias: await count('SELECT COUNT(*) AS c FROM categories WHERE tenant_id = $1', [tenantId]),
    movimientos: await count(
      'SELECT COUNT(*) AS c FROM inventory_movements WHERE tenant_id = $1',
      [tenantId],
    ),
  }
  console.log(
    `Antes: ${before.ventas} ventas, ${before.productos} productos, ` +
      `${before.categorias} categorías, ${before.movimientos} movimientos.`,
  )

  /* Orden seguro respecto a las FK:
     sales → cascada a sale_items, sale_payments, stored_tickets,
             service_quality_events y cashier_cut_sales
     inventory_movements / purchase_order_items → RESTRICT sobre products
     products → cascada a product_prices, product_discounts,
                inventory_lots e inventory_alerts
     categories → ya sin productos que las referencien */
  const steps: { label: string; sql: string; params?: unknown[] }[] = [
    { label: 'ventas', sql: 'DELETE FROM sales WHERE tenant_id = $1' },
    { label: 'movimientos de inventario', sql: 'DELETE FROM inventory_movements WHERE tenant_id = $1' },
    {
      label: 'renglones de pedidos',
      sql: `DELETE FROM purchase_order_items
             WHERE product_id IN (SELECT id FROM products WHERE tenant_id = $1)`,
    },
    { label: 'productos', sql: 'DELETE FROM products WHERE tenant_id = $1' },
    {
      label: 'categorías (excepto Abarrotes)',
      sql: `DELETE FROM categories WHERE tenant_id = $1 AND name <> 'Abarrotes'`,
    },
  ]

  await db.transaction(async (tx) => {
    for (const step of steps) {
      const result = await tx.query(step.sql, step.params ?? [tenantId])
      console.log(`  ✔ ${step.label}: ${result.rowCount} borrados`)
    }
    await tx.query(
      'UPDATE folio_sequences SET last_value = 0 WHERE tenant_id = $1',
      [tenantId],
    )
    console.log('  ✔ folio de ventas reiniciado en 0')
  })

  console.log('\nSembrando catálogo de abarrotes…')
  await seedCatalog()

  const after = {
    ventas: await count('SELECT COUNT(*) AS c FROM sales WHERE tenant_id = $1', [tenantId]),
    productos: await count('SELECT COUNT(*) AS c FROM products WHERE tenant_id = $1', [tenantId]),
    categorias: await count('SELECT COUNT(*) AS c FROM categories WHERE tenant_id = $1', [tenantId]),
  }
  console.log(
    `\nDespués: ${after.ventas} ventas, ${after.productos} productos, ` +
      `${after.categorias} categorías.`,
  )
}

main()
  .then(() => db.end())
  .catch(async (err) => {
    console.error('Error al resetear el catálogo:', err)
    await db.end()
    process.exit(1)
  })
