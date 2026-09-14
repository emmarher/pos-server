/**
 * src/app.ts — Construcción de la aplicación Fastify.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Qué hace este módulo:
 *   - `buildApp()` crea la instancia de Fastify con logger y config base.
 *   - Registra el endpoint de salud `/health` (lo usa el discovery del
 *     cliente para verificar conectividad).
 *   - Instala handlers de error/404 con el ENVOLTORIO DE RESPUESTA
 *     HOMOGÉNEO: { statusCode, message, data } — ver src/types/response.ts.
 *
 * REGLA DE RESPUESTAS:
 *   Toda ruta declara `schema.response` usando `okEnvelopeSchema(...)`
 *   (éxito) o `errorEnvelopeSchema` (error), y responde con los helpers
 *   `okEnvelope` / `errorEnvelope`. Así Fastify VALIDA la salida real
 *   contra el contrato antes de enviarla.
 *
 * Secciones:
 *   1) Schema del payload de /health (healthDataSchema)
 *   2) Plugin de salud (healthRoute)
 *   3) Constructor de la app (buildApp) — punto de entrada para tests
 *   4) Error handler global + not-found (helpers)
 * ────────────────────────────────────────────────────────────────────────
 */
import Fastify, {
  type FastifyInstance,
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import jwt from '@fastify/jwt'
import cors from '@fastify/cors'
import { env } from './config/env.js'
import { checkDatabase } from './database/client.js'
import { authRoutes } from './modules/auth/auth.routes.js'
import { inventoryRoutes } from './modules/inventory/inventory.routes.js'
import { productsRoutes } from './modules/products/products.routes.js'
import { salesRoutes } from './modules/sales/sales.routes.js'
import { cashierRoutes } from './modules/cashier/cashier.routes.js'
import { customersRoutes } from './modules/customers/customers.routes.js'
import { reportsRoutes } from './modules/reports/reports.routes.js'
import { printRoutes } from './modules/print/print.routes.js'
import { scaleRoutes } from './modules/scale/scale.routes.js'
import { qosRoutes } from './modules/qos/qos.routes.js'
import { registerDiscoveryRoutes } from './services/udp-discovery.js'
import { HttpError } from './types/errors.js'
import {
  errorEnvelope,
  okEnvelope,
  okEnvelopeSchema,
  type ApiDataSchema,
} from './types/response.js'
import type { ErrorCode } from './types/index.js'

/* ── 1) SCHEMA DEL PAYLOAD DE /health ────────────────────────────────── */

/** Schema JSON del `data` de /health (validado por Fastify en la salida). */
const healthDataSchema: ApiDataSchema = {
  type: 'object',
  required: ['status', 'service', 'db', 'version', 'timestamp'],
  additionalProperties: false,
  properties: {
    status: { enum: ['ok', 'degraded'] },
    service: { type: 'string' },
    db: { enum: ['up', 'down'] },
    version: { type: 'string' },
    timestamp: { type: 'string' },
  },
}

/* ── 2) PLUGIN DE SALUD ──────────────────────────────────────────────── */

/**
 * GET /health — usado por el cliente (pos-mobile) en el descubrimiento
 * para confirmar que el servidor responde ANTES de intentar login.
 * Incluye `db: up|down` para que la tablet muestre el estado real
 * (si PostgreSQL está caído, el POS no puede vender).
 */
function healthRoute(app: FastifyInstance): void {
  // Plugin SÍNCRONO a propósito: solo registra rutas. La ruta interna sí
  // es async porque consulta la base (checkDatabase → await).
  app.get(
    '/health',
    {
      schema: {
        // Contrato de respuesta: 200 OK y 503 degradado, ambos con el
        // envoltorio estándar { statusCode, message, data }.
        response: {
          200: okEnvelopeSchema(healthDataSchema),
          503: okEnvelopeSchema(healthDataSchema),
        },
      },
    },
    async (_req, reply) => {
      const db = await checkDatabase()
      const data = {
        status: db ? ('ok' as const) : ('degraded' as const),
        service: 'pos-server',
        db: db ? ('up' as const) : ('down' as const),
        version: '0.1.0',
        timestamp: new Date().toISOString(),
      }
      return reply
        .code(db ? 200 : 503)
        .send(okEnvelope(data, db ? 'Servidor operativo' : 'Base de datos no disponible', db ? 200 : 503))
    },
  )
}

/* ── 3) CONSTRUCTOR DE LA APP ────────────────────────────────────────── */

/**
 * Crea y devuelve la instancia de Fastify lista para `listen()` o para
 * tests (app.inject()). Cada módulo de negocio (auth, products, sales…)
 * se registrará aquí como plugin en las fases siguientes.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.logLevel,
    },
    // La API es local (LAN de sucursal); no hay CORS cross-origin real,
    // pero habilitarlo evita fricciones con herramientas de testing web.
    bodyLimit: 1024 * 1024, // 1 MB — los payloads de venta son pequeños
  })

  /* JWT: firma y verificación de access (24h) + refresh (30d) */
  void app.register(jwt, {
    secret: env.jwtSecret,
    sign: { expiresIn: env.jwtExpiresIn },
  })

  /* CORS habilitado (LAN local, sin orígenes restringidos por ahora) */
  void app.register(cors)

  /* Registro del healthcheck */
  void app.register(healthRoute)

  /* Módulos de negocio (cada fase agrega el suyo aquí) */
  void app.register(authRoutes)
  void app.register(productsRoutes)
  void app.register(salesRoutes)
  void app.register(inventoryRoutes)
  void app.register(cashierRoutes)
  void app.register(customersRoutes)
  void app.register(reportsRoutes)
  void app.register(printRoutes)
  void app.register(scaleRoutes)
  void app.register(qosRoutes)

  /* Rutas de utilidad del descubrimiento UDP (status/config) */
  void app.register(registerDiscoveryRoutes)

  /* Rutas no encontradas → envoltorio estándar con data: [] (404) */
  app.setNotFoundHandler((_req, reply) => {
    return reply
      .code(404)
      .send(errorEnvelope('Recurso no encontrado', 404))
  })

  /* Error handler global: responde SIEMPRE con el envoltorio estándar */
  app.setErrorHandler(
    (err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
      // Errores de dominio (HttpError): usan su propio status y código
      if (err instanceof HttpError) {
        return reply
          .code(err.statusCode)
          .send(errorEnvelope(err.message, err.statusCode))
      }

      const code = toErrorCode(err)
      const status = statusFor(code)
      let message = err.message || 'Error interno del servidor'

      // Los errores inesperados se loguean completo.
      // En dev/test se expone el mensaje real (p.ej. SQLITE_ERROR detalle) para
      // facilitar diagnóstico; en producción se enmascara por seguridad.
      if (status >= 500) {
        app.log.error({ err }, 'Error no manejado')
        const isDev = env.logLevel !== 'error' && process.env.NODE_ENV !== 'production'
        if (!isDev) {
          message = 'Error interno del servidor'
        } else if (err.message && err.message !== 'Error interno del servidor') {
          // Exponer detalle útil (p.ej. "no such table: tenants") manteniendo envoltorio
          message = err.message
        }
      }
      return reply.code(status).send(errorEnvelope(message, status))
    },
  )

  return app
}

