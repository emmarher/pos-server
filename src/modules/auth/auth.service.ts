/**
 * src/modules/auth/auth.service.ts — Lógica de negocio de autenticación.
 *
 * ────────────────────────────────────────────────────────────────────────
 * LOGIN (RF-AU-002), en orden:
 *   1) Resolver tenant por license_key (= tenant_code, única clave única
 *      humana del esquema; RF-AU-001 genera license_key por tenant).
 *   2) Validar licencia: is_active AND now < license_expires_at.
 *      Vencida → 403 LICENSE_EXPIRED (bloqueo total, RF-AU-003).
 *   3) Validar PIN del usuario (bcrypt contra users.pin_hash).
 *   4) Límite de dispositivos (RF-AU-004): si el device_id ya está
 *      registrado en el tenant se reutiliza; si es NUEVO y el tenant ya
 *      tiene max_devices activos → 403 DEVICE_LIMIT.
 *   5) Registrar/actualizar device_registrations + device_capabilities.
 *   6) Resolver permisos: user_roles → roles → role_permissions →
 *      permissions (una sola vez; se incrustan en el JWT).
 *   7) Firmar access (24h) + refresh (30d), registrar active_sessions.
 *
 * REFRESH (POST /auth/refresh):
 *   - Verifica el refresh token, busca la sesión activa por hash, emite
 *     un access token nuevo (rota el refresh: revoca el anterior).
 *
 * MULTI-TENANT: toda query lleva tenant_id explícito o se resuelve por
 * la clave del tenant; nunca se confía en un tenant_id del body.
 * ────────────────────────────────────────────────────────────────────────
 */
import { createHash } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'
import { env } from '../../config/env.js'
import { db } from '../../database/client.js'
import {
  getLicenseStatus,
  checkExpiryWarnings,
} from '../license/license.service.js'
import type { AuthResponse, AuthJwtPayload } from '../../types/auth.js'
import { HttpError } from '../../types/errors.js'

/* ── Tipos internos ───────────────────────────────────────────────────── */

interface TenantRow {
  id: string
  name: string
  license_key: string
  license_expires_at: string
  max_devices: number
  is_active: number
}

interface UserRow {
  id: string
  name: string
  pin_hash: string | null
  is_active: number
}

/* ── Constantes ───────────────────────────────────────────────────────── */

/** Vigencia del refresh token en segundos (default 30 días). */
const REFRESH_EXPIRES_IN = env.jwtRefreshExpiresIn

/** Duración real del access token en segundos (24h por PRD). */
const ACCESS_EXPIRES_IN = env.jwtExpiresIn

/** Normaliza device_type del móvil ('PC') al CHECK del esquema. */
function normalizeDeviceType(raw: string): 'TABLET' | 'DESKTOP' | 'PHONE' {
  if (raw === 'PC') return 'DESKTOP'
  if (raw === 'TABLET' || raw === 'DESKTOP' || raw === 'PHONE') return raw
  throw new HttpError('VALIDATION_ERROR', `device_type inválido: ${raw}`)
}

/** Hash SHA-256 del refresh token (para active_sessions.jwt_token_hash). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Licencia activa: tenant activo y fecha de vencimiento futura. */
function licenseStatus(tenant: TenantRow, now: Date): 'active' | 'expired' {
  return tenant.is_active === 1 &&
    new Date(tenant.license_expires_at).getTime() > now.getTime()
    ? 'active'
    : 'expired'
}

/* ── Login ────────────────────────────────────────────────────────────── */

export interface LoginInput {
  tenant_code: string
  pin: string
  device_id: string
  device_name: string
  device_type: string
}

/**
 * POST /auth/login. Valida licencia + PIN + límite de dispositivos y
 * devuelve tokens + configuración del tenant (RF-AU-002).
 */
