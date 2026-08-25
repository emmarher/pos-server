/**
 * tests/global-setup.ts — Prepara la BD de pruebas UNA vez por corrida.
 *
 * ────────────────────────────────────────────────────────────────────────
 * - Elimina cualquier `pos-test.sqlite` previo (arranque limpio).
 * - Aplica migraciones + seed demo + seed catálogo contra la BD de test.
 * - El env ya fue fijado por setup-env.ts (se re-fija aquí porque
 *   globalSetup corre en su propio proceso).
 * ────────────────────────────────────────────────────────────────────────
 */
import { rmSync } from 'node:fs'

async function setup(): Promise<void> {
  process.env.DB_PROVIDER = 'sqlite'
  process.env.SQLITE_PATH = './data/pos-test.sqlite'
  process.env.JWT_SECRET = 'test-secret-solo-para-vitest-0123456789abcdef'
  process.env.IMAGES_ENABLED = 'true'
  process.env.S3_ENDPOINT = 'http://127.0.0.1:3900'
  process.env.S3_REGION = 'garage'
  process.env.S3_ACCESS_KEY_ID = 'test-access-key'
  process.env.S3_SECRET_ACCESS_KEY = 'test-secret-key'
  process.env.S3_BUCKET = 'productos'
  process.env.S3_PUBLIC_URL = 'http://127.0.0.1:3902'
  process.env.S3_MAX_FILE_SIZE_MB = '5'

  rmSync('./data/pos-test.sqlite', { force: true })
  rmSync('./data/pos-test.sqlite-journal', { force: true })
  rmSync('./data/pos-test.sqlite-wal', { force: true })
  rmSync('./data/pos-test.sqlite-shm', { force: true })

  const { runMigrations } = await import('../src/database/migrate.js')
  const { seedDemo } = await import('../src/database/seed.js')
  const { seedCatalog } = await import('../src/database/seed-catalog.js')
  const { db } = await import('../src/database/client.js')

  await runMigrations()
  await seedDemo()
  await seedCatalog()
  await db.end()
}

export default setup
