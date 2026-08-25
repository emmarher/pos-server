/**
 * scripts/load-real-categories.ts — Reparación del catálogo de categorías.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Contexto: al resetear la BD se omitió seed-catalog, así que el script
 * load-real-products.ts insertó los 51 productos con category_id NULL y
 * la tabla categories quedó vacía (el buscador/inventario no mostraba
 * categorías).
 *
 * Uso (con el servidor DETENIDO):
 *   npx tsx scripts/load-real-categories.ts
 *
 * Qué hace:
 *   1) Inserta las categorías faltantes (idempotente: las que ya existen
 *      se dejan intactas) usando los prefijos de CATEGORY_PREFIX.
 *   2) Asigna category_id a los productos cuyo nombre coincida con el
 *      catálogo real definido en load-real-products.ts. El trigger
 *      trg_products_category_count mantiene product_count al día.
 * ────────────────────────────────────────────────────────────────────────
 */
import { db } from '../src/database/client.js'
import { CATEGORY_PREFIX, PRODUCTS } from './load-real-products.js'

/** Colores distintivos por categoría (hex). */
const CATEGORY_COLORS: Record<string, string> = {
  'Frutas y Verduras': '#22C55E',
  Lácteos: '#3B82F6',
  'Salsas y Condimentos': '#EF4444',
  Bebidas: '#06B6D4',
  Abarrotes: '#F59E0B',
  Botanas: '#A855F7',
  Limpieza: '#64748B',
}

async function main(): Promise<void> {
  const tenantRows = await db.query<{ id: string }>(
    "SELECT id FROM tenants WHERE license_key = 'DEMO-0001'",
  )
  const tenantId = tenantRows.rows[0]!.id

  /* ── 1) Crear categorías faltantes ─────────────────────────────────── */
  const existing = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM categories WHERE tenant_id = $1',
    [tenantId],
  )
  const byName = new Map(existing.rows.map((r) => [r.name, r.id]))

  let order = 0
  for (const [name, prefix] of Object.entries(CATEGORY_PREFIX)) {
    if (byName.has(name)) continue
    order += 1
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO categories
         (tenant_id, name, prefix, color, display_order, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $6) RETURNING id`,
      [tenantId, name, prefix, CATEGORY_COLORS[name] ?? '#3B82F6', order, new Date().toISOString()],
    )
    byName.set(name, rows[0]!.id)
    console.log(`+ categoría creada: ${name} (${prefix})`)
  }

  /* ── 2) Asignar categoría a productos sin ella ─────────────────────── */
  let assigned = 0
  let missing = 0
  for (const def of PRODUCTS) {
    const categoryId = byName.get(def.category)
    if (!categoryId) {
      console.warn(`! categoría no encontrada para "${def.name}" (${def.category})`)
      missing += 1
      continue
    }
    const result = await db.query(
      `UPDATE products SET category_id = $1, updated_at = $3
       WHERE tenant_id = $2 AND name = $4 AND category_id IS NULL`,
      [categoryId, tenantId, new Date().toISOString(), def.name],
    )
    assigned += result.rowCount ?? 0
  }

  /* ── 3) Resumen ────────────────────────────────────────────────────── */
  const summary = await db.query<{ name: string; total: number }>(
    `SELECT c.name, COUNT(p.id) AS total
     FROM categories c LEFT JOIN products p ON p.category_id = c.id AND p.is_active = 1
     WHERE c.tenant_id = $1 GROUP BY c.id ORDER BY c.display_order`,
    [tenantId],
  )
  const orphans = await db.query<{ total: number }>(
    'SELECT COUNT(*) AS total FROM products WHERE tenant_id = $1 AND category_id IS NULL',
    [tenantId],
  )

  console.log(`\nProductos reasignados: ${assigned}`)
  if (missing > 0) console.warn(`Productos sin categoría en defs: ${missing}`)
  console.log('Distribución final:')
  for (const row of summary.rows) console.log(`  ${row.name}: ${row.total}`)
  console.log(`Productos huérfanos (sin categoría): ${orphans.rows[0]?.total ?? 0}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('ERROR:', err)
    process.exit(1)
  })
