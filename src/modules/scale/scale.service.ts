/**
 * src/modules/scale/scale.service.ts — Báscula delegada (RF-BA).
 *
 * Heartbeat del dispositivo con báscula (RF-BA-002) y lectura del peso
 * cacheado (RF-BA-003). Tabla: device_status (migración 001).
 */

import { db } from '../../database/client.js'

/** Fila de device_status. */
export interface DeviceStatusRow {
  device_id: string
  tenant_id: string
  is_online: number
  last_heartbeat: string
  current_scale_weight: number | null
  scale_unit: string | null
  scale_is_stable: number
  updated_at: string
}

/** Payload de POST /device/heartbeat (RF-BA-002). */
export interface HeartbeatInput {
  device_id: string
  current_scale_weight?: number | null
  scale_unit?: string
  scale_is_stable?: boolean
  app_version?: string
  battery_level?: number
}

/**
 * UPSERT del estado del dispositivo (heartbeat cada ~500ms).
 * Marca is_online=1 y actualiza last_heartbeat/updated_at.
 */
export async function upsertHeartbeat(
  tenantId: string,
  input: HeartbeatInput,
): Promise<DeviceStatusRow> {
  const now = new Date().toISOString()
  const { rows } = await db.query<DeviceStatusRow>(
    `INSERT INTO device_status
       (device_id, tenant_id, is_online, last_heartbeat, current_scale_weight,
        scale_unit, scale_is_stable, app_version, battery_level, updated_at)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $3)
     ON CONFLICT (device_id) DO UPDATE SET
        is_online = 1,
        last_heartbeat = excluded.last_heartbeat,
        current_scale_weight = excluded.current_scale_weight,
        scale_unit = excluded.scale_unit,
        scale_is_stable = excluded.scale_is_stable,
        app_version = excluded.app_version,
        battery_level = excluded.battery_level,
        updated_at = excluded.updated_at
     RETURNING device_id, tenant_id, is_online, last_heartbeat, current_scale_weight,
               scale_unit, scale_is_stable, updated_at`,
    [
      input.device_id,
      tenantId,
      now,
      input.current_scale_weight ?? null,
      input.scale_unit ?? 'kg',
      input.scale_is_stable ? 1 : 0,
      input.app_version ?? null,
      input.battery_level ?? null,
    ],
  )
  const row = rows[0]
  if (!row) throw new Error('No se pudo registrar el heartbeat')
  return row
}

/** Último peso cacheado de un dispositivo (RF-BA-003). */
export async function getCurrentWeight(
  tenantId: string,
  deviceId: string,
): Promise<DeviceStatusRow | null> {
  const { rows } = await db.query<DeviceStatusRow>(
    `SELECT device_id, tenant_id, is_online, last_heartbeat, current_scale_weight,
            scale_unit, scale_is_stable, updated_at
     FROM device_status
     WHERE tenant_id = $1 AND device_id = $2`,
    [tenantId, deviceId],
  )
  return rows[0] ?? null
}