/* ── 4) ERROR HANDLER GLOBAL (helpers) ───────────────────────────────── */

/** Mapea la clase del error a un código de dominio. */
function toErrorCode(err: unknown): ErrorCode {
  // Errores Fastify de validación/parseo del payload
  if (isFastifyError(err, 'FST_ERR_VALIDATION')) return 'VALIDATION_ERROR'
  if (isFastifyError(err, 'FST_ERR_CTP_INVALID_MEDIA_TYPE')) return 'VALIDATION_ERROR'
  if (isFastifyError(err, 'FST_ERR_CTP_INVALID_JSON_BODY')) return 'VALIDATION_ERROR'
  if (isFastifyError(err, 'FST_ERR_CTP_EMPTY_JSON_BODY')) return 'VALIDATION_ERROR'
  // Errores de JWT (token faltante, inválido o expirado)
  if (isFastifyError(err, 'FST_JWT_NO_AUTHORIZATION_IN_HEADER')) return 'UNAUTHORIZED'
  if (isFastifyError(err, 'FST_JWT_BAD_REQUEST')) return 'UNAUTHORIZED'
  if (isFastifyError(err, 'FST_JWT_AUTHORIZATION_TOKEN_INVALID')) return 'UNAUTHORIZED'
  if (isFastifyError(err, 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED')) return 'UNAUTHORIZED'
  // SQLite WAL: busy se mapea a CONFLICT (409) para reintento cliente
  if (isSqliteBusy(err)) return 'CONFLICT'
  if (isSqliteCheckViolation(err)) return 'INSUFFICIENT_STOCK'
  return 'INTERNAL'
}

/** HTTP status acorde al código de dominio. */
function statusFor(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401
    case 'FORBIDDEN':
    case 'LICENSE_EXPIRED':
    case 'DEVICE_LIMIT':
      return 403
    case 'NOT_FOUND':
      return 404
    case 'CONFLICT':
    case 'TENANT_MISMATCH':
      return 409
    case 'VALIDATION_ERROR':
      return 400
    case 'INSUFFICIENT_STOCK':
      return 422
    default:
      return 500
  }
}

function isSqliteBusy(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  const msg = (err as { message?: string })?.message ?? ''
  return code === 'SQLITE_BUSY' || msg.includes('database is locked') || msg.includes('database table is locked')
}

function isSqliteCheckViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  const msg = (err as { message?: string })?.message ?? ''
  return code === 'SQLITE_CONSTRAINT_CHECK' || code === 'SQLITE_CONSTRAINT' || msg.includes('CHECK constraint failed')
}

/** Comprueba si el error de Fastify tiene el code indicado. */
function isFastifyError(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === code
  )
}
