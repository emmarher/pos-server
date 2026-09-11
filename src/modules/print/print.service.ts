/**
 * src/modules/print/print.service.ts — Impresión delegada (RF-IM).
 *
 * Cola centralizada de trabajos de impresión:
 *   - enqueue: crea un job PENDING para un dispositivo con impresora.
 *   - listPending: el dispositivo con can_print hace poll (2s).
 *   - updateStatus: la impresora marca PRINTING/COMPLETED/FAILED.
 * Tabla: print_jobs (ya en la migración 001).
 */

import { db } from '../../database/client.js'
import { HttpError } from '../../types/errors.js'

/** Tipo de trabajo de impresión (RF-IM). */
export type PrintJobType = 'SALE_TICKET' | 'CUT_TICKET' | 'TEST' | 'Z_REPORT'
export type PrintJobStatus = 'PENDING' | 'PRINTING' | 'COMPLETED' | 'FAILED'

/** Fila de print_jobs. */
export interface PrintJobRow {
  id: string
  tenant_id: string
  source_device_id: string
  target_device_id: string
  sale_id: string | null
  cashier_cut_id: string | null
  job_type: PrintJobType
  content: string
  status: PrintJobStatus
  retry_count: number
  max_retries: number
  error_message: string | null
  printed_at: string | null
  created_at: string
  updated_at: string
}

/** Entrada para encolar un trabajo (RF-IM-002). */
export interface EnqueuePrintInput {
  /** Si no se pasa, el backend resuelve el dispositivo con can_print (RF-IM, PRD p.1263). */
  target_device_id?: string | null
  content: string
  job_type?: PrintJobType
  sale_id?: string | null
  source_device_id?: string
}

/**
 * Encola un trabajo de impresión (quien vende).
 * content: texto del ticket; el dispositivo imprime ESC/POS (RF-IM-002).
 * Si target_device_id no se pasa, el backend busca el device con can_print=true
 * del tenant (flujo de impresión delegada, PRD sección FLUJO DE IMPRESIÓN).
 */
export async function enqueuePrint(
  tenantId: string,
  sourceDeviceId: string,
  input: EnqueuePrintInput,
): Promise<PrintJobRow> {
  // Auto-resolver el dispositivo con impresora si no se pasó explícito
  let targetDeviceId = input.target_device_id
  if (!targetDeviceId) {
    const { rows: devRows } = await db.query<{ device_id: string }>(
      `SELECT device_id FROM device_capabilities
       WHERE tenant_id = $1 AND can_print = true
       ORDER BY device_id LIMIT 1`,
      [tenantId],
    )
    targetDeviceId = devRows[0]?.device_id ?? null
    if (!targetDeviceId) {
      throw new HttpError('NOT_FOUND', 'No hay dispositivo con impresora registrado en este tenant')
    }
  }

  const { rows } = await db.query<PrintJobRow>(
    `INSERT INTO print_jobs
       (tenant_id, source_device_id, target_device_id, sale_id, cashier_cut_id,
        job_type, content, content_format, status, retry_count, max_retries, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, 'ESC_POS', 'PENDING', 0, 3, $7, $7)
     RETURNING id, tenant_id, source_device_id, target_device_id, sale_id, cashier_cut_id,
               job_type, content, status, retry_count, max_retries, error_message, printed_at,
               created_at, updated_at`,
     [
       tenantId,
       input.source_device_id ?? sourceDeviceId,
       targetDeviceId,
       input.sale_id ?? null,
       input.job_type ?? 'SALE_TICKET',
       input.content,
       new Date().toISOString(),
     ],
   )
  const job = rows[0]
  if (!job) throw new HttpError('INTERNAL', 'No se pudo encolar la impresión')
  return job
}

/** Lista trabajos pendientes para un dispositivo con impresora (poll 2s). */
export async function listPendingPrints(
  tenantId: string,
  targetDeviceId: string,
  status: 'PENDING' | 'FAILED' = 'PENDING',
): Promise<PrintJobRow[]> {
  const { rows } = await db.query<PrintJobRow>(
    `SELECT id, tenant_id, source_device_id, target_device_id, sale_id, cashier_cut_id,
            job_type, content, status, retry_count, max_retries, error_message, printed_at,
            created_at, updated_at
     FROM print_jobs
     WHERE tenant_id = $1 AND target_device_id = $2 AND status = $3
     ORDER BY created_at ASC
     LIMIT 50`,
    [tenantId, targetDeviceId, status],
  )
  return rows
}

/**
 * Actualiza el estado de un trabajo de impresión.
 * Si falla y quedan reintentos → FAILED con error_message (tras max_retries).
 */
export async function updatePrintStatus(
  tenantId: string,
  id: string,
  status: 'PRINTING' | 'COMPLETED' | 'FAILED',
  error?: string,
): Promise<PrintJobRow> {
  const { rows } = await db.query<PrintJobRow>(
    'SELECT id, tenant_id, status, retry_count, max_retries FROM print_jobs WHERE tenant_id = $1 AND id = $2',
    [tenantId, id],
  )
  const job = rows[0]
  if (!job) throw new HttpError('NOT_FOUND', 'Trabajo de impresión no encontrado')

  const now = new Date().toISOString()
  if (status === 'COMPLETED') {
    await db.query(
      `UPDATE print_jobs SET status = $3, printed_at = $4, updated_at = $4 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, status, now],
    )
  } else if (status === 'PRINTING') {
    await db.query(
      `UPDATE print_jobs SET status = $3, updated_at = $4 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, status, now],
    )
  } else {
    // FAILED → incrementar retry_count; si se agota el máximo, se mantiene FAILED
    const newRetry = job.retry_count + 1
    await db.query(
      `UPDATE print_jobs SET status = 'FAILED', retry_count = $3, error_message = $4, updated_at = $5
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, newRetry, error ?? null, now],
    )
  }

  const { rows: updated } = await db.query<PrintJobRow>(
    `SELECT id, tenant_id, source_device_id, target_device_id, sale_id, cashier_cut_id,
            job_type, content, status, retry_count, max_retries, error_message, printed_at,
            created_at, updated_at
     FROM print_jobs WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  )
  return updated[0]!
}