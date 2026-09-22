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
import { validateLicenseAtStartup } from './modules/license/license.service.js'
import { startLicenseMonitor } from './services/license-monitor.js'

/* ── 1) ARRANQUE ─────────────────────────────────────────────────────── */

const app = buildApp()
/* Monitor de background (heartbeat TTL + expiración en caliente) */
let licenseMonitor: ReturnType<typeof startLicenseMonitor> | null = null

// Validación temprana de esquema: falla rápido si la BD está vacía
// (caso "no such table: tenants" visto en login). Si falla, indica
// al usuario ejecutar migrate + seed.
async function assertSchemaReady(): Promise<void> {
  try {
    await db.query('SELECT 1 FROM tenants LIMIT 1')
  } catch (err) {
    app.log.fatal(
      err,
      'Esquema no inicializado (no existe tenants). Ejecuta: npm run migrate && npm run seed',
    )
    throw err
  }
}

assertSchemaReady()
  .then(async () => {
    /* Validar la licencia firmada al arranque (checklist de 8 pasos).
       Si la licencia es válida, actualiza tenants + license_state.
       Si es inválida/expirada, desactiva el tenant. Si falta el .lic,
       entra en modo degradado (usa los campos BD existentes). */
    const licenseStatus = await validateLicenseAtStartup(app)
    if (licenseStatus === 'active') {
      app.log.info('Licencia válida — servidor operativo')
    } else if (licenseStatus === 'missing') {
      app.log.warn('Sin archivo de licencia — modo degradado (usa campos BD)')
    } else if (licenseStatus === 'invalid') {
      app.log.error('Licencia inválida (firma rota) — servidor en modo bloqueado')
    } else if (licenseStatus === 'expired') {
      app.log.warn('Licencia expirada — servidor en modo degradado (ventas bloqueadas)')
    } else if (licenseStatus === 'grace_clock') {
      app.log.warn('Retroceso de reloj detectado — ventas bloqueadas (gracia expirada)')
    } else if (licenseStatus === 'grace_fingerprint') {
      app.log.warn('Fingerprint no coincide — modo gracia 15 días')
    } else if (licenseStatus === 'unsupported_schema') {
      app.log.warn('Schema de licencia no soportado — actualice el server')
    }

    return app.listen({ port: env.port, host: env.host }, (err, address) => {
      if (err) {
        app.log.fatal(err, 'No se pudo iniciar el servidor')
        process.exit(1)
      }
      app.log.info(`POS Server escuchando en ${address}`)

      /* Monitor de background: heartbeat TTL + expiración en caliente */
      licenseMonitor = startLicenseMonitor(app)

      // UDP Discovery (RF-DS-001): el servidor responde a "POS_DISCOVER"
      // en el puerto 5000 para que las tablets lo encuentren en la LAN.
      startDiscovery()
        .then(() => app.log.info('UDP Discovery service iniciado (puerto 5000)'))
        .catch((discoveryErr) => {
          app.log.error(discoveryErr, 'No se pudo iniciar UDP Discovery')
        })
    })
  })
  .catch(() => process.exit(1))

/* ── 2) APAGADO ORDENADO ─────────────────────────────────────────────── */

/** Cierra HTTP + UDP discovery + cliente de base de datos de forma ordenada. */
async function shutdown(signal: string): Promise<void> {
  app.log.info(`Recibido ${signal} — apagando…`)
  try {
    licenseMonitor?.stop()
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
