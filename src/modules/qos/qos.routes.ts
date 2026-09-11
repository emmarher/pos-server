/**
 * src/modules/qos/qos.routes.ts — Rutas de QoS (RF-QS).
 *
 * POST /service-quality/:id   responde la encuesta (RF-QS-002)
 * GET  /service-quality/pending   eventos pendientes para la tablet
 * Permiso: qos:manage.
 */
import type { FastifyInstance } from 'fastify'
import type { FastifyRequest } from 'fastify'
import { authenticate, requirePermission } from '../../middleware/auth.js'
import { okEnvelope, okEnvelopeSchema, type ApiDataSchema } from '../../types/response.js'
import { submitQosResponse, listPendingQos } from './qos.service.js'

type AuthedRequest = FastifyRequest & { user: { tenant_id: string; sub: string } }

const qosEventSchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    sale_id: { type: 'string' },
    rating: { type: ['string', 'null'] },
    comment: { type: ['string', 'null'] },
    status: { type: 'string' },
    responded_at: { type: ['string', 'null'] },
  },
}

/** Plugin Fastify con las rutas de QoS. */
export function qosRoutes(app: FastifyInstance): void {
  /* ── GET /service-quality/pending ──────────────────────────────────── */
  app.get(
    '/service-quality/pending',
    {
      preHandler: [authenticate, requirePermission('qos:manage')],
      schema: { response: { 200: okEnvelopeSchema({ type: 'array', items: qosEventSchema }) } },
    },
    async (request: AuthedRequest) => {
      const events = await listPendingQos(request.user.tenant_id)
      return okEnvelope(events, 'Encuestas pendientes', 200)
    },
  )

  /* ── POST /service-quality/:id ─────────────────────────────────────── */
  app.post(
    '/service-quality/:id',
    {
      preHandler: [authenticate, requirePermission('qos:manage')],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: { id: { type: 'string', minLength: 1 } },
        },
        body: {
          type: 'object',
          required: ['rating'],
          additionalProperties: false,
          properties: {
            rating: { type: 'string', enum: ['EXCELLENT', 'GOOD', 'AVERAGE', 'POOR', 'TERRIBLE'] },
            comment: { type: 'string', maxLength: 1000 },
          },
        },
        response: { 200: okEnvelopeSchema(qosEventSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const body = request.body as {
        rating: 'EXCELLENT' | 'GOOD' | 'AVERAGE' | 'POOR' | 'TERRIBLE'
        comment?: string
      }
      const event = await submitQosResponse(request.user.tenant_id, id, body.rating, body.comment)
      return okEnvelope(event, 'Calificación registrada', 200)
    },
  )
}