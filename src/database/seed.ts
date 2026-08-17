/**
 * src/database/seed.ts — Seed de desarrollo (CLI: npm run seed).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Crea un tenant DEMO con usuario admin + vendedor para poder probar el
 * login y el resto de módulos antes de tener el flujo de registro real.
 * Es IDEMPOTENTE: si el tenant ya existe, no duplica nada.
 *
 * Lo que crea (fiel al esquema autoritativo):
 *   - tenants (license_key = 'DEMO-0001' → se usa como tenant_code)
 *   - tenant_settings (nombre del negocio, pie de ticket)
 *   - roles Administrador (TODOS los permisos) y Vendedor (subconjunto
 *     del PRD RF-RO-002: las filas con ✅ en la columna Vendedor)
 *   - usuarios admin (PIN 1234) y vendedor (PIN 5678) con bcrypt
 *   - user_roles + role_permissions
 *   - price_types por tenant (Público RETAIL default, Mayoreo WHOLESALE)
 *   - inventory_locations (Tienda Principal)
 *
 * NOTA: measurement_units ya se siembran en la migración 001 (globales,
 * tenant_id NULL) igual que en el esquema PG.
 * ────────────────────────────────────────────────────────────────────────
 */
import bcrypt from 'bcryptjs'
import { db } from './client.js'

/** Código de tenant demo (el PRD lo llama tenant_code; aquí es license_key) */
export const DEMO_TENANT_CODE = 'DEMO-0001'

/** PINs de prueba (4-6 dígitos, RF-AU-002) */
const ADMIN_PIN = '1234'
const VENDEDOR_PIN = '5678'

/** Permisos que el PRD otorga al rol Vendedor (RF-RO-002, columna ✅) */
const VENDEDOR_PERMISSIONS = [
  'products:read',
  'categories:read',
  'sales:create',
  'sales:read_own',
  'customers:read',
  'cashier:cut_own',
  'print:delegate',
  'scale:read',
]

/** Si el tenant demo ya existe, no volver a sembrar. */
async function tenantExists(): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM tenants WHERE license_key = $1',
    [DEMO_TENANT_CODE],
  )
  return rows.length > 0
}

