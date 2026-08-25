/**
 * scripts/load-real-products.ts — Carga del catálogo real de la tienda.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Uso (con el servidor DETENIDO y Garage corriendo):
 *   npx tsx scripts/load-real-products.ts
 *
 * Qué hace:
 *   1) Inserta 52 productos reales (32 con imagen en ../images/ + 20 sin
 *      imagen) con categoría, unidad, precios RETAIL/WHOLESALE, barcode
 *      e internal_code generados.
 *   2) Sube cada imagen al bucket usando el SERVICIO REAL de storage
 *      (sharp → WebP → S3/Garage → BD), igual que lo haría la API.
 *
 * Requisitos previos:
 *   - BD recién migrada + seed (tenant DEMO-0001 existe).
 *   - IMAGES_ENABLED=true y credenciales S3 en .env.
 * ────────────────────────────────────────────────────────────────────────
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../src/database/client.js'
import { uploadProductImage } from '../src/services/storage.service.js'

/* ── 1) DEFINICIÓN DEL CATÁLOGO ──────────────────────────────────────── */

interface ProductDef {
  name: string
  category: string // nombre exacto en tabla categories
  unit: 'kg' | 'piece' | 'liter' | 'pack' | 'bag' | 'dozen'
  price: number // precio público MXN
  cost: number
  wholesale?: number // precio mayoreo (default: price*0.9)
  image?: string // archivo dentro de ../images/
  scale?: boolean // venta por báscula (default: unit === 'kg')
}

/** Prefijos de internal_code por categoría (ej. FRY0001). */
const CATEGORY_PREFIX: Record<string, string> = {
  'Frutas y Verduras': 'FRV',
  Lácteos: 'LAC',
  'Salsas y Condimentos': 'SAC',
  Bebidas: 'BEB',
  Abarrotes: 'ABA',
  Botanas: 'BOT',
  'Limpieza': 'LIM',
}

