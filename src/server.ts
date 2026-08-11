/**
 * src/server.ts — Punto de arranque del servidor.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Qué hace este módulo:
 *   - Construye la app (buildApp) y la pone a escuchar en PORT/HOST.
 *   - Apagado ordenado: al recibir SIGINT/SIGTERM cierra el pool de
 *     PostgreSQL y detiene el HTTP para no perder conexiones a mitad
 *     de una venta.
 *
 * Secciones:
 *   1) Arranque (listen)
 *   2) Apagado ordenado (graceful shutdown)
 * ────────────────────────────────────────────────────────────────────────
 */
import { buildApp } from './app.js'
import { env } from './config/env.js'
import { pool } from './database/pool.js'

/* ── 1) ARRANQUE ─────────────────────────────────────────────────────── */

const app = buildApp()

app.listen({ port: env.port, host: env.host }, (err, address) => {
  if (err) {
    app.log.fatal(err, 'No se pudo iniciar el servidor')
    process.exit(1)
  }
  app.log.info(`POS Server escuchando en ${address}`)
})

/* ── 2) APAGADO ORDENADO ─────────────────────────────────────────────── */

/** Cierra HTTP + pool de PostgreSQL de forma ordenada. */
async function shutdown(signal: string): Promise<void> {
  app.log.info(`Recibido ${signal} — apagando…`)
  try {
    await app.close()
    await pool.end()
    process.exit(0)
  } catch (err) {
    app.log.error(err, 'Error durante el apagado')
    process.exit(1)
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
