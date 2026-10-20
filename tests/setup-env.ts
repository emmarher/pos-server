/**
 * tests/setup-env.ts — Variables de entorno para la suite de tests.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Se ejecuta ANTES de cargar cualquier módulo del servidor (vitest
 * `setupFiles`), así `src/config/env.ts` valida esta configuración y no
 * la del `.env` real. La BD de pruebas es SIEMPRE un SQLite aparte
 * (`data/pos-test.sqlite`) — nunca toca la BD de desarrollo.
 * ────────────────────────────────────────────────────────────────────────
 */
process.env.DB_PROVIDER = 'sqlite'
process.env.SQLITE_PATH = './data/pos-test.sqlite'
process.env.JWT_SECRET = 'test-secret-solo-para-vitest-0123456789abcdef'
process.env.LOG_LEVEL = 'warn'

/* Modo desarrollo: la licencia NUNCA bloquea al tenant durante los tests.
   Lo inyecta también el script `npm test` (cross-env); aquí está para que
   `npx vitest` directo tenga la misma semántica.
   Los tests que verifique el comportamiento ESTRICTO lo desactivan
   explícitamente con Object.defineProperty(env, 'licenseDevMode', ...). */
process.env.LICENSE_DEV_MODE = 'true'

/* Ruta del .lic SOLO de tests. Sin esto, POST /license/upload persiste en
   ~/.pos/license.lic (la ruta real de producción) y deja el server de dev
   con una licencia de prueba expirada → "ventas bloqueadas". */
process.env.LICENSE_FILE_PATH = './data/test-license.lic'

/* Imágenes habilitadas; el storage S3 se MOCKEA en los tests (no se
   requiere Garage corriendo). Las credenciales son placeholder. */
process.env.IMAGES_ENABLED = 'true'
process.env.S3_ENDPOINT = 'http://127.0.0.1:3900'
process.env.S3_REGION = 'garage'
process.env.S3_ACCESS_KEY_ID = 'test-access-key'
process.env.S3_SECRET_ACCESS_KEY = 'test-secret-key'
process.env.S3_BUCKET = 'pos-images'
process.env.S3_PUBLIC_URL = 'http://127.0.0.1:3902'
process.env.S3_MAX_FILE_SIZE_MB = '5'

/* Seed demo SIN pin forzado: los helpers hacen login directo con 1234/5678.
   El flujo MUST_CHANGE_PIN se prueba dedicado en tests/auth-pin.test.ts. */
process.env.SEED_DEMO_MUST_CHANGE_PIN = '0'