export async function login(
  app: FastifyInstance,
  input: LoginInput,
): Promise<AuthResponse> {
  /* 1) Tenant por license_key (única clave única humana del esquema) */
  const tenantRows = await db.query<TenantRow>(
    'SELECT id, name, license_key, license_expires_at, max_devices, is_active FROM tenants WHERE license_key = $1',
    [input.tenant_code.trim()],
  )
  const tenant = tenantRows.rows[0]
  if (!tenant) {
    throw new HttpError('UNAUTHORIZED', 'Código de tenant o PIN incorrecto')
  }

  /* 2) Licencia activa — vencida = bloqueo total */
  const now = new Date()
  if (licenseStatus(tenant, now) !== 'active') {
    throw new HttpError(
      'LICENSE_EXPIRED',
      'Licencia vencida. Contacte a soporte.',
    )
  }

  /* 3) PIN del usuario (4-6 dígitos, hash bcrypt) */
  const userRows = await db.query<UserRow>(
    'SELECT id, name, pin_hash, is_active FROM users WHERE tenant_id = $1 AND is_active = 1',
    [tenant.id],
  )
  const user = userRows.rows.find((u) => u.pin_hash && bcrypt.compareSync(input.pin, u.pin_hash))
  if (!user) {
    throw new HttpError('UNAUTHORIZED', 'Código de tenant o PIN incorrecto')
  }

  /* 4) Límite de dispositivos (RF-AU-004) */
  const deviceType = normalizeDeviceType(input.device_type)
  const deviceId = input.device_id.trim()

  const existing = await db.query<{ id: string }>(
    'SELECT id FROM device_registrations WHERE tenant_id = $1 AND device_id = $2 AND is_active = 1',
    [tenant.id, deviceId],
  )

  if (existing.rows.length === 0) {
    const count = await db.query<{ c: number }>(
      'SELECT COUNT(*) AS c FROM device_registrations WHERE tenant_id = $1 AND is_active = 1',
      [tenant.id],
    )
    const activeDevices = count.rows[0]?.c ?? 0
    if (activeDevices >= tenant.max_devices) {
      throw new HttpError(
        'DEVICE_LIMIT',
        `Límite de dispositivos alcanzado (${tenant.max_devices}). Desvincule un dispositivo desde la administración.`,
      )
    }
  }

  /* 5) Registrar / actualizar dispositivo (UPSERT por UNIQUE tenant+device) */
  const nowIso = now.toISOString()
  await db.query(
    `INSERT INTO device_registrations (tenant_id, device_id, device_name, device_type, is_active, last_seen_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $5)
     ON CONFLICT (tenant_id, device_id)
     DO UPDATE SET device_name = excluded.device_name,
                   device_type = excluded.device_type,
                   is_active = 1,
                   last_seen_at = excluded.last_seen_at,
                   updated_at = excluded.updated_at`,
    [tenant.id, deviceId, input.device_name.trim(), deviceType, nowIso],
  )

  await db.query(
    `INSERT INTO device_capabilities (device_id, tenant_id, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (device_id) DO UPDATE SET tenant_id = excluded.tenant_id, updated_at = excluded.updated_at`,
    [deviceId, tenant.id, nowIso],
  )

  /* 6) Permisos del usuario (rol → permisos) */
  const { permissions, roleName } = await resolvePermissions(user.id)

  /* 7) Tokens + sesión */
  const accessToken = signAccess(app, {
    sub: user.id,
    tenant_id: tenant.id,
    device_id: deviceId,
    role_name: roleName,
    permissions,
  })
  const refreshToken = signRefresh(app, {
    sub: user.id,
    tenant_id: tenant.id,
    device_id: deviceId,
    role_name: roleName,
    permissions: [],
  })

  const isHeartbeatExempt = roleName === 'Administrador' ? 1 : 0
  await db.query(
    `INSERT INTO active_sessions (tenant_id, device_id, user_id, jwt_token_hash, expires_at, ip_address, updated_at, last_heartbeat_at, is_heartbeat_exempt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tenant.id,
      deviceId,
      user.id,
      hashToken(refreshToken),
      new Date(now.getTime() + REFRESH_EXPIRES_IN * 1000).toISOString(),
      null,
      nowIso,
      nowIso,
      isHeartbeatExempt,
    ],
  )

  /* 8) Configuración del tenant para la app (RF-AU-002) */
  const tenantInfo = await loadTenantInfo(tenant.id)

  /* Enriquecer license con datos de license_state (lic_id, customer, features)
     y warning_level de vencimiento (30/7 días). */
  const licenseInfo = await getLicenseStatus(tenant.id)
  const isLicenseExpired = licenseStatus(tenant, now) !== 'active'
  const enrichedLicense = {
    lic_id: licenseInfo.lic_id ?? null,
    customer: licenseInfo.customer ?? null,
    features: licenseInfo.features ?? [],
    warning_level: isLicenseExpired ? null : checkExpiryWarnings(tenant.license_expires_at),
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: ACCESS_EXPIRES_IN,
    user: {
      id: user.id,
      tenant_id: tenant.id,
      name: user.name,
      role_name: roleName,
      permissions,
    },
    tenant: tenantInfo.tenant,
    device: {
      device_id: deviceId,
      tenant_id: tenant.id,
      device_name: input.device_name.trim(),
      device_type: deviceType,
      can_print: false,
      can_scale: false,
    },
    license: {
      status: licenseStatus(tenant, now),
      expires_at: tenant.license_expires_at,
      max_devices: tenant.max_devices,
      ...enrichedLicense,
    },
  }
}

/* ── Refresh ──────────────────────────────────────────────────────────── */

/**
 * POST /auth/refresh. Valida el refresh token contra active_sessions y
 * emite un access token nuevo (rota el refresh y revoca el anterior).
 */
export async function refresh(
  app: FastifyInstance,
  refreshToken: string,
): Promise<AuthResponse> {
  let payload: AuthJwtPayload
  try {
    payload = app.jwt.verify<AuthJwtPayload>(refreshToken)
  } catch {
    throw new HttpError('UNAUTHORIZED', 'Sesión expirada. Inicie sesión de nuevo.')
  }

  if (payload.typ !== 'refresh') {
    throw new HttpError('UNAUTHORIZED', 'Token de refresco inválido')
  }

  /* Sesión activa y vigente por hash del refresh token */
  const sessions = await db.query<{ is_valid: number; expires_at: string }>(
    'SELECT is_valid, expires_at FROM active_sessions WHERE tenant_id = $1 AND device_id = $2 AND user_id = $3 AND jwt_token_hash = $4',
    [payload.tenant_id, payload.device_id, payload.sub, hashToken(refreshToken)],
  )
  const session = sessions.rows[0]
  if (
    !session ||
    session.is_valid !== 1 ||
    new Date(session.expires_at).getTime() <= Date.now()
  ) {
    throw new HttpError('UNAUTHORIZED', 'Sesión expirada. Inicie sesión de nuevo.')
  }

  /* Licencia sigue activa (bloqueo total si venció) */
  const tenantRows = await db.query<{ license_expires_at: string; is_active: number }>(
    'SELECT license_expires_at, is_active FROM tenants WHERE id = $1',
    [payload.tenant_id],
  )
  const tenant = tenantRows.rows[0]
  if (!tenant || tenant.is_active !== 1 || new Date(tenant.license_expires_at).getTime() <= Date.now()) {
    throw new HttpError('LICENSE_EXPIRED', 'Licencia vencida. Contacte a soporte.')
  }

  /* Rotar refresh: revoca el anterior y emite uno nuevo */
  await db.query(
    'UPDATE active_sessions SET is_valid = 0 WHERE jwt_token_hash = $1',
    [hashToken(refreshToken)],
  )

  const newRefresh = signRefresh(app, {
    sub: payload.sub,
    tenant_id: payload.tenant_id,
    device_id: payload.device_id,
    role_name: payload.role_name,
    permissions: [],
  })
  const nowIso = new Date().toISOString()
  const isExemptRefresh = payload.role_name === 'Administrador' ? 1 : 0
  await db.query(
    `INSERT INTO active_sessions (tenant_id, device_id, user_id, jwt_token_hash, expires_at, ip_address, updated_at, last_heartbeat_at, is_heartbeat_exempt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      payload.tenant_id,
      payload.device_id,
      payload.sub,
      hashToken(newRefresh),
      new Date(Date.now() + REFRESH_EXPIRES_IN * 1000).toISOString(),
      null,
      nowIso,
      nowIso,
      isExemptRefresh,
    ],
  )

  const newAccess = signAccess(app, payload)

  const tenantInfo = await loadTenantInfo(payload.tenant_id)
  const userRows = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM users WHERE id = $1',
    [payload.sub],
  )
  const user = userRows.rows[0]

  /* Enriquecer license con datos de license_state */
  const licenseInfo = await getLicenseStatus(payload.tenant_id)
  return {
    access_token: newAccess,
    refresh_token: newRefresh,
    token_type: 'Bearer',
    expires_in: ACCESS_EXPIRES_IN,
    user: {
      id: payload.sub,
      tenant_id: payload.tenant_id,
      name: user?.name ?? '',
      role_name: payload.role_name,
      permissions: payload.permissions,
    },
    tenant: tenantInfo.tenant,
    device: {
      device_id: payload.device_id,
      tenant_id: payload.tenant_id,
      device_name: '',
      device_type: 'TABLET',
      can_print: false,
      can_scale: false,
    },
    license: {
      status: 'active', // refresh implica licencia válida (ya se verificó arriba)
      expires_at: tenant.license_expires_at,
      max_devices: licenseInfo.max_devices,
      lic_id: licenseInfo.lic_id ?? null,
      customer: licenseInfo.customer ?? null,
      features: licenseInfo.features,
      warning_level: licenseInfo.warning_level,
    },
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

/** Permisos del usuario por sus roles + nombre del primer rol activo. */
async function resolvePermissions(
  userId: string,
): Promise<{ permissions: string[]; roleName: string | null }> {
  const { rows } = await db.query<{ code: string; role_name: string | null }>(
    `SELECT DISTINCT p.code, r.name AS role_name
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id AND r.is_active = 1
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1`,
    [userId],
  )
  const permissions = rows.map((r) => r.code)
  const roleName = rows[0]?.role_name ?? null
  return { permissions, roleName }
}

/** Datos de tenant_settings que consume la app (móvil). */
async function loadTenantInfo(tenantId: string): Promise<{
  tenant: AuthResponse['tenant']
}> {
  const { rows } = await db.query<{
    id: string
    business_name: string | null
    business_address: string | null
    business_phone: string | null
    ticket_footer: string | null
  }>(
    `SELECT ts.business_name, ts.business_address, ts.business_phone, ts.ticket_footer
     FROM tenant_settings ts WHERE ts.tenant_id = $1`,
    [tenantId],
  )
  const row = rows[0]
  return {
    tenant: {
      id: tenantId,
      tenant_id: tenantId,
      business_name: row?.business_name ?? '',
      address: row?.business_address ?? null,
      phone: row?.business_phone ?? null,
      receipt_footer: row?.ticket_footer ?? null,
    },
  }
}

/** Firma el access token (24h, lleva permisos para requirePermission). */
function signAccess(
  app: FastifyInstance,
  payload: Omit<AuthJwtPayload, 'typ'>,
): string {
  return app.jwt.sign(
    { ...payload, typ: 'access' },
    { expiresIn: ACCESS_EXPIRES_IN },
  )
}

/** Firma el refresh token (30d, sin permisos). */
function signRefresh(
  app: FastifyInstance,
  payload: Omit<AuthJwtPayload, 'typ'>,
): string {
  return app.jwt.sign(
    { ...payload, typ: 'refresh' },
    { expiresIn: REFRESH_EXPIRES_IN },
  )
}
