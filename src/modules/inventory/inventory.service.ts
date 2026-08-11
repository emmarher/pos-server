/**
 * src/modules/inventory/inventory.service.ts — Inventario (RF-IN).
 *
 * ────────────────────────────────────────────────────────────────────────
 * RF-IN-001 (ubicaciones), RF-IN-002 (lotes), RF-IN-003 (movimientos),
 * RF-IN-004 (entradas de mercancía / purchase_orders), RF-IN-005 (ajustes
 * manuales con motivo obligatorio), RF-IN-006 (alertas LOW_STOCK).
 *
 * REGLAS:
 *   - El stock global del producto lo actualizan los triggers de venta
 *     (OUT/RETURN) y AQUÍ las entradas de mercancía y los ajustes — cada
 *     uno con su movimiento de inventario (IN / ADJUSTMENT) y before/after.
 *   - RF-IN-004: al registrar la compra se aumenta el stock, se crea/actualiza
 *     el lote y se actualiza el costo promedio ponderado (esquema autoritativo:
 *     "Actualiza cost promedio ponderado del producto").
 *   - MULTI-TENANT: TODAS las consultas filtran por tenant_id = $x; el tenant
 *     SIEMPRE viene del JWT (request.user.tenant_id), nunca del body/query.
 * ────────────────────────────────────────────────────────────────────────
 */
import { db } from '../../database/client.js'
import { HttpError } from '../../types/errors.js'
import type {
  InventoryAlert,
  InventoryListResult,
  InventoryLocation,
  InventoryLot,
  InventoryMovement,
  PurchaseOrder,
  PurchaseOrderItem,
  Supplier,
} from '../../types/inventory.js'

/* ── Interfaces de entrada (lo que llega del cliente) ─────────────────── */

export interface LocationInput {
  name: string
  code: string
  is_active?: boolean
}

export interface LotInput {
  product_id: string
  location_id: string
  lot_number?: string | null
  quantity?: number
  expiry_date?: string | null
}

export interface AdjustmentInput {
  product_id: string
  location_id?: string | null
  /** Cantidad del ajuste: positiva (entra) o negativa (sale). */
  quantity: number
  /** Motivo OBLIGATORIO (RF-IN-005). */
  reason: string
}

export interface PurchaseOrderItemInput {
  product_id: string
  quantity: number
  unit_cost: number
  expiry_date?: string | null
  /** Número de lote para el lote FIFO creado en la entrada (RF-IN-002). */
  lot_number?: string | null
}

export interface PurchaseOrderInput {
  supplier_id?: string | null
  location_id?: string | null
  invoice_number?: string | null
  notes?: string | null
  items: PurchaseOrderItemInput[]
}

export interface SupplierInput {
  name: string
  contact_name?: string | null
  phone?: string | null
  email?: string | null
  address?: string | null
  rfc?: string | null
  is_active?: boolean
}

/* ── Filas crudas de la BD ────────────────────────────────────────────── */

interface LocationRow {
  id: string
  tenant_id: string
  name: string
  code: string
  is_active: number
  created_at: string
  updated_at: string
}

interface LotRow {
  id: string
  tenant_id: string
  product_id: string
  location_id: string
  lot_number: string | null
  quantity: number
  expiry_date: string | null
  received_at: string
  is_active: number
  created_at: string
  updated_at: string
  product_name?: string | null
}

interface MovementRow {
  id: string
  tenant_id: string
  product_id: string
  location_id: string
  lot_id: string | null
  movement_type: string
  quantity: number
  inventory_before: number
  inventory_after: number
  reference_type: string | null
  reference_id: string | null
  expiry_date: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  product_name?: string | null
  location_name?: string | null
}

interface AlertRow {
  id: string
  tenant_id: string
  product_id: string
  location_id: string | null
  alert_type: string
  severity: string
  message: string | null
  is_resolved: number
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
  product_name?: string | null
}

