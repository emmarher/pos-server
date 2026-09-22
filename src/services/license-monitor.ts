/**
 * src/services/license-monitor.ts — Monitor de background para licencias.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Se inicia al arranque del servidor (después de listen). Ejecuta:
 *   1. cleanupExpiredSessions() cada 60s — invalida sesiones sin heartbeat
 *      en 90s (libera asientos). Admin exento (is_heartbeat_exempt=1).
 *   2. Verifica expiración de licencias cada 5 min — si expiraron mientras
 *      el server estaba corriendo, actualiza tenants.is_active.
 *
 * El monitor se detiene en graceful shutdown (server.ts → shutdown()).
 * ─────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from 'fastify'
import { env } from '../config/env.js'
import { db } from '../database/client.js'
import { cleanupExpiredSessions } from '../modules/license/license.service.js'

/* 60s: limpieza de sesiones por TTL de heartbeat */
const SESSION_CLEANUP_INTERVAL_MS = 60_000

/* 5 min: verificación de expiración de licencias */
const LICENSE_CHECK_INTERVAL_MS = 5 * 60_000

/** Inicia los timers de background. Devuelve { stop } para shutdown. */
export function startLicenseMonitor(app: FastifyInstance): { stop: () => void } {
  let timers: Array<ReturnType<typeof setInterval>> = []

  // 1. Limpieza de sesiones expiradas (TTL heartbeat)
  const t1 = setInterval(async () => {
    try {
      const freed = await cleanupExpiredSessions()
      if (freed > 0) {
        app.log.info(`[monitor] ${freed} sesiones expiradas por heartbeat-TTL limpiadas`)
      }
    } catch (err) {
      app.log.error(err, '[monitor] Error en cleanupExpiredSessions')
    }
  }, SESSION_CLEANUP_INTERVAL_MS)
  timers.push(t1)

  // 2. Verificación de expiración de licencias (casos: .lic expirado en caliente)
  const t2 = setInterval(async () => {
    try {
      const now = new Date().toISOString()
      const { rowCount } = await db.query(
        `UPDATE tenants
         SET is_active = 0, updated_at = $1
         WHERE is_active = 1
           AND (license_expires_at <= $2 OR license_expires_at IS NULL)`,
        [now, now],
      )
      if (rowCount > 0) {
        app.log.warn(`[monitor] ${rowCount} tenant(s) desactivados por licencia expirada`)
      }
    } catch (err) {
      app.log.error(err, '[monitor] Error en license expiry check')
    }
  }, LICENSE_CHECK_INTERVAL_MS)
  timers.push(t2)

  // No bloquear el event loop
  t1.unref?.()
  t2.unref?.()

  return {
    stop: () => {
      for (const t of timers) {
        clearInterval(t)
      }
      timers = []
    },
  }
}
