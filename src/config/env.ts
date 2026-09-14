/**
 * src/config/env.ts — Configuración de entorno del servidor.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Qué hace este módulo:
 *   - Carga las variables de entorno desde `.env` (dotenv).
 *   - Las valida y expone como un objeto tipado (`env`) para que el resto
 *     del código consuma valores seguros y con defaults claros.
 *
 * Secciones:
 *   1) Interfaz de configuración (AppEnv)
 *   2) Carga y validación (loadEnv)
 *   3) Instancia única exportada (env)
 * ────────────────────────────────────────────────────────────────────────
 */
import 'dotenv/config'

/* ── 1) INTERFAZ DE CONFIGURACIÓN ────────────────────────────────────── */

/**
 * Proveedor de base de datos.
 * - `postgres` → PostgreSQL 16 (PRODUCCIÓN, única fuente de verdad según PRD).
 * - `sqlite`   → SQLite con la MISMA estructura (solo para desarrollo/tests
 *                iniciales, mientras no haya PostgreSQL local instalado).
 * El cliente unificado (src/database/client.ts) expone la misma interfaz
 * para ambos; el cambio es solo de configuración, nunca de lógica de negocio.
 */
export type DbProvider = 'sqlite' | 'postgres'

export interface AppEnv {
  /** Puerto HTTP del API (los clientes POS se conectan aquí) */
  port: number
  /** Host donde escucha (0.0.0.0 para que la LAN alcance al servidor) */
  host: string
  /** Proveedor activo de base de datos (sqlite en dev, postgres en prod) */
  dbProvider: DbProvider
  /** Ruta del archivo SQLite (solo usado cuando dbProvider === 'sqlite') */
  sqlitePath: string
  /** WAL por defecto (solo sqlite); pool lectura configurable 2-4 */
  sqlitePoolReadSize: number
  /** Busy timeout en ms (solo sqlite, default 5000) */
  sqliteBusyTimeoutMs: number
  /** Synchronous pragma (solo sqlite, NORMAL para WAL) */
  sqliteSynchronous: 'NORMAL' | 'FULL'
  /** Tamaño de cache en KB (negativo, default -64000 = 64 MiB) */
  sqliteCacheSizeKb: number
  /** Tamaño mmap en bytes (default 32 MiB) */
  sqliteMmapSize: number
  /** Conexión a PostgreSQL 16 (fuente única de verdad, multi-tenant) */
  databaseUrl: string
  /** Secreto para firmar JWT (access 24h + refresh) */
  jwtSecret: string
  /** Vigencia del access token en segundos */
  jwtExpiresIn: number
  /** Vigencia del refresh token en segundos */
  jwtRefreshExpiresIn: number
  /** Máximo de dispositivos por tenant (PRD: default 2) */
  deviceLimitDefault: number
  /** Nivel de log de Fastify/pino */
  logLevel: string

  /* ── Almacenamiento de imágenes (Garage, S3-compatible) ────────────── */

  /**
   * Habilita el módulo de imágenes. En false, los endpoints de upload
   * responden 503 controlado (útil en dev/tests sin Garage corriendo).
   */
  imagesEnabled: boolean
  /** Endpoint API del S3-compatible (ej. http://127.0.0.1:3900) */
  s3Endpoint: string
  /** Región del bucket (Garage suele usar 'garage') */
  s3Region: string
  s3AccessKeyId: string
  s3SecretAccessKey: string
  /** Nombre del bucket de imágenes */
  s3Bucket: string
  /** URL pública directa para leer objetos (ej. http://127.0.0.1:3901) */
  s3PublicUrl: string
  /** Tamaño máximo por imagen en MB (default 5) */
  s3MaxFileSizeMb: number
}

/* ── 2) CARGA Y VALIDACIÓN ───────────────────────────────────────────── */

/**
 * Lee process.env y devuelve la configuración tipada.
 * Usa defaults seguros: si falta JWT_SECRET el servidor NO arranca
 * (los JWT serían predecibles — sería un fallo de seguridad silencioso).
 */