interface SupplierRow {
  id: string
  tenant_id: string
  name: string
  contact_name: string | null
  phone: string | null
  email: string | null
  address: string | null
  rfc: string | null
  is_active: number
  created_at: string
  updated_at: string
}

interface PurchaseOrderRow {
  id: string
  tenant_id: string
  supplier_id: string | null
  location_id: string | null
  invoice_number: string | null
  total_cost: number
  status: string
  notes: string | null
  created_by: string | null
  cloud_sync_status: string
  created_at: string
  updated_at: string
  supplier_name?: string | null
  location_name?: string | null
}

interface PurchaseOrderItemRow {
  id: string
  purchase_order_id: string
  product_id: string
  lot_id: string | null
  quantity: number
  unit_cost: number
  total_cost: number
  expiry_date: string | null
  created_at: string
  product_name?: string | null
}

interface ProductStockRow {
  id: string
  tenant_id: string
  name: string
  cost: number
  stock: number
  is_active: number
}

/* ── Mapeadores crudo → dominio ───────────────────────────────────────── */

function toLocation(row: LocationRow): InventoryLocation {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    code: row.code,
    is_active: row.is_active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toLot(row: LotRow): InventoryLot {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    product_id: row.product_id,
    location_id: row.location_id,
    lot_number: row.lot_number,
    quantity: Number(row.quantity),
    expiry_date: row.expiry_date,
    received_at: row.received_at,
    is_active: row.is_active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    product_name: row.product_name,
  }
}

function toMovement(row: MovementRow): InventoryMovement {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    product_id: row.product_id,
    location_id: row.location_id,
    lot_id: row.lot_id,
    movement_type: row.movement_type as InventoryMovement['movement_type'],
    quantity: Number(row.quantity),
    inventory_before: Number(row.inventory_before),
    inventory_after: Number(row.inventory_after),
    reference_type: row.reference_type,
    reference_id: row.reference_id,
    expiry_date: row.expiry_date,
    notes: row.notes,
    created_by: row.created_by,
    created_at: row.created_at,
    product_name: row.product_name,
    location_name: row.location_name,
  }
}

function toAlert(row: AlertRow): InventoryAlert {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    product_id: row.product_id,
    location_id: row.location_id,
    alert_type: row.alert_type as InventoryAlert['alert_type'],
    severity: row.severity as InventoryAlert['severity'],
    message: row.message,
    is_resolved: row.is_resolved === 1,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    created_at: row.created_at,
    product_name: row.product_name,
  }
}

function toSupplier(row: SupplierRow): Supplier {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    contact_name: row.contact_name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    rfc: row.rfc,
    is_active: row.is_active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toPurchaseOrder(row: PurchaseOrderRow): PurchaseOrder {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    supplier_id: row.supplier_id,
    location_id: row.location_id,
    invoice_number: row.invoice_number,
    total_cost: Number(row.total_cost),
    status: row.status as PurchaseOrder['status'],
    notes: row.notes,
    created_by: row.created_by,
    cloud_sync_status: row.cloud_sync_status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    supplier_name: row.supplier_name,
    location_name: row.location_name,
  }
}

