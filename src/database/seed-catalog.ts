/**
 * src/database/seed-catalog.ts — Genera el catálogo demo (dev/demo).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Crea ~800 productos sintéticos realistas + 3 precios por producto
 * (Público RETAIL / Mayoreo WHOLESALE / Especial SPECIAL) y las
 * categorías necesarias para el tenant DEMO-0001.
 *
 * SOLO PARA DESARROLLO/DEMO — no ejecutar en producción.
 * IDEMPOTENTE: si el tenant ya tiene ≥800 productos activos, termina.
 *
 * Ejecutar: npm run seed:catalog
 * ────────────────────────────────────────────────────────────────────────
 */
import { db } from './client.js'
import { DEMO_TENANT_CODE } from './seed.js'

/** Total de productos objetivo (aprox). */
const TARGET_PRODUCTS = 800

/** Categorías a crear con su prefix (3 letras). */
const CATEGORY_DEFS: { name: string; prefix: string; unit: string; scale: boolean }[] = [
  { name: 'Abarrotes', prefix: 'ABR', unit: 'piece', scale: false },
  { name: 'Bebidas', prefix: 'BEB', unit: 'liter', scale: false },
  { name: 'Lácteos', prefix: 'LAC', unit: 'piece', scale: false },
  { name: 'Carnes y Embutidos', prefix: 'CAR', unit: 'kg', scale: true },
  { name: 'Frutas y Verduras', prefix: 'FRU', unit: 'kg', scale: true },
  { name: 'Panadería', prefix: 'PAN', unit: 'piece', scale: false },
  { name: 'Botanas', prefix: 'BOT', unit: 'piece', scale: false },
  { name: 'Limpieza', prefix: 'LIM', unit: 'liter', scale: false },
  { name: 'Higiene Personal', prefix: 'HIG', unit: 'piece', scale: false },
  { name: 'Papelería', prefix: 'PAP', unit: 'piece', scale: false },
  { name: 'Ferretería', prefix: 'FER', unit: 'piece', scale: false },
  { name: 'Electrónica', prefix: 'ELE', unit: 'piece', scale: false },
  { name: 'Mascotas', prefix: 'MAS', unit: 'piece', scale: false },
  { name: 'Bebés', prefix: 'BEBE', unit: 'piece', scale: false },
  { name: 'Congelados', prefix: 'CON', unit: 'kg', scale: true },
  { name: 'Salsas y Condimentos', prefix: 'SAL', unit: 'piece', scale: false },
]