function loadEnv(): AppEnv {
  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret || jwtSecret.startsWith('change-me')) {
    throw new Error(
      'FALTA JWT_SECRET en .env. Genera uno con: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    )
  }

  // DB_PROVIDER solo acepta 'sqlite' | 'postgres'. Cualquier otro valor es
  // un error de configuración (mejor fallar temprano que vender en sqlite
  // por error de tipeo y pensar que es postgres).
  const dbProvider = normalizeDbProvider(process.env.DB_PROVIDER)

  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '0.0.0.0',
    dbProvider,
    sqlitePath: process.env.SQLITE_PATH ?? './data/pos.sqlite',
    sqlitePoolReadSize: normalizePoolReadSize(process.env.SQLITE_POOL_READ_SIZE),
    sqliteBusyTimeoutMs: normalizeBusyTimeout(process.env.SQLITE_BUSY_TIMEOUT_MS),
    sqliteSynchronous: normalizeSynchronous(process.env.SQLITE_SYNCHRONOUS),
    sqliteCacheSizeKb: normalizeCacheSizeKb(process.env.SQLITE_CACHE_SIZE_KB),
    sqliteMmapSize: normalizeMmapSize(process.env.SQLITE_MMAP_SIZE),
    databaseUrl:
      process.env.DATABASE_URL ?? 'postgres://pos:pos@127.0.0.1:5432/pos',
    jwtSecret,
    jwtExpiresIn: Number(process.env.JWT_EXPIRES_IN ?? 86400),
    jwtRefreshExpiresIn: Number(process.env.JWT_REFRESH_EXPIRES_IN ?? 2592000),
    deviceLimitDefault: Number(process.env.DEVICE_LIMIT_DEFAULT ?? 2),
    logLevel: process.env.LOG_LEVEL ?? 'info',

    // Imágenes: si IMAGES_ENABLED=true pero falta alguna credencial S3,
    // se desactiva el módulo con warning en vez de tumbar el arranque
    // (las imágenes son un extra: la venta nunca debe depender de Garage).
    ...loadImagesEnv(),
  }
}

/** Lee y normaliza la config del storage de imágenes (Garage/S3). */
function loadImagesEnv(): Pick<
  AppEnv,
  | 'imagesEnabled'
  | 's3Endpoint'
  | 's3Region'
  | 's3AccessKeyId'
  | 's3SecretAccessKey'
  | 's3Bucket'
  | 's3PublicUrl'
  | 's3MaxFileSizeMb'
> {
  const s3Endpoint = process.env.S3_ENDPOINT?.trim() ?? ''
  const s3Region = process.env.S3_REGION?.trim() || 'garage'
  const s3AccessKeyId = process.env.S3_ACCESS_KEY_ID?.trim() ?? ''
  const s3SecretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim() ?? ''
  const s3Bucket = process.env.S3_BUCKET?.trim() ?? ''
  const s3PublicUrl = (process.env.S3_PUBLIC_URL?.trim() ?? '').replace(/\/+$/, '')
  const s3MaxFileSizeMb = Number(process.env.S3_MAX_FILE_SIZE_MB ?? 5)

  const requested = (process.env.IMAGES_ENABLED ?? 'true').trim().toLowerCase()
  const credentialsOk =
    s3Endpoint !== '' && s3AccessKeyId !== '' && s3SecretAccessKey !== '' && s3Bucket !== ''

  if (requested === 'true' && !credentialsOk) {
    // No es fatal: el servidor arranca, solo las rutas de imagen dan 503.
    console.warn(
      '[env] IMAGES_ENABLED=true pero faltan variables S3_*; módulo de imágenes DESACTIVADO.',
    )
  }

  return {
    imagesEnabled: requested === 'true' && credentialsOk,
    s3Endpoint,
    s3Region,
    s3AccessKeyId,
    s3SecretAccessKey,
    s3Bucket,
    s3PublicUrl,
    s3MaxFileSizeMb: Number.isFinite(s3MaxFileSizeMb) && s3MaxFileSizeMb > 0 ? s3MaxFileSizeMb : 5,
  }
}

/**
 * Valida DB_PROVIDER y devuelve el enum tipado.
 * Por defecto es `postgres` (el PRD manda: PostgreSQL es la única fuente
 * de verdad). SQLite es un modo explícito de desarrollo/pruebas.
 */
function normalizeDbProvider(raw: string | undefined): DbProvider {
  const value = (raw ?? 'postgres').trim().toLowerCase()
  if (value === 'sqlite') return 'sqlite'
  if (value === 'postgres') return 'postgres'
  throw new Error(
    `DB_PROVIDER inválido: "${raw}". Usa "sqlite" (dev) o "postgres" (prod).`,
  )
}

function normalizePoolReadSize(raw: string | undefined): number {
  const n = Number(raw ?? 3)
  if (!Number.isFinite(n) || n < 2 || n > 4) return 3
  return Math.floor(n)
}

function normalizeBusyTimeout(raw: string | undefined): number {
  const n = Number(raw ?? 5000)
  if (!Number.isFinite(n) || n < 0 || n > 30000) return 5000
  return Math.floor(n)
}

function normalizeSynchronous(raw: string | undefined): 'NORMAL' | 'FULL' {
  const v = (raw ?? 'NORMAL').trim().toUpperCase()
  return v === 'FULL' ? 'FULL' : 'NORMAL'
}

function normalizeCacheSizeKb(raw: string | undefined): number {
  const n = Number(raw ?? -64000)
  if (!Number.isFinite(n) || n === 0) return -64000
  return Math.floor(n)
}

function normalizeMmapSize(raw: string | undefined): number {
  const n = Number(raw ?? 32 * 1024 * 1024)
  if (!Number.isFinite(n) || n < 0) return 32 * 1024 * 1024
  return Math.floor(n)
}

/* ── 3) INSTANCIA ÚNICA EXPORTADA ────────────────────────────────────── */

/** Configuración validada del servidor (única instancia al importar). */
export const env = loadEnv()