function toPurchaseOrderItem(row: PurchaseOrderItemRow): PurchaseOrderItem {
  return {
    id: row.id,
    purchase_order_id: row.purchase_order_id,
    product_id: row.product_id,
    lot_id: row.lot_id,
    quantity: Number(row.quantity),
    unit_cost: Number(row.unit_cost),
    total_cost: Number(row.total_cost),
    expiry_date: row.expiry_date,
    created_at: row.created_at,
    product_name: row.product_name,
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Carga un producto del tenant (para stock/costo). */
async function loadProduct(
  tx: typeof db,
  tenantId: string,
  productId: string,
): Promise<ProductStockRow> {
  const { rows } = await tx.query<ProductStockRow>(
    `SELECT id, tenant_id, name, cost, stock, is_active FROM products
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, productId],
  )
  const product = rows[0]
  if (!product) {
    throw new HttpError('NOT_FOUND', `Producto no encontrado: ${productId}`)
  }
  return product
}

/** Valida que una ubicación exista y sea del tenant (o devuelve la default). */
async function resolveLocation(
  tx: typeof db,
  tenantId: string,
  locationId: string | null | undefined,
): Promise<string> {
  if (locationId) {
    const { rows } = await tx.query<{ id: string }>(
      'SELECT id FROM inventory_locations WHERE tenant_id = $1 AND id = $2 AND is_active = 1',
      [tenantId, locationId],
    )
    if (!rows[0]) {
      throw new HttpError('TENANT_MISMATCH', 'Ubicación no válida o de otro tenant')
    }
    return locationId
  }
  // Ubicación por defecto del tenant (el seed crea "Tienda Principal" STORE)
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM inventory_locations
     WHERE tenant_id = $1 AND is_active = 1 ORDER BY created_at ASC LIMIT 1`,
    [tenantId],
  )
  if (!rows[0]) {
    throw new HttpError(
      'CONFLICT',
      'No existe una ubicación de inventario activa. Cree una primero.',
    )
  }
  return rows[0].id
}

/* ── RF-IN-001: Ubicaciones ───────────────────────────────────────────── */

/** GET /inventory/locations — ubicaciones del tenant. */
export async function listLocations(tenantId: string): Promise<InventoryLocation[]> {
  const { rows } = await db.query<LocationRow>(
    `SELECT id, tenant_id, name, code, is_active, created_at, updated_at
     FROM inventory_locations WHERE tenant_id = $1
     ORDER BY created_at ASC`,
    [tenantId],
  )
  return rows.map(toLocation)
}

/** POST /inventory/locations — crea una ubicación (código único por tenant). */
export async function createLocation(
  tenantId: string,
  input: LocationInput,
): Promise<InventoryLocation> {
  const now = new Date().toISOString()
  try {
    const { rows } = await db.query<LocationRow>(
      `INSERT INTO inventory_locations (tenant_id, name, code, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING id, tenant_id, name, code, is_active, created_at, updated_at`,
      [tenantId, input.name.trim(), input.code.trim().toUpperCase(), input.is_active === false ? 0 : 1, now],
    )
    const row = rows[0]
    if (!row) throw new HttpError('INTERNAL', 'No se pudo crear la ubicación')
    return toLocation(row)
  } catch (err) {
    throw toHttpError(err, 'No se pudo crear la ubicación')
  }
}

/** PATCH /inventory/locations/:id — actualiza nombre/estado. */
export async function updateLocation(
  tenantId: string,
  id: string,
  input: Partial<LocationInput>,
): Promise<InventoryLocation> {
  const current = (await listLocations(tenantId)).find((l) => l.id === id)
  if (!current) throw new HttpError('NOT_FOUND', 'Ubicación no encontrada')

  const now = new Date().toISOString()
  try {
    const { rows } = await db.query<LocationRow>(
      `UPDATE inventory_locations
       SET name = $3, code = $4, is_active = $5, updated_at = $6
       WHERE tenant_id = $1 AND id = $2
       RETURNING id, tenant_id, name, code, is_active, created_at, updated_at`,
      [
        tenantId,
        id,
        input.name?.trim() ?? current.name,
        (input.code?.trim() ?? current.code).toUpperCase(),
        input.is_active === undefined ? (current.is_active ? 1 : 0) : input.is_active ? 1 : 0,
        now,
      ],
    )
    const row = rows[0]
    if (!row) throw new HttpError('NOT_FOUND', 'Ubicación no encontrada')
    return toLocation(row)
  } catch (err) {
    throw toHttpError(err, 'No se pudo actualizar la ubicación')
  }
}

/* ── RF-IN-002: Lotes ─────────────────────────────────────────────────── */

/** GET /inventory/lots — lotes del tenant, filtrables por producto. */
export async function listLots(
  tenantId: string,
  productId?: string,
): Promise<InventoryLot[]> {
  const where = productId
    ? 'l.tenant_id = $1 AND l.product_id = $2'
    : 'l.tenant_id = $1'
  const values = productId ? [tenantId, productId] : [tenantId]
  const { rows } = await db.query<LotRow>(
    `SELECT l.id, l.tenant_id, l.product_id, l.location_id, l.lot_number,
            l.quantity, l.expiry_date, l.received_at, l.is_active,
            l.created_at, l.updated_at, p.name AS product_name
     FROM inventory_lots l
     JOIN products p ON p.id = l.product_id
     WHERE ${where}
     ORDER BY l.received_at ASC, l.expiry_date ASC NULLS LAST`,
    values,
  )
  return rows.map(toLot)
}

/** POST /inventory/lots — alta manual de lote (sin tocar stock global). */
export async function createLot(tenantId: string, input: LotInput): Promise<InventoryLot> {
  await loadProduct(db, tenantId, input.product_id)
  const locationId = await resolveLocation(db, tenantId, input.location_id)

  const now = new Date().toISOString()
  try {
    const { rows } = await db.query<LotRow>(
      `INSERT INTO inventory_lots
         (tenant_id, product_id, location_id, lot_number, quantity, expiry_date, received_at, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $7, $7)
       RETURNING id, tenant_id, product_id, location_id, lot_number, quantity, expiry_date, received_at, is_active, created_at, updated_at`,
      [
        tenantId,
        input.product_id,
        locationId,
        input.lot_number ?? null,
        input.quantity ?? 0,
        input.expiry_date ?? null,
        now,
      ],
    )
    const row = rows[0]
    if (!row) throw new HttpError('INTERNAL', 'No se pudo crear el lote')
    return toLot(row)
  } catch (err) {
    throw toHttpError(err, 'No se pudo crear el lote')
  }
}

/* ── RF-IN-003: Movimientos ───────────────────────────────────────────── */

/** GET /inventory/movements — trazabilidad con filtros y paginación. */
export async function listMovements(
  tenantId: string,
  params: {
    product_id?: string
    movement_type?: string
    limit?: number
    offset?: number
  },
): Promise<InventoryListResult<InventoryMovement>> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
  const offset = Math.max(params.offset ?? 0, 0)

  const conditions: string[] = ['m.tenant_id = $1']
  const values: unknown[] = [tenantId]
  let paramIndex = 2

  if (params.product_id) {
    conditions.push(`m.product_id = $${paramIndex++}`)
    values.push(params.product_id)
  }
  if (params.movement_type) {
    conditions.push(`m.movement_type = $${paramIndex++}`)
    values.push(params.movement_type)
  }

  const whereSql = conditions.join(' AND ')

  const [{ rows: countRows }, { rows }] = await Promise.all([
    db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM inventory_movements m WHERE ${whereSql}`,
      values,
    ),
    db.query<MovementRow>(
      `SELECT m.id, m.tenant_id, m.product_id, m.location_id, m.lot_id,
              m.movement_type, m.quantity, m.inventory_before, m.inventory_after,
              m.reference_type, m.reference_id, m.expiry_date, m.notes,
              m.created_by, m.created_at,
              p.name AS product_name, l.name AS location_name
       FROM inventory_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN inventory_locations l ON l.id = m.location_id
       WHERE ${whereSql}
       ORDER BY m.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset],
    ),
  ])

  return {
    items: rows.map(toMovement),
    total: countRows[0]?.total ?? 0,
  }
}

