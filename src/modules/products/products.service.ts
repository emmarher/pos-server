/**
 * src/modules/products/products.service.ts — Lógica de catálogos.
 *
 * ────────────────────────────────────────────────────────────────────────
 * RF-CA-001 (categorías), RF-CA-002 (productos), RF-CA-003 (tipos de
 * precio), RF-CA-004 (precios por producto), RF-CA-006 (búsqueda, limit 20).
 *
 * TRIGGERS (nunca se reimplementan en JS):
 *   - internal_code: lo genera la BD (prefix + secuencia por categoría).
 *   - is_scale_enabled: solo con sale_unit MASS (valida la BD).
 *   - categories.product_count: lo mantiene la BD.
 *   - No desactivar categoría con productos activos: lo valida la BD.
 *   La API solo INSERTA/ACTUALIZA filas y propaga el error de la BD
 *   (CONFLICT / CHECK / RAISE) como HttpError legible.
 *
 * MULTI-TENANT: TODAS las consultas filtran por tenant_id = $x; el tenant
 * SIEMPRE viene del JWT (request.user.tenant_id), nunca del body/query.
 * ────────────────────────────────────────────────────────────────────────
 */
import { db } from '../../database/client.js'
import { HttpError } from '../../types/errors.js'
import type {
  Category,
  MeasurementUnit,
  PriceType,
  Product,
  ProductPrice,
  ProductSearchResult,
} from '../../types/products.js'

/* ── Interfaces de entrada (lo que llega del cliente) ─────────────────── */

export interface CategoryInput {
  name: string
  prefix: string
  description?: string | null
  color?: string
  display_order?: number
  is_active?: boolean
}

export interface ProductInput {
  category_id?: string | null
  name: string
  description?: string | null
  barcode?: string | null
  internal_code?: string | null
  sku?: string | null
  base_unit_id: string
  sale_unit_id: string
  unit_conversion?: number
  price?: number
  cost?: number
  min_stock?: number
  max_stock?: number | null
  is_scale_enabled?: boolean
  allow_fractional_sale?: boolean
  is_active?: boolean
  /** Precios por tipo de precio (RF-CA-004), insertados junto al producto. */
  prices?: ProductPriceInput[]
}

export interface ProductPriceInput {
  price_type_id: string
  price: number
  min_quantity?: number
  start_date?: string
  end_date?: string | null
}

export interface ProductSearchParams {
  /** búsqueda por nombre / internal_code / barcode (RF-CA-006) */
  q?: string
  category_id?: string
  limit?: number
  offset?: number
  /** false → incluye productos inactivos (filtro de administración) */
  activeOnly?: boolean
}

/* ── Fila cruda de la BD (con joins) ──────────────────────────────────── */

interface ProductRow {
  id: string
  tenant_id: string
  category_id: string | null
  name: string
  description: string | null
  barcode: string | null
  internal_code: string | null
  sku: string | null
  base_unit_id: string
  sale_unit_id: string
  unit_conversion: number
  price: number
  cost: number
  stock: number
  min_stock: number
  max_stock: number | null
  is_scale_enabled: number
  allow_fractional_sale: number
  is_active: number
  category_name: string | null
  category_prefix: string | null
  category_color: string | null
  category_display_order: number | null
  category_product_count: number | null
  category_is_active: number | null
  base_unit_code: string | null
  base_unit_name: string | null
  base_unit_symbol: string | null
  base_unit_type: string | null
  sale_unit_code: string | null
  sale_unit_name: string | null
  sale_unit_symbol: string | null
  sale_unit_type: string | null
}

interface CategoryRow {
  id: string
  tenant_id: string
  name: string
  description: string | null
  prefix: string
  color: string
  display_order: number
  product_count: number
  is_active: number
}

interface MeasurementUnitRow {
  id: string
  tenant_id: string
  code: string
  name: string
  symbol: string
  unit_type: 'MASS' | 'COUNT' | 'VOLUME' | 'LENGTH'
  is_fractional: number
  decimal_places: number
  is_system_default: number
  is_active: number
}

