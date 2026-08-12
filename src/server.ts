/**
 * src/server.ts — Punto de arranque del servidor.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Qué hace este módulo:
 *   - Construye la app (buildApp) y la pone a escuchar en PORT/HOST.
 *   - Apagado ordenado: al recibir SIGINT/SIGTERM cierra el cliente de la
 *     base (sqlite o postgres según DB_PROVIDER) y detiene el HTTP para no
 *     perder operaciones a mitad de una venta.
 *
 * Secciones:
 *   1) Arranque (listen)
 *   2) Apagado ordenado (graceful shutdown)
 * ────────────────────────────────────────────────────────────────────────
 */
import { buildApp } from './app.js'
import { env } from './config/env.js'
import { db } from './database/client.js'
import { startDiscovery, stopDiscovery } from './services/udp-discovery.js'

/* ── 1) ARRANQUE ─────────────────────────────────────────────────────── */

const app = buildApp()

app.listen({ port: env.port, host: env.host }, (err, address) => {
  if (err) {
    app.log.fatal(err, 'No se pudo iniciar el servidor')
    process.exit(1)
  }
  app.log.info(`POS Server escuchando en ${address}`)

  // UDP Discovery (RF-DS-001): el servidor responde a "POS_DISCOVER"
  // en el puerto 5000 para que las tablets lo encuentren en la LAN.
  startDiscovery()
    .then(() => app.log.info('UDP Discovery service iniciado (puerto 5000)'))
    .catch((discoveryErr) => {
      app.log.error(discoveryErr, 'No se pudo iniciar UDP Discovery')
    })
})

/* ── 2) APAGADO ORDENADO ─────────────────────────────────────────────── */

/** Cierra HTTP + UDP discovery + cliente de base de datos de forma ordenada. */
async function shutdown(signal: string): Promise<void> {
  app.log.info(`Recibido ${signal} — apagando…`)
  try {
    await stopDiscovery()
    await app.close()
    await db.end()
    process.exit(0)
  } catch (err) {
    app.log.error(err, 'Error durante el apagado')
    process.exit(1)
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
