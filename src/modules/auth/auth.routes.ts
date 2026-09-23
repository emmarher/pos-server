/**
 * src/modules/auth/auth.routes.ts — Rutas de autenticación.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Endpoints (contrato con pos-mobile):
 *   POST /auth/login    — tenant_code + PIN + dispositivo → JWT + refresh
 *   POST /auth/refresh  — refresh_token → access token nuevo
 *
 * Ninguna de las dos usa `authenticate` (login/refresh no llevan token).
 * Toda OTRA ruta del servidor debe declarar:
 *   preHandler: [authenticate, requirePermission('modulo:accion')]
 *
 * Los errores se lanzan desde el service (HttpError) y el error handler
 * global de app.ts los convierte al envoltorio estándar. Fastify captura
 * los rejects de los handlers automáticamente.
 * ────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from 'fastify'
import { okEnvelope, okEnvelopeSchema } from '../../types/response.js'
import { changePin, login, refresh } from './auth.service.js'
import {
  authDataSchema,
  changePinBodySchema,
  changePinResultSchema,
  loginBodySchema,
  refreshBodySchema,
} from './auth.schema.js'

/** Plugin Fastify que registra las rutas de auth. */
export function authRoutes(app: FastifyInstance): void {
  /* ── POST /auth/login ─────────────────────────────────────────────── */
  app.post(
    '/auth/login',
    {
      schema: {
        body: loginBodySchema,
        response: {
          200: okEnvelopeSchema(authDataSchema),
        },
      },
    },
    async (request) => {
      const body = request.body as {
        tenant_code: string
        pin: string
        device_id: string
        device_name: string
        device_type: string
      }
      const data = await login(app, body)
      return okEnvelope(data, 'Inicio de sesión exitoso', 200)
    },
  )

  /* ── POST /auth/change-pin (F-I2b: PIN inicial obligatorio, sin JWT) ── */
  app.post(
    '/auth/change-pin',
    {
      schema: {
        body: changePinBodySchema,
        response: {
          200: okEnvelopeSchema(changePinResultSchema),
        },
      },
    },
    async (request) => {
      const body = request.body as {
        tenant_code: string
        pin: string
        new_pin: string
      }
      const data = await changePin(body)
      return okEnvelope(data, 'PIN actualizado. Inicia sesión con tu nuevo PIN.', 200)
    },
  )

  /* ── POST /auth/refresh ───────────────────────────────────────────── */
  app.post(
    '/auth/refresh',
    {
      schema: {
        body: refreshBodySchema,
        response: {
          200: okEnvelopeSchema(authDataSchema),
        },
      },
    },
    async (request) => {
      const body = request.body as { refresh_token: string }
      const data = await refresh(app, body.refresh_token)
      return okEnvelope(data, 'Sesión renovada', 200)
    },
  )
}