/** Crea el tenant demo + todo lo que depende de él. */
export async function seedDemo(): Promise<void> {
  if (await tenantExists()) {
    console.log('Tenant demo ya existe — seed omitido.')
    return
  }

  const nowIso = new Date().toISOString()
  // Licencia válida 1 año a partir de hoy (pruebas)
  const expiresAt = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()

  await db.transaction(async (tx) => {
    /* 1) Tenant + settings */
    await tx.query(
      `INSERT INTO tenants (name, license_key, license_expires_at, max_devices, max_branches, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, 1, $5, $5)`,
      ['Tenant Demo', DEMO_TENANT_CODE, expiresAt, 3, nowIso],
    )
    const tenantRows = await tx.query<{ id: string }>(
      'SELECT id FROM tenants WHERE license_key = $1',
      [DEMO_TENANT_CODE],
    )
    const tenantId = tenantRows.rows[0]?.id
    if (!tenantId) throw new Error('No se pudo crear el tenant demo')

    await tx.query(
      `INSERT INTO tenant_settings (tenant_id, business_name, business_address, business_phone, ticket_footer, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [
        tenantId,
        'Tienda Demo S.A.',
        'Av. Principal 123',
        '555-1234',
        'Gracias por su compra',
        nowIso,
      ],
    )

    /* 2) price_types por tenant (Público default + Mayoreo + Especial) */
    await tx.query(
      `INSERT INTO price_types (tenant_id, name, code, is_default, is_active, created_at, updated_at)
       VALUES ($1, 'Público', 'RETAIL', 1, 1, $2, $2)`,
      [tenantId, nowIso],
    )
    await tx.query(
      `INSERT INTO price_types (tenant_id, name, code, is_default, is_active, created_at, updated_at)
       VALUES ($1, 'Mayoreo', 'WHOLESALE', 0, 1, $2, $2)`,
      [tenantId, nowIso],
    )
    await tx.query(
      `INSERT INTO price_types (tenant_id, name, code, is_default, is_active, created_at, updated_at)
       VALUES ($1, 'Especial', 'SPECIAL', 0, 1, $2, $2)`,
      [tenantId, nowIso],
    )

    /* 3) inventory_locations por tenant */
    await tx.query(
      `INSERT INTO inventory_locations (tenant_id, name, code, is_active, created_at, updated_at)
       VALUES ($1, 'Tienda Principal', 'STORE', 1, $2, $2)`,
      [tenantId, nowIso],
    )

    /* 4) Roles: Administrador (todos) y Vendedor (subconjunto PRD) */
    await tx.query(
      `INSERT INTO roles (tenant_id, name, is_default, is_active, created_at, updated_at)
       VALUES ($1, 'Administrador', 1, 1, $2, $2)`,
      [tenantId, nowIso],
    )
    await tx.query(
      `INSERT INTO roles (tenant_id, name, is_default, is_active, created_at, updated_at)
       VALUES ($1, 'Vendedor', 0, 1, $2, $2)`,
      [tenantId, nowIso],
    )
    const roleRows = await tx.query<{ id: string; name: string }>(
      'SELECT id, name FROM roles WHERE tenant_id = $1',
      [tenantId],
    )
    const roleIds = new Map(roleRows.rows.map((r) => [r.name, r.id]))
    const adminRoleId = roleIds.get('Administrador')
    const vendedorRoleId = roleIds.get('Vendedor')
    if (!adminRoleId || !vendedorRoleId) {
      throw new Error('No se pudieron crear los roles')
    }

    /* 5) Permisos → roles */
    const permRows = await tx.query<{ id: string; code: string }>(
      'SELECT id, code FROM permissions',
    )
    const permIds = new Map(permRows.rows.map((p) => [p.code, p.id]))

    for (const [code, permId] of permIds) {
      if (!permId) continue
      // Administrador: TODOS los permisos
      await tx.query(
        'INSERT INTO role_permissions (role_id, permission_id, created_at) VALUES ($1, $2, $3)',
        [adminRoleId, permId, nowIso],
      )
      // Vendedor: solo el subconjunto del PRD
      if (VENDEDOR_PERMISSIONS.includes(code)) {
        await tx.query(
          'INSERT INTO role_permissions (role_id, permission_id, created_at) VALUES ($1, $2, $3)',
          [vendedorRoleId, permId, nowIso],
        )
      }
    }

    /* 6) Usuarios + roles asignados */
    const adminHash = bcrypt.hashSync(ADMIN_PIN, 10)
    const vendedorHash = bcrypt.hashSync(VENDEDOR_PIN, 10)

    await tx.query(
      `INSERT INTO users (tenant_id, name, pin_hash, email, is_active, created_at, updated_at)
       VALUES ($1, 'Administrador', $2, 'admin@demo.local', 1, $3, $3)`,
      [tenantId, adminHash, nowIso],
    )
    await tx.query(
      `INSERT INTO users (tenant_id, name, pin_hash, email, is_active, created_at, updated_at)
       VALUES ($1, 'Vendedor', $2, 'vendedor@demo.local', 1, $3, $3)`,
      [tenantId, vendedorHash, nowIso],
    )
    const userRows = await tx.query<{ id: string; name: string }>(
      'SELECT id, name FROM users WHERE tenant_id = $1',
      [tenantId],
    )
    const userIds = new Map(userRows.rows.map((u) => [u.name, u.id]))

    const adminUserId = userIds.get('Administrador')
    const vendedorUserId = userIds.get('Vendedor')
    if (!adminUserId || !vendedorUserId) {
      throw new Error('No se pudieron crear los usuarios')
    }

    await tx.query(
      'INSERT INTO user_roles (user_id, role_id, created_at) VALUES ($1, $2, $3)',
      [adminUserId, adminRoleId, nowIso],
    )
    await tx.query(
      'INSERT INTO user_roles (user_id, role_id, created_at) VALUES ($1, $2, $3)',
      [vendedorUserId, vendedorRoleId, nowIso],
    )
  })

  console.log(
    `Tenant demo creado:
  tenant_code: ${DEMO_TENANT_CODE}
  admin PIN:   ${ADMIN_PIN}
  vendedor PIN:${VENDEDOR_PIN}`,
  )
}

/* ── CLI: se ejecuta solo cuando este archivo es el punto de entrada ──── */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const isMain =
  process.argv[1] != null && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  seedDemo()
    .then(() => db.end())
    .catch(async (err) => {
      console.error('Error al sembrar:', err)
      await db.end()
      process.exit(1)
    })
}
