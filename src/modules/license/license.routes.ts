/**
 * src/modules/license/license.routes.ts — Rutas de licencias (admin-operated).
 *
 * ─────────────────────────────────────────────────────────────────────
 * Endpoints:
 *   POST /license/upload  — admin sube un .lic nuevo (renovación/ampliación)
 *   GET  /license/status  — estado actual de la licencia (para la UI)
 *   POST /auth/heartbeat  — mantiene asientos activos (heartbeat 30s + TTL 90s)
 *
 * POST /license/upload requiere `settings:manage` (solo administrador).
 * La verificación de firma se hace en license.service.ts (verifyLicenseSignature).
 * ─────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, requirePermission } from '../../middleware/auth.js'
import { okEnvelope, okEnvelopeSchema } from '../../types/response.js'
import type { AuthJwtPayload } from '../../types/auth.js'
import { licenseInfoSchema, uploadLicenseBodySchema } from './license.schema.js'
import { uploadLicense, getLicenseStatus, recordHeartbeat } from './license.service.js'

type AuthedRequest = FastifyRequest & { user: AuthJwtPayload }

/** Plugin Fastify que registra las rutas de licencia. */
export function licenseRoutes(app: FastifyInstance): void {
  /* ── POST /license/upload (RF-AU: renovación/ampliación vía admin) ────── */
  app.post(
    '/license/upload',
    {
      preHandler: [authenticate, requirePermission('settings:manage')],
      schema: {
        body: uploadLicenseBodySchema,
        response: {
          200: okEnvelopeSchema(licenseInfoSchema),
        },
      },
    },
    async (request: AuthedRequest) => {
      const body = request.body as { license_data: string }
      const result = await uploadLicense(body.license_data, request.user.tenant_id)
      return okEnvelope(result, 'Licencia actualizada', 200)
    },
  )

  /* ── GET /license/status (estado para la UI) ──────────────────────────── */
  app.get(
    '/license/status',
    {
      preHandler: [authenticate],
      schema: {
        response: {
          200: okEnvelopeSchema(licenseInfoSchema),
        },
      },
    },
    async (request: AuthedRequest) => {
      const status = await getLicenseStatus(request.user.tenant_id)
      return okEnvelope(status, 'Estado de licencia', 200)
    },
  )

  /* ── POST /auth/heartbeat (RF-AU-004: mantiene asientos activos) ──────── */
  app.post(
    '/auth/heartbeat',
    {
      preHandler: [authenticate],
    },
    async (request: AuthedRequest) => {
      // El admin está exento (is_heartbeat_exempt=1); el heartbeat sigue
      // funcionando igual para mantener la sesión viva.
      await recordHeartbeat(request.user.device_id, request.user.tenant_id)
      return okEnvelope({ heartbeat: true }, 'Heartbeat registrado', 200)
    },
  )
}