interface PriceTypeRow {
  id: string
  tenant_id: string
  name: string
  code: string
  is_default: number
  is_active: number
}

/* ── Mapeadores crudo → dominio (normalizan INTEGER → boolean) ────────── */

function toMeasurementUnit(row: MeasurementUnitRow): MeasurementUnit {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    symbol: row.symbol,
    unit_type: row.unit_type,
    is_fractional: row.is_fractional === 1,
    decimal_places: row.decimal_places,
    is_system_default: row.is_system_default === 1,
    is_active: row.is_active === 1,
  }
}

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    description: row.description,
    prefix: row.prefix,
    color: row.color,
    display_order: row.display_order,
    product_count: row.product_count,
    is_active: row.is_active === 1,
  }
}

function toPriceType(row: PriceTypeRow): PriceType {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    code: row.code,
    is_default: row.is_default === 1,
    is_active: row.is_active === 1,
  }
}

/** Construye un Product con las relaciones resueltas del row crudo. */
function toProduct(row: ProductRow, prices: ProductPrice[]): Product {
  const category: Category | null =
    row.category_id && row.category_name !== null
      ? {
          id: row.category_id,
          tenant_id: row.tenant_id,
          name: row.category_name,
          description: null,
          prefix: row.category_prefix ?? '',
          color: row.category_color ?? '#3B82F6',
          display_order: row.category_display_order ?? 0,
          product_count: row.category_product_count ?? 0,
          is_active: row.category_is_active === 1,
        }
      : null

  const base_unit: MeasurementUnit | null =
    row.base_unit_code !== null
      ? {
          id: row.base_unit_id,
          tenant_id: row.tenant_id,
          code: row.base_unit_code,
          name: row.base_unit_name ?? '',
          symbol: row.base_unit_symbol ?? '',
          unit_type: (row.base_unit_type ?? 'COUNT') as MeasurementUnit['unit_type'],
          is_fractional: row.base_unit_type === 'MASS',
          decimal_places: row.base_unit_type === 'MASS' ? 3 : 0,
          is_system_default: false,
          is_active: true,
        }
      : null

  const sale_unit: MeasurementUnit | null =
    row.sale_unit_code !== null
      ? {
          id: row.sale_unit_id,
          tenant_id: row.tenant_id,
          code: row.sale_unit_code,
          name: row.sale_unit_name ?? '',
          symbol: row.sale_unit_symbol ?? '',
          unit_type: (row.sale_unit_type ?? 'COUNT') as MeasurementUnit['unit_type'],
          is_fractional: row.sale_unit_type === 'MASS',
          decimal_places: row.sale_unit_type === 'MASS' ? 3 : 0,
          is_system_default: false,
          is_active: true,
        }
      : null

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    category_id: row.category_id,
    name: row.name,
    description: row.description,
    barcode: row.barcode,
    internal_code: row.internal_code,
    sku: row.sku,
    base_unit_id: row.base_unit_id,
    sale_unit_id: row.sale_unit_id,
    unit_conversion: row.unit_conversion,
    price: row.price,
    cost: row.cost,
    stock: row.stock,
    min_stock: row.min_stock,
    max_stock: row.max_stock,
    is_scale_enabled: row.is_scale_enabled === 1,
    allow_fractional_sale: row.allow_fractional_sale === 1,
    is_active: row.is_active === 1,
    category,
    base_unit,
    sale_unit,
    prices,
  }
}

