/**
 * src/types/errors.ts — Error de dominio con código tipado.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Los servicios de negocio lanzan `HttpError` con un `code` del dominio
 * (ErrorCode). El error handler global de app.ts convierte el código en
 * HTTP status y envuelve el mensaje en el envoltorio estándar.
 * ────────────────────────────────────────────────────────────────────────
 */
import type { ErrorCode } from './index.js'

/** Error de dominio: `code` en vocabulario POS + mensaje legible. */
export class HttpError extends Error {
  readonly code: ErrorCode
  readonly statusCode: number

  constructor(code: ErrorCode, message: string, statusCode?: number) {
    super(message)
    this.name = 'HttpError'
    this.code = code
    // Si no se pasa status, se deduce del código (misma tabla que app.ts)
    this.statusCode = statusCode ?? statusFor(code)
  }
}

/** Mapea código de dominio → HTTP status (espejo de app.ts). */
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
