/**
 * src/database/sqlite.ts — Adaptador SQLite (SOLO desarrollo/pruebas).
 *
 * ────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE:
 *   - El PRD manda que PostgreSQL 16 es la ÚNICA fuente de verdad.
 *   - Mientras no haya PostgreSQL local instalado, SQLite con la MISMA
 *     estructura (migraciones `*.sqlite.sql`) permite desarrollar y
 *     probar el servidor de forma realista y sin fricción.
 *   - En producción el proveedor activo es `postgres` (ver client.ts);
 *     este adaptador solo se usa cuando DB_PROVIDER=sqlite.
 *
 * COMPATIBILIDAD DE QUERIES:
 *   - El código de negocio se escribe en estilo PostgreSQL: placeholders
 *     `$1, $2…`. Este adaptador traduce `$N` → `?` posicional en runtime,
 *     así las consultas son idénticas para ambos proveedores.
 *   - `exec()` (multi-sentencia) se usa para migraciones y PRAGMA.
 *
 * LIMITACIÓN CONOCIDA (dev): la transacción usa BEGIN/COMMIT manual sobre
 * la conexión única síncrona de better-sqlite3; en producción el adaptador
 * postgres usa un cliente dedicado del pool con aislamiento real.
 * ────────────────────────────────────────────────────────────────────────
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { DbClient, QueryResult } from './client.js'

/* ── Adaptador ────────────────────────────────────────────────────────── */

/** Cliente SQLite que implementa la interfaz unificada DbClient. */
export class SqliteClient implements DbClient {
  private readonly db: Database.Database

  constructor(path: string) {
    // Asegura que el directorio del archivo exista (p. ej. ./data/)
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    // WAL: lecturas concurrentes sin bloquear; foreign_keys: integridad real
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
  }

  /** Ejecuta una consulta y devuelve { rows, rowCount } (forma pg). */
  query<T = unknown>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const { sql: sqliteSql, params: sqliteParams } = translatePlaceholders(
      sql,
      params,
    )
    const stmt = this.db.prepare(sqliteSql)
    if (stmt.reader) {
      const rows = stmt.all(...sqliteParams) as T[]
      return Promise.resolve({ rows, rowCount: rows.length })
    }
    const info = stmt.run(...sqliteParams)
    return Promise.resolve({ rows: [] as T[], rowCount: info.changes })
  }

  /** Ejecuta SQL multi-sentencia (migraciones). */
  exec(sql: string): Promise<void> {
    this.db.exec(sql)
    return Promise.resolve()
  }

  /** Transacción manual (BEGIN/COMMIT/ROLLBACK) sobre la conexión única. */
  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN')
    try {
      const result = await fn(this)
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Cierra el archivo SQLite. */
  end(): Promise<void> {
    this.db.close()
    return Promise.resolve()
  }
}

/* ── Helper ───────────────────────────────────────────────────────────── */

/**
 * Traduce placeholders estilo PostgreSQL (`$1, $2…`) a posicionales de
 * SQLite (`?`) ligando CADA aparición a su valor. Si el mismo `$N` se usa
 * dos veces (p. ej. created_at y updated_at con el mismo valor), su valor
 * se liga en ambas posiciones — igual que hace PostgreSQL con parámetros
 * nombrados. No se usan literales con `$N` en el código del servidor, así
 * que el reemplazo global es seguro.
 */
function translatePlaceholders(
  sql: string,
  params: unknown[],
): { sql: string; params: unknown[] } {
  const reordered: unknown[] = []

  const translated = sql.replace(/\$(\d+)/g, (_, raw) => {
    const n = Number(raw)
    // params viene en orden $1..$N (como en PostgreSQL); ligar cada
    // aparición (posicional) al mismo valor del array original.
    reordered.push(params[n - 1])
    return '?'
  })

  return { sql: translated, params: reordered }
}
