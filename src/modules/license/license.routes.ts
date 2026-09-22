/**
 * src/modules/license/license.routes.ts — Rutas de licencias (admin-operated).
 *
 * ─────────────────────────────────────────────────────────────────────
 * Endpoints:
 *   POST /license/upload  — admin sube un .lic nuevo (renovación/ampliación) | bootstrap-aware sin auth si falta licencia
 *   POST /license/trial   — emite trial 1 día firmado server-side (familia trial aislada) | bootstrap-aware
 *   GET  /license/status  — estado actual de la licencia (público: 404 NO_LICENSE si falta)
 *   POST /auth/heartbeat  — mantiene asientos activos (heartbeat 30s + TTL 90s)
 *
 * POST /license/upload en flujo normal requiere `settings:manage`; en bootstrap (sin licencia válida)
 * se permite sin JWT para que el wizard de primer arranque pueda activar el servidor.
 * La verificación de firma (main + trial) se hace en license.service.ts.
 * ─────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, requirePermission } from '../../middleware/auth.js'
import { okEnvelope, okEnvelopeSchema } from '../../types/response.js'
import type { AuthJwtPayload } from '../../types/auth.js'
import { licenseInfoSchema, uploadLicenseBodySchema } from './license.schema.js'
import { uploadLicense, getLicenseStatus, recordHeartbeat, isBootstrapNeeded, issueTrialLicense } from './license.service.js'
import { HttpError } from '../../types/errors.js'
import { db } from '../../database/client.js'

type AuthedRequest = FastifyRequest & { user: AuthJwtPayload }

/** Intenta verificar JWT si viene Authorization; no lanza si falta (modo bootstrap). */
async function tryAuth(request: FastifyRequest): Promise<AuthJwtPayload | null> {
  const auth = request.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return null
  try {
    const payload = await request.jwtVerify<AuthJwtPayload>()
    // attach for downstream requirePermission checks
    ;(request as AuthedRequest).user = payload
    return payload
  } catch {
    return null
  }
}

async function resolveBootstrapTenantId(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM tenants WHERE is_active = 1 LIMIT 1',
  )
  if (rows[0]?.id) return rows[0].id
  const any = await db.query<{ id: string }>('SELECT id FROM tenants LIMIT 1')
  if (any.rows[0]?.id) return any.rows[0].id
  throw new HttpError('NOT_FOUND', 'No hay tenant configurado para boot')
}

/** Plugin Fastify que registra las rutas de licencia. */
export function licenseRoutes(app: FastifyInstance): void {
  /* ── POST /license/upload (RF-AU: renovación/ampliación vía admin | bootstrap-aware) ── */
  app.post(
    '/license/upload',
    {
      schema: {
        body: uploadLicenseBodySchema,
        response: {
          200: okEnvelopeSchema(licenseInfoSchema),
        },
      },
    },
    async (request) => {
      const body = request.body as { license_data: string }
      if (!body?.license_data) throw new HttpError('VALIDATION', 'license_data requerido')
      const authed = await tryAuth(request)
      if (authed) {
        // Flujo autenticado: exigir permiso salvo que estemos en bootstrap (permite primer admin)
        const bootstrap = await isBootstrapNeeded()
        if (!bootstrap) {
          const perms = authed.permissions ?? []
          if (!perms.includes('settings:manage')) {
            throw new HttpError('FORBIDDEN', 'Permiso requerido: settings:manage')
          }
        }
        const result = await uploadLicense(body.license_data, authed.tenant_id)
        return okEnvelope(result, 'Licencia actualizada', 200)
      }
      // Flujo bootstrap sin JWT
      const bootstrap = await isBootstrapNeeded()
      if (!bootstrap) throw new HttpError('UNAUTHORIZED', 'Autenticación requerida')
      const tenantId = await resolveBootstrapTenantId()
      const result = await uploadLicense(body.license_data, tenantId)
      return okEnvelope(result, 'Licencia actualizada (bootstrap)', 200)
    },
  )

  /* ── POST /license/trial — emite trial 1 día (familia aislada) ─────────── */
  app.post(
    '/license/trial',
    {
      schema: {
        response: {
          200: okEnvelopeSchema(licenseInfoSchema),
        },
      },
    },
    async (request) => {
      const authed = await tryAuth(request)
      const tenantId = authed?.tenant_id ?? (await (async () => {
        const bootstrap = await isBootstrapNeeded()
        if (!bootstrap && !authed) throw new HttpError('UNAUTHORIZED', 'Autenticación requerida')
        return resolveBootstrapTenantId()
      })())
      const result = await issueTrialLicense(tenantId)
      return okEnvelope(result, 'Trial emitido (1 día)', 200)
    },
  )

  /* ── GET /license/status (público; 404 NO_LICENSE si falta) ────────────── */
  app.get(
    '/license/status',
    {
      schema: {
        response: {
          200: okEnvelopeSchema(licenseInfoSchema),
        },
      },
    },
    async (request) => {
      const authed = await tryAuth(request)
      let tenantId: string | null = authed?.tenant_id ?? null
      if (!tenantId) {
        const { rows } = await db.query<{ id: string }>(
          'SELECT id FROM tenants WHERE is_active = 1 LIMIT 1',
        )
        if (rows[0]?.id) tenantId = rows[0].id
        else {
          const any = await db.query<{ id: string }>('SELECT id FROM tenants LIMIT 1')
          tenantId = any.rows[0]?.id ?? null
        }
      }
      if (!tenantId) {
        throw new HttpError('NO_LICENSE', 'Sin licencia')
      }
      const status = await getLicenseStatus(tenantId)
      const hasLicense = status.lic_id !== null || status.expires_at !== ''
      if (!hasLicense) {
        throw new HttpError('NO_LICENSE', 'Sin licencia')
      }
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
