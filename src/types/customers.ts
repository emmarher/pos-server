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
  /** Nombre del cliente */
  name: string
  /** Descripción o datos adicionales */
  description: string | null
  /** Teléfono de contacto */
  phone: string | null
  /** Correo electrónico */
  email: string | null
  /** Domicilio */
  address: string | null
  /** RFC (tax ID) */
  rfc: string | null
  /** Límite de crédito en pesos */
  credit_limit: number
  /** Saldo actual debito ( negativo en customer_credits ) */
  current_balance: number
  /** Puntos de lealtad */
  loyalty_points: number
  /** Valor unitario de los puntos */
  loyalty_points_value: number
  /** ¿Activo? */
  is_active: boolean
  /** Fecha de creación */
  created_at: string
  /** Fecha de última actualización */
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

/** Datos para crear un cliente. */
export interface CustomerInput {
  name: string
  /** Opcional: descripción o datos adicionales. */
  description?: string | null
  /** Opcional: teléfono. */
  phone?: string | null
  /** Opcional: correo electrónico. */
  email?: string | null
  /** Opcional: dirección. */
  address?: string | null
  /** Opcional: RFC. */
  rfc?: string | null
  /** Límite de crédito (default: 0 = sin crédito). */
  credit_limit?: number
  /** ¿Activo por defecto? */
  is_active?: boolean
}

/** Abono o cargo a crédito (RF-VE-005). */
export interface CustomerCreditAdjustment {
  /** Monto negativo = abono (reduce saldo). Monto positivo = cargo. */
  amount: number
  /** Motivo obligatorio. */
  reason: string
  /** Tipo: 'ADJUSTMENT' (cargo) o 'PAYMENT' (abono). */
  type: 'ADJUSTMENT' | 'PAYMENT'
}

/** Parámetros de pago para venta a crédito. */
export interface CustomerPaymentPayload {
  /** ID del cliente. */
  customer_id: string
  /** Monto a cargar (positive) o abono (negative). */
  amount: number
  /** Motivo obligatorio. */
  reason: string
}

/** Respuesta de venta a crédito. */
export interface CustomerCreditResponse {
  /** Nuevo saldo del cliente. */
  new_balance: number
  /** ¿Ultraa el límite? */
  exceeded_limit: boolean
  /** Mensaje de validación. */
  message: string
}