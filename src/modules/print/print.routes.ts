/**
 * src/modules/print/print.routes.ts — Rutas de impresión delegada (RF-IM).
 *
 * POST  /print-jobs                    encolar (RF-IM-002)
 * GET   /print-jobs?target_device_id   poll del dispositivo con impresora
 * PATCH /print-jobs/:id                marcar PRINTING/COMPLETED/FAILED
 * Permiso: print:delegate (lo tiene Admin y Vendedor según PRD).
 */
import type { FastifyInstance } from 'fastify'
import type { FastifyRequest } from 'fastify'
import { authenticate, requirePermission } from '../../middleware/auth.js'
import { errorEnvelope, okEnvelope, okEnvelopeSchema, type ApiDataSchema } from '../../types/response.js'
import {
  enqueuePrint,
  listPendingPrints,
  updatePrintStatus,
  type PrintJobRow,
} from './print.service.js'
import { subscribePrintJobs } from './print-events.js'

type AuthedRequest = FastifyRequest & { user: { tenant_id: string; sub: string } }

/** Schema de un trabajo de impresión (data de las respuestas). */
const printJobSchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tenant_id: { type: 'string' },
    source_device_id: { type: 'string' },
    target_device_id: { type: 'string' },
    sale_id: { type: ['string', 'null'] },
    cashier_cut_id: { type: ['string', 'null'] },
    job_type: { type: 'string' },
    content: { type: 'string' },
    status: { type: 'string' },
    retry_count: { type: 'integer' },
    max_retries: { type: 'integer' },
    error_message: { type: ['string', 'null'] },
    printed_at: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
}

const printJobListSchema: ApiDataSchema = { type: 'array', items: printJobSchema }

/** Plugin Fastify con las rutas de impresión delegada. */
export function printRoutes(app: FastifyInstance): void {
  /* ── POST /print-jobs — encolar (RF-IM-002) ───────────────────────── */
  app.post(
    '/print-jobs',
    {
      preHandler: [authenticate, requirePermission('print:delegate')],
      schema: {
        body: {
          type: 'object',
          required: ['content'],
          additionalProperties: false,
          properties: {
            target_device_id: { type: 'string', minLength: 1 },
            content: { type: 'string', minLength: 1 },
            job_type: { type: 'string', enum: ['SALE_TICKET', 'CUT_TICKET', 'TEST', 'Z_REPORT'] },
            sale_id: { type: ['string', 'null'] },
            source_device_id: { type: 'string' },
          },
        },
        response: { 200: okEnvelopeSchema(printJobSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const body = request.body as {
        target_device_id: string
        content: string
        job_type?: 'SALE_TICKET' | 'CUT_TICKET' | 'TEST' | 'Z_REPORT'
        sale_id?: string | null
        source_device_id?: string
      }
      const job = await enqueuePrint(request.user.tenant_id, request.user.sub, body)
      return okEnvelope(job, 'Trabajo de impresión encolado', 200)
    },
  )

  /* ── GET /print-jobs/stream — SSE (push en tiempo real) ───────────── */
  app.get(
    '/print-jobs/stream',
    {
      preHandler: [authenticate, requirePermission('print:delegate')],
      schema: {
        querystring: {
          type: 'object',
          required: ['target_device_id'],
          additionalProperties: false,
          properties: { target_device_id: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: AuthedRequest, reply) => {
      const { target_device_id: targetDeviceId } = request.query as {
        target_device_id: string
      }
      if (!targetDeviceId) {
        return reply.code(400).send(errorEnvelope('target_device_id requerido', 400))
      }

      // Respuesta cruda: el stream queda abierto hasta que el cliente corte.
      reply.hijack()
      const raw = reply.raw
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        // Evita buffering en proxies intermedios.
        'X-Accel-Buffering': 'no',
      })

      const send = (event: string, data: unknown) => {
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      // Recuperación: jobs pendientes antes de conectar.
      const pending = await listPendingPrints(
        request.user.tenant_id,
        targetDeviceId,
        'PENDING',
      )
      send('ready', { pending: pending.length })
      for (const job of pending) send('job', job)

      const unsubscribe = subscribePrintJobs(
        request.user.tenant_id,
        targetDeviceId,
        job => send('job', job),
      )
      // Latido para mantener viva la conexión y detectar cortes.
      const heartbeat = setInterval(() => raw.write(': ping\n\n'), 15000)

      request.raw.on('close', () => {
        clearInterval(heartbeat)
        unsubscribe()
        raw.end()
      })
    },
  )

  /* ── GET /print-jobs — poll del dispositivo con impresora ─────────── */
  app.get(
    '/print-jobs',
    {
      preHandler: [authenticate, requirePermission('print:delegate')],
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target_device_id: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: ['PENDING', 'FAILED'] },
          },
        },
        response: { 200: okEnvelopeSchema(printJobListSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const q = request.query as { target_device_id: string; status?: 'PENDING' | 'FAILED' }
      if (!q.target_device_id) {
        return okEnvelope<PrintJobRow[]>([], 'Sin trabajos', 200)
      }
      const jobs = await listPendingPrints(request.user.tenant_id, q.target_device_id, q.status ?? 'PENDING')
      return okEnvelope(jobs, 'Trabajos de impresión', 200)
    },
  )

  /* ── PATCH /print-jobs/:id — actualizar estado ────────────────────── */
  app.patch(
    '/print-jobs/:id',
    {
      preHandler: [authenticate, requirePermission('print:delegate')],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: { id: { type: 'string', minLength: 1 } },
        },
        body: {
          type: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['PRINTING', 'COMPLETED', 'FAILED'] },
            error: { type: 'string' },
          },
        },
        response: { 200: okEnvelopeSchema(printJobSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const body = request.body as { status: 'PRINTING' | 'COMPLETED' | 'FAILED'; error?: string }
      const job = await updatePrintStatus(request.user.tenant_id, id, body.status, body.error)
      return okEnvelope(job, 'Trabajo de impresión actualizado', 200)
    },
  )
}