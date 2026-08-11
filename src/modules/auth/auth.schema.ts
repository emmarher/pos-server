/**
 * src/modules/auth/auth.schema.ts — JSON Schemas del módulo auth.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Contrato de POST /auth/login y POST /auth/refresh.
 * La respuesta SIEMPRE va envuelta en el envoltorio homogéneo
 * { statusCode, message, data } — ver src/types/response.ts.
 *
 * NOTA device_type: el móvil envía 'TABLET' | 'PC', pero el CHECK del
 * esquema autoritativo es ('TABLET','DESKTOP','PHONE'). El servicio
 * normaliza 'PC' → 'DESKTOP' al guardar y devuelve el valor guardado.
 * ────────────────────────────────────────────────────────────────────────
 */
import type { ApiDataSchema } from '../../types/response.js'

/* ── Body de login ────────────────────────────────────────────────────── */

export const loginBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['tenant_code', 'pin', 'device_id', 'device_name', 'device_type'],
  additionalProperties: false,
  properties: {
    // "código de tenant" → se resuelve contra tenants.license_key
    tenant_code: { type: 'string', minLength: 1, maxLength: 255 },
    // PIN de usuario (4-6 dígitos, RF-AU-002)
    pin: { type: 'string', minLength: 4, maxLength: 6, pattern: '^[0-9]{4,6}$' },
    // Identificador persistente del dispositivo (RF-AU-004)
    device_id: { type: 'string', minLength: 1, maxLength: 255 },
    device_name: { type: 'string', minLength: 1, maxLength: 255 },
    // Aceptamos PC además de los del CHECK; el service normaliza a DESKTOP
    device_type: {
      enum: ['TABLET', 'DESKTOP', 'PHONE', 'PC'],
    },
  },
}

/* ── Body de refresh ──────────────────────────────────────────────────── */

export const refreshBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['refresh_token'],
  additionalProperties: false,
  properties: {
    refresh_token: { type: 'string', minLength: 10 },
  },
}

/* ── Schemas de data de respuesta (login y refresh comparten shape) ───── */

/** Schema del objeto `license` dentro del data. */
const licenseSchema: ApiDataSchema = {
  type: 'object',
  required: ['status', 'expires_at', 'max_devices'],
  additionalProperties: false,
  properties: {
    status: { enum: ['active', 'expired', 'grace'] },
    expires_at: { type: 'string' },
    max_devices: { type: 'integer' },
  },
}

/** Schema del data de /auth/login. */
export const authDataSchema: ApiDataSchema = {
  type: 'object',
  required: [
    'access_token',
    'refresh_token',
    'token_type',
    'expires_in',
    'user',
    'tenant',
    'device',
    'license',
  ],
  additionalProperties: false,
  properties: {
    access_token: { type: 'string' },
    refresh_token: { type: 'string' },
    token_type: { type: 'string' },
    expires_in: { type: 'integer' },
    user: {
      type: 'object',
      required: ['id', 'tenant_id', 'name', 'role_name', 'permissions'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        tenant_id: { type: 'string' },
        name: { type: 'string' },
        role_name: { type: ['string', 'null'] },
        permissions: { type: 'array', items: { type: 'string' } },
      },
    },
    tenant: {
      type: 'object',
      required: ['id', 'tenant_id', 'business_name'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        tenant_id: { type: 'string' },
        business_name: { type: 'string' },
        address: { type: ['string', 'null'] },
        phone: { type: ['string', 'null'] },
        receipt_footer: { type: ['string', 'null'] },
      },
    },
    device: {
      type: 'object',
      required: ['device_id', 'tenant_id', 'device_name', 'device_type', 'can_print', 'can_scale'],
      additionalProperties: false,
      properties: {
        device_id: { type: 'string' },
        tenant_id: { type: 'string' },
        device_name: { type: 'string' },
        device_type: { type: 'string' },
        can_print: { type: 'boolean' },
        can_scale: { type: 'boolean' },
      },
    },
    license: licenseSchema,
  },
}
