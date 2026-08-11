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
    databaseUrl:
      process.env.DATABASE_URL ?? 'postgres://pos:pos@127.0.0.1:5432/pos',
    jwtSecret,
    jwtExpiresIn: Number(process.env.JWT_EXPIRES_IN ?? 86400),
    jwtRefreshExpiresIn: Number(process.env.JWT_REFRESH_EXPIRES_IN ?? 2592000),
    deviceLimitDefault: Number(process.env.DEVICE_LIMIT_DEFAULT ?? 2),
    logLevel: process.env.LOG_LEVEL ?? 'info',
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

/* ── 3) INSTANCIA ÚNICA EXPORTADA ────────────────────────────────────── */

/** Configuración validada del servidor (única instancia al importar). */
export const env = loadEnv()
