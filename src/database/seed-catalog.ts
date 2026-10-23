/**
 * src/database/seed-catalog.ts — Siembra el catálogo demo de ABARROTES.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Crea los productos de abarrotes del tenant DEMO-0001 en UNA sola
 * categoría ("Abarrotes") con sus 3 precios por producto
 * (Público RETAIL / Mayoreo WHOLESALE / Especial SPECIAL).
 *
 * El catálogo es una lista curada de abarrotes reales: 1 nombre = 1
 * producto (sin variantes sintéticas "v1/v2" ni categorías de otros giros).
 *
 * SOLO PARA DESARROLLO/DEMO — no ejecutar en producción.
 * IDEMPOTENTE: compara por nombre dentro de la categoría Abarrotes y solo
 * inserta los productos que falten.
 *
 * Ejecutar:  npm run seed:catalog
 * Reset:     npm run seed:catalog:reset  (borra ventas + catálogo y resiembra)
 * ────────────────────────────────────────────────────────────────────────
 */
import { db } from './client.js'
import { DEMO_TENANT_CODE } from './seed.js'

/** Única categoría del catálogo demo. */
const CATEGORY_NAME = 'Abarrotes'
const CATEGORY_PREFIX = 'ABR'
/** Mismo primer color de la paleta que usa el alta automática del desktop. */
const CATEGORY_COLOR = '#22C55E'

interface AbarrotesDef {
  name: string
  /** Precio público (MXN). */
  price: number
  /** Costo de compra (MXN). */
  cost: number
}

/**
 * Catálogo curado de abarrotes. El precio/costo es de referencia para la
 * demo; el mayoreo (−10 %) y el especial (+15 %) se derivan del público.
 */