/** Marcas y nombres base por categoría para generar nombres realistas. */
const ITEM_POOL: Record<string, string[]> = {
  ABR: ['Arroz', 'Frijol', 'Lenteja', 'Garbanzo', 'Avena', 'Harina de trigo', 'Azúcar', 'Sal', 'Aceite vegetal', 'Atún en lata', 'Sardinas', 'Pasta', 'Galletas de soda', 'Cereal de maíz', 'Café soluble', 'Chocolate en polvo', 'Mermelada', 'Miel', 'Mayonesa', 'Mostaza'],
  BEB: ['Agua mineral', 'Refresco de cola', 'Refresco de naranja', 'Jugo de naranja', 'Jugo de manzana', 'Agua de sabor', 'Té helado', 'Agua tónica', 'Cerveza', 'Vino tinto', 'Bebida energética', 'Bebida isotónica', 'Leche saborizada', 'Horchata', 'Jamaica', 'Agua de coco', 'Sidra', 'Pulque'],
  LAC: ['Leche entera', 'Leche deslactosada', 'Yogurt natural', 'Yogurt de fresa', 'Queso manchego', 'Queso panela', 'Queso crema', 'Crema ácida', 'Mantequilla', 'Margarina', 'Ghee', 'Requesón', 'Cajeta', 'Flan', 'Helado de vainilla'],
  CAR: ['Pechuga de pollo', 'Muslo de pollo', 'Res en bistec', 'Carne molida', 'Chuleta de cerdo', 'Tocino', 'Salchicha', 'Jamón de pavo', 'Chorizo', 'Longaniza', 'Pescado entero', 'Filete de pescado', 'Camarón', 'Atún fresco', 'Cecina', 'Costilla de res'],
  FRU: ['Manzana', 'Plátano', 'Naranja', 'Lima', 'Limón', 'Mango', 'Papaya', 'Sandía', 'Melón', 'Uva', 'Fresa', 'Arándano', 'Piña', 'Aguacate', 'Tomate', 'Cebolla', 'Papa', 'Zanahoria', 'Brócoli', 'Chile poblano'],
  PAN: ['Pan de caja', 'Bolillo', 'Tortilla de harina', 'Concha', 'Dona', 'Croissant', 'Pan dulce', 'Baguette', 'Pan integral', 'Cuernito', 'Pie de limón', 'Pastel de chocolate', 'Galletas surtidas', 'Pan tostado', 'Media noche'],
  BOT: ['Papas fritas', 'Totopos', 'Chicharrón', 'Cacahuates', 'Pistaches', 'Almendras', 'Nueces', 'Palomitas', 'Barritas de granola', 'Chocolate', 'Caramelo', 'Chicles', 'Gomitas', 'Galletas con chispas', 'Pretzels'],
  LIM: ['Cloro', 'Detergente en polvo', 'Suavizante', 'Jabón de trastes', 'Limpiavidrios', 'Desinfectante', 'Escoba', 'Trapeador', 'Esponja', 'Bolsa de basura', 'Papel higiénico', 'Servilletas', 'Toallas de cocina', 'Limpiador multiusos', 'Fabuloso'],
  HIG: ['Jabón de baño', 'Champú', 'Acondicionador', 'Pasta dental', 'Cepillo dental', 'Desodorante', 'Gel de baño', 'Crema corporal', 'Rasuradora', 'Toallas sanitarias', 'Pañales', 'Talco', 'Alcohol en gel', 'Cotonetes', 'Enjuague bucal'],
  PAP: ['Cuaderno', 'Lápiz', 'Pluma', 'Borrador', 'Sacapuntas', 'Regla', 'Marcadores', 'Colores', 'Papel bond', 'Carpeta', 'Engrapadora', 'Clips', 'Resistol', 'Tijeras', 'Goma de borrar'],
  FER: ['Martillo', 'Desarmador', 'Pinzas', 'Cinta de aislar', 'Clavos', 'Tornillos', 'Tornillo de banco', 'Llave inglesa', 'Nivel', 'Flexómetro', 'Brocha', 'Pintura blanca', 'Lija', 'Candado', 'Candado de combinación'],
  ELE: ['Audífonos', 'Cargador USB', 'Cable HDMI', 'Bocina bluetooth', 'Power bank', 'Mouse', 'Teclado', 'Memoria USB', 'Lámpara LED', 'Extensión eléctrica', 'Adaptador', 'Pilas AA', 'Pilas AAA', 'Cámara web', 'Micrófono'],
  MAS: ['Croquetas de perro', 'Croquetas de gato', 'Arena para gato', 'Correa', 'Collar', 'Plato de mascota', 'Juguete para perro', 'Juguete para gato', 'Shampoo de mascota', 'Cepillo para mascota', 'Comida húmeda', 'Premios', 'Cama de mascota', 'Transportadora', 'Bebedero'],
  BEBE: ['Pañal etapa 1', 'Pañal etapa 2', 'Toallitas húmedas', 'Biberón', 'Chupón', 'Fórmula infantil', 'Crema para pañal', 'Talco para bebé', 'Ropa de bebé', 'Cobija', 'Juguete de peluche', 'Sonajero', 'Mordedera', 'Set de baño', 'Shampoo de bebé'],
  CON: ['Pizza congelada', 'Pescado congelado', 'Verduras congeladas', 'Frutas congeladas', 'Helado', 'Nuggets de pollo', 'Papas a la francesa', 'Pan congelado', 'Mariscos congelados', 'Paleta de hielo', 'Ravioles', 'Sopa congelada', 'Puré de papa', 'Elote congelado', 'Chicharrón congelado'],
  SAL: ['Salsa de tomate', 'Salsa picante', 'Salsa verde', 'Salsa roja', 'Adobo', 'Vinagre', 'Soya', 'Salsa inglesa', 'Consomé de pollo', 'Consomé de res', 'Especias', 'Pimienta', 'Orégano', 'Canela', 'Chile en polvo'],
}

