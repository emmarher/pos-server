/**
 * src/modules/customers/customers.routes.ts — Rutas del módulo clientes y crédito (RF-VE-005).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Endpoints:
 *   GET  /customers             listado de clientes (RF-VE-005, permiso: customers:read)
 *   POST /customers             crear cliente (permiso: customers:manage)
 *   GET  /customers/:id         detalle con balance (RF-VE-005, permiso: customers:read)
 *   PATCH /customers/:id        actualizar cliente (permiso: customers:manage)
 *   POST /customers/:id/credit  cargo o abono al crédito (RF-VE-005, permiso: customers:manage)
 *   POST /customers/:id/payment pago a crédito (RF-VE-005, permiso: customers:manage)
 *
 * El tenant sale del JWT (request.user.tenant_id) — nunca del body/query.
 * ────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, requirePermission } from '../../middleware/auth.js'
import { okEnvelope, okEnvelopeSchema } from '../../types/response.js'
import {
  customerSchema,
  customerListResultSchema,
  customerQuerySchema,
  customerCreateBodySchema,
  customerUpdateBodySchema,
  creditAdjustmentBodySchema,
  creditPaymentBodySchema,
  customerCreditResponseSchema,
} from './customers.schema.js'
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  checkCredit,
  makeCreditAdjustment,
  makeCreditPayment,
} from './customers.service.js'

/** Auth JWT: todo handler lee el tenant desde aquí. */
type AuthedRequest = FastifyRequest & {
  user: { tenant_id: string; sub: string }
}

/** Plugin Fastify que registra las rutas de clientes. */
export function customersRoutes(app: FastifyInstance): void {
  /* ── GET /customers ──────────────────────────────────────────────────── */
  app.get(
    '/customers',
    {
      preHandler: [authenticate, requirePermission('customers:read')],
      schema: {
        querystring: customerQuerySchema,
        response: { 200: okEnvelopeSchema(customerListResultSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const query = request.query as {
        q?: string
        activeOnly?: string
        limit?: number
        offset?: number
      }
      const result = await listCustomers(request.user.tenant_id, {
        q: query.q,
        activeOnly: query.activeOnly === undefined ? true : query.activeOnly === 'true',
        limit: query.limit,
        offset: query.offset,
      })
      return okEnvelope(result, 'Clientes encontrados', 200)
    },
  )

  /* ── POST /customers ────────────────────────────────────────────────── */
  app.post(
    '/customers',
    {
      preHandler: [authenticate, requirePermission('customers:manage')],
      schema: {
        body: customerCreateBodySchema,
        response: { 200: okEnvelopeSchema(customerSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const customer = await createCustomer(
        request.user.tenant_id,
        request.body as CustomerInput,
      )
      return okEnvelope(customer, 'Cliente creado', 200)
    },
  )

  /* ── GET /customers/:id ─────────────────────────────────────────────── */
  app.get(
    '/customers/:id',
    {
      preHandler: [authenticate, requirePermission('customers:read')],
      schema: {
        params: { id: { type: 'string', minLength: 1 } },
        response: { 200: okEnvelopeSchema(customerSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const customer = await getCustomer(request.user.tenant_id, id)
      return okEnvelope(customer, 'Cliente encontrado', 200)
    },
  )

  /* ── PATCH /customers/:id ────────────────────────────────────────────── */
  app.patch(
    '/customers/:id',
    {
      preHandler: [authenticate, requirePermission('customers:manage')],
      schema: {
        params: { id: { type: 'string', minLength: 1 } },
        body: customerUpdateBodySchema,
        response: { 200: okEnvelopeSchema(customerSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const customer = await updateCustomer(
        request.user.tenant_id,
        id,
        request.body as Partial<CustomerInput>,
      )
      return okEnvelope(customer, 'Cliente actualizado', 200)
    },
  )

  /* ── POST /customers/:id/credit ──────────────────────────────────────── */
  app.post(
    '/customers/:id/credit',
    {
      preHandler: [authenticate, requirePermission('customers:manage')],
      schema: {
        params: { id: { type: 'string', minLength: 1 } },
        body: creditAdjustmentBodySchema,
        response: { 200: okEnvelopeSchema(customerCreditResponseSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const result = await makeCreditAdjustment(
        { tenant_id: request.user.tenant_id, user_id: request.user.sub },
        request.body as CustomerCreditAdjustment,
      )
      return okEnvelope(result, 'Ajuste de crédito registrado', 200)
    },
  )

  /* ── POST /customers/:id/payment ─────────────────────────────────────── */
  app.post(
    '/customers/:id/payment',
    {
      preHandler: [authenticate, requirePermission('customers:manage')],
      schema: {
        params: { id: { type: 'string', minLength: 1 } },
        body: creditPaymentBodySchema,
        response: { 200: okEnvelopeSchema(customerCreditResponseSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const result = await makeCreditPayment(
        { tenant_id: request.user.tenant_id, user_id: request.user.sub },
        request.body as CustomerPaymentPayload,
      )
      return okEnvelope(result, 'Pago a crédito registrado', 200)
    },
  )
}