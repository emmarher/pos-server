/**
 * src/types/inventory.ts — Contrato del módulo de inventario (RF-IN).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Espejo EXACTO de las columnas de esquema_BD_POS_v4_completo.sql
 * (tablas: inventory_locations, inventory_lots, inventory_movements,
 * inventory_alerts, suppliers, purchase_orders, purchase_order_items).
 * Nada se inventa: solo se tipa lo que ya existe en el esquema autoritativo.
 *
 * Nota de tipado: los INTEGER 0/1 de SQLite se normalizan a boolean en el
 * service antes de devolverlos (el móvil tipa con boolean, no con int).
 * ────────────────────────────────────────────────────────────────────────
 */

/** Ubicación de inventario (RF-IN-001). La "STORE" se crea con el tenant. */
export interface InventoryLocation {
  id: string
  tenant_id: string
  /** Ej: 'Almacén Principal', 'Tienda' */
  name: string
  /** Ej: 'WAREHOUSE', 'STORE', 'OFFICE' (único por tenant) */
  code: string
  is_active: boolean
  created_at: string
  updated_at: string
}

/** Lote de inventario (RF-IN-002) — FIFO con caducidad. */
export interface InventoryLot {
  id: string
  tenant_id: string
  product_id: string
  location_id: string
  lot_number: string | null
  quantity: number
  expiry_date: string | null
  received_at: string
  is_active: boolean
  created_at: string
  updated_at: string
  /** Relación resuelta (nombre del producto) para listados. */
  product_name?: string | null
}

/** Movimiento de inventario (RF-IN-003) — trazabilidad completa. */
export interface InventoryMovement {
  id: string
  tenant_id: string
  product_id: string
  location_id: string
  lot_id: string | null
  movement_type: 'IN' | 'OUT' | 'ADJUSTMENT' | 'RETURN' | 'CANCEL'
  quantity: number
  inventory_before: number
  inventory_after: number
  reference_type: string | null
  reference_id: string | null
  expiry_date: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  /** Relaciones resueltas para listados. */
  product_name?: string | null
  location_name?: string | null
}

/** Alerta de inventario (RF-IN-006). */
export interface InventoryAlert {
  id: string
  tenant_id: string
  product_id: string
  location_id: string | null
  alert_type: 'LOW_STOCK' | 'EXPIRY_WARNING' | 'EXPIRED' | 'AGED_STOCK'
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  message: string | null
  is_resolved: boolean
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
  /** Relación resuelta para la bandeja de alertas. */
  product_name?: string | null
}

/** Proveedor (catálogo de RF-IN-004: entradas de mercancía). */
export interface Supplier {
  id: string
  tenant_id: string
  name: string
  contact_name: string | null
  phone: string | null
  email: string | null
  address: string | null
  rfc: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

/** Ítem de una orden de compra (RF-IN-004). */
export interface PurchaseOrderItem {
  id: string
  purchase_order_id: string
  product_id: string
  lot_id: string | null
  quantity: number
  unit_cost: number
  total_cost: number
  expiry_date: string | null
  created_at: string
  /** Relaciones resueltas para el detalle. */
  product_name?: string | null
}

/** Orden de compra / entrada de mercancía (RF-IN-004). */
export interface PurchaseOrder {
  id: string
  tenant_id: string
  supplier_id: string | null
  location_id: string | null
  invoice_number: string | null
  total_cost: number
  status: 'PENDING' | 'COMPLETED' | 'CANCELLED'
  notes: string | null
  created_by: string | null
  cloud_sync_status: string
  created_at: string
  updated_at: string
  /** Relaciones resueltas para listados/detalle. */
  supplier_name?: string | null
  location_name?: string | null
  items?: PurchaseOrderItem[]
}

/** Resultado paginado de movimientos/alertas. */
export interface InventoryListResult<T> {
  items: T[]
  total: number
}
