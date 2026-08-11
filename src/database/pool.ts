/**
 * src/database/pool.ts — Pool de conexiones a PostgreSQL 16.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Qué hace este módulo:
 *   - Crea el pool único de conexiones (`pg.Pool`) usado por todo el
 *     servidor. PostgreSQL es la ÚNICA fuente de verdad del sistema.
 *
 * REGLA MULTI-TENANT (ver skill postgres-multitenant):
 *   - Esquema compartido: todos los tenants conviven en las mismas tablas,
 *     separados por `tenant_id`. Ninguna query puede omitir ese filtro.
 *   - El pool NO conoce al tenant: cada query recibe `tenant_id` como
 *     parámetro explícito desde la capa de rutas.
 *
 * Secciones:
 *   1) Pool de conexiones (exportado)
 *   2) Helper de verificación de conectividad (checkDatabase)
 * ────────────────────────────────────────────────────────────────────────
 */
import pg from 'pg'
import { env } from '../config/env.js'

/* ── 1) POOL DE CONEXIONES ───────────────────────────────────────────── */

/**
 * Pool único del proceso. `max: 10` es suficiente para un servidor de
 * sucursal local con pocas tablets; evita agotar conexiones en PostgreSQL.
 */
export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

/* ── 2) VERIFICACIÓN DE CONECTIVIDAD ─────────────────────────────────── */

/**
 * SELECT 1 contra la base. Se usa en /health y al arrancar para avisar
 * temprano si PostgreSQL está caído (servidor caído = nadie puede vender).
 */
export async function checkDatabase(): Promise<boolean> {
  try {
    await pool.query('SELECT 1')
    return true
  } catch {
    return false
  }
}