/* ── RF-IN-005: Ajustes manuales ──────────────────────────────────────── */

/**
 * POST /inventory/adjustments — ajuste de stock con motivo obligatorio.
 * Registra movimiento ADJUSTMENT con before/after reales. Un ajuste que
 * dejaría stock negativo se rechaza (422).
 */
export async function createAdjustment(
  actor: { tenant_id: string; user_id: string },
  input: AdjustmentInput,
): Promise<InventoryMovement> {
  if (!input.reason || input.reason.trim() === '') {
    throw new HttpError('VALIDATION_ERROR', 'El motivo del ajuste es obligatorio')
  }
  if (!Number.isFinite(input.quantity) || input.quantity === 0) {
    throw new HttpError('VALIDATION_ERROR', 'La cantidad del ajuste no puede ser cero')
  }

  const { tenant_id, user_id } = actor

  return db.transaction(async (tx) => {
    const product = await loadProduct(tx, tenant_id, input.product_id)
    const locationId = await resolveLocation(tx, tenant_id, input.location_id)

    const before = Number(product.stock)
    const after = round2(before + input.quantity)
    if (after < 0) {
      throw new HttpError(
        'INSUFFICIENT_STOCK',
        `Ajuste dejaría stock negativo para ${product.name}: disponible ${before}, ajuste ${input.quantity}`,
      )
    }

    const now = new Date().toISOString()
    await tx.query(
      `UPDATE products SET stock = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
      [tenant_id, product.id, after, now],
    )

    const { rows } = await tx.query<MovementRow>(
      `INSERT INTO inventory_movements
         (tenant_id, product_id, location_id, lot_id, movement_type, quantity,
          inventory_before, inventory_after, reference_type, reference_id,
          notes, created_by, created_at)
       VALUES ($1, $2, $3, NULL, 'ADJUSTMENT', $4, $5, $6, 'ADJUSTMENT', NULL, $7, $8, $9)
       RETURNING id, tenant_id, product_id, location_id, lot_id, movement_type,
                 quantity, inventory_before, inventory_after, reference_type,
                 reference_id, expiry_date, notes, created_by, created_at`,
      [tenant_id, product.id, locationId, Math.abs(input.quantity), before, after, input.reason.trim(), user_id, now],
    )
    const row = rows[0]
    if (!row) throw new HttpError('INTERNAL', 'No se pudo registrar el ajuste')
    return toMovement(row)
  })
}

/* ── RF-IN-004: Entradas de mercancía (purchase_orders) ───────────────── */

/**
 * POST /purchase-orders — entrada de mercancía transaccional:
 *   1. INSERT purchase_orders (status COMPLETED).
 *   2. Por cada ítem: INSERT purchase_order_items, aumentar stock global,
 *      crear/actualizar lote (FIFO con caducidad), movimiento IN con
 *      before/after y costo promedio ponderado del producto.
 */
export async function createPurchaseOrder(
  actor: { tenant_id: string; user_id: string },
  input: PurchaseOrderInput,
): Promise<PurchaseOrder> {
  if (!input.items || input.items.length === 0) {
    throw new HttpError('VALIDATION_ERROR', 'La entrada de mercancía debe tener al menos un artículo')
  }

  const { tenant_id, user_id } = actor

  return db.transaction(async (tx) => {
    // Validar proveedor si viene
    if (input.supplier_id) {
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM suppliers WHERE tenant_id = $1 AND id = $2 AND is_active = 1',
        [tenant_id, input.supplier_id],
      )
      if (!rows[0]) {
        throw new HttpError('TENANT_MISMATCH', 'Proveedor no válido o de otro tenant')
      }
    }
    const locationId = await resolveLocation(tx, tenant_id, input.location_id)

    // Calcular total y validar productos ANTES de insertar
    const items: Array<PurchaseOrderItemInput & { product: ProductStockRow }> = []
    let totalCost = 0
    for (const item of input.items) {
      if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
        throw new HttpError('VALIDATION_ERROR', 'La cantidad de entrada debe ser mayor a cero')
      }
      if (!Number.isFinite(item.unit_cost) || item.unit_cost < 0) {
        throw new HttpError('VALIDATION_ERROR', 'El costo unitario no puede ser negativo')
      }
      const product = await loadProduct(tx, tenant_id, item.product_id)
      items.push({ ...item, product })
      totalCost = round2(totalCost + item.quantity * item.unit_cost)
    }

    const now = new Date().toISOString()
    const { rows: orderRows } = await tx.query<PurchaseOrderRow>(
      `INSERT INTO purchase_orders
         (tenant_id, supplier_id, location_id, invoice_number, total_cost, status,
          notes, created_by, cloud_sync_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'COMPLETED', $6, $7, 'PENDING', $8, $8)
       RETURNING id, tenant_id, supplier_id, location_id, invoice_number,
                 total_cost, status, notes, created_by, cloud_sync_status, created_at, updated_at`,
      [
        tenant_id,
        input.supplier_id ?? null,
        locationId,
        input.invoice_number ?? null,
        totalCost,
        input.notes ?? null,
        user_id,
        now,
      ],
    )
    const order = orderRows[0]
    if (!order) throw new HttpError('INTERNAL', 'No se pudo registrar la entrada de mercancía')

    for (const item of items) {
      const { product } = item
      const before = Number(product.stock)
      const after = round2(before + item.quantity)

      // Costo promedio ponderado (esquema autoritativo RF-IN-004)
      const newCost =
        after > 0
          ? round2((product.cost * before + item.unit_cost * item.quantity) / after)
          : item.unit_cost

      // 1) INSERT purchase_order_items
      const { rows: itemRows } = await tx.query<{ id: string }>(
        `INSERT INTO purchase_order_items
           (purchase_order_id, product_id, quantity, unit_cost, total_cost, expiry_date, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          order.id,
          product.id,
          item.quantity,
          item.unit_cost,
          round2(item.quantity * item.unit_cost),
          item.expiry_date ?? null,
          now,
        ],
      )
      const itemId = itemRows[0]?.id

      // 2) Aumentar stock + costo promedio ponderado
      await tx.query(
        `UPDATE products SET stock = $3, cost = $4, updated_at = $5
         WHERE tenant_id = $1 AND id = $2`,
        [tenant_id, product.id, after, newCost, now],
      )

      // 3) Crear/actualizar lote (mismo product+location+lot_number → sumar)
      let lotId: string | null = null
      const lotNumber = item.lot_number ?? null
      if (lotNumber) {
        const { rows: lotRows } = await tx.query<{ id: string }>(
          `SELECT id FROM inventory_lots
           WHERE tenant_id = $1 AND product_id = $2 AND location_id = $3
             AND lot_number = $4 AND is_active = 1
           LIMIT 1`,
          [tenant_id, product.id, locationId, lotNumber],
        )
        if (lotRows[0]) {
          lotId = lotRows[0].id
          await tx.query(
            `UPDATE inventory_lots SET quantity = quantity + $4, updated_at = $5
             WHERE tenant_id = $1 AND id = $2 AND is_active = 1`,
            [tenant_id, lotId, 0, item.quantity, now],
          )
        }
      }
      if (!lotId) {
        const { rows: newLot } = await tx.query<{ id: string }>(
          `INSERT INTO inventory_lots
             (tenant_id, product_id, location_id, lot_number, quantity, expiry_date, received_at, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $7, $7)
           RETURNING id`,
          [tenant_id, product.id, locationId, lotNumber, item.quantity, item.expiry_date ?? null, now],
        )
        lotId = newLot[0]?.id ?? null
      }

      // 4) Vincular el lote creado al ítem + movimiento IN
      if (lotId) {
        await tx.query(
          'UPDATE purchase_order_items SET lot_id = $1 WHERE id = $2',
          [lotId, itemId],
        )
      }
      await tx.query(
        `INSERT INTO inventory_movements
           (tenant_id, product_id, location_id, lot_id, movement_type, quantity,
            inventory_before, inventory_after, reference_type, reference_id,
            expiry_date, notes, created_by, created_at)
         VALUES ($1, $2, $3, $4, 'IN', $5, $6, $7, 'PURCHASE', $8, $9, $10, $11, $12)`,
        [
          tenant_id,
          product.id,
          locationId,
          lotId,
          item.quantity,
          before,
          after,
          order.id,
          item.expiry_date ?? null,
          input.notes ? `Entrada de mercancía: ${input.notes}` : 'Entrada de mercancía',
          user_id,
          now,
        ],
      )
    }

    return getPurchaseOrder(tenant_id, order.id)
  })
}