/** Rango de precios base (mín, máx) por categoría. */
const PRICE_RANGE: Record<string, [number, number]> = {
  ABR: [15, 180], BEB: [12, 250], LAC: [18, 150], CAR: [35, 350], FRU: [5, 90],
  PAN: [8, 120], BOT: [10, 130], LIM: [15, 160], HIG: [20, 200], PAP: [5, 120],
  FER: [15, 450], ELE: [50, 2500], MAS: [20, 400], BEBE: [30, 500], CON: [25, 300], SAL: [10, 80],
}

/** Redondea a 2 decimales. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Genera un EAN-13 simulado (13 dígitos, único por llamada). */
function makeBarcode(seed: number): string {
  const base = (1000000000000 + seed * 7919) % 10000000000000
  return String(base).padStart(13, '0')
}

/** Genera el catálogo masivo (idempotente). */
export async function seedCatalog(): Promise<void> {
  const tenantRows = await db.query<{ id: string }>(
    'SELECT id FROM tenants WHERE license_key = $1',
    [DEMO_TENANT_CODE],
  )
  const tenantId = tenantRows.rows[0]?.id
  if (!tenantId) {
    throw new Error(`Tenant ${DEMO_TENANT_CODE} no existe — corre npm run seed primero`)
  }

  const { rows: countRows } = await db.query<{ c: number }>(
    'SELECT COUNT(*) AS c FROM products WHERE tenant_id = $1 AND is_active = 1',
    [tenantId],
  )
  const current = countRows[0]?.c ?? 0
  if (current >= TARGET_PRODUCTS) {
    console.log(`Ya hay ${current} productos activos — seed del catálogo omitido.`)
    return
  }
  const toCreate = TARGET_PRODUCTS - current
  console.log(`Creando ${toCreate} productos para ${DEMO_TENANT_CODE}…`)

  // Unidades por código
  const unitRows = await db.query<{ id: string; code: string }>(
    'SELECT id, code FROM measurement_units',
  )
  const units = new Map(unitRows.rows.map(u => [u.code, u.id]))

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

  // Categorías del tenant (crea las que falten)
  const catRows = await db.query<{ id: string; name: string; prefix: string }>(
    'SELECT id, name, prefix FROM categories WHERE tenant_id = $1',
    [tenantId],
  )
  const categoryMap = new Map<string, { id: string; prefix: string }>()
  for (const c of catRows.rows) categoryMap.set(c.name, { id: c.id, prefix: c.prefix })

  const now = new Date().toISOString()
  const today = new Date().toISOString().slice(0, 10)

  await db.transaction(async (tx) => {
    // Crear categorías faltantes
    const createdCats: { name: string; prefix: string; id: string }[] = []
    for (const def of CATEGORY_DEFS) {
      if (!categoryMap.has(def.name)) {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO categories (tenant_id, name, description, prefix, color, display_order, is_active, created_at, updated_at)
           VALUES ($1, $2, '', $3, '#3B82F6', 0, 1, $4, $4) RETURNING id`,
          [tenantId, def.name, def.prefix, now],
        )
        const id = rows[0]?.id
        if (id) {
          categoryMap.set(def.name, { id, prefix: def.prefix })
          createdCats.push({ name: def.name, prefix: def.prefix, id })
        }
      }
    }
    console.log(`Categorías: ${createdCats.length} nuevas`)

    // Generar productos + 3 precios
    const defs = CATEGORY_DEFS
    let created = 0
    const batch: unknown[][] = []
    const priceBatch: unknown[][] = []
    const BATCH = 100

    for (let i = 0; i < toCreate; i++) {
      const def = defs[i % defs.length]!
      const cat = categoryMap.get(def.name)
      if (!cat) continue
      const unitId = units.get(def.unit) ?? units.get('piece')
      if (!unitId) continue
      const pool = (ITEM_POOL[cat.prefix] ?? ITEM_POOL['ABR'])!
      const itemName = pool[i % pool.length]!
      const variant = Math.floor(i / pool.length) + 1
      const name = `${itemName} ${def.unit === 'kg' ? `${(0.5 + (i % 4) * 0.25).toFixed(2)}kg` : `${(250 + (i % 5) * 250)}g`} v${variant}`
      const seq = 1000 + i
      const [minP = 15, maxP = 150] = PRICE_RANGE[cat.prefix] ?? [15, 150]
      const price = round2(minP + ((i * 37) % Math.max(1, Math.round(maxP - minP))))
      const cost = round2(price * (0.6 + ((i * 13) % 20) / 100))
      const stock = (i * 29) % 501 // 0..500 (algunos agotados)
      const isScale = def.scale ? 1 : 0

      batch.push([
        tenantId, cat.id, name, `Producto de ${def.name}`,
        makeBarcode(i + 1), `${cat.prefix}${String(seq).slice(-4)}`, `SKU-${cat.prefix}${String(seq).slice(-4)}`,
        unitId, unitId, 1, price, cost, stock,
        Math.max(5, Math.round(stock * 0.2)), 500, isScale, isScale, 1, now, now,
      ])
      priceBatch.push(
        [tenantId, retailId, price, 1],
        [tenantId, wholesaleId, round2(price * 0.9), 10],
        [tenantId, specialId, round2(price * 1.15), 1],
      )

      if (batch.length >= BATCH) {
        await insertBatch(tx, tenantId, batch, priceBatch, now, today)
        created += batch.length
        batch.length = 0
        priceBatch.length = 0
      }
    }
    if (batch.length > 0) {
      await insertBatch(tx, tenantId, batch, priceBatch, now, today)
      created += batch.length
    }
    console.log(`Productos creados: ${created} (+${created * 3} precios)`)
  })

  const { rows: finalCount } = await db.query<{ c: number }>(
    'SELECT COUNT(*) AS c FROM products WHERE tenant_id = $1 AND is_active = 1',
    [tenantId],
  )
  console.log(`Total productos activos: ${finalCount[0]?.c}`)
}

/** Inserta un lote de productos y sus 3 precios (uno a uno con RETURNING). */
async function insertBatch(
  tx: typeof db,
  tenantId: string,
  batch: unknown[][],
  priceBatch: unknown[][],
  _now: string,
  today: string,
): Promise<void> {
  // priceBatch tiene 3 filas por producto en el mismo orden que batch
  const perProduct = 3
  for (let i = 0; i < batch.length; i++) {
    const p = batch[i] as unknown[]
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO products
        (tenant_id, category_id, name, description, barcode, internal_code, sku,
         base_unit_id, sale_unit_id, unit_conversion, price, cost, stock, min_stock,
         max_stock, is_scale_enabled, allow_fractional_sale, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      p,
    )
    const productId = rows[0]?.id
    if (!productId) continue

    // Los 3 precios de este producto
    for (let k = 0; k < perProduct; k++) {
      const pp = priceBatch[i * perProduct + k] as unknown[]
      // pp = [tenant_id, price_type_id, price, min_quantity]
      await tx.query(
        `INSERT INTO product_prices
          (tenant_id, product_id, price_type_id, price, min_quantity, start_date, end_date, is_active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,1,$7,$7)`,
        [pp[0], productId, pp[1], pp[2], pp[3], today, _now],
      )
    }
  }
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
