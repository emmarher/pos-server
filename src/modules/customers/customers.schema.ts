/**
 * src/modules/customers/customers.schema.ts — JSON Schemas del módulo clientes y crédito.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Contrato de:
 *   GET    /customers             (listado, RF-VE-005)
 *   POST /customers             (crear cliente)
 *   GET  /customers/:id         (detalle con balance)
 *   PATCH /customers/:id        (actualizar cliente)
 *   POST /customers/:id/credit  (cargo o abono al crédito, RF-VE-005)
 *
 * Respuestas SIEMPRE envueltas en { statusCode, message, data } (types/response).
 * ────────────────────────────────────────────────────────────────────────
 */
import type { ApiDataSchema } from '../../types/response.js'

/** Cliente (RF-VE-005). */
export const customerSchema: ApiDataSchema = {
  type: 'object',
  required: [
    'id', 'tenant_id', 'name', 'credit_limit', 'current_balance',
    'is_active', 'created_at', 'updated_at',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    address: { type: ['string', 'null'] },
    rfc: { type: ['string', 'null'] },
    credit_limit: { type: 'number' },
    current_balance: { type: 'number' },
    loyalty_points: { type: 'number' },
    loyalty_points_value: { type: 'number' },
    is_active: { type: 'boolean' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
};

/** Resultado paginado { items, total }. */
export const customerListResultSchema: ApiDataSchema = {
  type: 'object',
  required: ['items', 'total'],
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: customerSchema },
    total: { type: 'integer' },
  },
};

/** Query de GET /customers. */
export const customerQuerySchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 255 },
    active_only: { type: 'string', enum: ['true', 'false'] },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    offset: { type: 'integer', minimum: 0 },
  },
};

/** Body de POST /customers (RF-VE-005). */
export const customerCreateBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    description: { type: ['string', 'null'], maxLength: 500 },
    phone: { type: ['string', 'null'], maxLength: 20 },
    email: { type: ['string', 'null'], maxLength: 255 },
    address: { type: ['string', 'null'], maxLength: 500 },
    rfc: { type: ['string', 'null'], maxLength: 13 },
    credit_limit: { type: 'number', minimum: 0 },
    is_active: { type: 'boolean' },
  },
};

/** Body de PATCH /customers/:id — mismos campos, todos opcionales. */
export const customerUpdateBodySchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: customerCreateBodySchema.properties,
};

/** Parámetros de body para POST /customers/:id/credit (RF-VE-005). */
export const creditAdjustmentBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['customer_id', 'amount', 'reason'],
  additionalProperties: false,
  properties: {
    customer_id: { type: 'string', minLength: 1 },
    amount: { type: 'number' },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
};

/** Parámetros de body para POST /customers/:id/payment (RF-VE-005). */
export const creditPaymentBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['customer_id', 'amount', 'reason'],
  additionalProperties: false,
  properties: {
    customer_id: { type: 'string', minLength: 1 },
    amount: { type: 'number' },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
};

/** Respuesta de crédito (nuevo balance). */
export const customerCreditResponseSchema: ApiDataSchema = {
  type: 'object',
  required: ['new_balance', 'exceeded_limit', 'message'],
  additionalProperties: false,
  properties: {
    new_balance: { type: 'number' },
    exceeded_limit: { type: 'boolean' },
    message: { type: 'string' },
  },
}
