/**
 * src/database/migrate.ts — Runner de migraciones (CLI: npm run migrate).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Qué hace este módulo:
 *   - Escanea `migrations/`, aplica SOLO los archivos del proveedor activo
 *     (`.sqlite.sql` para DB_PROVIDER=sqlite, `.pg.sql` para postgres).
 *   - Lleva el registro en la tabla `schema_migrations` (infra del runner,
 *     NO es una tabla de negocio del esquema autoritativo).
 *   - Cada migración corre dentro de una transacción: si falla, se
 *     revierte completa (BEGIN → exec → INSERT ledger → COMMIT).
 *
 * REGLAS (skill postgres-multitenant):
 *   - El orden importa: se ordena por nombre de archivo (001_, 002_…).
 *   - NUNCA se edita una migración ya aplicada; se crea una nueva.
 *   - El SQL de migración es multi-tenant: `tenant_id NOT NULL` con las
 *     claves foráneas correctas (así queda en el esquema autoritativo).
 * ────────────────────────────────────────────────────────────────────────
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../config/env.js'
import { db } from './client.js'

/** Carpeta de migraciones: pos-server/migrations (raíz del proyecto). */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations')

/** Sufijo de archivo según el proveedor activo. */
function suffixFor(provider: typeof env.dbProvider): string {
  return provider === 'sqlite' ? '.sqlite.sql' : '.pg.sql'
}

/** Crea la tabla ledger del runner si no existe (DDL por proveedor). */
async function ensureLedger(): Promise<void> {
  const sql =
    env.dbProvider === 'sqlite'
      ? `CREATE TABLE IF NOT EXISTS schema_migrations (
           filename TEXT PRIMARY KEY,
           applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         )`
      : `CREATE TABLE IF NOT EXISTS schema_migrations (
           filename TEXT PRIMARY KEY,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`
  await db.exec(sql)
}

/** Filenames ya aplicados (ledger). */
async function appliedMigrations(): Promise<Set<string>> {
  const { rows } = await db.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  )
  return new Set(rows.map((r) => r.filename))
}

/** Aplica una migración dentro de una transacción y la registra. */
async function applyMigration(filename: string, sql: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.exec(sql)
    await tx.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename])
  })
}

/**
 * Punto de entrada de la CLI. `npm run migrate` ejecuta esta función.
 * Exportada para poder reutilizarla en tests (tests/ pueden llamarla).
 */
export async function runMigrations(): Promise<string[]> {
  const suffix = suffixFor(env.dbProvider)
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(suffix))
    .sort()

  await ensureLedger()
  const applied = await appliedMigrations()
  const appliedNow: string[] = []

  for (const file of files) {
    if (applied.has(file)) continue
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    await applyMigration(file, sql)
    appliedNow.push(file)
    console.log(`✔ ${file} (${env.dbProvider})`)
  }

  if (appliedNow.length === 0) {
    console.log(`Sin migraciones pendientes (${env.dbProvider})`)
  }
  return appliedNow
}

/* ── CLI: se ejecuta solo cuando este archivo es el punto de entrada ──── */

const isMain =
  process.argv[1] != null &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  runMigrations()
    .then(() => db.end())
    .catch(async (err) => {
      console.error('Error al migrar:', err)
      await db.end()
      process.exit(1)
    })
}
