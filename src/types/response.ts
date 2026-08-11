/**
 * src/types/response.ts — Envoltorio de respuesta homogéneo + JSON Schemas.
 *
 * ────────────────────────────────────────────────────────────────────────
 * FORMATO ÚNICO de todas las respuestas del API (éxito y error):
 *
 *   {
 *     "statusCode": 200,
 *     "message": "OK",
 *     "data": [...]
 *   }
 *
 * - `statusCode`: HTTP status real de la respuesta.
 * - `message`:    texto legible (en español, vocabulario POS).
 * - `data`:       payload. En errores SIEMPRE es `[]` (homogéneo).
 *
 * Los JSON Schemas se usan en `schema.response` de cada ruta de Fastify,
 * que VALIDA la respuesta real contra el schema antes de enviarla. Esto
 * garantiza que ninguna ruta se desvíe del formato.
 *
 * Secciones:
 *   1) Tipos del envoltorio (ApiEnvelope / ApiDataSchema)
 *   2) Schema base del envoltorio (envelopeSchema)
 *   3) Factory para respuestas OK (okEnvelopeSchema) + schema de error
 *   4) Helpers de runtime (okEnvelope / errorEnvelope)
 * ────────────────────────────────────────────────────────────────────────
 */

/* ── 1) TIPOS DEL ENVOLTORIO ─────────────────────────────────────────── */

/** Envoltorio tipado de una respuesta exitosa. */
export interface ApiEnvelope<T> {
  statusCode: number
  message: string
  data: T
}

/** Schema JSON del campo `data` (JSON Schema draft-07 compatible AJV). */
export type ApiDataSchema = Record<string, unknown>

/* ── 2) SCHEMA BASE DEL ENVOLTORIO ───────────────────────────────────── */

/**
 * Propiedades del envoltorio, extraídas a constante para poder reusarlas
 * en las factories (spread de `envelopeSchema.properties` no es tipable
 * porque sería `unknown`). Con `as const` AJV/Fastify las acepta igual.
 */
const envelopeProperties = {
  statusCode: { type: 'integer' },
  message: { type: 'string' },
  data: {},
} as const

/**
 * Parte común del schema: el esqueleto { statusCode, message, data }.
 * `data` se sobrescribe en cada factory con el schema específico.
 * `additionalProperties: false` fuerza a que NINGUNA respuesta lleve
 * campos fuera del contrato.
 */
export const envelopeSchema: ApiDataSchema = {
  type: 'object',
  required: ['statusCode', 'message', 'data'],
  additionalProperties: false,
  properties: envelopeProperties,
}

/* ── 3) FACTORY PARA RESPUESTAS OK + SCHEMA DE ERROR ─────────────────── */

/**
 * Envuelve el schema del `data` de un endpoint en el formato estándar.
 * Uso en una ruta:
 *   schema: { response: { 200: okEnvelopeSchema(productSchema) } }
 */
export function okEnvelopeSchema(dataSchema: ApiDataSchema): ApiDataSchema {
  return {
    ...envelopeSchema,
    properties: { ...envelopeProperties, data: dataSchema },
  }
}

/**
 * Schema de respuesta de ERROR: idéntico al éxito pero `data` es SIEMPRE
 * un array vacío, para que el cliente procese ambos casos igual.
 */
export const errorEnvelopeSchema: ApiDataSchema = {
  ...envelopeSchema,
  properties: {
    ...envelopeProperties,
    data: { type: 'array', maxItems: 0 },
  },
}

/* ── 4) HELPERS DE RUNTIME ───────────────────────────────────────────── */

/**
 * Construye una respuesta exitosa con el formato estándar.
 * @param data     payload de la respuesta (objeto o array)
 * @param message  texto legible (default "OK")
 * @param statusCode HTTP status (default 200)
 */
export function okEnvelope<T>(
  data: T,
  message = 'OK',
  statusCode = 200,
): ApiEnvelope<T> {
  return { statusCode, message, data }
}

/**
 * Construye una respuesta de ERROR con el formato estándar (data: []).
 * La usan el error handler global y el not-found handler.
 */
export function errorEnvelope(
  message: string,
  statusCode: number,
): ApiEnvelope<never[]> {
  return { statusCode, message, data: [] }
}
