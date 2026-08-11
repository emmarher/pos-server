/**
 * src/database/client.ts — Cliente unificado de base de datos.
 *
 * ────────────────────────────────────────────────────────────────────────
 * PROVEEDORES:
 *   - `sqlite`   (DB_PROVIDER=sqlite)   → dev/pruebas, MISMA estructura que PG
 *   - `postgres` (DB_PROVIDER=postgres) → PRODUCCIÓN (única fuente de verdad)
 *
 * La interfaz `DbClient` es idéntica para ambos: el código de negocio se
 * escribe UNA vez, en estilo PostgreSQL ($1, $2…), y el adaptador sqlite
 * traduce los placeholders en runtime. El resto del servidor SOLO conoce
 * `db` (esta interfaz) y nunca toca el driver directamente.
 *
 * REGLA MULTI-TENANT (skill postgres-multitenant):
 *   - El cliente NO conoce al tenant: cada query recibe `tenant_id` como
 *     parámetro explícito desde la capa de rutas. Ninguna consulta puede
 *     omitir ese filtro.
 *
 * Secciones:
 *   1) Interfaz unificada (DbClient / QueryResult)
 *   2) Adaptador PostgreSQL (PgClient) — delega en pool.ts
 *   3) Instancia activa (db) + checkDatabase
 * ────────────────────────────────────────────────────────────────────────
 */
import { env } from '../config/env.js'
import { pool } from './pool.js'
import { SqliteClient } from './sqlite.js'

/* ── 1) INTERFAZ UNIFICADA ────────────────────────────────────────────── */

/** Resultado de query, con la MISMA forma que pg (rows + rowCount). */
export interface QueryResult<T = unknown> {
  rows: T[]
  rowCount: number
}

/**
 * Contrato único de acceso a datos. Implementado por SqliteClient y por
 * PgClient. Las consultas se escriben con placeholders `$1, $2…`.
 */
export interface DbClient {
  /** Ejecuta una consulta parametrizada. */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
  /** Ejecuta SQL multi-sentencia (migraciones). */
  exec(sql: string): Promise<void>
  /** Ejecuta fn dentro de una transacción (BEGIN/COMMIT/ROLLBACK). */
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>
  /** Cierra la conexión(es) del proveedor activo. */
  end(): Promise<void>
}

/* ── 2) ADAPTADOR POSTGRESQL ──────────────────────────────────────────── */

/** Implementación sobre pg.Pool (pool.ts). Produce resultados nativos. */
class PgClient implements DbClient {
  async query<T = unknown>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await pool.query(sql, params as never[])
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount ?? result.rows.length,
    }
  }

  /** pg ejecuta multi-sentencia con el protocolo simple (sin params). */
  async exec(sql: string): Promise<void> {
    await pool.query(sql)
  }

  /** Transacción real con cliente dedicado del pool (aislamiento verdadero). */
  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    const tx: DbClient = {
      query: async <U = unknown>(sql: string, params: unknown[] = []) => {
        const result = await client.query(sql, params as never[])
        return {
          rows: result.rows as U[],
          rowCount: result.rowCount ?? result.rows.length,
        }
      },
      exec: async (sql: string) => {
        await client.query(sql)
      },
      transaction: () => {
        throw new Error('Transacciones anidadas no soportadas')
      },
      end: () => {
        client.release()
        return Promise.resolve()
      },
    }
    try {
      await client.query('BEGIN')
      const result = await fn(tx)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async end(): Promise<void> {
    await pool.end()
  }
}

/* ── 3) INSTANCIA ACTIVA + CHECK ──────────────────────────────────────── */

/** Selecciona el cliente según DB_PROVIDER (una vez al importar). */
function buildClient(): DbClient {
  return env.dbProvider === 'sqlite'
    ? new SqliteClient(env.sqlitePath)
    : new PgClient()
}

/** Cliente activo — TODO el servidor pasa por esta única instancia. */
export const db: DbClient = buildClient()

/** SELECT 1 contra la base activa (usa /health y el arranque). */
export async function checkDatabase(): Promise<boolean> {
  try {
    await db.query('SELECT 1')
    return true
  } catch {
    return false
  }
}
