/**
 * tests/global-setup.ts — Prepara la BD de pruebas UNA vez por corrida.
 *
 * ────────────────────────────────────────────────────────────────────────
 * - Elimina cualquier `pos-test.sqlite` previo (arranque limpio).
 * - Aplica migraciones + seed demo + seed catálogo contra la BD de test.
 * - El env ya fue fijado por setup-env.ts (se re-fija aquí porque
 *   globalSetup corre en su propio proceso).
 * - IMPORTANTE: exports NAMED (setup/teardown). Vitest 3 ignora el export
 *   `teardown` si el módulo tiene un `export default` (solo usa el default
 *   como setup) → la clave de producción no se restauraría.
 * ────────────────────────────────────────────────────────────────────────
 */
import { rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { resolve } from 'node:path'

/**
 * Clave pública embebida en src/keys/publicKey.ts ANTES de la corrida.
 * Se guarda para restaurarla en el teardown: los tests necesitan la clave
 * de prueba embebida, pero si se queda embebida, un `npm start` posterior
 * (sin rebuild) arrancaría el server con la clave de PRUEBA.
 */
let stashedProductionKey: string | null = null

export async function setup(): Promise<void> {
  process.env.DB_PROVIDER = 'sqlite'
  process.env.SQLITE_PATH = './data/pos-test.sqlite'
  process.env.JWT_SECRET = 'test-secret-solo-para-vitest-0123456789abcdef'
  process.env.IMAGES_ENABLED = 'true'
  process.env.S3_ENDPOINT = 'http://127.0.0.1:3900'
  process.env.S3_REGION = 'garage'
  process.env.S3_ACCESS_KEY_ID = 'test-access-key'
  process.env.S3_SECRET_ACCESS_KEY = 'test-secret-key'
  process.env.S3_BUCKET = 'pos-images'
  process.env.S3_PUBLIC_URL = 'http://127.0.0.1:3902'
  process.env.S3_MAX_FILE_SIZE_MB = '5'
  // Seed demo SIN pin forzado: globalSetup corre en proceso aparte y NO hereda
  // setup-env.ts; sin esto, seedDemo usa el default '1' y rompe los logins helper.
  process.env.SEED_DEMO_MUST_CHANGE_PIN = '0'
  // Nunca tocar ~/.pos/license.lic (la licencia real del usuario).
  process.env.LICENSE_FILE_PATH = './data/test-license.lic'

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
  // Guardar la clave de producción embebida (si la hay) para restaurarla al final.
  const publicKeyPath = resolve('src/keys/publicKey.ts')
  if (existsSync(publicKeyPath)) {
    const current = readFileSync(publicKeyPath, 'utf8')
    if (!current.includes('IS_TEST_KEY = true')) {
      stashedProductionKey = current
    }
  }
  // Regenerar publicKey.ts con la clave de test
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' })
  writeFileSync(
    publicKeyPath,
    `/* AUTOGENERADO — no editar. Tests usan clave Ed25519 de prueba. */\nexport const PUBLIC_KEY_PEM = \`${publicKeyPem}\`;\nexport const IS_TEST_KEY = true;\n`,
  )

  rmSync('./data/pos-test.sqlite', { force: true })
  rmSync('./data/pos-test.sqlite-journal', { force: true })
  rmSync('./data/pos-test.sqlite-wal', { force: true })
  rmSync('./data/pos-test.sqlite-shm', { force: true })
  // El .lic de test también se borra al ARRANCAR (no solo al terminar): si
  // quedó uno de la corrida anterior, `validateLicenseAtStartup` lo leería y
  // el estado inicial del tenant dependería de la corrida previa.
  rmSync(resolve('data/test-license.lic'), { force: true })

  const { runMigrations } = await import('../src/database/migrate.js')
  const { seedDemo } = await import('../src/database/seed.js')
  const { seedCatalog } = await import('../src/database/seed-catalog.js')
  const { db } = await import('../src/database/client.js')

  await runMigrations()
  await seedDemo()
  await seedCatalog()
  await db.end()
}

/**
 * Restaura la clave pública de producción embebida (si existía antes de la
 * corrida) y borra el .lic de test. Sin esto, `npm test` dejaría el server
 * con la clave de PRUEBA embebida → rechazaría todas las licencias reales.
 */
export async function teardown(): Promise<void> {
  if (stashedProductionKey) {
    writeFileSync(resolve('src/keys/publicKey.ts'), stashedProductionKey, 'utf8')
    stashedProductionKey = null
  }
  rmSync(resolve('data/test-license.lic'), { force: true })
}
