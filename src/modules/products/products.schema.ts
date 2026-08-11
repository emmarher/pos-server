/**
 * src/modules/products/products.schema.ts — JSON Schemas del módulo products.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Contrato de:
 *   GET  /products             (búsqueda RF-CA-006, limit 20)
 *   POST /products             (crear RF-CA-002)
 *   GET  /products/:id         (detalle)
 *   PATCH /products/:id        (actualizar RF-CA-002)
 *   GET  /products/:id/prices  (precios por tipo, RF-CA-004)
 *   GET  /categories           (RF-CA-001)
 *   POST /categories
 *   PATCH /categories/:id
 *   GET  /measurement-units
 *   GET  /price-types          (RF-CA-003)
 *
 * Respuestas SIEMPRE envueltas en { statusCode, message, data } (types/response).
 * ────────────────────────────────────────────────────────────────────────
 */
import type { ApiDataSchema } from '../../types/response.js'

/* ── Schemas de entidades (data interno) ──────────────────────────────── */

/** Unidad de medida (MASS/COUNT/VOLUME/LENGTH). */
export const measurementUnitSchema: ApiDataSchema = {
  type: 'object',
  required: [
    'id', 'tenant_id', 'code', 'name', 'symbol', 'unit_type',
    'is_fractional', 'decimal_places', 'is_system_default', 'is_active',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    code: { type: 'string' },
    name: { type: 'string' },
    symbol: { type: 'string' },
    unit_type: { enum: ['MASS', 'COUNT', 'VOLUME', 'LENGTH'] },
    is_fractional: { type: 'boolean' },
    decimal_places: { type: 'integer' },
    is_system_default: { type: 'boolean' },
    is_active: { type: 'boolean' },
  },
}

/** Categoría de producto (RF-CA-001). */
export const categorySchema: ApiDataSchema = {
  type: 'object',
  required: [
    'id', 'tenant_id', 'name', 'prefix', 'color', 'display_order',
    'product_count', 'is_active',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    prefix: { type: 'string' },
    color: { type: 'string' },
    display_order: { type: 'integer' },
    product_count: { type: 'integer' },
    is_active: { type: 'boolean' },
  },
}

/** Tipo de precio (RF-CA-003). */
export const priceTypeSchema: ApiDataSchema = {
  type: 'object',
  required: ['id', 'tenant_id', 'name', 'code', 'is_default', 'is_active'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    name: { type: 'string' },
    code: { type: 'string' },
    is_default: { type: 'boolean' },
    is_active: { type: 'boolean' },
  },
}

/** Precio por tipo de precio (RF-CA-004). */
export const productPriceSchema: ApiDataSchema = {
  type: 'object',
  required: ['id', 'product_id', 'price_type_id', 'price', 'min_quantity', 'start_date'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    product_id: { type: 'string' },
    price_type_id: { type: 'string' },
    price: { type: 'number' },
    min_quantity: { type: 'number' },
    start_date: { type: 'string' },
    end_date: { type: ['string', 'null'] },
  },
}

/** Producto completo (RF-CA-002), con relaciones resueltas. */
export const productSchema: ApiDataSchema = {
  type: 'object',
  required: [
    'id', 'tenant_id', 'name', 'base_unit_id', 'sale_unit_id', 'unit_conversion',
    'price', 'cost', 'stock', 'min_stock', 'is_scale_enabled',
    'allow_fractional_sale', 'is_active',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    category_id: { type: ['string', 'null'] },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    barcode: { type: ['string', 'null'] },
    internal_code: { type: ['string', 'null'] },
    sku: { type: ['string', 'null'] },
    base_unit_id: { type: 'string' },
    sale_unit_id: { type: 'string' },
    unit_conversion: { type: 'number' },
    price: { type: 'number' },
    cost: { type: 'number' },
    stock: { type: 'number' },
    min_stock: { type: 'number' },
    max_stock: { type: ['number', 'null'] },
    is_scale_enabled: { type: 'boolean' },
    allow_fractional_sale: { type: 'boolean' },
    is_active: { type: 'boolean' },
    category: { type: ['object', 'null'], properties: categorySchema.properties },
    base_unit: { type: ['object', 'null'], properties: measurementUnitSchema.properties },
    sale_unit: { type: ['object', 'null'], properties: measurementUnitSchema.properties },
    prices: { type: 'array', items: productPriceSchema },
  },
}

/** Resultado de búsqueda (RF-CA-006): items + total. */
export const productSearchSchema: ApiDataSchema = {
  type: 'object',
  required: ['items', 'total'],
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: productSchema },
    total: { type: 'integer' },
  },
}

/* ── Query y body de entrada ──────────────────────────────────────────── */

/** Query de GET /products (todos los params opcionales). */
export const productQuerySchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 255 },
    category_id: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    offset: { type: 'integer', minimum: 0 },
    active_only: { type: 'string', enum: ['true', 'false'] },
  },
}

/** Precio a insertar dentro de productBodySchema.prices[]. */
const productPriceInputSchema: ApiDataSchema = {
  type: 'object',
  required: ['price_type_id', 'price'],
  additionalProperties: false,
  properties: {
    price_type_id: { type: 'string', minLength: 1 },
    price: { type: 'number', minimum: 0 },
    min_quantity: { type: 'number', minimum: 0 },
    start_date: { type: 'string' },
    end_date: { type: ['string', 'null'] },
  },
}

/** Body de POST /products (RF-CA-002). */
export const productCreateBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['name', 'base_unit_id', 'sale_unit_id'],
  additionalProperties: false,
  properties: {
    category_id: { type: ['string', 'null'], minLength: 1 },
    name: { type: 'string', minLength: 1, maxLength: 255 },
    description: { type: ['string', 'null'], maxLength: 1000 },
    barcode: { type: ['string', 'null'], maxLength: 100 },
    internal_code: { type: ['string', 'null'], maxLength: 20 },
    sku: { type: ['string', 'null'], maxLength: 100 },
    base_unit_id: { type: 'string', minLength: 1 },
    sale_unit_id: { type: 'string', minLength: 1 },
    unit_conversion: { type: 'number', exclusiveMinimum: 0 },
    price: { type: 'number', minimum: 0 },
    cost: { type: 'number', minimum: 0 },
    min_stock: { type: 'number', minimum: 0 },
    max_stock: { type: ['number', 'null'], minimum: 0 },
    is_scale_enabled: { type: 'boolean' },
    allow_fractional_sale: { type: 'boolean' },
    is_active: { type: 'boolean' },
    prices: { type: 'array', items: productPriceInputSchema },
  },
}

/** Body de PATCH /products/:id — mismos campos, todos opcionales. */
export const productUpdateBodySchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: productCreateBodySchema.properties,
}

/** Body de POST /categories (RF-CA-001). */
export const categoryCreateBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['name', 'prefix'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    prefix: { type: 'string', minLength: 1, maxLength: 4 },
    description: { type: ['string', 'null'], maxLength: 500 },
    color: { type: 'string', minLength: 4, maxLength: 7 },
    display_order: { type: 'integer' },
    is_active: { type: 'boolean' },
  },
}

/** Body de PATCH /categories/:id — mismos campos, todos opcionales. */
export const categoryUpdateBodySchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: categoryCreateBodySchema.properties,
}

/* ── Params de ruta ───────────────────────────────────────────────────── */

export const idParamsSchema: ApiDataSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
  },
}