/** GET /purchase-orders — órdenes del tenant (más recientes primero). */
export async function listPurchaseOrders(tenantId: string): Promise<PurchaseOrder[]> {
  const { rows } = await db.query<PurchaseOrderRow>(
    `SELECT po.id, po.tenant_id, po.supplier_id, po.location_id, po.invoice_number,
            po.total_cost, po.status, po.notes, po.created_by, po.cloud_sync_status,
            po.created_at, po.updated_at,
            s.name AS supplier_name, l.name AS location_name
     FROM purchase_orders po
     LEFT JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN inventory_locations l ON l.id = po.location_id
     WHERE po.tenant_id = $1
     ORDER BY po.created_at DESC`,
    [tenantId],
  )
  return rows.map(toPurchaseOrder)
}

/** GET /purchase-orders/:id — detalle con ítems. */
export async function getPurchaseOrder(
  tenantId: string,
  id: string,
): Promise<PurchaseOrder> {
  const { rows } = await db.query<PurchaseOrderRow>(
    `SELECT po.id, po.tenant_id, po.supplier_id, po.location_id, po.invoice_number,
            po.total_cost, po.status, po.notes, po.created_by, po.cloud_sync_status,
            po.created_at, po.updated_at,
            s.name AS supplier_name, l.name AS location_name
     FROM purchase_orders po
     LEFT JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN inventory_locations l ON l.id = po.location_id
     WHERE po.tenant_id = $1 AND po.id = $2`,
    [tenantId, id],
  )
  const order = rows[0]
  if (!order) throw new HttpError('NOT_FOUND', 'Entrada de mercancía no encontrada')

  const { rows: itemRows } = await db.query<PurchaseOrderItemRow>(
    `SELECT poi.id, poi.purchase_order_id, poi.product_id, poi.lot_id,
            poi.quantity, poi.unit_cost, poi.total_cost, poi.expiry_date, poi.created_at,
            p.name AS product_name
     FROM purchase_order_items poi
     JOIN products p ON p.id = poi.product_id
     WHERE poi.purchase_order_id = $1
     ORDER BY poi.created_at ASC`,
    [id],
  )

  return {
    ...toPurchaseOrder(order),
    items: itemRows.map(toPurchaseOrderItem),
  }
}

