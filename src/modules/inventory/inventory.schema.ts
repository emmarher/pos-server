/**
 * src/modules/inventory/inventory.schema.ts — JSON Schemas de inventario.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Contrato de:
 *   GET/POST /inventory/locations    (RF-IN-001)
 *   PATCH    /inventory/locations/:id
 *   GET/POST /inventory/lots         (RF-IN-002)
 *   GET      /inventory/movements    (RF-IN-003)
 *   POST     /inventory/adjustments  (RF-IN-005)
 *   GET/POST /purchase-orders        (RF-IN-004)
 *   GET      /purchase-orders/:id
 *   GET      /inventory/alerts       (RF-IN-006)
 *   PATCH    /inventory/alerts/:id
 *   GET/POST /suppliers              (proveedores, RF-IN-004)
 *
 * Respuestas SIEMPRE envueltas en { statusCode, message, data } (types/response).
 * ────────────────────────────────────────────────────────────────────────
 */
import type { ApiDataSchema } from '../../types/response.js'

/* ── Schemas de entidades (data interno) ──────────────────────────────── */

/** Ubicación de inventario (RF-IN-001). */
export const inventoryLocationSchema: ApiDataSchema = {
  type: 'object',
  required: ['id', 'tenant_id', 'name', 'code', 'is_active', 'created_at', 'updated_at'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    name: { type: 'string' },
    code: { type: 'string' },
    is_active: { type: 'boolean' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
}

/** Lote de inventario (RF-IN-002). */
export const inventoryLotSchema: ApiDataSchema = {
  type: 'object',
  required: [
    'id', 'tenant_id', 'product_id', 'location_id', 'quantity', 'received_at',
    'is_active', 'created_at', 'updated_at',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    product_id: { type: 'string' },
    location_id: { type: 'string' },
    lot_number: { type: ['string', 'null'] },
    quantity: { type: 'number' },
    expiry_date: { type: ['string', 'null'] },
    received_at: { type: 'string' },
    is_active: { type: 'boolean' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    product_name: { type: ['string', 'null'] },
  },
}

/** Movimiento de inventario (RF-IN-003). */
export const inventoryMovementSchema: ApiDataSchema = {
  type: 'object',
  required: [
    'id', 'tenant_id', 'product_id', 'location_id', 'movement_type', 'quantity',
    'inventory_before', 'inventory_after', 'created_at',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    product_id: { type: 'string' },
    location_id: { type: 'string' },
    lot_id: { type: ['string', 'null'] },
    movement_type: { enum: ['IN', 'OUT', 'ADJUSTMENT', 'RETURN', 'CANCEL'] },
    quantity: { type: 'number' },
    inventory_before: { type: 'number' },
    inventory_after: { type: 'number' },
    reference_type: { type: ['string', 'null'] },
    reference_id: { type: ['string', 'null'] },
    expiry_date: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
    created_by: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    product_name: { type: ['string', 'null'] },
    location_name: { type: ['string', 'null'] },
  },
}

/** Alerta de inventario (RF-IN-006). */
export const inventoryAlertSchema: ApiDataSchema = {
  type: 'object',
  required: [
    'id', 'tenant_id', 'product_id', 'alert_type', 'severity',
    'is_resolved', 'created_at',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    product_id: { type: 'string' },
    location_id: { type: ['string', 'null'] },
    alert_type: { enum: ['LOW_STOCK', 'EXPIRY_WARNING', 'EXPIRED', 'AGED_STOCK'] },
    severity: { enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    message: { type: ['string', 'null'] },
    is_resolved: { type: 'boolean' },
    resolved_at: { type: ['string', 'null'] },
    resolved_by: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    product_name: { type: ['string', 'null'] },
  },
}

/** Proveedor (catálogo RF-IN-004). */
export const supplierSchema: ApiDataSchema = {
  type: 'object',
  required: ['id', 'tenant_id', 'name', 'is_active', 'created_at', 'updated_at'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    name: { type: 'string' },
    contact_name: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    address: { type: ['string', 'null'] },
    rfc: { type: ['string', 'null'] },
    is_active: { type: 'boolean' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
}

/** Ítem de entrada de mercancía (dentro del detalle de purchase order). */
export const purchaseOrderItemSchema: ApiDataSchema = {
  type: 'object',
  required: [
    'id', 'purchase_order_id', 'product_id', 'quantity', 'unit_cost',
    'total_cost', 'created_at',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    purchase_order_id: { type: 'string' },
    product_id: { type: 'string' },
    lot_id: { type: ['string', 'null'] },
    quantity: { type: 'number' },
    unit_cost: { type: 'number' },
    total_cost: { type: 'number' },
    expiry_date: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    product_name: { type: ['string', 'null'] },
  },
}

/** Orden de compra / entrada de mercancía (RF-IN-004). */
export const purchaseOrderSchema: ApiDataSchema = {
  type: 'object',
  required: [
    'id', 'tenant_id', 'total_cost', 'status', 'cloud_sync_status',
    'created_at', 'updated_at',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    supplier_id: { type: ['string', 'null'] },
    location_id: { type: ['string', 'null'] },
    invoice_number: { type: ['string', 'null'] },
    total_cost: { type: 'number' },
    status: { enum: ['PENDING', 'COMPLETED', 'CANCELLED'] },
    notes: { type: ['string', 'null'] },
    created_by: { type: ['string', 'null'] },
    cloud_sync_status: { type: 'string' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    supplier_name: { type: ['string', 'null'] },
    location_name: { type: ['string', 'null'] },
    items: { type: 'array', items: purchaseOrderItemSchema },
  },
}

/** Resultado paginado { items, total }. */
function listResultSchema(itemSchema: ApiDataSchema): ApiDataSchema {
  return {
    type: 'object',
    required: ['items', 'total'],
    additionalProperties: false,
    properties: {
      items: { type: 'array', items: itemSchema },
      total: { type: 'integer' },
    },
  }
}

/* ── Body y query de entrada ──────────────────────────────────────────── */

/** Body de POST /inventory/locations. */
export const locationCreateBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['name', 'code'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    code: { type: 'string', minLength: 1, maxLength: 20 },
    is_active: { type: 'boolean' },
  },
}

/** Body de PATCH /inventory/locations/:id — mismos campos, opcionales. */
export const locationUpdateBodySchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: locationCreateBodySchema.properties,
}

/** Query de GET /inventory/lots. */
export const lotQuerySchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    product_id: { type: 'string', minLength: 1 },
  },
}

/** Body de POST /inventory/lots. */
export const lotCreateBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['product_id'],
  additionalProperties: false,
  properties: {
    product_id: { type: 'string', minLength: 1 },
    location_id: { type: 'string', minLength: 1 },
    lot_number: { type: ['string', 'null'], maxLength: 100 },
    quantity: { type: 'number', minimum: 0 },
    expiry_date: { type: ['string', 'null'] },
  },
}

/** Query de GET /inventory/movements. */
export const movementQuerySchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    product_id: { type: 'string', minLength: 1 },
    movement_type: { enum: ['IN', 'OUT', 'ADJUSTMENT', 'RETURN', 'CANCEL'] },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    offset: { type: 'integer', minimum: 0 },
  },
}

