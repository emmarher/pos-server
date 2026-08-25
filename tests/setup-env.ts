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

/* Imágenes habilitadas; el storage S3 se MOCKEA en los tests (no se
   requiere Garage corriendo). Las credenciales son placeholder. */
process.env.IMAGES_ENABLED = 'true'
process.env.S3_ENDPOINT = 'http://127.0.0.1:3900'
process.env.S3_REGION = 'garage'
process.env.S3_ACCESS_KEY_ID = 'test-access-key'
process.env.S3_SECRET_ACCESS_KEY = 'test-secret-key'
process.env.S3_BUCKET = 'productos'
process.env.S3_PUBLIC_URL = 'http://127.0.0.1:3902'
process.env.S3_MAX_FILE_SIZE_MB = '5'