/* ── RF-IN-006: Alertas ───────────────────────────────────────────────── */

/** GET /inventory/alerts — bandeja de alertas (resueltas o pendientes). */
export async function listAlerts(
  tenantId: string,
  params: { resolved?: boolean; alert_type?: string; limit?: number; offset?: number },
): Promise<InventoryListResult<InventoryAlert>> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
  const offset = Math.max(params.offset ?? 0, 0)

  const conditions: string[] = ['a.tenant_id = $1']
  const values: unknown[] = [tenantId]
  let paramIndex = 2

  if (params.resolved !== undefined) {
    conditions.push(`a.is_resolved = $${paramIndex++}`)
    values.push(params.resolved ? 1 : 0)
  }
  if (params.alert_type) {
    conditions.push(`a.alert_type = $${paramIndex++}`)
    values.push(params.alert_type)
  }

  const whereSql = conditions.join(' AND ')

  const [{ rows: countRows }, { rows }] = await Promise.all([
    db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM inventory_alerts a WHERE ${whereSql}`,
      values,
    ),
    db.query<AlertRow>(
      `SELECT a.id, a.tenant_id, a.product_id, a.location_id, a.alert_type,
              a.severity, a.message, a.is_resolved, a.resolved_at, a.resolved_by, a.created_at,
              p.name AS product_name
       FROM inventory_alerts a
       JOIN products p ON p.id = a.product_id
       WHERE ${whereSql}
       ORDER BY a.is_resolved ASC, a.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset],
    ),
  ])

  return {
    items: rows.map(toAlert),
    total: countRows[0]?.total ?? 0,
  }
}

