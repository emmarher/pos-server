/**
 * src/modules/sales/sales.routes.ts — Rutas de ventas (RF-VE).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Endpoints (contrato con pos-mobile):
 *   POST /sales        crear venta (sales:create) — transacción atómica
 *   GET  /sales/:id    detalle con ítems y pagos (sales:read_own)
 *
 * SEGURIDAD: TODAS usan [authenticate, requirePermission(...)]. El tenant
 * sale del JWT (request.user.tenant_id) — nunca del body/query. El
 * seller_id y device_id también vienen del JWT (sub y device_id).
 * ────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, requirePermission } from '../../middleware/auth.js'
import { okEnvelope, okEnvelopeSchema } from '../../types/response.js'
import type { AuthJwtPayload } from '../../types/auth.js'
import type { CreateSalePayload } from '../../types/sales.js'
import {
  cancelSaleBodySchema,
  createSaleBodySchema,
  idParamsSchema,
  saleDetailSchema,
  salesListSchema,
  saleResponseSchema,
  storedTicketSchema,
} from './sales.schema.js'
import { cancelSale, createSale, getSale, getTicket, listSales } from './sales.service.js'

/** Request autenticado: el JWT trae tenant_id, sub (seller) y device_id. */
type AuthedRequest = FastifyRequest & { user: AuthJwtPayload }

/** Plugin Fastify que registra las rutas del módulo de ventas. */
export function salesRoutes(app: FastifyInstance): void {
  /* ── POST /sales (RF-VE-002: venta transaccional) ──────────────────── */
  app.post(
    '/sales',
    {
      preHandler: [authenticate, requirePermission('sales:create')],
      schema: {
        body: createSaleBodySchema,
        response: { 200: okEnvelopeSchema(saleResponseSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const sale = await createSale(
        {
          tenant_id: request.user.tenant_id,
          seller_id: request.user.sub,
          device_id: request.user.device_id,
        },
        request.body as CreateSalePayload,
      )
      return okEnvelope(sale, `Venta ${sale.folio} registrada`, 200)
    },
  )

  /* ── GET /sales/:id (detalle con ítems y pagos) ────────────────────── */
  app.get(
    '/sales/:id',
    {
      preHandler: [authenticate, requirePermission('sales:read_own')],
      schema: {
        params: idParamsSchema,
        response: { 200: okEnvelopeSchema(saleDetailSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const sale = await getSale(request.user.tenant_id, id)
      return okEnvelope(sale, `Venta ${sale.folio} encontrada`, 200)
    },
  )

  /* ── GET /sales (listado para "mis tickets", RF-VE-006) ──────────────── */
  app.get(
    '/sales',
    {
      preHandler: [authenticate, requirePermission('sales:read_own')],
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
        response: { 200: okEnvelopeSchema(salesListSchema) },
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
      // Si el usuario solo tiene sales:read_own (no read_all), filtra por su seller_id
      const hasReadAll = request.user.permissions.includes('sales:read_all')
      const sellerId = !hasReadAll ? request.user.sub : q.seller_id
      const history = await listSales(request.user.tenant_id, {
        from: q.from,
        to: q.to,
        seller_id: sellerId,
        limit: q.limit,
        offset: q.offset,
      })
      return okEnvelope(history, 'Listado de ventas', 200)
    },
  )

  /* ── GET /sales/:id/ticket (reimpresión de ticket almacenado) ────────── */
  app.get(
    '/sales/:id/ticket',
    {
      preHandler: [authenticate, requirePermission('sales:read_own')],
      schema: {
        params: idParamsSchema,
        response: { 200: okEnvelopeSchema(storedTicketSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const ticket = await getTicket(request.user.tenant_id, id)
      return okEnvelope(ticket, `Ticket de ${ticket.ticket_type}`, 200)
    },
  )

  /* ── POST /sales/:id/cancel (RF-VE-006: cancelación) ───────────────── */
  app.post(
    '/sales/:id/cancel',
    {
      preHandler: [authenticate, requirePermission('sales:cancel')],
      schema: {
        params: idParamsSchema,
        body: cancelSaleBodySchema,
        response: { 200: okEnvelopeSchema(saleResponseSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const body = request.body as { reason: string }
      const sale = await cancelSale(
        {
          tenant_id: request.user.tenant_id,
          seller_id: request.user.sub,
          device_id: request.user.device_id,
        },
        id,
        body.reason,
      )
      return okEnvelope(sale, `Venta ${sale.folio} cancelada`, 200)
    },
  )
}