const PRODUCTS: ProductDef[] = [
  /* ── Frutas y Verduras (KG, báscula) ── */
  { name: 'Cebolla', category: 'Frutas y Verduras', unit: 'kg', price: 32.0, cost: 24.0, image: 'cebolla.webp' },
  { name: 'Cebolla morada', category: 'Frutas y Verduras', unit: 'kg', price: 38.0, cost: 29.0, image: 'cebolla morada.webp' },
  { name: 'Chile de árbol', category: 'Frutas y Verduras', unit: 'kg', price: 95.0, cost: 75.0, image: 'chile de arbol.webp' },
  { name: 'Chile serrano', category: 'Frutas y Verduras', unit: 'kg', price: 55.0, cost: 42.0, image: 'chile serrano.webp' },
  { name: 'Jitomate saladet', category: 'Frutas y Verduras', unit: 'kg', price: 34.5, cost: 26.0, image: 'jitomate.webp' },
  { name: 'Limón sin semilla', category: 'Frutas y Verduras', unit: 'kg', price: 62.0, cost: 48.0, image: 'limon sin semilla.webp' },
  { name: 'Mandarina', category: 'Frutas y Verduras', unit: 'kg', price: 28.0, cost: 20.0, image: 'mandarina.webp' },
  { name: 'Mango ataulfo', category: 'Frutas y Verduras', unit: 'kg', price: 36.0, cost: 27.0, image: 'mango.webp' },
  { name: 'Naranja para jugo', category: 'Frutas y Verduras', unit: 'kg', price: 24.0, cost: 17.0, image: 'naranja.webp' },
  { name: 'Tomate verde', category: 'Frutas y Verduras', unit: 'kg', price: 42.0, cost: 32.0, image: 'tomate verde.webp' },
  { name: 'Zanahoria', category: 'Frutas y Verduras', unit: 'kg', price: 22.0, cost: 15.0, image: 'zanahoria.webp' },

  /* ── Lácteos ── */
  { name: 'Leche Alpura Clásica 1L', category: 'Lácteos', unit: 'piece', price: 25.5, cost: 21.0, image: 'leche alpura clasica.webp' },
  { name: 'Leche Alpura Deslactosada 1L', category: 'Lácteos', unit: 'piece', price: 26.5, cost: 22.0, image: 'leche alpura deslactosada.webp' },
  { name: 'Leche Santa Clara Entera 1L', category: 'Lácteos', unit: 'piece', price: 31.0, cost: 26.0, image: 'leche santa clara entera.webp' },
  { name: 'Leche Santa Clara Deslactosada 1L', category: 'Lácteos', unit: 'piece', price: 31.5, cost: 26.5, image: 'santa clara deslactosada.webp' },
  { name: 'Queso Manchego Cuadritos 1kg', category: 'Lácteos', unit: 'piece', price: 145.0, cost: 120.0, image: 'queso manchego cuadritos 1k.webp' },
  { name: 'Queso Manchego Lala 1.2kg', category: 'Lácteos', unit: 'piece', price: 168.0, cost: 140.0, image: 'queso manchego lala 1.2kg.webp' },
  { name: 'Queso Manchego Lala 200g', category: 'Lácteos', unit: 'piece', price: 39.0, cost: 31.0, image: 'queso manchego lala 200g.webp' },
  { name: 'Queso Oaxaca Lala 700g', category: 'Lácteos', unit: 'piece', price: 98.0, cost: 80.0, image: 'queso oaxaca lala 700g.webp' },

  /* ── Salsas y Condimentos ── */
  { name: 'Catsup Clemente 340g', category: 'Salsas y Condimentos', unit: 'piece', price: 18.0, cost: 13.5, image: 'catsup clemente 340g.webp' },
  { name: 'Catsup Clemente 4kg', category: 'Salsas y Condimentos', unit: 'piece', price: 148.0, cost: 122.0, image: 'catsup clemente 4kg.webp' },
  { name: 'Catsup La Costeña 385g', category: 'Salsas y Condimentos', unit: 'piece', price: 27.5, cost: 21.0, image: 'catsup la costeña 385g.webp' },
  { name: 'Catsup La Costeña 4kg', category: 'Salsas y Condimentos', unit: 'piece', price: 185.0, cost: 155.0, image: 'catsup la costeña 4kg.webp' },
  { name: 'Mayonesa McCormick 390g', category: 'Salsas y Condimentos', unit: 'piece', price: 52.0, cost: 41.0, image: 'mayonesa maccormick 390g.webp' },
  { name: 'Mayonesa McCormick Grande 1.8kg', category: 'Salsas y Condimentos', unit: 'piece', price: 135.0, cost: 110.0, image: 'mayonesa mccormick grande.webp' },
  { name: 'Salsa San Luis 400g', category: 'Salsas y Condimentos', unit: 'piece', price: 24.0, cost: 18.0, image: 'salsa san luis 400g.webp' },
  { name: 'Salsa San Luis Extra Picante', category: 'Salsas y Condimentos', unit: 'piece', price: 25.0, cost: 19.0, image: 'salsa san luis extra picante.webp' },
  { name: 'Salsa Valentina Grande 370ml', category: 'Salsas y Condimentos', unit: 'piece', price: 22.0, cost: 16.0, image: 'salsa valentina grande.webp' },

  /* ── Bebidas ── */
  { name: 'Jugo Jumex Durazno 500ml', category: 'Bebidas', unit: 'piece', price: 17.0, cost: 12.5, image: 'jugo durazno jumex 500ml.webp' },
  { name: 'Jugo Jumex Mango 500ml', category: 'Bebidas', unit: 'piece', price: 17.0, cost: 12.5, image: 'jugo mango jumex 500ml.webp' },
  { name: 'Refresco Coca-Cola 600ml', category: 'Bebidas', unit: 'piece', price: 19.0, cost: 14.0 },
  { name: 'Refresco Sprite 600ml', category: 'Bebidas', unit: 'piece', price: 18.0, cost: 13.5 },
  { name: 'Agua Ciel 1L', category: 'Bebidas', unit: 'piece', price: 14.0, cost: 9.0 },

  /* ── Abarrotes ── */
  { name: 'Knorr Caldo de Pollo 950g', category: 'Abarrotes', unit: 'piece', price: 118.0, cost: 96.0, image: 'knorr pollo 950g.webp' },
  { name: 'Maruchan Camarón y Chile', category: 'Abarrotes', unit: 'piece', price: 16.0, cost: 11.5, image: 'maruchan camaron y chile.webp' },
  { name: 'Arroz Verde Valle 1kg', category: 'Abarrotes', unit: 'bag', price: 34.0, cost: 26.0 },
  { name: 'Frijol Negro La Campiña 900g', category: 'Abarrotes', unit: 'bag', price: 38.0, cost: 29.0 },
  { name: 'Aceite Nutrioli 900ml', category: 'Abarrotes', unit: 'piece', price: 58.0, cost: 46.0 },
  { name: 'Azúcar Estándar 1kg', category: 'Abarrotes', unit: 'kg', price: 27.5, cost: 22.0 },
  { name: 'Sal La Fina 1kg', category: 'Abarrotes', unit: 'piece', price: 16.0, cost: 11.0 },
  { name: 'Atún Dolmar en Agua 140g', category: 'Abarrotes', unit: 'piece', price: 19.5, cost: 15.0 },
  { name: 'Café Nescafé Clásico 100g', category: 'Abarrotes', unit: 'piece', price: 68.0, cost: 54.0 },
  { name: 'Galletas Emperador 90g', category: 'Abarrotes', unit: 'piece', price: 13.5, cost: 10.0 },
  { name: 'Pan Bimbo Grande', category: 'Abarrotes', unit: 'bag', price: 46.0, cost: 37.0 },
  { name: 'Huevos Bachoco 18 piezas', category: 'Abarrotes', unit: 'pack', price: 62.0, cost: 50.0 },
  { name: 'Tortillas de Maíz 1kg', category: 'Abarrotes', unit: 'kg', price: 24.0, cost: 17.0 },

  /* ── Botanas ── */
  { name: 'Papas Sabritas Originales 150g', category: 'Botanas', unit: 'piece', price: 28.0, cost: 21.0 },

  /* ── Limpieza ── */
  { name: 'Jabón Zote Blanco 400g', category: 'Limpieza', unit: 'piece', price: 21.0, cost: 16.0 },
  { name: 'Detergente Ariel 1kg', category: 'Limpieza', unit: 'piece', price: 52.0, cost: 41.0 },
  { name: 'Cloro Cloralex 1L', category: 'Limpieza', unit: 'piece', price: 23.0, cost: 17.5 },
  { name: 'Papel Higiénico Regio 4 rollos', category: 'Limpieza', unit: 'pack', price: 44.0, cost: 35.0 },
]

