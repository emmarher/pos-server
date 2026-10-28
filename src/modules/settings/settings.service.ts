/**
 * settings.service.ts — Configuración del negocio (multi-tenant).
 *
 * Fuente del nombre visible:
 *   1) license_state.customer (lo firmado en el .lic) — decisión D1.
 *   2) tenant_settings.business_name — fallback D10.
 *   3) tenants.name — último recurso.
 */
import { db } from '../../database/client.js'
import { HttpError } from '../../types/errors.js'
import {
  deleteImage,
  keyFromUrl,
  uploadMerchantLogo,
} from '../../services/storage.service.js'

/** Configuración que consume la pestaña Ajustes y el navbar. */
export interface TenantSettingsView {
  business_name: string | null
  /** Nombre a mostrar: licencia > business_name > tenants.name */
  display_name: string
  address: string | null
  phone: string | null
  email: string | null
  rfc: string | null
  tax_rate: number
  currency: string
  ticket_header: string
  receipt_footer: string | null
  logo_url: string | null
  timezone: string
}

/** Campos editables desde la app (business_name NO: lo manda la licencia). */
export interface TenantSettingsPatch {
  address?: string | null
  phone?: string | null
  email?: string | null
  rfc?: string | null
  tax_rate?: number
  currency?: string
  ticket_header?: string | null
  receipt_footer?: string | null
}

/** Mapa campo de API → columna real de tenant_settings. */
const FIELD_COLUMNS: Record<keyof TenantSettingsPatch, string> = {
  address: 'business_address',
  phone: 'business_phone',
  email: 'business_email',
  rfc: 'business_rfc',
  tax_rate: 'tax_rate',
  currency: 'currency',
  ticket_header: 'ticket_header',
  receipt_footer: 'ticket_footer',
}

interface SettingsRow {
  business_name: string | null
  business_address: string | null
  business_phone: string | null
  business_email: string | null
  business_rfc: string | null
  tax_rate: number
  currency: string
  ticket_header: string
  ticket_footer: string | null
  logo_url: string | null
  timezone: string
  tenant_name: string | null
  license_customer: string | null
}

/** Lee configuración + nombre resuelto del negocio. */
export async function getTenantSettings(tenantId: string): Promise<TenantSettingsView> {
  const { rows } = await db.query<SettingsRow>(
    `SELECT ts.business_name, ts.business_address, ts.business_phone, ts.business_email,
            ts.business_rfc,
            COALESCE(ts.tax_rate, 16) AS tax_rate,
            COALESCE(ts.currency, 'MXN') AS currency,
            COALESCE(ts.ticket_header, '') AS ticket_header,
            ts.ticket_footer,
            ts.logo_url,
            COALESCE(ts.timezone, 'America/Mexico_City') AS timezone,
            t.name AS tenant_name,
            ls.customer AS license_customer
     FROM tenants t
     LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
     LEFT JOIN license_state ls ON ls.tenant_id = t.id
     WHERE t.id = $1`,
    [tenantId],
  )
  const row = rows[0]
  if (!row) throw new HttpError('NOT_FOUND', 'Comercio no encontrado')

  // Prioridad acordada: licencia → business_name → nombre del tenant.
  const display_name =
    row.license_customer?.trim() ||
    row.business_name?.trim() ||
    row.tenant_name?.trim() ||
    ''

  return {
    business_name: row.business_name,
    display_name,
    address: row.business_address,
    phone: row.business_phone,
    email: row.business_email,
    rfc: row.business_rfc,
    tax_rate: Number(row.tax_rate),
    currency: row.currency,
    ticket_header: row.ticket_header ?? '',
    receipt_footer: row.ticket_footer,
    logo_url: row.logo_url,
    timezone: row.timezone,
  }
}

/** Actualiza solo los campos enviados (upsert de tenant_settings). */
export async function updateTenantSettings(
  tenantId: string,
  patch: TenantSettingsPatch,
): Promise<TenantSettingsView> {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return getTenantSettings(tenantId)

  const now = new Date().toISOString()
  // Garantiza la fila de settings antes del UPDATE (tenants creados por fixture).
  await db.query(
    `INSERT INTO tenant_settings (tenant_id, created_at, updated_at)
     VALUES ($1, $2, $2)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, now],
  )

  const sets: string[] = []
  const values: unknown[] = [tenantId]
  let idx = 2
  for (const [field, value] of entries) {
    const column = FIELD_COLUMNS[field as keyof TenantSettingsPatch]
    sets.push(`${column} = $${idx++}`)
    values.push(value)
  }
  values.push(now)

  await db.query(
    `UPDATE tenant_settings SET ${sets.join(', ')}, updated_at = $${idx}
     WHERE tenant_id = $1`,
    values,
  )
  return getTenantSettings(tenantId)
}

/** Sube el logo y borra el anterior (si pertenece al tenant). */
export async function saveMerchantLogo(
  tenantId: string,
  buffer: Buffer,
): Promise<{ logo_url: string }> {
  const current = await getTenantSettings(tenantId)
  const uploaded = await uploadMerchantLogo(tenantId, buffer)

  // Upsert de settings + ruta relativa del proxy.
  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO tenant_settings (tenant_id, logo_url, created_at, updated_at)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (tenant_id) DO UPDATE SET logo_url = $2, updated_at = $3`,
    [tenantId, uploaded.url, now],
  )

  const oldKey = keyFromUrl(current.logo_url, tenantId)
  if (oldKey && oldKey !== uploaded.key) {
    await deleteImage(oldKey)
  }
  return { logo_url: uploaded.url }
}

/** Quita el logo del comercio (BD + bucket). */
export async function removeMerchantLogo(tenantId: string): Promise<{ logo_url: null }> {
  const current = await getTenantSettings(tenantId)
  const now = new Date().toISOString()
  await db.query(
    `UPDATE tenant_settings SET logo_url = NULL, updated_at = $2 WHERE tenant_id = $1`,
    [tenantId, now],
  )
  const oldKey = keyFromUrl(current.logo_url, tenantId)
  if (oldKey) await deleteImage(oldKey)
  return { logo_url: null }
}
