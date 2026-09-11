/**
 * src/modules/reports/reports.routes.ts — Rutas de reportes (RF-PR).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Endpoints:
 *   GET /reports/quick-stats    — totales de ventas (permiso reports:read)
 *   GET /reports/sales-history  — historial con filtros (permiso reports:read)
 * El Vendedor no tiene reports:read → 403 (y el frontend oculta la pestaña).
 * ────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from 'fastify'
import type { FastifyRequest } from 'fastify'
import { authenticate, requirePermission } from '../../middleware/auth.js'
import { okEnvelope, okEnvelopeSchema, type ApiDataSchema } from '../../types/response.js'
import { quickStats, salesHistory } from './reports.service.js'

type AuthedRequest = FastifyRequest & { user: { tenant_id: string; sub: string } }

/** Schema de una venta del historial. */
const saleHistoryItemSchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    folio: { type: 'string' },
    seller_id: { type: ['string', 'null'] },
    seller_name: { type: ['string', 'null'] },
    customer_name: { type: ['string', 'null'] },
    subtotal: { type: 'number' },
    discount: { type: 'number' },
    tax: { type: 'number' },
    total: { type: 'number' },
    payment_state: { type: 'string' },
    created_at: { type: 'string' },
  },
}

const salesHistorySchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: saleHistoryItemSchema },
    total: { type: 'integer' },
  },
}

/** Schema del data de /reports/quick-stats. */
const quickStatsSchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    today: {
      type: 'object',
      additionalProperties: false,
      properties: {
        total_sales: { type: 'number' },
        transactions: { type: 'number' },
        average_ticket: { type: 'number' },
      },
    },
    yesterday: {
      type: 'object',
      additionalProperties: false,
      properties: {
        total_sales: { type: 'number' },
        transactions: { type: 'number' },
      },
    },
    by_payment_method: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          method: { type: 'string' },
          total: { type: 'number' },
          count: { type: 'number' },
        },
      },
    },
    by_category: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category_id: { type: ['string', 'null'] },
          category_name: { type: ['string', 'null'] },
          total: { type: 'number' },
        },
      },
    },
  },
}

/** Plugin Fastify con las rutas de reportes. */
export function reportsRoutes(app: FastifyInstance): void {
  /* ── GET /reports/quick-stats ─────────────────────────────────────── */
  app.get(
    '/reports/quick-stats',
    {
      preHandler: [authenticate, requirePermission('reports:read')],
      schema: {
        response: { 200: okEnvelopeSchema(quickStatsSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const stats = await quickStats(request.user.tenant_id)
      return okEnvelope(stats, 'Estadísticas rápidas', 200)
    },
  )

  /* ── GET /reports/sales-history ───────────────────────────────────── */
  app.get(
    '/reports/sales-history',
    {
      preHandler: [authenticate, requirePermission('reports:read')],
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            seller_id: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
        response: { 200: okEnvelopeSchema(salesHistorySchema) },
      },
    },
    async (request: AuthedRequest) => {
      const q = request.query as {
        from?: string
        to?: string
        seller_id?: string
        limit?: number
        offset?: number
      }
      const history = await salesHistory(request.user.tenant_id, q)
      return okEnvelope(history, 'Historial de ventas', 200)
    },
  )
}