/** PATCH /inventory/alerts/:id — marca la alerta como resuelta. */
export async function resolveAlert(
  actor: { tenant_id: string; user_id: string },
  id: string,
): Promise<InventoryAlert> {
  const { tenant_id, user_id } = actor
  const now = new Date().toISOString()

  const { rows } = await db.query<AlertRow>(
    `UPDATE inventory_alerts
     SET is_resolved = 1, resolved_at = $3, resolved_by = $4
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, tenant_id, product_id, location_id, alert_type, severity,
               message, is_resolved, resolved_at, resolved_by, created_at`,
    [tenant_id, id, now, user_id],
  )
  const row = rows[0]
  if (!row) throw new HttpError('NOT_FOUND', 'Alerta no encontrada')
  return toAlert(row)
}

/* ── Proveedores (catálogo RF-IN-004) ─────────────────────────────────── */

/** GET /suppliers — proveedores del tenant. */
export async function listSuppliers(tenantId: string): Promise<Supplier[]> {
  const { rows } = await db.query<SupplierRow>(
    `SELECT id, tenant_id, name, contact_name, phone, email, address, rfc,
            is_active, created_at, updated_at
     FROM suppliers WHERE tenant_id = $1
     ORDER BY name ASC`,
    [tenantId],
  )
  return rows.map(toSupplier)
}