/** SELECT con joins a categoría y unidades (base + venta). */
const PRODUCT_SELECT = `
  SELECT
    p.id, p.tenant_id, p.category_id, p.name, p.description, p.barcode,
    p.internal_code, p.sku, p.base_unit_id, p.sale_unit_id, p.unit_conversion,
    p.price, p.cost, p.stock, p.min_stock, p.max_stock, p.is_scale_enabled,
    p.allow_fractional_sale, p.is_active,
    c.name AS category_name, c.prefix AS category_prefix, c.color AS category_color,
    c.display_order AS category_display_order, c.product_count AS category_product_count,
    c.is_active AS category_is_active,
    bu.code AS base_unit_code, bu.name AS base_unit_name, bu.symbol AS base_unit_symbol,
    bu.unit_type AS base_unit_type,
    su.code AS sale_unit_code, su.name AS sale_unit_name, su.symbol AS sale_unit_symbol,
    su.unit_type AS sale_unit_type
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN measurement_units bu ON bu.id = p.base_unit_id
  LEFT JOIN measurement_units su ON su.id = p.sale_unit_id
`

/* ── Categorías (RF-CA-001) ───────────────────────────────────────────── */

/** GET /categories — lista del tenant (activas o todas). */
export async function listCategories(
  tenantId: string,
  activeOnly = true,
): Promise<Category[]> {
  const where = activeOnly
    ? 'WHERE tenant_id = $1 AND is_active = 1'
    : 'WHERE tenant_id = $1'
  const { rows } = await db.query<CategoryRow>(
    `SELECT id, tenant_id, name, description, prefix, color, display_order,
            product_count, is_active
     FROM categories ${where}
     ORDER BY display_order ASC, name ASC`,
    [tenantId],
  )
  return rows.map(toCategory)
}

/** Crea una categoría. El product_count lo mantiene la BD. */
export async function createCategory(
  tenantId: string,
  input: CategoryInput,
): Promise<Category> {
  const now = new Date().toISOString()
  try {
    const { rows } = await db.query<CategoryRow>(
      `INSERT INTO categories
         (tenant_id, name, description, prefix, color, display_order, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING id, tenant_id, name, description, prefix, color, display_order, product_count, is_active`,
      [
        tenantId,
        input.name.trim(),
        input.description ?? null,
        input.prefix.trim().toUpperCase(),
        input.color ?? '#3B82F6',
        input.display_order ?? 0,
        input.is_active === false ? 0 : 1,
        now,
      ],
    )
    const row = rows[0]
    if (!row) throw new HttpError('NOT_FOUND', 'Categoría no encontrada')
    return toCategory(row)
  } catch (err) {
    throw toHttpError(err, 'No se pudo crear la categoría')
  }
}/** Actualiza una categoría (la guardia de desactivación la hace la BD). */
export async function updateCategory(
  tenantId: string,
  id: string,
  input: Partial<CategoryInput>,
): Promise<Category> {
  const current = await findCategory(tenantId, id)
  const merged: CategoryInput = {
    name: input.name ?? current.name,
    prefix: input.prefix ?? current.prefix,
    description: input.description !== undefined ? input.description : current.description,
    color: input.color ?? current.color,
    display_order: input.display_order ?? current.display_order,
    is_active: input.is_active ?? current.is_active,
  }
  try {
    const { rows } = await db.query<CategoryRow>(
      `UPDATE categories
       SET name = $3, description = $4, prefix = $5, color = $6,
           display_order = $7, is_active = $8, updated_at = $9
       WHERE tenant_id = $1 AND id = $2
       RETURNING id, tenant_id, name, description, prefix, color, display_order, product_count, is_active`,
      [
        tenantId,
        id,
        merged.name.trim(),
        merged.description,
        merged.prefix.trim().toUpperCase(),
        merged.color,
        merged.display_order,
        merged.is_active ? 1 : 0,
        new Date().toISOString(),
      ],
    )
    const row = rows[0]
    if (!row) throw new HttpError('NOT_FOUND', 'Categoría no encontrada')
    return toCategory(row)
  } catch (err) {
    throw toHttpError(err, 'No se pudo actualizar la categoría')
  }
}