const ABARROTES: AbarrotesDef[] = [
  { name: 'Arroz Verde Valle 1 kg', price: 34.0, cost: 26.0 },
  { name: 'Arroz Súper Extra 1 kg', price: 28.5, cost: 22.0 },
  { name: 'Arroz integral 900 g', price: 39.0, cost: 31.0 },
  { name: 'Frijol Negro La Campiña 900 g', price: 38.0, cost: 29.0 },
  { name: 'Frijol Pinto 1 kg', price: 35.0, cost: 27.0 },
  { name: 'Frijol Peruano 1 kg', price: 36.0, cost: 28.0 },
  { name: 'Lenteja 500 g', price: 21.0, cost: 16.0 },
  { name: 'Garbanzo 500 g', price: 24.0, cost: 18.5 },
  { name: 'Alubia 500 g', price: 23.0, cost: 17.5 },
  { name: 'Habas 500 g', price: 20.0, cost: 15.0 },
  { name: 'Avena Quaker 800 g', price: 42.0, cost: 34.0 },
  { name: 'Harina de trigo 1 kg', price: 25.0, cost: 19.0 },
  { name: 'Harina de maíz Maseca 1 kg', price: 24.0, cost: 18.5 },
  { name: 'Azúcar Estándar 1 kg', price: 27.5, cost: 22.0 },
  { name: 'Azúcar 2 kg', price: 52.0, cost: 43.0 },
  { name: 'Sal La Fina 1 kg', price: 16.0, cost: 11.0 },
  { name: 'Sal de grano 1 kg', price: 14.0, cost: 10.0 },
  { name: 'Aceite Nutrioli 900 ml', price: 58.0, cost: 46.0 },
  { name: 'Aceite de oliva 500 ml', price: 96.0, cost: 80.0 },
  { name: 'Aceite de maíz 900 ml', price: 52.0, cost: 42.0 },
  { name: 'Atún Dolmar en Agua 140 g', price: 19.5, cost: 15.0 },
  { name: 'Atún Dolmar en Aceite 140 g', price: 20.5, cost: 16.0 },
  { name: 'Sardinas La Costeña 425 g', price: 24.0, cost: 18.5 },
  { name: 'Sardinas en tomate 425 g', price: 23.0, cost: 17.5 },
  { name: 'Pasta para sopa 200 g', price: 12.0, cost: 8.5 },
  { name: 'Spaghetti La Moderna 200 g', price: 13.5, cost: 9.5 },
  { name: 'Coditos 200 g', price: 12.5, cost: 9.0 },
  { name: 'Fideo 200 g', price: 11.5, cost: 8.0 },
  { name: 'Galletas Saladas 240 g', price: 22.0, cost: 17.0 },
  { name: 'Galletas María 200 g', price: 18.0, cost: 13.5 },
  { name: 'Galletas Emperador 90 g', price: 13.5, cost: 10.0 },
  { name: 'Cereal Zucaritas 500 g', price: 49.0, cost: 40.0 },
  { name: 'Cereal Corn Flakes 500 g', price: 46.0, cost: 37.0 },
  { name: 'Cereal de avena 400 g', price: 44.0, cost: 35.0 },
  { name: 'Café Nescafé Clásico 100 g', price: 68.0, cost: 54.0 },
  { name: 'Café molido 500 g', price: 92.0, cost: 78.0 },
  { name: 'Café de olla 250 g', price: 55.0, cost: 45.0 },
  { name: 'Chocolate Abuelita 400 g', price: 62.0, cost: 51.0 },
  { name: 'Chocolate en tableta 180 g', price: 28.0, cost: 22.0 },
  { name: 'Mermelada de fresa 270 g', price: 32.0, cost: 25.0 },
  { name: 'Mermelada de piña 270 g', price: 31.0, cost: 24.0 },
  { name: 'Miel de abeja 250 g', price: 48.0, cost: 39.0 },
  { name: 'Mayonesa McCormick 390 g', price: 52.0, cost: 41.0 },
  { name: 'Mostaza 390 g', price: 28.0, cost: 22.0 },
  { name: 'Catsup Clemente 340 g', price: 18.0, cost: 13.5 },
  { name: 'Salsa San Luis 400 g', price: 24.0, cost: 18.0 },
  { name: 'Salsa Valentina 370 ml', price: 22.0, cost: 16.0 },
  { name: 'Salsa inglesa 150 ml', price: 19.0, cost: 14.5 },
  { name: 'Salsa de soya 150 ml', price: 21.0, cost: 16.5 },
  { name: 'Vinagre blanco 500 ml', price: 15.0, cost: 11.0 },
  { name: 'Knorr Caldo de Pollo 950 g', price: 118.0, cost: 96.0 },
  { name: 'Knorr Caldo de Res 950 g', price: 118.0, cost: 96.0 },
  { name: 'Caldo de tomate 100 g', price: 18.0, cost: 13.5 },
  { name: 'Pimienta molida 50 g', price: 22.0, cost: 17.0 },
  { name: 'Orégano molido 20 g', price: 12.0, cost: 8.5 },
  { name: 'Canela molida 20 g', price: 13.0, cost: 9.5 },
  { name: 'Comino molido 20 g', price: 12.5, cost: 9.0 },
  { name: 'Chile en polvo 50 g', price: 15.0, cost: 11.0 },
  { name: 'Ajo en polvo 50 g', price: 16.0, cost: 12.0 },
  { name: 'Cebolla en polvo 50 g', price: 16.0, cost: 12.0 },
  { name: 'Leche en polvo Nido 400 g', price: 118.0, cost: 100.0 },
  { name: 'Leche evaporada Carnation 360 g', price: 32.0, cost: 26.0 },
  { name: 'Leche condensada La Lechera 390 g', price: 38.0, cost: 31.0 },
  { name: 'Crema para café 400 g', price: 45.0, cost: 37.0 },
  { name: 'Pan Bimbo Grande', price: 46.0, cost: 37.0 },
  { name: 'Pan Integral Bimbo 600 g', price: 52.0, cost: 42.0 },
  { name: 'Tortillas de harina 500 g', price: 28.0, cost: 22.0 },
  { name: 'Tostadas 200 g', price: 22.0, cost: 17.0 },
  { name: 'Totopos 200 g', price: 26.0, cost: 20.0 },
  { name: 'Palomitas para microondas 100 g', price: 18.0, cost: 13.5 },
  { name: 'Cacahuates salados 150 g', price: 21.0, cost: 16.0 },
  { name: 'Almendras 100 g', price: 45.0, cost: 37.0 },
  { name: 'Nueces 100 g', price: 52.0, cost: 43.0 },
  { name: 'Pasas 100 g', price: 18.0, cost: 13.5 },
  { name: 'Ajonjolí 100 g', price: 14.0, cost: 10.0 },
  { name: 'Coco rallado 100 g', price: 17.0, cost: 12.5 },
  { name: 'Gelatina en polvo 120 g', price: 15.0, cost: 11.0 },
  { name: 'Flan en polvo 100 g', price: 17.0, cost: 12.5 },
  { name: 'Pudín en polvo 100 g', price: 16.0, cost: 12.0 },
  { name: 'Polvo para hornear 200 g', price: 19.0, cost: 14.0 },
  { name: 'Bicarbonato de sodio 100 g', price: 12.0, cost: 8.5 },
  { name: 'Levadura en polvo 100 g', price: 14.0, cost: 10.0 },
  { name: 'Vainilla 120 ml', price: 24.0, cost: 18.5 },
  { name: 'Colorante vegetal 10 g', price: 9.0, cost: 6.0 },
  { name: 'Sopa Maruchan Camarón 70 g', price: 16.0, cost: 11.5 },
  { name: 'Sopa Maruchan Pollo 70 g', price: 15.0, cost: 11.0 },
  { name: 'Frijoles refritos 400 g', price: 26.0, cost: 20.0 },
  { name: 'Frijoles enteros en lata 400 g', price: 24.0, cost: 18.5 },
  { name: 'Elote en lata 400 g', price: 27.0, cost: 21.0 },
  { name: 'Chícharos en lata 400 g', price: 25.0, cost: 19.5 },
  { name: 'Verduras mixtas en lata 400 g', price: 28.0, cost: 22.0 },
  { name: 'Champiñones en lata 400 g', price: 32.0, cost: 25.0 },
  { name: 'Piña en almíbar 400 g', price: 29.0, cost: 22.5 },
  { name: 'Duraznos en almíbar 400 g', price: 31.0, cost: 24.0 },
  { name: 'Cóctel de frutas 400 g', price: 32.0, cost: 25.0 },
  { name: 'Puré de tomate 400 g', price: 18.0, cost: 13.5 },
  { name: 'Pasta de tomate 200 g', price: 14.0, cost: 10.0 },
  { name: 'Tomate triturado 400 g', price: 22.0, cost: 17.0 },
  { name: 'Chiles jalapeños en escabeche 220 g', price: 24.0, cost: 18.5 },
  { name: 'Chipotles adobados 220 g', price: 26.0, cost: 20.0 },
  { name: 'Huevos Bachoco 18 piezas', price: 62.0, cost: 50.0 },
  { name: 'Tortillas de maíz 1 kg', price: 24.0, cost: 17.0 },
]

