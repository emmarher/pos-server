/**
 * src/modules/license/license.schema.ts — JSON Schemas del módulo de licencias.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Contrato de las rutas de licencia (license.routes.ts).
 * Todas las respuestas van envueltas en el formato homogéneo
 * { statusCode, message, data } — ver src/types/response.ts.
 * ─────────────────────────────────────────────────────────────────────
 */
import type { ApiDataSchema } from '../../types/response.js'

/** Schema del campo `license_data` en el body de POST /license/upload. */
export const uploadLicenseBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['license_data'],
  additionalProperties: false,
  properties: {
    /** Licencia firmada en formato base64url(payload).base64url(signature) */
    license_data: { type: 'string', minLength: 1 },
  },
}

/** Schema del `data` de GET /license/status y POST /license/upload. Canonico con LicenseInfo. */
export const licenseInfoSchema: ApiDataSchema = {
  type: 'object',
  required: [
    'status',
    'expires_at',
    'max_devices',
    'lic_id',
    'customer',
    'features',
    'warning_level',
  ],
  additionalProperties: false,
  properties: {
    status: { enum: ['active', 'expired', 'grace'] },
    expires_at: { type: 'string' },
    max_devices: { type: 'integer' },
    lic_id: { type: ['string', 'null'] },
    customer: { type: ['string', 'null'] },
    features: { type: 'array', items: { type: 'string' } },
    warning_level: { enum: ['none', 'warning', 'critical', null] },
    grace_reason: { enum: ['clock', 'fingerprint', null] },
    grace_expires_at: { type: ['string', 'null'] },
  },
}