/** POST /suppliers — crea un proveedor. */
export async function createSupplier(
  tenantId: string,
  input: SupplierInput,
): Promise<Supplier> {
  const now = new Date().toISOString()
  try {
    const { rows } = await db.query<SupplierRow>(
      `INSERT INTO suppliers
         (tenant_id, name, contact_name, phone, email, address, rfc, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING id, tenant_id, name, contact_name, phone, email, address, rfc, is_active, created_at, updated_at`,
      [
        tenantId,
        input.name.trim(),
        input.contact_name ?? null,
        input.phone ?? null,
        input.email ?? null,
        input.address ?? null,
        input.rfc ?? null,
        input.is_active === false ? 0 : 1,
        now,
      ],
    )
    const row = rows[0]
    if (!row) throw new HttpError('INTERNAL', 'No se pudo crear el proveedor')
    return toSupplier(row)
  } catch (err) {
    throw toHttpError(err, 'No se pudo crear el proveedor')
  }
}

/* ── Conversión de errores de la BD ───────────────────────────────────── */

/** Convierte errores de la BD (constraints/triggers) en HttpError legible. */
function toHttpError(err: unknown, fallback: string): HttpError {
  if (err instanceof HttpError) return err
  const message = err instanceof Error ? err.message : ''
  const code = (err as { code?: string })?.code ?? ''

  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/i.test(message)) {
    return new HttpError('CONFLICT', 'Ya existe un registro con ese código')
  }
  if (code === 'SQLITE_CONSTRAINT_CHECK' || /CHECK/i.test(message)) {
    return new HttpError('VALIDATION_ERROR', 'El registro no cumple las reglas de validación')
  }
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY/i.test(message)) {
    return new HttpError('CONFLICT', 'Referencia no válida o recurso en uso')
  }
  return new HttpError('INTERNAL', fallback)
}