/** Redondea a 2 decimales. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Barcode EAN-13 determinista a partir del nombre: reejecutar el seed
 * produce el mismo código (idempotencia) y evita choques entre productos.
 */
function makeBarcode(name: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `750${String(h).padStart(10, '0')}`
}

/** Genera el catálogo de abarrotes (idempotente por nombre). */
export async function seedCatalog(): Promise<void> {
  const tenantRows = await db.query<{ id: string }>(
    'SELECT id FROM tenants WHERE license_key = $1',
    [DEMO_TENANT_CODE],
  )
  const tenantId = tenantRows.rows[0]?.id
  if (!tenantId) {
    throw new Error(`Tenant ${DEMO_TENANT_CODE} no existe — corre npm run seed primero`)
  }

  // Unidad base/venta: pieza (la presentación va en el nombre del producto).
  const unitRows = await db.query<{ id: string }>(
    "SELECT id FROM measurement_units WHERE code = 'piece'",
  )
  const unitId = unitRows.rows[0]?.id
  if (!unitId) {
    throw new Error("Falta la unidad 'piece' — corre npm run seed primero")
  }

  // Price types del tenant
  const ptRows = await db.query<{ id: string; code: string }>(
    'SELECT id, code FROM price_types WHERE tenant_id = $1 AND is_active = 1',
    [tenantId],
  )
  const priceTypes = new Map(ptRows.rows.map(p => [p.code, p.id]))
  const retailId = priceTypes.get('RETAIL')
  const wholesaleId = priceTypes.get('WHOLESALE')
  const specialId = priceTypes.get('SPECIAL')
  if (!retailId || !wholesaleId || !specialId) {
    throw new Error('Faltan price_types (RETAIL/WHOLESALE/SPECIAL) — corre npm run seed')
  }

  // Categoría única del catálogo (la crea si no existe; la reactiva si estaba apagada).
  const now = new Date().toISOString()
  const today = now.slice(0, 10)
  const catRows = await db.query<{ id: string; is_active: number }>(
    'SELECT id, is_active FROM categories WHERE tenant_id = $1 AND name = $2',
    [tenantId, CATEGORY_NAME],
  )
  let categoryId = catRows.rows[0]?.id
  if (!categoryId) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO categories
         (tenant_id, name, description, prefix, color, display_order, is_active, created_at, updated_at)
       VALUES ($1, $2, '', $3, $4, 0, 1, $5, $5) RETURNING id`,
      [tenantId, CATEGORY_NAME, CATEGORY_PREFIX, CATEGORY_COLOR, now],
    )
    categoryId = rows[0]?.id
    if (!categoryId) throw new Error('No se pudo crear la categoría Abarrotes')
    console.log(`Categoría "${CATEGORY_NAME}" creada`)
  } else if (!catRows.rows[0]?.is_active) {
    await db.query(
      'UPDATE categories SET is_active = 1, updated_at = $1 WHERE id = $2',
      [now, categoryId],
    )
    console.log(`Categoría "${CATEGORY_NAME}" reactivada`)
  }

  // Idempotencia: por nombre dentro de Abarrotes.
  const existingRows = await db.query<{ name: string }>(
    `SELECT p.name FROM products p
       JOIN categories c ON c.id = p.category_id
      WHERE p.tenant_id = $1 AND c.name = $2 AND p.is_active = 1`,
    [tenantId, CATEGORY_NAME],
  )
  const existing = new Set(existingRows.rows.map(r => r.name.trim().toLowerCase()))
  const missing = ABARROTES.filter(
    d => !existing.has(d.name.trim().toLowerCase()),
  )

  if (missing.length === 0) {
    console.log(
      `El catálogo de ${CATEGORY_NAME} ya está completo (${ABARROTES.length} productos) — nada que sembrar.`,
    )
    return
  }
  console.log(
    `Sembrando ${missing.length} de ${ABARROTES.length} productos de ${CATEGORY_NAME}…`,
  )

  const created: string[] = []
  await db.transaction(async (tx) => {
    for (const def of missing) {
      const idx = ABARROTES.indexOf(def)
      const seq = String(idx + 1).padStart(4, '0')
      // Stock variado para la demo: algunos en 0 (se ven como "Agotado").
      const stock = idx % 13 === 0 ? 0 : 18 + ((idx * 29) % 180)
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO products
           (tenant_id, category_id, name, description, barcode, internal_code, sku,
            base_unit_id, sale_unit_id, unit_conversion, price, cost, stock, min_stock,
            max_stock, is_scale_enabled, allow_fractional_sale, is_active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,1,$9,$10,$11,$12,500,0,0,1,$13,$13)
         RETURNING id`,
        [
          tenantId,
          categoryId,
          def.name,
          `Producto de ${CATEGORY_NAME}`,
          makeBarcode(def.name),
          `${CATEGORY_PREFIX}${seq}`,
          `SKU-${CATEGORY_PREFIX}${seq}`,
          unitId,
          def.price,
          def.cost,
          stock,
          Math.max(5, Math.round(stock * 0.2)),
          now,
        ],
      )
      const productId = rows[0]?.id
      if (!productId) continue

      const prices: [string, number, number][] = [
        [retailId, def.price, 1],
        [wholesaleId, round2(def.price * 0.9), 10],
        [specialId, round2(def.price * 1.15), 1],
      ]
      for (const [priceTypeId, price, minQty] of prices) {
        await tx.query(
          `INSERT INTO product_prices
             (tenant_id, product_id, price_type_id, price, min_quantity,
              start_date, end_date, is_active, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,NULL,1,$7,$7)`,
          [tenantId, productId, priceTypeId, price, minQty, today, now],
        )
      }
      created.push(def.name)
    }
  })

  console.log(
    `Productos creados: ${created.length} (+${created.length * 3} precios)`,
  )
}

// main cuando se ejecuta directo
if (process.argv[1]?.endsWith('seed-catalog.ts')) {
  seedCatalog()
    .then(() => {
      console.log('Catálogo listo.')
      return db.end()
    })
    .catch((err) => {
      console.error('Error al sembrar catálogo:', err)
      process.exit(1)
    })
}