/* ── 2) HELPERS ──────────────────────────────────────────────────────── */

function nowIso(): string {
  return new Date().toISOString()
}

/** Barcode EAN-like determinista: 75 + índice + relleno (13 dígitos). */
function makeBarcode(index: number): string {
  return `7501234${String(index).padStart(6, '0')}`
}

async function loadMap<T>(
  sql: string,
  keyFn: (row: T) => string,
): Promise<Map<string, T>> {
  const { rows } = await db.query<T>(sql)
  return new Map(rows.map((r) => [keyFn(r), r]))
}

/* ── 3) INSERCIÓN DE PRODUCTOS ───────────────────────────────────────── */

async function insertProducts(): Promise<Map<string, string>> {
  const categories = await loadMap<{ id: string } & Record<string, unknown>, string>(
    "SELECT id, name FROM categories WHERE is_active = 1",
    (r) => String(r.name),
  )
  const units = await loadMap<{ id: string; code: string }, string>(
    'SELECT id, code FROM measurement_units',
    (r) => r.code,
  )
  const priceTypes = await loadMap<{ id: string; code: string }, string>(
    'SELECT id, code FROM price_types',
    (r) => r.code,
  )
  const tenantRows = await db.query<{ id: string }>(
    "SELECT id FROM tenants WHERE license_key = 'DEMO-0001'",
  )
  const tenantId = tenantRows.rows[0]!.id

  const productIdByName = new Map<string, string>()
  const counters = new Map<string, number>() // folio por prefijo de categoría

  for (let i = 0; i < PRODUCTS.length; i++) {
    const def = PRODUCTS[i]!
    const categoryId = categories.get(def.category)?.id ?? null
    const unitId = units.get(def.unit)?.id
    if (!unitId) throw new Error(`Unidad desconocida: ${def.unit}`)

    const prefix = CATEGORY_PREFIX[def.category] ?? 'GEN'
    const seq = (counters.get(prefix) ?? 0) + 1
    counters.set(prefix, seq)

    const id = crypto.randomUUID().replace(/-/g, '')
    const now = nowIso()
    const isScale = def.scale ?? def.unit === 'kg'

    await db.query(
      `INSERT INTO products
         (id, tenant_id, category_id, name, barcode, internal_code,
          base_unit_id, sale_unit_id, price, cost, stock,
          is_scale_enabled, allow_fractional_sale,
          is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,100,$10,$10,1,$11,$11)`,
      [
        id,
        tenantId,
        categoryId,
        def.name,
        makeBarcode(i + 1),
        `${prefix}${String(seq).padStart(4, '0')}`,
        unitId,
        def.price,
        def.cost,
        isScale ? 1 : 0,
        now,
      ],
    )

    /* Precios por tipo: RETAIL (default) + WHOLESALE */
    const retail = priceTypes.get('RETAIL')?.id
    const wholesaleId = priceTypes.get('WHOLESALE')?.id
    if (retail) {
      await db.query(
        `INSERT INTO product_prices
           (product_id, tenant_id, price_type_id, price, min_quantity, created_at, updated_at)
         VALUES ($1,$2,$3,$4,1,$5,$5)`,
        [id, tenantId, retail, def.price, now],
      )
    }
    if (wholesaleId) {
      await db.query(
        `INSERT INTO product_prices
           (product_id, tenant_id, price_type_id, price, min_quantity, created_at, updated_at)
         VALUES ($1,$2,$3,$4,12,$5,$5)`,
        [id, tenantId, wholesaleId, def.wholesale ?? Math.round(def.price * 0.9 * 100) / 100, now],
      )
    }

    productIdByName.set(normalizeName(def.name), id)
  }

  return productIdByName
}