/** Busca una categoría por id dentro del tenant (404 si no existe). */
async function findCategory(tenantId: string, id: string): Promise<Category> {
  const { rows } = await db.query<CategoryRow>(
    `SELECT id, tenant_id, name, description, prefix, color, display_order,
            product_count, is_active
     FROM categories WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  )
  if (!rows[0]) {
    throw new HttpError('NOT_FOUND', 'Categoría no encontrada')
  }
  return toCategory(rows[0])
}

/* ── Unidades de medida y tipos de precio (catálogo base) ─────────────── */

/**
 * GET /measurement-units — unidades del tenant + las de sistema.
 * El esquema autoritativo inserta las unidades de sistema SIN tenant
 * (tenant_id NULL), así que se filtran con OR is_system_default = 1.
 */
export async function listMeasurementUnits(
  tenantId: string,
  activeOnly = true,
): Promise<MeasurementUnit[]> {
  const where = activeOnly
    ? '(tenant_id = $1 OR is_system_default = 1) AND is_active = 1'
    : 'tenant_id = $1 OR is_system_default = 1'
  const { rows } = await db.query<MeasurementUnitRow>(
    `SELECT id, tenant_id, code, name, symbol, unit_type, is_fractional,
            decimal_places, is_system_default, is_active
     FROM measurement_units WHERE ${where}
     ORDER BY unit_type ASC, name ASC`,
    [tenantId],
  )
  return rows.map(toMeasurementUnit)
}

/** GET /price-types — tipos de precio del tenant (para la venta). */
export async function listPriceTypes(tenantId: string): Promise<PriceType[]> {
  const { rows } = await db.query<PriceTypeRow>(
    `SELECT id, tenant_id, name, code, is_default, is_active
     FROM price_types WHERE tenant_id = $1 AND is_active = 1
     ORDER BY is_default DESC, name ASC`,
    [tenantId],
  )
  return rows.map(toPriceType)
}

/* ── Productos (RF-CA-002) ────────────────────────────────────────────── */

/**
 * Búsqueda de productos (RF-CA-006): por nombre (LIKE), internal_code,
 * barcode y categoría. Limit default 20. Los precios de cada producto se
 * resuelven al tipo de precio DEFAULT del tenant en la respuesta (el
 * cajero puede cambiar el tipo con GET /products/:id/prices).
 */
export async function searchProducts(
  tenantId: string,
  params: ProductSearchParams,
): Promise<ProductSearchResult> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50)
  const offset = Math.max(params.offset ?? 0, 0)

  const conditions: string[] = ['p.tenant_id = $1']
  const values: unknown[] = [tenantId]
  let paramIndex = 2

  if (params.activeOnly !== false) {
    conditions.push('p.is_active = 1')
  }
  if (params.category_id) {
    conditions.push(`p.category_id = $${paramIndex++}`)
    values.push(params.category_id)
  }
  if (params.q && params.q.trim() !== '') {
    const term = params.q.trim()
    // Búsqueda amplia: nombre LIKE + coincidencias exactas por código.
    conditions.push(
      `(p.name LIKE $${paramIndex} OR p.internal_code = $${paramIndex + 1} OR p.barcode = $${paramIndex + 2})`,
    )
    values.push(`%${term}%`, term, term)
    paramIndex += 3
  }

  const whereSql = conditions.join(' AND ')

  const [{ rows: countRows }, { rows }] = await Promise.all([
    db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM products p WHERE ${whereSql}`,
      values,
    ),
    db.query<ProductRow>(
      `${PRODUCT_SELECT}
       WHERE ${whereSql}
       ORDER BY p.name ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset],
    ),
  ])

  const total = countRows[0]?.total ?? 0
  const items = await Promise.all(
    rows.map(async (row) => {
      const prices = await loadPrices(tenantId, row.id)
      return toProduct(row, prices)
    }),
  )

  return { items, total }
}

/**
 * Carga los precios vigentes de un producto (RF-CA-004).
 * Devuelve UN precio por cada tipo de precio activo del tenant:
 *   - Si el producto tiene `product_prices` para ese tipo → el específico.
 *   - Si no → el precio base del producto (`products.price`) como fallback.
 * Así la terminal SIEMPRE muestra todos los tipos de precio disponibles
 * (Público, Mayoreo…) aunque el producto no tenga precios registrados.
 */
async function loadPrices(tenantId: string, productId: string): Promise<ProductPrice[]> {
  const [priceTypesRes, { rows: productPrices }, { rows: product }] = await Promise.all([
    db.query<PriceTypeRow>(
      'SELECT id, tenant_id, name, code, is_default, is_active FROM price_types WHERE tenant_id = $1 AND is_active = 1 ORDER BY is_default DESC, name ASC',
      [tenantId],
    ),
    db.query<ProductPrice>(
      `SELECT id, product_id, price_type_id, price, min_quantity, start_date, end_date
       FROM product_prices
       WHERE tenant_id = $1 AND product_id = $2 AND is_active = 1
         AND (end_date IS NULL OR end_date >= date('now'))
       ORDER BY start_date DESC`,
      [tenantId, productId],
    ),
    db.query<{ price: number }>('SELECT price FROM products WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      productId,
    ]),
  ])

  const basePrice = product[0]?.price ?? 0
  const priceTypes = priceTypesRes.rows
  const byType = new Map(productPrices.map(pp => [pp.price_type_id, pp]))

  // Un precio por cada tipo activo; fallback al precio base del producto
  return priceTypes.map(pt => {
    const existing = byType.get(pt.id)
    if (existing) {
      return existing
    }
    return {
      id: `${productId}-${pt.id}`,
      product_id: productId,
      price_type_id: pt.id,
      price: basePrice,
      min_quantity: 1,
      start_date: new Date().toISOString().slice(0, 10),
      end_date: null,
    }
  })
}

/** GET /products/:id — detalle completo con precios. */
export async function getProduct(tenantId: string, id: string): Promise<Product> {
  const { rows } = await db.query<ProductRow>(
    `${PRODUCT_SELECT} WHERE p.tenant_id = $1 AND p.id = $2`,
    [tenantId, id],
  )
  const row = rows[0]
  if (!row) {
    throw new HttpError('NOT_FOUND', 'Producto no encontrado')
  }
  const prices = await loadPrices(tenantId, row.id)
  return toProduct(row, prices)
}

/** GET /products/:id/prices — precios por tipo de precio (RF-CA-004). */
export async function getProductPrices(
  tenantId: string,
  productId: string,
): Promise<ProductPrice[]> {
  // Verifica que el producto exista y sea del tenant (aislamiento)
  const { rows: check } = await db.query<{ id: string }>(
    'SELECT id FROM products WHERE tenant_id = $1 AND id = $2',
    [tenantId, productId],
  )
  if (!check[0]) {
    throw new HttpError('NOT_FOUND', 'Producto no encontrado')
  }
  return loadPrices(tenantId, productId)
}

/**
 * Crea un producto. El internal_code y las validaciones (báscula, stock,
 * unicidad) las aplica la BD vía triggers/constraints; aquí solo se
 * inserta la fila y los precios (RF-CA-002 + RF-CA-004).
 */
export async function createProduct(
  tenantId: string,
  input: ProductInput,
): Promise<Product> {
  await validateRefs(tenantId, input)

  const now = new Date().toISOString()
  let productId = ''
  try {
    await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO products
           (tenant_id, category_id, name, description, barcode, internal_code, sku,
            base_unit_id, sale_unit_id, unit_conversion, price, cost, stock, min_stock,
            max_stock, is_scale_enabled, allow_fractional_sale, is_active, created_at, updated_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13, $14, $15, $16, $17, $18, $18)
         RETURNING id`,
        [
          tenantId,
          input.category_id ?? null,
          input.name.trim(),
          input.description ?? null,
          input.barcode ?? null,
          input.internal_code ?? null,
          input.sku ?? null,
          input.base_unit_id,
          input.sale_unit_id,
          input.unit_conversion ?? 1,
          input.price ?? 0,
          input.cost ?? 0,
          input.min_stock ?? 0,
          input.max_stock ?? null,
          input.is_scale_enabled ? 1 : 0,
          input.allow_fractional_sale === false ? 0 : 1,
          input.is_active === false ? 0 : 1,
          now,
        ],
      )
      const inserted = rows[0]
      if (!inserted) throw new HttpError('INTERNAL', 'No se pudo crear el producto')
      productId = inserted.id

      // Precios por tipo de precio (RF-CA-004) — opcionales
      if (input.prices && input.prices.length > 0) {
        for (const price of input.prices) {
          await tx.query(
            `INSERT INTO product_prices
               (tenant_id, product_id, price_type_id, price, min_quantity, start_date, end_date, is_active, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)`,
            [
              tenantId,
              productId,
              price.price_type_id,
              price.price,
              price.min_quantity ?? 1,
              price.start_date ?? new Date().toISOString().slice(0, 10),
              price.end_date ?? null,
              now,
            ],
          )
        }
      }
    })
  } catch (err) {
    throw toHttpError(err, 'No se pudo crear el producto')
  }

  return getProduct(tenantId, productId)
}

