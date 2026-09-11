/**
 * src/modules/scale/scale.routes.ts — Rutas de báscula delegada (RF-BA).
 *
 * POST /device/heartbeat   UPSERT device_status (RF-BA-002)
 * GET  /scale/current      último peso cacheado (RF-BA-003)
 * Permiso: scale:read (Admin y Vendedor).
 */
import type { FastifyInstance } from 'fastify'
import type { FastifyRequest } from 'fastify'
import { authenticate, requirePermission } from '../../middleware/auth.js'
import { okEnvelope, okEnvelopeSchema, type ApiDataSchema } from '../../types/response.js'
import { upsertHeartbeat, getCurrentWeight } from './scale.service.js'

type AuthedRequest = FastifyRequest & { user: { tenant_id: string; sub: string } }

/** Schema del data de device_status / peso. */
const deviceStatusSchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    device_id: { type: 'string' },
    tenant_id: { type: 'string' },
    is_online: { type: 'integer' },
    last_heartbeat: { type: 'string' },
    current_scale_weight: { type: ['number', 'null'] },
    scale_unit: { type: ['string', 'null'] },
    scale_is_stable: { type: 'integer' },
    updated_at: { type: 'string' },
  },
}

/** Plugin Fastify con las rutas de báscula. */
export function scaleRoutes(app: FastifyInstance): void {
  /* ── POST /device/heartbeat ────────────────────────────────────────── */
  app.post(
    '/device/heartbeat',
    {
      preHandler: [authenticate, requirePermission('scale:read')],
      schema: {
        body: {
          type: 'object',
          required: ['device_id'],
          additionalProperties: false,
          properties: {
            device_id: { type: 'string', minLength: 1 },
            current_scale_weight: { type: ['number', 'null'] },
            scale_unit: { type: 'string' },
            scale_is_stable: { type: 'boolean' },
            app_version: { type: 'string' },
            battery_level: { type: 'integer' },
          },
        },
        response: { 200: okEnvelopeSchema(deviceStatusSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const body = request.body as {
        device_id: string
        current_scale_weight?: number | null
        scale_unit?: string
        scale_is_stable?: boolean
        app_version?: string
        battery_level?: number
      }
      const status = await upsertHeartbeat(request.user.tenant_id, body)
      return okEnvelope(status, 'Heartbeat registrado', 200)
    },
  )

  /* ── GET /scale/current ────────────────────────────────────────────── */
  app.get(
    '/scale/current',
    {
      preHandler: [authenticate, requirePermission('scale:read')],
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { device_id: { type: 'string', minLength: 1 } },
        },
        response: { 200: okEnvelopeSchema(deviceStatusSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { device_id } = request.query as { device_id: string }
      const status = await getCurrentWeight(request.user.tenant_id, device_id)
      if (!status) {
        return okEnvelope(null, 'Sin peso registrado', 200)
      }
      return okEnvelope(status, 'Peso actual', 200)
    },
  )
}