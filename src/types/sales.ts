/**
 * src/types/sales.ts — Contrato del módulo de ventas.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Espejo EXACTO del contrato de pos-mobile (src/models: SaleItemPayload,
 * CreateSalePayload, SaleResponse, PaymentMethod, SalePayment) y de las
 * columnas de venta en esquema_BD_POS_v4_completo.sql (sales, sale_items,
 * sale_payments). Nada se inventa: solo se tipa lo que ya existe.
 *
 * Flujo (RF-VE-002): el móvil construye el payload con buildSalePayload()
 * y lo envía a POST /sales; el servidor recalcula precios/descuentos desde
 * la BD (fuente de verdad) y devuelve SaleResponse.
 * ────────────────────────────────────────────────────────────────────────
 */

/** Métodos de pago (RF-VE-004) — vocabulario del esquema. */
export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER' | 'CREDIT' | 'VOUCHER'

/** Ítem del payload de POST /sales (espejo de SaleItemPayload). */
export interface SaleItemPayload {
  product_id: string
  /** Cantidad vendida (COUNT; CAJ: 1, el peso va en alternate_quantity). */
  quantity: number
  /** CAJ / venta por peso: kg netos leídos de la báscula. */
  alternate_quantity?: number
  unit_price: number
  discount: number
  subtotal: number
  base_quantity: number
  price_type_id: string
}

/** Pago del payload de POST /sales (espejo de SalePayment). */
export interface SalePaymentPayload {
  method: PaymentMethod
  amount: number
  /** Tarjeta: últimos 4 dígitos; Transferencia: folio; Voucher: referencia. */
  reference_code?: string
}

/** Body de POST /sales (espejo de CreateSalePayload). */
export interface CreateSalePayload {
  customer_id?: string
  items: SaleItemPayload[]
  payments: SalePaymentPayload[]
  subtotal: number
  total_discount: number
  total: number
}

/** Respuesta de POST /sales (espejo de SaleResponse). */
export interface SaleResponse {
  id: string
  tenant_id: string
  /** folio_display generado por la BD: V-000001. */
  folio: string
  status: string
  payment_state: string
  subtotal: number
  total_discount: number
  total: number
  /** Vuelto en efectivo (0 si no hubo cambio). */
  payment_change?: number
  created_at: string
  /** Evento QoS creado por trigger (null si no aplicó). */
  qos_event_id?: string
}

/** Pago tal como vive en sale_payments (para GET /sales/:id). */
export interface SalePayment {
  id: string
  method: PaymentMethod
  amount: number
  reference_code: string | null
  change_amount: number
  created_at: string
}

/** Ítem tal como vive en sale_items (para GET /sales/:id). */
export interface SaleItem {
  id: string
  product_id: string
  product_name: string
  product_barcode: string | null
  price_type_id: string | null
  quantity: number
  base_quantity: number
  alternate_quantity: number | null
  unit_id: string
  unit_price: number
  discount_applied: number
  subtotal: number
}

/** Venta completa con sus ítems y pagos (GET /sales/:id). */
export interface SaleDetail {
  id: string
  tenant_id: string
  device_id: string
  seller_id: string
  customer_id: string | null
  folio_number: number
  folio_prefix: string
  folio: string
  subtotal: number
  discount: number
  tax: number
  total: number
  status: string
  payment_state: string
  cancel_reason: string | null
  notes: string | null
  created_at: string
  items: SaleItem[]
  payments: SalePayment[]
}
