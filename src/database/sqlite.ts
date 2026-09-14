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
 * CONCURRENCIA (WAL + busy_timeout + pool):
 *   - journal_mode=WAL por defecto (lectores no bloquean escritor) + validado
 *     que el pragma realmente quedó en WAL.
 *   - busy_timeout configurable (default 5000ms) para esperar lock en vez de
 *     fallar inmediato con SQLITE_BUSY.
 *   - synchronous=NORMAL (WAL) configurable, cache_size, mmap_size, etc.
 *   - Pool de lectura configurable 2-4 conexiones (round-robin) + 1 escritura
 *     serializada mediante cola Promise (BEGIN IMMEDIATE).
 * ────────────────────────────────────────────────────────────────────────
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { env } from '../config/env.js'
import type { DbClient, QueryResult } from './client.js'

/* ── Adaptador ────────────────────────────────────────────────────────── */

/** Cliente SQLite que implementa la interfaz unificada DbClient. */
export class SqliteClient implements DbClient {
  private readonly writer: Database.Database
  private readonly readers: Database.Database[]
  private nextReader = 0
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.writer = this.openWithPragmas(path)
    const poolSize = env.sqlitePoolReadSize
    this.readers = Array.from({ length: poolSize }, () => this.openWithPragmas(path))
    console.info(
      `[sqlite] WAL pool ready: journal_mode=WAL synchronous=${env.sqliteSynchronous} busy_timeout=${env.sqliteBusyTimeoutMs}ms pool_read=${poolSize} writer=1 cache=${env.sqliteCacheSizeKb} mmap=${env.sqliteMmapSize}`,
    )
  }

  private openWithPragmas(path: string): Database.Database {
    const db = new Database(path)
    // WAL por defecto + validación (puede revertir a delete si falla)
    db.pragma('journal_mode = WAL')
    const mode = (db.pragma('journal_mode', { simple: true }) as string)?.toLowerCase()
    if (mode !== 'wal') {
      console.warn(`[sqlite] journal_mode no es WAL (actual: ${mode}), lectores podrían bloquear escritor`)
    }
    db.pragma(`busy_timeout = ${env.sqliteBusyTimeoutMs}`)
    db.pragma(`synchronous = ${env.sqliteSynchronous}`)
    db.pragma('foreign_keys = ON')
    db.pragma(`cache_size = ${env.sqliteCacheSizeKb}`)
    db.pragma('temp_store = MEMORY')
    db.pragma(`mmap_size = ${env.sqliteMmapSize}`)
    // Limitar WAL y autocheckpoint (evita crecimiento ilimitado)
    try {
      db.pragma('journal_size_limit = 67108864')
      db.pragma('wal_autocheckpoint = 1000')
    } catch {
      /* pragmas opcionales en versiones viejas */
    }
    return db
  }

  private pickReader(): Database.Database {
    const r = this.readers[this.nextReader % this.readers.length]!
    this.nextReader = (this.nextReader + 1) % this.readers.length
    return r
  }

  private isSelect(sql: string): boolean {
    return /^\s*SELECT/i.test(sql)
  }

  private enqueueWrite<T>(work: () => T | Promise<T>): Promise<T> {
    const run = () => {
      try {
        const result = work()
        return result instanceof Promise ? result : Promise.resolve(result)
      } catch (err) {
        return Promise.reject(err)
      }
    }
    const result = this.writeQueue.then(run, run) as Promise<T>
    // Mantener la cola viva aunque falle una escritura
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Ejecuta una consulta y devuelve { rows, rowCount } (forma pg). */
  query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const { sql: sqliteSql, params: sqliteParams } = translatePlaceholders(sql, params)
    const useReader = this.isSelect(sql)
    if (useReader) {
      const db = this.pickReader()
      const stmt = db.prepare(sqliteSql)
      if (stmt.reader) {
        const rows = stmt.all(...sqliteParams) as T[]
        return Promise.resolve({ rows, rowCount: rows.length })
      }
      const info = stmt.run(...sqliteParams)
      return Promise.resolve({ rows: [] as T[], rowCount: info.changes })
    }
    // Escrituras via writer serializado (RETURNING incluye reader=true -> se maneja igual pero encolado)
    return this.enqueueWrite(() => {
      const stmt = this.writer.prepare(sqliteSql)
      if (stmt.reader) {
        const rows = stmt.all(...sqliteParams) as T[]
        return { rows, rowCount: rows.length }
      }
      const info = stmt.run(...sqliteParams)
      return { rows: [] as T[], rowCount: info.changes }
    })
  }

  /** Ejecuta SQL multi-sentencia (migraciones). Encolado en writer. */
  exec(sql: string): Promise<void> {
    return this.enqueueWrite(() => {
      this.writer.exec(sql)
    })
  }

  /** Transacción serializada con BEGIN IMMEDIATE (adquiere lock de escritura al inicio). */
  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.enqueueWrite(async () => {
      this.writer.exec('BEGIN IMMEDIATE')
      try {
        const tx: DbClient = {
          query: <U = unknown>(s: string, p: unknown[] = []) => {
            const { sql: ss, params: pp } = translatePlaceholders(s, p)
            const stmt = this.writer.prepare(ss)
            if (stmt.reader) {
              const rows = stmt.all(...pp) as U[]
              return Promise.resolve({ rows, rowCount: rows.length })
            }
            const info = stmt.run(...pp)
            return Promise.resolve({ rows: [] as U[], rowCount: info.changes })
          },
          exec: (s: string) => {
            this.writer.exec(s)
            return Promise.resolve()
          },
          transaction: () => {
            throw new Error('Transacciones anidadas no soportadas')
          },
          end: () => Promise.resolve(),
        }
        const result = await fn(tx)
        this.writer.exec('COMMIT')
        return result
      } catch (err) {
        try {
          this.writer.exec('ROLLBACK')
        } catch {
          /* rollback puede fallar si no hay transacción */
        }
        throw err
      }
    })
  }

  /** Cierra escritor + lectores y checkpoint WAL. */
  end(): Promise<void> {
    try {
      this.writer.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* best-effort */
    }
    this.writer.close()
    for (const r of this.readers) {
      try {
        r.close()
      } catch {
        /* ignore */
      }
    }
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
    reordered.push(params[n - 1])
    return '?'
  })

  return { sql: translated, params: reordered }
}
