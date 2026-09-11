/**
 * src/modules/qos/qos.service.ts — Calidad de servicio (RF-QS).
 *
 * Respuesta de encuesta post-venta (RF-QS-002/003). La venta ya genera el
 * evento PENDING; aquí se registra la calificación y se marca COMPLETED.
 * Tabla: service_quality_events (migración 001).
 */

import { db } from '../../database/client.js'
import { HttpError } from '../../types/errors.js'

export type QosRating = 'EXCELLENT' | 'GOOD' | 'AVERAGE' | 'POOR' | 'TERRIBLE'

/** Fila de service_quality_events. */
export interface QosEventRow {
  id: string
  tenant_id: string
  sale_id: string
  rating: QosRating | null
  comment: string | null
  status: 'PENDING' | 'COMPLETED' | 'EXPIRED'
  responded_at: string | null
}

/** Registra la respuesta del cliente de una encuesta QoS. */
export async function submitQosResponse(
  tenantId: string,
  eventId: string,
  rating: QosRating,
  comment?: string,
): Promise<QosEventRow> {
  const { rows } = await db.query<QosEventRow>(
    'SELECT id, tenant_id, sale_id, rating, comment, status FROM service_quality_events WHERE tenant_id = $1 AND id = $2',
    [tenantId, eventId],
  )
  const ev = rows[0]
  if (!ev) throw new HttpError('NOT_FOUND', 'Evento de calidad no encontrado')
  if (ev.status === 'EXPIRED') {
    throw new HttpError('CONFLICT', 'La encuesta ya expiró')
  }
  if (ev.status === 'COMPLETED') {
    throw new HttpError('CONFLICT', 'La encuesta ya fue respondida')
  }

  const now = new Date().toISOString()
  const { rows: updated } = await db.query<QosEventRow>(
    `UPDATE service_quality_events
       SET rating = $3, comment = $4, status = 'COMPLETED', responded_at = $5
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, tenant_id, sale_id, rating, comment, status, responded_at`,
    [tenantId, eventId, rating, comment ?? null, now],
  )
  return updated[0]!
}

/** Lista eventos QoS pendientes de un tenant (para la tablet del cliente). */
export async function listPendingQos(tenantId: string): Promise<QosEventRow[]> {
  const { rows } = await db.query<QosEventRow>(
    `SELECT id, tenant_id, sale_id, rating, comment, status, responded_at
     FROM service_quality_events
     WHERE tenant_id = $1 AND status = 'PENDING' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
     ORDER BY created_at DESC`,
    [tenantId],
  )
  return rows
}