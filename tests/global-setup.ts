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
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { resolve } from 'node:path'

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

  /* ── Generar par de claves Ed25519 para tests de licencias ───────────── */
  // El private key se guarda en tests/test-private.pem para firmar .lic de prueba.
  // El public key se embebe en src/keys/publicKey.ts (gitignored).
  // NOTA: crear el dir ANTES de escribir (en entornos sin tools/keys previo fallaba con ENOENT).
  mkdirSync(resolve('../tools/keys'), { recursive: true })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  writeFileSync(
    resolve('tests/test-private.pem'),
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
  )
  writeFileSync(
    resolve('../tools/keys/test-public.pem'),
    publicKey.export({ type: 'spki', format: 'pem' }),
  )
  // Regenerar publicKey.ts con la clave de test
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' })
  writeFileSync(
    resolve('src/keys/publicKey.ts'),
    `/* AUTOGENERADO — no editar. Tests usan clave Ed25519 de prueba. */\nexport const PUBLIC_KEY_PEM = \`${publicKeyPem}\`;\n`,
  )

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