/** Actualiza campos de un producto (RF-CA-002). stock NO se edita aquí. */
export async function updateProduct(
  tenantId: string,
  id: string,
  input: Partial<ProductInput>,
): Promise<Product> {
  // Existencia + aislamiento
  const current = await getProduct(tenantId, id)
  if (
    input.base_unit_id ||
    input.sale_unit_id ||
    input.category_id !== undefined ||
    input.is_scale_enabled !== undefined
  ) {
    await validateRefs(tenantId, {
      name: current.name,
      base_unit_id: input.base_unit_id ?? current.base_unit_id,
      sale_unit_id: input.sale_unit_id ?? current.sale_unit_id,
      category_id: input.category_id !== undefined ? input.category_id : current.category_id,
      is_scale_enabled: input.is_scale_enabled ?? current.is_scale_enabled,
      prices: input.prices,
    })
  } else if (input.prices) {
    await validateRefs(tenantId, {
      name: current.name,
      base_unit_id: current.base_unit_id,
      sale_unit_id: current.sale_unit_id,
      prices: input.prices,
    })
  }

  const now = new Date().toISOString()
  try {
    const sets: string[] = []
    const values: unknown[] = [tenantId, id]

    const map: Array<[string, unknown]> = [
      ['category_id', input.category_id !== undefined ? input.category_id : undefined],
      ['name', input.name],
      ['description', input.description],
      ['barcode', input.barcode],
      ['internal_code', input.internal_code],
      ['sku', input.sku],
      ['base_unit_id', input.base_unit_id],
      ['sale_unit_id', input.sale_unit_id],
      ['unit_conversion', input.unit_conversion],
      ['price', input.price],
      ['cost', input.cost],
      ['min_stock', input.min_stock],
      ['max_stock', input.max_stock],
      ['is_scale_enabled', input.is_scale_enabled === undefined ? undefined : input.is_scale_enabled ? 1 : 0],
      ['allow_fractional_sale', input.allow_fractional_sale === undefined ? undefined : input.allow_fractional_sale ? 1 : 0],
      ['is_active', input.is_active === undefined ? undefined : input.is_active ? 1 : 0],
    ]

    for (const [column, value] of map) {
      if (value !== undefined) {
        sets.push(`${column} = $${values.length + 1}`)
        values.push(value)
      }
    }

    if (sets.length === 0 && !input.prices) {
      throw new HttpError('VALIDATION_ERROR', 'No hay campos para actualizar')
    }

    if (sets.length > 0) {
      sets.push(`updated_at = $${values.length + 1}`)
      values.push(now)
      await db.query(
        `UPDATE products SET ${sets.join(', ')}
         WHERE tenant_id = $1 AND id = $2`,
        values,
      )
    }

    // Reemplaza los precios si vienen en el payload (RF-CA-004)
    const newPrices = input.prices
    if (newPrices) {
      await db.transaction(async (tx) => {
        await tx.query(
          'DELETE FROM product_prices WHERE tenant_id = $1 AND product_id = $2',
          [tenantId, id],
        )
        for (const price of newPrices) {
          await tx.query(
            `INSERT INTO product_prices
               (tenant_id, product_id, price_type_id, price, min_quantity, start_date, end_date, is_active, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)`,
            [
              tenantId,
              id,
              price.price_type_id,
              price.price,
              price.min_quantity ?? 1,
              price.start_date ?? new Date().toISOString().slice(0, 10),
              price.end_date ?? null,
              now,
            ],
          )
        }
      })
    }
  } catch (err) {
    throw toHttpError(err, 'No se pudo actualizar el producto')
  }

  return getProduct(tenantId, id)
}

