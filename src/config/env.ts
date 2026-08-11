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

export interface AppEnv {
  /** Puerto HTTP del API (los clientes POS se conectan aquí) */
  port: number
  /** Host donde escucha (0.0.0.0 para que la LAN alcance al servidor) */
  host: string
  /** Conexión a PostgreSQL 16 (fuente única de verdad, multi-tenant) */
  databaseUrl: string
  /** Secreto para firmar JWT (access 24h + refresh) */
  jwtSecret: string
  /** Vigencia del access token en segundos */
  jwtExpiresIn: number
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

  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl:
      process.env.DATABASE_URL ?? 'postgres://pos:pos@127.0.0.1:5432/pos',
    jwtSecret,
    jwtExpiresIn: Number(process.env.JWT_EXPIRES_IN ?? 86400),
    deviceLimitDefault: Number(process.env.DEVICE_LIMIT_DEFAULT ?? 2),
    logLevel: process.env.LOG_LEVEL ?? 'info',
  }
}

/* ── 3) INSTANCIA ÚNICA EXPORTADA ────────────────────────────────────── */

/** Configuración validada del servidor (única instancia al importar). */
export const env = loadEnv()
