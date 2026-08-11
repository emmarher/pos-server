/**
 * src/types/index.ts — Tipos base compartidos del servidor.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Qué contiene este módulo:
 *   - Códigos de error del dominio (vocabulario en español).
 *   - Re-exporta el envoltorio de respuesta homogéneo (types/response.ts).
 *   - Tipos que se irán poblando en las fases siguientes (módulos de
 *     negocio), sin inventar nada que no esté en el esquema SQL.
 * ────────────────────────────────────────────────────────────────────────
 */

/* ── Re-export del envoltorio de respuesta homogéneo ─────────────────── */

export {
  okEnvelope,
  errorEnvelope,
  okEnvelopeSchema,
  errorEnvelopeSchema,
  envelopeSchema,
  type ApiEnvelope,
  type ApiDataSchema,
} from './response.js'

/* ── Errores ─────────────────────────────────────────────────────────── */

/**
 * Códigos de error del dominio. El cliente los muestra tal cual, así que
 * se mantienen en español/vocabulario POS (folio, tenant, etc.).
 */
export type ErrorCode =
  | 'UNAUTHORIZED' // token inválido o expirado
  | 'FORBIDDEN' // sin permiso para la acción
  | 'LICENSE_EXPIRED' // licencia vencida → bloqueo total
  | 'DEVICE_LIMIT' // se superó max_devices del tenant (403)
  | 'NOT_FOUND' // recurso inexistente
  | 'CONFLICT' // conflicto de unicidad (barcode, folio, etc.)
  | 'VALIDATION_ERROR' // body/query inválido
  | 'INSUFFICIENT_STOCK' // stock insuficiente al vender
  | 'TENANT_MISMATCH' // recurso de otro tenant (aislamiento)
  | 'INTERNAL' // error inesperado

/* ── Notas de diseño (fases siguientes) ──────────────────────────────── */

/**
 * Los tipos de negocio (Product, Sale, Customer…) se agregarán aquí
 * espejando EXACTAMENTE las columnas de esquema_BD_POS_v4_completo.sql.
 * No se definen en FASE 0 para no adelantar trabajo ni inventar campos.
 */
