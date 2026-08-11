/**
 * src/middleware/auth.ts — Autenticación y permisos por endpoint.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Dos piezas:
 *   1) `authenticate`     — verifica el JWT y revalida la licencia del
 *                           tenant en CADA request (licencia vencida =
 *                           bloqueo total, RF-AU-003). Adjunta el payload
 *                           tipado en request.user.
 *   2) `requirePermission`— preHandler factory: exige un permiso del rol.
 *                           El payload ya trae `permissions` resuelto en
 *                           el login, así no se toca la BD por request.
 *
 * REGLA MULTI-TENANT:
 *   - request.user.tenant_id es la ÚNICA fuente del tenant. Nunca se
 *     acepta tenant_id del body/query del cliente.
 * ────────────────────────────────────────────────────────────────────────
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../database/client.js'
import type { AuthJwtPayload } from '../types/auth.js'
import { HttpError } from '../types/errors.js'

/** Firma de un preHandler de Fastify (async). */
type PreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>

/**
 * Verifica el Bearer token y revalida licencia activa del tenant.
 * Uso: `app.addHook('preHandler', authenticate)` o por ruta.
 */
export const authenticate: PreHandler = async (request) => {
  // jwtVerify lanza si falta/es inválido/expirado (→ 401 por error handler)
  const payload = await request.jwtVerify<AuthJwtPayload>()

  // Revalidación de licencia por request (bloqueo total si venció).
  const { rows } = await db.query<{
    is_active: number
    license_expires_at: string
  }>('SELECT is_active, license_expires_at FROM tenants WHERE id = $1', [
    payload.tenant_id,
  ])

  const tenant = rows[0]
  const now = new Date()
  const expired =
    !tenant ||
    tenant.is_active !== 1 ||
    new Date(tenant.license_expires_at).getTime() <= now.getTime()

  if (expired) {
    throw new HttpError(
      'LICENSE_EXPIRED',
      'Licencia vencida. Contacte a soporte.',
    )
  }

  // Adjunta el payload tipado; las rutas leen request.user.tenant_id
  request.user = payload
}

/**
 * Factory de preHandler que exige un permiso (código del PRD).
 * Ej: `{ preHandler: [authenticate, requirePermission('sales:cancel')] }`
 */
export function requirePermission(code: string): PreHandler {
  return (request) => {
    const permissions = request.user?.permissions ?? []
    if (!permissions.includes(code)) {
      return Promise.reject(new HttpError('FORBIDDEN', `Permiso requerido: ${code}`))
    }
    return Promise.resolve()
  }
}
