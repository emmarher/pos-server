/**
 * src/types/auth.ts — Payload JWT y contrato del módulo de autenticación.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Contenido:
 *   1) AuthJwtPayload — datos que viajan DENTRO del JWT (access y refresh).
 *   2) Declaración de merging para @fastify/jwt (request.user tipado).
 *   3) Tipos de respuesta del login espejo de pos-mobile/src/models
 *      (AuthResponse). El frontend ya tipa contra este contrato.
 *
 * NOTA DE DISEÑO (tenant_code):
 *   - El PRD pide login con "código de tenant" (RF-AU-002) pero el esquema
 *     autoritativo NO tiene columna `tenant_code` en `tenants`. La única
 *     clave humana única por tenant es `license_key` (NOT NULL UNIQUE,
 *     generada en RF-AU-001). Por eso el servidor resuelve el tenant
 *     buscando `tenants.license_key = tenant_code`.
 * ────────────────────────────────────────────────────────────────────────
 */
import type { ErrorCode } from './index.js'

/* ── 1) PAYLOAD JWT ───────────────────────────────────────────────────── */

/**
 * Payload de los JWT del POS. `permissions` se incrusta en el token en el
 * login (rol → permisos resueltos una sola vez) para no golpear la BD en
 * cada request; el middleware requirePermission valida contra este array.
 */
export interface AuthJwtPayload {
  /** user_id (sub estándar del JWT) */
  sub: string
  /** tenant_id del usuario — toda query debe filtrar por esto */
  tenant_id: string
  /** device_id desde el que se hizo login (RF-AU-004) */
  device_id: string
  /** Nombre del rol principal (Administrador/Vendedor) */
  role_name: string | null
  /** Códigos de permiso del usuario (permisos → roles → usuario) */
  permissions: string[]
  /** 'access' (24h) o 'refresh' (30d) — el refresh NO lleva permisos */
  typ: 'access' | 'refresh'
}

/* ── 2) MERGING PARA @fastify/jwt ─────────────────────────────────────── */

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthJwtPayload
    user: AuthJwtPayload
  }
}

/* ── 3) CONTRATO DE RESPUESTA (login / refresh) ───────────────────────── */

/** Respuesta de login espejo de pos-mobile AuthResponse. */
export interface AuthResponse {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  user: AuthUserInfo
  tenant: AuthTenantInfo
  device: AuthDeviceInfo
  license: AuthLicenseInfo
}

export interface AuthUserInfo {
  id: string
  tenant_id: string
  name: string
  role_name: string | null
  permissions: string[]
}

export interface AuthTenantInfo {
  id: string
  tenant_id: string
  business_name: string
  address: string | null
  phone: string | null
  receipt_footer: string | null
}

export interface AuthDeviceInfo {
  device_id: string
  tenant_id: string
  device_name: string
  device_type: string
  can_print: boolean
  can_scale: boolean
}

export interface AuthLicenseInfo {
  status: 'active' | 'expired' | 'grace'
  expires_at: string
  max_devices: number
}

/* ── Códigos de error del módulo auth (re-export para comodidad) ──────── */

export type AuthErrorCode = Extract<
  ErrorCode,
  | 'UNAUTHORIZED'
  | 'LICENSE_EXPIRED'
  | 'DEVICE_LIMIT'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
>
