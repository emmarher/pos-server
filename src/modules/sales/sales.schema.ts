/**
 * src/modules/sales/sales.schema.ts — JSON Schemas del módulo de ventas.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Contrato de:
 *   POST /sales          (crear venta, RF-VE-002 — payload espejo de
 *                         pos-mobile CreateSalePayload)
 *   GET  /sales/:id      (detalle de venta con ítems y pagos)
 *
 * Respuestas SIEMPRE envueltas en { statusCode, message, data } (types/response).
 * ────────────────────────────────────────────────────────────────────────
 */
import type { ApiDataSchema } from '../../types/response.js'

/* ── Métodos de pago (RF-VE-004) ──────────────────────────────────────── */

export const paymentMethodEnum = ['CASH', 'CARD', 'TRANSFER', 'CREDIT', 'VOUCHER'] as const

/* ── Ítem del payload de POST /sales (espejo SaleItemPayload) ──────────── */

export const saleItemInputSchema: ApiDataSchema = {
  type: 'object',
  required: ['product_id', 'quantity', 'unit_price', 'discount', 'subtotal', 'base_quantity', 'price_type_id'],
  additionalProperties: false,
  properties: {
    product_id: { type: 'string', minLength: 1 },
    quantity: { type: 'number', exclusiveMinimum: 0 },
    alternate_quantity: { type: 'number', exclusiveMinimum: 0 },
    unit_price: { type: 'number', minimum: 0 },
    discount: { type: 'number', minimum: 0 },
    subtotal: { type: 'number', minimum: 0 },
    base_quantity: { type: 'number', minimum: 0 },
    price_type_id: { type: 'string', minLength: 1 },
  },
}

/* ── Pago del payload (espejo SalePayment) ─────────────────────────────── */

export const salePaymentInputSchema: ApiDataSchema = {
  type: 'object',
  required: ['method', 'amount'],
  additionalProperties: false,
  properties: {
    method: { type: 'string', enum: [...paymentMethodEnum] },
    amount: { type: 'number', exclusiveMinimum: 0 },
    reference_code: { type: 'string', maxLength: 100 },
  },
}

/* ── Body de POST /sales (espejo CreateSalePayload) ────────────────────── */

export const createSaleBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['items', 'payments', 'subtotal', 'total_discount', 'total'],
  additionalProperties: false,
  properties: {
    customer_id: { type: ['string', 'null'], minLength: 1 },
    items: {
      type: 'array',
      minItems: 1,
      items: saleItemInputSchema,
    },
    payments: {
      type: 'array',
      minItems: 1,
      items: salePaymentInputSchema,
    },
    subtotal: { type: 'number', minimum: 0 },
    total_discount: { type: 'number', minimum: 0 },
    total: { type: 'number', minimum: 0 },
  },
}

/* ── Respuesta de POST /sales (espejo SaleResponse) ────────────────────── */

export const saleResponseSchema: ApiDataSchema = {
  type: 'object',
  required: [
    'id', 'tenant_id', 'folio', 'status', 'payment_state',
    'subtotal', 'total_discount', 'total', 'created_at',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    folio: { type: 'string' },
    status: { type: 'string' },
    payment_state: { type: 'string', enum: ['PAID', 'PENDING', 'PARTIAL'] },
    subtotal: { type: 'number' },
    total_discount: { type: 'number' },
    total: { type: 'number' },
    payment_change: { type: 'number' },
    created_at: { type: 'string' },
    qos_event_id: { type: 'string' },
  },
}

/* ── Ítem y pago del detalle (GET /sales/:id) ──────────────────────────── */

export const saleItemSchema: ApiDataSchema = {
  type: 'object',
  required: [
    'id', 'product_id', 'product_name', 'product_barcode', 'price_type_id',
    'quantity', 'base_quantity', 'alternate_quantity', 'unit_id', 'unit_price',
    'discount_applied', 'subtotal',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    product_id: { type: 'string' },
    product_name: { type: 'string' },
    product_barcode: { type: ['string', 'null'] },
    price_type_id: { type: ['string', 'null'] },
    quantity: { type: 'number' },
    base_quantity: { type: 'number' },
    alternate_quantity: { type: ['number', 'null'] },
    unit_id: { type: 'string' },
    unit_price: { type: 'number' },
    discount_applied: { type: 'number' },
    subtotal: { type: 'number' },
  },
}

export const salePaymentSchema: ApiDataSchema = {
  type: 'object',
  required: ['id', 'method', 'amount', 'reference_code', 'change_amount', 'created_at'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    method: { type: 'string', enum: [...paymentMethodEnum] },
    amount: { type: 'number' },
    reference_code: { type: ['string', 'null'] },
    change_amount: { type: 'number' },
    created_at: { type: 'string' },
  },
}

/* ── Detalle completo (GET /sales/:id) ─────────────────────────────────── */

export const saleDetailSchema: ApiDataSchema = {
  type: 'object',
  required: [
    'id', 'tenant_id', 'device_id', 'seller_id', 'customer_id', 'folio_number',
    'folio_prefix', 'folio', 'subtotal', 'discount', 'tax', 'total', 'status',
    'payment_state', 'cancel_reason', 'notes', 'created_at', 'items', 'payments',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    device_id: { type: 'string' },
    seller_id: { type: 'string' },
    customer_id: { type: ['string', 'null'] },
    folio_number: { type: 'integer' },
    folio_prefix: { type: 'string' },
    folio: { type: 'string' },
    subtotal: { type: 'number' },
    discount: { type: 'number' },
    tax: { type: 'number' },
    total: { type: 'number' },
    status: { type: 'string', enum: ['COMPLETED', 'CANCELLED', 'REFUNDED'] },
    payment_state: { type: 'string', enum: ['PAID', 'PENDING', 'PARTIAL'] },
    cancel_reason: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    items: { type: 'array', items: saleItemSchema },
    payments: { type: 'array', items: salePaymentSchema },
  },
}

/* ── Body de POST /sales/:id/cancel ────────────────────────────────────── */

export const cancelSaleBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
}

/* ── Params de ruta ────────────────────────────────────────────────────── */

export const idParamsSchema: ApiDataSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
  },
}