/** Normaliza un nombre para emparejarlo con su archivo de imagen. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/* ── 4) SUBIDA DE IMÁGENES AL BUCKET ─────────────────────────────────── */

/** Mapa clave-de-imagen → productId (basado en el campo `image`). */
function buildImageIndex(
  productIdByName: Map<string, string>,
): Map<string, string> {
  const index = new Map<string, string>()
  for (const def of PRODUCTS) {
    if (!def.image) continue
    const productId = productIdByName.get(normalizeName(def.name))
    if (!productId) continue
    index.set(normalizeName(def.image.replace(/\.webp$/i, '')), productId)
  }
  return index
}

async function uploadImages(
  imageIndex: Map<string, string>,
  tenantId: string,
): Promise<{ ok: number; fail: string[] }> {
  const imagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'images')
  const files = readdirSync(imagesDir).filter((f) => f.endsWith('.webp'))

  let ok = 0
  const fail: string[] = []

  for (const file of files) {
    const baseName = file.replace(/\.webp$/i, '')
    const productId = imageIndex.get(normalizeName(baseName))
    if (!productId) {
      fail.push(`${file} (sin producto "${baseName}")`)
      continue
    }
    try {
      const buffer = readFileSync(join(imagesDir, file))
      const uploaded = await uploadProductImage(tenantId, buffer)
      await db.query(
        'UPDATE products SET imagen_url = $1, updated_at = $2 WHERE id = $3',
        [uploaded.url, nowIso(), productId],
      )
      ok++
      console.log(`✔ ${file}`)
    } catch (err) {
      fail.push(`${file} (${(err as Error).message})`)
    }
  }

  return { ok, fail }
}

/* ── 5) MAIN ─────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const tenantRows = await db.query<{ id: string }>(
    "SELECT id FROM tenants WHERE license_key = 'DEMO-0001'",
  )
  const tenantId = tenantRows.rows[0]!.id

  /* Modo --images-only: NO inserta productos, solo sube imágenes
     (útil para reintentar tras un fallo parcial). */
  let imageIndex: Map<string, string>
  if (process.argv.includes('--images-only')) {
    const { rows } = await db.query<{ name: string; id: string }>(
      'SELECT name, id FROM products WHERE is_active = 1',
    )
    imageIndex = buildImageIndex(
      new Map(rows.map((r) => [normalizeName(r.name), r.id])),
    )
  } else {
    console.log(`Insertando ${PRODUCTS.length} productos…`)
    const productIdByName = await insertProducts()
    console.log(`✔ Productos insertados: ${productIdByName.size}`)
    imageIndex = buildImageIndex(productIdByName)
  }

  console.log('\nSubiendo imágenes al bucket…')
  const { ok, fail } = await uploadImages(imageIndex, tenantId)
  console.log(`\nImágenes subidas: ${ok}`)
  if (fail.length > 0) {
    console.log('Fallidas:')
    for (const f of fail) console.log(`  ✖ ${f}`)
  }

  await db.end()
}

main().catch(async (err) => {
  console.error('Error:', err)
  await db.end()
  process.exit(1)
})