/** Desactiva un producto (borrado lógico; el borrado físico rompería ventas). */
export async function deactivateProduct(
  tenantId: string,
  id: string,
): Promise<Product> {
  await getProduct(tenantId, id)
  const now = new Date().toISOString()
  await db.query(
    `UPDATE products SET is_active = 0, updated_at = $3
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, now],
  )
  return getProduct(tenantId, id)
}

/* ── Validaciones auxiliares ──────────────────────────────────────────── */

/**
 * Valida que las referencias (categoría, unidades, tipos de precio)
 * pertenezcan al tenant. Regla de aislamiento: un producto de un tenant
 * no puede apuntar a un recurso de otro.
 */
async function validateRefs(tenantId: string, input: ProductInput): Promise<void> {
  const checks: Array<[string, string | null | undefined, string]> = [
    ['categories', input.category_id, 'Categoría'],
    ['measurement_units', input.base_unit_id, 'Unidad base'],
    ['measurement_units', input.sale_unit_id, 'Unidad de venta'],
  ]
  for (const [table, idValue, message] of checks) {
    if (idValue === undefined || idValue === null) continue
    // Las unidades de sistema viven con tenant_id NULL (esquema autoritativo):
    // se aceptan además de las propias del tenant.
    const unitScope =
      table === 'measurement_units' ? '(tenant_id = $1 OR is_system_default = 1)' : 'tenant_id = $1'
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE ${unitScope} AND id = $2`,
      [tenantId, idValue],
    )
    if (!rows[0]) {
      throw new HttpError('TENANT_MISMATCH', `${message} no válida o de otro tenant`)
    }
  }

  // Tipos de precio referenciados por los precios del producto
  if (input.prices) {
    for (const price of input.prices) {
      const { rows } = await db.query<{ id: string }>(
        'SELECT id FROM price_types WHERE tenant_id = $1 AND id = $2',
        [tenantId, price.price_type_id],
      )
      if (!rows[0]) {
        throw new HttpError(
          'TENANT_MISMATCH',
          'Tipo de precio no válido o de otro tenant',
        )
      }
    }
  }
}

