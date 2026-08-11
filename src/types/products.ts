/**
 * src/types/products.ts — Contrato del módulo de catálogos (productos).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Espejo EXACTO de las columnas de esquema_BD_POS_v4_completo.sql y de los
 * modelos de pos-mobile (src/models: Product, Category, MeasurementUnit,
 * PriceType, ProductPrice). Nada se inventa: solo se tipa lo que ya existe
 * en el esquema autoritativo.
 *
 * Nota de tipado: los INTEGER 0/1 de SQLite se normalizan a boolean en el
 * service antes de devolverlos (el móvil tipa con boolean, no con int).
 * ────────────────────────────────────────────────────────────────────────
 */

/** Unidad de medida (MASS/COUNT/VOLUME/LENGTH — vocabulario PRD). */
export interface MeasurementUnit {
  id: string
  tenant_id: string
  code: string
  name: string
  symbol: string
  unit_type: 'MASS' | 'COUNT' | 'VOLUME' | 'LENGTH'
  is_fractional: boolean
  decimal_places: number
  is_system_default: boolean
  is_active: boolean
}

/** Categoría de producto (RF-CA-001). */
export interface Category {
  id: string
  tenant_id: string
  name: string
  description: string | null
  /** Prefijo del código interno, ej: 'POO', 'CAR', 'BEB' */
  prefix: string
  color: string
  display_order: number
  /** Mantenido por trigger (product_count). */
  product_count: number
  is_active: boolean
}

/** Tipo de precio ('Público', 'Mayoreo'… RF-CA-003). */
export interface PriceType {
  id: string
  tenant_id: string
  name: string
  code: string
  is_default: boolean
  is_active: boolean
}

/** Precio por tipo de precio (RF-CA-004, histórico con vigencia). */
export interface ProductPrice {
  id: string
  product_id: string
  price_type_id: string
  price: number
  min_quantity: number
  start_date: string
  end_date: string | null
}

/** Producto completo (RF-CA-002), con relaciones resueltas. */
export interface Product {
  id: string
  tenant_id: string
  category_id: string | null
  name: string
  description: string | null
  barcode: string | null
  /** Generado por trigger: {prefix}{4 dígitos}, ej. POO0042 */
  internal_code: string | null
  sku: string | null
  base_unit_id: string
  sale_unit_id: string
  /** 1 venta = X base (descuento de stock en base_quantity). */
  unit_conversion: number
  /** Precio por defecto (fallback si no hay product_prices). */
  price: number
  cost: number
  /** Stock en unidad base (descontado por trigger al vender). */
  stock: number
  min_stock: number
  max_stock: number | null
  is_scale_enabled: boolean
  allow_fractional_sale: boolean
  is_active: boolean
  category: Category | null
  base_unit: MeasurementUnit | null
  sale_unit: MeasurementUnit | null
  prices: ProductPrice[]
}

/** Resultado de búsqueda de productos (RF-CA-006, limit 20). */
export interface ProductSearchResult {
  items: Product[]
  total: number
}
