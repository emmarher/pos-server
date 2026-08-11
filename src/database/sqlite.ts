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
    const stmt = this.db.prepare(translatePlaceholders(sql))
    if (stmt.reader) {
      const rows = stmt.all(...params) as T[]
      return Promise.resolve({ rows, rowCount: rows.length })
    }
    const info = stmt.run(...params)
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
 * SQLite (`?`). No se usan literales con `$N` en el código del servidor,
 * así que el reemplazo global es seguro.
 */
function translatePlaceholders(sql: string): string {
  return sql.replace(/\$(\d+)/g, '?')
}
