/**
 * src/database/pool.ts — Pool de conexiones a PostgreSQL 16.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Qué hace este módulo:
 *   - Crea el pool único de conexiones (`pg.Pool`) usado por el adaptador
 *     PostgreSQL de client.ts (DB_PROVIDER=postgres, PRODUCCIÓN).
 *   - PostgreSQL es la ÚNICA fuente de verdad del sistema según el PRD.
 *
 * NOTA: El servidor NO usa `pool` directamente; pasa por `db` (client.ts)
 * para que el proveedor sqlite/postgres sea intercambiable en dev.
 *
 * REGLA MULTI-TENANT (ver skill postgres-multitenant):
 *   - Esquema compartido: todos los tenants conviven en las mismas tablas,
 *     separados por `tenant_id`. Ninguna query puede omitir ese filtro.
 *   - El pool NO conoce al tenant: cada query recibe `tenant_id` como
 *     parámetro explícito desde la capa de rutas.
 * ────────────────────────────────────────────────────────────────────────
 */
import pg from 'pg'
import { env } from '../config/env.js'

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