/** Body de POST /inventory/adjustments (RF-IN-005). */
export const adjustmentCreateBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['product_id', 'quantity', 'reason'],
  additionalProperties: false,
  properties: {
    product_id: { type: 'string', minLength: 1 },
    location_id: { type: ['string', 'null'], minLength: 1 },
    quantity: { type: 'number' },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
}

/** Body de POST /purchase-orders (RF-IN-004). */
export const purchaseOrderCreateBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    supplier_id: { type: ['string', 'null'], minLength: 1 },
    location_id: { type: ['string', 'null'], minLength: 1 },
    invoice_number: { type: ['string', 'null'], maxLength: 100 },
    notes: { type: ['string', 'null'], maxLength: 1000 },
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['product_id', 'quantity', 'unit_cost'],
        additionalProperties: false,
        properties: {
          product_id: { type: 'string', minLength: 1 },
          quantity: { type: 'number', exclusiveMinimum: 0 },
          unit_cost: { type: 'number', minimum: 0 },
          lot_number: { type: ['string', 'null'], maxLength: 100 },
          expiry_date: { type: ['string', 'null'] },
        },
      },
    },
  },
}

/** Query de GET /inventory/alerts. */
export const alertQuerySchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    resolved: { type: 'string', enum: ['true', 'false'] },
    alert_type: { enum: ['LOW_STOCK', 'EXPIRY_WARNING', 'EXPIRED', 'AGED_STOCK'] },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    offset: { type: 'integer', minimum: 0 },
  },
}

/** Body de POST /suppliers. */
export const supplierCreateBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    contact_name: { type: ['string', 'null'], maxLength: 255 },
    phone: { type: ['string', 'null'], maxLength: 20 },
    email: { type: ['string', 'null'], maxLength: 255 },
    address: { type: ['string', 'null'], maxLength: 500 },
    rfc: { type: ['string', 'null'], maxLength: 13 },
    is_active: { type: 'boolean' },
  },
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

/* ── Schemas de listas (arrays planos) ────────────────────────────────── */

export const inventoryLocationListSchema: ApiDataSchema = {
  type: 'array',
  items: inventoryLocationSchema,
}

export const inventoryLotListSchema: ApiDataSchema = {
  type: 'array',
  items: inventoryLotSchema,
}

export const purchaseOrderListSchema: ApiDataSchema = {
  type: 'array',
  items: purchaseOrderSchema,
}

export const supplierListSchema: ApiDataSchema = {
  type: 'array',
  items: supplierSchema,
}

export const movementListResultSchema = listResultSchema(inventoryMovementSchema)
export const alertListResultSchema = listResultSchema(inventoryAlertSchema)
