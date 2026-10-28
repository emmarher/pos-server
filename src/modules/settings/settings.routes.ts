/**
 * settings.routes.ts — Configuración del comercio.
 *
 *   GET    /settings/tenant  — configuración + nombre resuelto (settings:manage)
 *   PATCH  /settings/tenant  — dirección/teléfono/pie de ticket, etc.
 *   POST   /settings/logo    — subir/reemplazar logo (multipart)
 *   DELETE /settings/logo    — quitar logo
 * El nombre de la tienda no se edita: viene de la licencia (D1).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import multipart from '@fastify/multipart'
import { authenticate, requirePermission } from '../../middleware/auth.js'
import { env } from '../../config/env.js'
import { HttpError } from '../../types/errors.js'
import {
  errorEnvelope,
  okEnvelope,
  okEnvelopeSchema,
  type ApiDataSchema,
} from '../../types/response.js'
import {
  getTenantSettings,
  removeMerchantLogo,
  saveMerchantLogo,
  updateTenantSettings,
  type TenantSettingsPatch,
} from './settings.service.js'

type AuthedRequest = FastifyRequest & { user: { tenant_id: string; sub: string } }

const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** `data` de GET/PATCH /settings/tenant. */
const tenantSettingsSchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    business_name: { type: ['string', 'null'] },
    display_name: { type: 'string' },
    address: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    rfc: { type: ['string', 'null'] },
    tax_rate: { type: 'number' },
    currency: { type: 'string' },
    ticket_header: { type: 'string' },
    receipt_footer: { type: ['string', 'null'] },
    logo_url: { type: ['string', 'null'] },
    timezone: { type: 'string' },
  },
}

/** `data` de las rutas de logo. */
const logoStateSchema: ApiDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { logo_url: { type: ['string', 'null'] } },
}

/** Plugin de configuración del negocio. */
export function settingsRoutes(app: FastifyInstance): void {
  // Multipart encapsulado: solo las rutas de logo lo necesitan.
  app.register(multipart, {
    limits: { fileSize: env.s3MaxFileSizeMb * 1024 * 1024 },
  })

  /* ── GET /settings/tenant ─────────────────────────────────────────── */
  app.get(
    '/settings/tenant',
    {
      preHandler: [authenticate, requirePermission('settings:manage')],
      schema: { response: { 200: okEnvelopeSchema(tenantSettingsSchema) } },
    },
    async (request: AuthedRequest) => {
      const settings = await getTenantSettings(request.user.tenant_id)
      return okEnvelope(settings, 'Configuración del comercio', 200)
    },
  )

  /* ── PATCH /settings/tenant ───────────────────────────────────────── */
  app.patch(
    '/settings/tenant',
    {
      preHandler: [authenticate, requirePermission('settings:manage')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            address: { type: ['string', 'null'], maxLength: 500 },
            phone: { type: ['string', 'null'], maxLength: 20 },
            email: { type: ['string', 'null'], maxLength: 255 },
            rfc: { type: ['string', 'null'], maxLength: 13 },
            tax_rate: { type: 'number', minimum: 0, maximum: 100 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            ticket_header: { type: ['string', 'null'], maxLength: 2000 },
            receipt_footer: { type: ['string', 'null'], maxLength: 2000 },
          },
        },
        response: { 200: okEnvelopeSchema(tenantSettingsSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const settings = await updateTenantSettings(
        request.user.tenant_id,
        request.body as TenantSettingsPatch,
      )
      return okEnvelope(settings, 'Configuración actualizada', 200)
    },
  )

  /* ── POST /settings/logo ──────────────────────────────────────────── */
  app.post(
    '/settings/logo',
    {
      preHandler: [authenticate, requirePermission('settings:manage')],
      schema: { response: { 200: okEnvelopeSchema(logoStateSchema) } },
    },
    async (request: AuthedRequest, reply) => {
      if (!env.imagesEnabled) {
        return reply.code(503).send(errorEnvelope('Imágenes no disponibles', 503))
      }
      let data
      try {
        data = await request.file()
      } catch {
        // Content-type incorrecto (no multipart).
        throw new HttpError('VALIDATION_ERROR', 'El logo debe enviarse como multipart/form-data')
      }
      if (!data) throw new HttpError('VALIDATION_ERROR', 'No se envió ninguna imagen')
      if (!MIME_TYPES.has(data.mimetype)) {
        throw new HttpError('VALIDATION_ERROR', 'Formato no permitido. Usa JPEG, PNG o WebP')
      }
      let buffer: Buffer
      try {
        buffer = await data.toBuffer()
      } catch {
        return reply
          .code(413)
          .send(errorEnvelope(`La imagen supera el máximo de ${env.s3MaxFileSizeMb} MB`, 413))
      }
      const result = await saveMerchantLogo(request.user.tenant_id, buffer)
      return okEnvelope(result, 'Logo actualizado', 200)
    },
  )

  /* ── DELETE /settings/logo ────────────────────────────────────────── */
  app.delete(
    '/settings/logo',
    {
      preHandler: [authenticate, requirePermission('settings:manage')],
      schema: { response: { 200: okEnvelopeSchema(logoStateSchema) } },
    },
    async (request: AuthedRequest) => {
      const result = await removeMerchantLogo(request.user.tenant_id)
      return okEnvelope(result, 'Logo eliminado', 200)
    },
  )
}
