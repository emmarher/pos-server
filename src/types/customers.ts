/**
 * src/types/customers.ts — Contrato del módulo de clientes y crédito (RF-VE-005).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Espejo EXACTO de las columnas de esquema_BD_POS_v4_completo.sql
 * (tablas: customers, customer_credits).
 * Nada se inventa: solo se tipa lo que ya existe en el esquema autoritativo.
 * ────────────────────────────────────────────────────────────────────────
 */

/** Cliente (RF-VE-005). */
export interface Customer {
  id: string
  tenant_id: string
  name: string
  description: string | null
  phone: string | null
  email: string | null
  address: string | null
  rfc: string | null
  credit_limit: number
  current_balance: number
  loyalty_points: number
  loyalty_points_value: number
  is_active: boolean
  created_at: string
  updated_at: string
}

/** Resultado de búsqueda de clientes (RF-VE-005, limit 10). */
export interface CustomerSearchResult {
  items: Customer[]
  total: number
}

/** Parámetros de query para listar clientes. */
export interface CustomerQuery {
  /** Búsqueda por nombre (LIKE). */
  q?: string
  /** Sólo activos (default: true). */
  activeOnly?: boolean
  /** Límite (default: 20). */
  limit?: number
  /** Offset. */
  offset?: number
}