/** Convierte errores de la BD (constraints/triggers) en HttpError legible. */
function toHttpError(err: unknown, fallback: string): HttpError {
  if (err instanceof HttpError) return err
  const message = err instanceof Error ? err.message : ''
  const code = (err as { code?: string })?.code ?? ''

  // Unicidad violada (barcode/internal_code/sku por tenant)
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/i.test(message)) {
    return new HttpError('CONFLICT', 'Ya existe un producto con ese código de barras o código interno')
  }
  // CHECK / RAISE de triggers (báscula, stock…)
  if (code === 'SQLITE_CONSTRAINT_CHECK' || /CHECK/i.test(message)) {
    return new HttpError('VALIDATION_ERROR', 'El producto no cumple las reglas de validación')
  }
  if (/báscula/i.test(message)) {
    return new HttpError(
      'VALIDATION_ERROR',
      'Solo los productos con unidad de venta tipo MASA pueden usar báscula',
    )
  }
  if (/No se puede desactivar/i.test(message)) {
    return new HttpError('CONFLICT', 'No se puede desactivar la categoría porque tiene productos activos')
  }
  // FK violada
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY/i.test(message)) {
    return new HttpError('CONFLICT', 'Referencia no válida o recurso en uso')
  }

  return new HttpError('INTERNAL', fallback)
}
