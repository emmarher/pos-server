/**
 * src/modules/sales/sales.service.ts — Ventas (RF-VE), transacción atómica.
 *
 * ────────────────────────────────────────────────────────────────────────
 * FLUJO EXACTO de POST /sales (ver notas de implementación del esquema
 * autoritativo, sección "FLUJO DE VENTA TRANSACCIONAL"):
 *   1. BEGIN
 *   2. Folio: nextval('seq_folio_{tenant}') en PG (dashes→underscore);
 *      en SQLite UPSERT atómico en `folio_sequences` (adaptación 003).
 *   3. Precios: product_prices vigente por price_type_id (fallback
 *      products.price cuando no hay fila para ese tipo).
 *   4. Descuentos: product_discounts + discount_types (P=%, F=fijo) con
 *      minimum_quantity y vigencia; filtrados por product_discount_price_types.
 *   5. INSERT sales  (folio_prefix 'V', status COMPLETED, payment_state PAID)
 *   6. INSERT sale_items  (base_quantity la recalcula el trigger)
 *   7. INSERT sale_payments (CASH con change_amount/vuelto)
 *   8. Triggers automáticos: stock OUT, inventory_movements, LOW_STOCK, QoS
 *   9. INSERT stored_tickets (content ESC_POS para reimpresión)
 *   10. COMMIT
 *
 * CAJ (venta por peso): quantity=1, alternate_quantity = kg de la báscula,
 * subtotal = alternate_quantity × unit_price; el stock se descuenta en
 * base_quantity (conversión por unit_conversion, trigger).
 *
 * REGLA: los precios y descuentos se RECALCULAN desde la BD (fuente de
 * verdad); los montos del payload solo se usan como referencia de la UI.
 *
 * MULTI-TENANT: todas las queries filtran tenant_id (del JWT).
 * ────────────────────────────────────────────────────────────────────────
 */
import { env } from '../../config/env.js'
import { db } from '../../database/client.js'
import { HttpError } from '../../types/errors.js'
import type {
  CreateSalePayload,
  SaleDetail,
  SaleItem,
  SalePayment,
  SaleResponse,
} from '../../types/sales.js'

/* ── Contexto del request (usuario autenticado) ───────────────────────── */

export interface SaleActor {
  tenant_id: string
  /** seller_id = sub del JWT (user_id). */
  seller_id: string
  /** device_id del JWT (RF-AU-004). */
  device_id: string
}

/* ── Filas crudas de la BD ────────────────────────────────────────────── */

interface ProductStockRow {
  id: string
  tenant_id: string
  name: string
  barcode: string | null
  base_unit_id: string
  sale_unit_id: string
  unit_conversion: number
  price: number
  stock: number
  min_stock: number
  is_active: number
  allow_fractional_sale: number
  /** unit_type de la unidad de venta (MASS/COUNT/…) — distingue CAJ. */
  sale_unit_type: string
}

interface PriceRow {
  price: number
}

interface DiscountRow {
  discount_value: number
  value_type: 'P' | 'F'
}

interface SaleInsertRow {
  id: string
  tenant_id: string
  folio_number: number
  folio_prefix: string
  folio_display: string
  subtotal: number
  discount: number
  tax: number
  total: number
  status: string
  payment_state: string
  created_at: string
}

interface QosRow {
  id: string
}

/* ── Helpers de redondeo (DECIMAL(12,2) del esquema) ──────────────────── */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Siguiente folio de venta del tenant, consumido DENTRO de la transacción.
 * - PG: nextval('seq_folio_{tenant_id}' con guiones → guiones bajos), igual
 *   que el esquema autoritativo (create_tenant_folio_sequence).
 * - SQLite: UPSERT atómico en folio_sequences (migración 003); el primer
 *   uso crea la fila con last_value=1, los siguientes la incrementan.
 */
async function nextFolio(tx: typeof db, tenantId: string): Promise<number> {
  if (env.dbProvider === 'postgres') {
    const sequence = `seq_folio_${tenantId.replace(/-/g, '_')}`
    const { rows } = await tx.query<{ nextval: number }>(
      `SELECT nextval('${sequence}') AS nextval`,
    )
    return Number(rows[0]?.nextval ?? 0)
  }
  const { rows } = await tx.query<{ last_value: number }>(
    `INSERT INTO folio_sequences (tenant_id, last_value)
     VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET last_value = folio_sequences.last_value + 1
     RETURNING last_value`,
    [tenantId],
  )
  return Number(rows[0]?.last_value ?? 0)
}

/** Valida que el producto exista, esté activo y sea del tenant. */
async function loadProduct(
  tx: typeof db,
  tenantId: string,
  productId: string,
): Promise<ProductStockRow> {
  const forUpdate = env.dbProvider === 'postgres' ? ' FOR UPDATE' : ''
  const { rows } = await tx.query<ProductStockRow>(
    `SELECT p.id, p.tenant_id, p.name, p.barcode, p.base_unit_id, p.sale_unit_id,
            p.unit_conversion, p.price, p.stock, p.min_stock, p.is_active, p.allow_fractional_sale,
            su.unit_type AS sale_unit_type
     FROM products p
     JOIN measurement_units su ON su.id = p.sale_unit_id
     WHERE p.tenant_id = $1 AND p.id = $2${forUpdate}`,
    [tenantId, productId],
  )
  const product = rows[0]
  if (!product) {
    throw new HttpError('NOT_FOUND', `Producto no encontrado: ${productId}`)
  }
  if (product.is_active !== 1) {
    throw new HttpError('CONFLICT', `Producto inactivo: ${product.name}`)
  }
  return product
}

/**
 * Precio unitario vigente (RF-CA-004): product_prices del price_type
 * seleccionado; si no hay fila vigente para ese tipo → products.price.
 */
async function resolveUnitPrice(
  tx: typeof db,
  tenantId: string,
  productId: string,
  priceTypeId: string,
  quantity: number,
  fallback: number,
): Promise<number> {
  const { rows } = await tx.query<PriceRow>(
    `SELECT price FROM product_prices
     WHERE tenant_id = $1 AND product_id = $2 AND price_type_id = $3
       AND is_active = 1 AND min_quantity <= $4
       AND start_date <= date('now')
       AND (end_date IS NULL OR end_date >= date('now'))
     ORDER BY min_quantity DESC, start_date DESC
     LIMIT 1`,
    [tenantId, productId, priceTypeId, quantity],
  )
  return Number(rows[0]?.price ?? fallback)
}

/**
 * Mejor descuento vigente aplicable al ítem (P=porcentaje, F=monto fijo).
 * Aplica si: is_active, minimum_quantity ≤ cantidad, vigencia por fechas, y
 * el descuento está ligado al price_type del ítem O no tiene tipos restringidos.
 * Devuelve { value, value_type } para que el caller convierta a monto
 * (P → % del precio, F → monto fijo). El LEFT JOIN puede duplicar filas si
 * el descuento tiene varios price_types; se toma el de mayor descuento.
 */
async function resolveDiscount(
  tx: typeof db,
  tenantId: string,
  productId: string,
  priceTypeId: string,
  quantity: number,
): Promise<DiscountRow | null> {
  const { rows } = await tx.query<DiscountRow>(
    `SELECT pd.discount_value, dt.value_type
     FROM product_discounts pd
     JOIN discount_types dt ON dt.id = pd.discount_type_id
     LEFT JOIN product_discount_price_types pdt ON pdt.product_discount_id = pd.id
     WHERE pd.tenant_id = $1 AND pd.product_id = $2 AND pd.is_active = 1
       AND pd.minimum_quantity <= $4
       AND pd.start_date <= date('now')
       AND (pd.end_date IS NULL OR pd.end_date >= date('now'))
       AND (pdt.price_type_id IS NULL OR pdt.price_type_id = $3)
     ORDER BY pd.minimum_quantity DESC, pd.start_date DESC`,
    [tenantId, productId, priceTypeId, quantity],
  )
  if (rows.length === 0) return null
  return rows.reduce((acc, r) =>
    Number(r.discount_value) > Number(acc.discount_value) ? r : acc,
  )
}

/**
 * Convierte el descuento bruto a monto aplicable al ítem.
 * P = porcentaje del precio (ej. 10 → 10%), F = monto fijo en pesos.
 */
function discountToAmount(
  discount: DiscountRow | null,
  unitPrice: number,
  quantity: number,
): number {
  if (!discount || Number(discount.discount_value) <= 0) return 0
  const value = Number(discount.discount_value)
  if (discount.value_type === 'P') {
    return round2((unitPrice * quantity * value) / 100)
  }
  // F (fijo): aplica por ítem, acotado al subtotal (no vender con negativo).
  return round2(Math.min(value, unitPrice * quantity))
}

/* ── POST /sales ──────────────────────────────────────────────────────── */

/**
 * Crea una venta de forma atómica. Devuelve SaleResponse (contrato móvil).
 * Lanza INSUFFICIENT_STOCK (422) si algún ítem supera el stock disponible.
 */
export async function createSale(
  actor: SaleActor,
  input: CreateSalePayload,
): Promise<SaleResponse> {
  if (!input.items || input.items.length === 0) {
    throw new HttpError('VALIDATION_ERROR', 'La venta debe tener al menos un artículo')
  }
  if (!input.payments || input.payments.length === 0) {
    throw new HttpError('VALIDATION_ERROR', 'La venta debe tener al menos un pago')
  }

  const { tenant_id, seller_id, device_id } = actor

  /* RF-VE-003: transacción atómica. FOR UPDATE en loadProduct bloquea la fila
     de stock durante toda la transacción, evitando que dos cajeros lean stock
     stale y vendan el mismo lote (race condition). El segundo cajero queda
     bloqueado hasta que el primero hace COMMIT, luego lee stock real y falla
     con INSUFFICIENT_STOCK (422) en lugar de un error de constraint (500). */
  try {
    return await db.transaction(async (tx) => {
    /* 2) Folio dentro de la transacción (único por tenant+prefix). */
    const folioNumber = await nextFolio(tx, tenant_id)

    /* 3-4) Precios y descuentos recalculados desde la BD. */
    const resolved: Array<{
      product: ProductStockRow
      unitPrice: number
      quantity: number
      baseQuantity: number
      alternateQuantity: number | null
      discountAmount: number
      subtotal: number
      priceTypeId: string
    }> = []

    for (const item of input.items) {
      const product = await loadProduct(tx, tenant_id, item.product_id)

      // CAJ (venta por peso): producto COUNT (caja) vendido por kg de la
      // báscula → quantity=1, alternate_quantity = peso (skill sales-transaction).
      // MASS: quantity ES el peso en kg (el móvil lo manda en quantity y
      // alternate_quantity por compatibilidad; el stock se descuenta en
      // base_quantity = quantity × unit_conversion via trigger).
      const hasWeight = item.alternate_quantity !== undefined && item.alternate_quantity > 0
      const isCaj = hasWeight && product.sale_unit_type === 'COUNT'
      const quantity = isCaj ? 1 : item.quantity
      const saleAmount = isCaj ? item.alternate_quantity! : quantity

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new HttpError('VALIDATION_ERROR', `Cantidad inválida para: ${product.name}`)
      }
      if (isCaj && (!Number.isFinite(item.alternate_quantity!) || item.alternate_quantity! <= 0)) {
        throw new HttpError(
          'VALIDATION_ERROR',
          `Peso inválido para venta por peso (CAJ): ${product.name}`,
        )
      }

      const unitPrice = await resolveUnitPrice(
        tx,
        tenant_id,
        product.id,
        item.price_type_id,
        quantity,
        product.price,
      )

      // Descuento: bruto de la BD → monto (P = % del precio, F = fijo).
      const discountRow = await resolveDiscount(
        tx,
        tenant_id,
        product.id,
        item.price_type_id,
        quantity,
      )
      const discountAmount = discountToAmount(discountRow, unitPrice, saleAmount)

      // El subtotal del ítem: base de cálculo sin descuento (como el móvil).
      const subtotal = round2(saleAmount * unitPrice)
      const baseQuantity = round2(quantity * product.unit_conversion)

      // Stock: validación DENTRO de la transacción (invariante RF-VE-003).
      if (baseQuantity > product.stock) {
        throw new HttpError(
          'INSUFFICIENT_STOCK',
          `Stock insuficiente para ${product.name}: disponible ${product.stock}, requerido ${baseQuantity}`,
        )
      }

      resolved.push({
        product,
        unitPrice,
        quantity,
        baseQuantity,
        alternateQuantity: isCaj ? item.alternate_quantity! : null,
        discountAmount,
        subtotal,
        priceTypeId: item.price_type_id,
      })
    }

    /* 5) INSERT sales */
    const subtotal = round2(resolved.reduce((s, r) => s + r.subtotal, 0))
    const discount = round2(resolved.reduce((s, r) => s + r.discountAmount, 0))
    const total = round2(Math.max(0, subtotal - discount))
    // NOTA impuestos: el contrato móvil actual (CreateSalePayload/SaleResponse)
    // no incluye IVA; la columna tax del esquema queda en 0 hasta que el
    // frontend incorpore impuestos al flujo (tenant_settings.tax_rate).
    const tax = 0

    const { rows: saleRows } = await tx.query<SaleInsertRow>(
      `INSERT INTO sales
         (tenant_id, device_id, seller_id, customer_id, folio_number, folio_prefix,
          subtotal, discount, tax, total, status, payment_state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'V', $6, $7, $8, $9, 'COMPLETED', 'PAID', $10, $10)
       RETURNING id, tenant_id, folio_number, folio_prefix, folio_display,
                 subtotal, discount, tax, total, status, payment_state, created_at`,
      [
        tenant_id,
        device_id,
        seller_id,
        input.customer_id ?? null,
        folioNumber,
        subtotal,
        discount,
        tax,
        total,
        new Date().toISOString(),
      ],
    )
    const sale = saleRows[0]
    if (!sale) throw new HttpError('INTERNAL', 'No se pudo registrar la venta')

    /* 6) INSERT sale_items (base_quantity la recalcula el trigger) */
    for (const r of resolved) {
      const now = new Date().toISOString()
      await tx.query(
        `INSERT INTO sale_items
           (sale_id, tenant_id, product_id, product_name, product_barcode,
            product_base_unit_id, product_sale_unit_id, product_unit_conversion,
            price_type_id, quantity, base_quantity, alternate_quantity, unit_id,
            unit_price, discount_applied, subtotal, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          sale.id,
          tenant_id,
          r.product.id,
          r.product.name,
          r.product.barcode,
          r.product.base_unit_id,
          r.product.sale_unit_id,
          r.product.unit_conversion,
          r.priceTypeId,
          r.quantity,
          r.baseQuantity,
          r.alternateQuantity,
          r.product.sale_unit_id,
          r.unitPrice,
          r.discountAmount,
          r.subtotal,
          now,
        ],
      )
    }

    /* 7) INSERT sale_payments + estado de pago + crédito ------------------ */

    // Clasifica pagos: no-crédito (líquidos) y crédito (RF-VE-005).
    const liquid = input.payments.filter((p) => p.method !== 'CREDIT')
    const credit = input.payments.filter((p) => p.method === 'CREDIT')
    const liquidAmount = round2(liquid.reduce((s, p) => s + Number(p.amount ?? 0), 0))
    const creditAmount = round2(credit.reduce((s, p) => s + Number(p.amount ?? 0), 0))

    // Los métodos no-efectivo no pueden exceder el total (no hay "vuelto").
    const nonCash = liquid.filter((p) => p.method !== 'CASH')
    const nonCashAmount = round2(nonCash.reduce((s, p) => s + Number(p.amount ?? 0), 0))
    if (nonCashAmount > total) {
      throw new HttpError(
        'VALIDATION_ERROR',
        'Los pagos con tarjeta/transferencia/voucher exceden el total',
      )
    }

    // El efectivo puede exceder → genera vuelto (change_amount).
    let paymentState: 'PAID' | 'PENDING' | 'PARTIAL' = 'PAID'
    let changeAmount = 0

    if (creditAmount > 0) {
      const creditApplied = round2(total - liquidAmount)
      if (creditApplied < 0) {
        throw new HttpError('VALIDATION_ERROR', 'Los pagos exceden el total de la venta')
      }
      if (creditAmount < creditApplied) {
        throw new HttpError(
          'VALIDATION_ERROR',
          `El crédito no cubre el remanente: faltan $${round2(creditApplied - creditAmount)}`,
        )
      }
      // Cliente obligatorio para venta a crédito (RF-VE-005).
      if (!input.customer_id) {
        throw new HttpError(
          'VALIDATION_ERROR',
          'Una venta a crédito requiere seleccionar un cliente',
        )
      }
      const { rows: customerRows } = await tx.query<{
        credit_limit: number
        current_balance: number
        is_active: number
      }>(
        `SELECT credit_limit, current_balance, is_active FROM customers
         WHERE tenant_id = $1 AND id = $2`,
        [tenant_id, input.customer_id],
      )
      const customer = customerRows[0]
      if (!customer) {
        throw new HttpError('NOT_FOUND', 'Cliente no encontrado')
      }
      if (customer.is_active !== 1) {
        throw new HttpError('CONFLICT', 'Cliente inactivo')
      }
      const balanceAfter = Number(customer.current_balance) + creditApplied
      if (balanceAfter > Number(customer.credit_limit)) {
        throw new HttpError(
          'CONFLICT',
          `Límite de crédito excedido: saldo ${balanceAfter} > límite ${customer.credit_limit}`,
        )
      }

      // Pago a crédito: registra el débito en customer_credits (amount negativo)
      // y actualiza el saldo corriente del cliente.
      const now = new Date().toISOString()
      await tx.query(
        `INSERT INTO customer_credits
           (tenant_id, customer_id, sale_id, amount, type, notes, created_by, created_at)
         VALUES ($1, $2, $3, $4, 'SALE', $5, $6, $7)`,
        [tenant_id, input.customer_id, sale.id, -creditApplied, `Venta ${sale.folio_display}`, seller_id, now],
      )
      await tx.query(
        `UPDATE customers SET current_balance = current_balance + $3, updated_at = $4
         WHERE tenant_id = $1 AND id = $2`,
        [tenant_id, input.customer_id, creditApplied, now],
      )

      paymentState = creditApplied >= total ? 'PENDING' : 'PARTIAL'
    }

    // Filas de pago. El vuelto se asigna a la primera fila CASH.
    for (const payment of input.payments) {
      const now = new Date().toISOString()
      let change = 0
      if (payment.method === 'CASH') {
        const otherLiquid = round2(
          liquid
            .filter((p) => p !== payment)
            .reduce((s, p) => s + Number(p.amount ?? 0), 0),
        )
        change = round2(Math.max(0, Number(payment.amount) - (total - otherLiquid)))
        changeAmount = change
      }
      await tx.query(
        `INSERT INTO sale_payments
           (sale_id, tenant_id, method, amount, reference_code, change_amount, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sale.id,
          tenant_id,
          payment.method,
          Number(payment.amount),
          payment.reference_code ?? null,
          change,
          now,
        ],
      )
    }

    // Si no hubo crédito pero los pagos líquidos no cubren el total → error.
    if (creditAmount === 0 && liquidAmount < total) {
      throw new HttpError(
        'VALIDATION_ERROR',
        `Los pagos no cubren el total: faltan $${round2(total - liquidAmount)}`,
      )
    }

    // Actualiza el estado de pago definitivo (puede ser PENDING/PARTIAL).
    if (paymentState !== 'PAID') {
      await tx.query(
        `UPDATE sales SET payment_state = $3, updated_at = $4
         WHERE tenant_id = $1 AND id = $2`,
        [tenant_id, sale.id, paymentState, new Date().toISOString()],
      )
    }

    /* 9) INSERT stored_tickets (ESC_POS de texto para reimpresión) */
    const ticket = buildEscPosTicket({
      businessName: (await loadBusinessName(tx, tenant_id)) ?? 'POS',
      folio: sale.folio_display,
      createdAt: sale.created_at,
      items: resolved,
      subtotal,
      discount,
      total,
      payments: input.payments,
      change: changeAmount,
      paymentState,
    })
    await tx.query(
      `INSERT INTO stored_tickets
         (tenant_id, sale_id, ticket_type, content, content_format, created_at)
       VALUES ($1, $2, 'SALE', $3, 'ESC_POS', $4)`,
      [tenant_id, sale.id, ticket, new Date().toISOString()],
    )

    /* 8-10) QoS: el trigger ya creó el evento; se devuelve su id. */
    const { rows: qosRows } = await tx.query<QosRow>(
      `SELECT id FROM service_quality_events
       WHERE tenant_id = $1 AND sale_id = $2 LIMIT 1`,
      [tenant_id, sale.id],
    )

    return {
      id: sale.id,
      tenant_id: sale.tenant_id,
      folio: sale.folio_display,
      status: sale.status,
      payment_state: paymentState,
      subtotal: Number(sale.subtotal),
      total_discount: Number(sale.discount),
      total: Number(sale.total),
      payment_change: changeAmount > 0 ? changeAmount : undefined,
      created_at: sale.created_at,
      qos_event_id: qosRows[0]?.id,
    }
  })
  } catch (err: unknown) {
    /* Defense-in-depth: si el trigger CHECK dispara por una condición de
       carrera no cubierta por FOR UPDATE, convertir a INSUFFICIENT_STOCK (422)
       en lugar de un 500 genérico. */
    if (isPgCheckViolation(err)) {
      throw new HttpError(
        'INSUFFICIENT_STOCK',
        'Otro cajero acaba de vender el stock disponible. Intente nuevamente.',
      )
    }
    throw err
  }
}

/** Detecta violaciones de CHECK de PostgreSQL (código 23514). */
function isPgCheckViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23514'
  )
}

/** Nombre comercial para el ticket (tenant_settings.business_name). */
async function loadBusinessName(tx: typeof db, tenantId: string): Promise<string | null> {
  const { rows } = await tx.query<{ business_name: string | null }>(
    'SELECT business_name FROM tenant_settings WHERE tenant_id = $1',
    [tenantId],
  )
  return rows[0]?.business_name ?? null
}

/* ── GET /sales/:id ───────────────────────────────────────────────────── */

/** Devuelve la venta completa con ítems y pagos (GET /sales/:id). */
export async function getSale(tenantId: string, saleId: string): Promise<SaleDetail> {
  const { rows: saleRows } = await db.query<
    Omit<SaleDetail, 'folio' | 'items' | 'payments'> & { folio_display: string }
  >(
    `SELECT id, tenant_id, device_id, seller_id, customer_id, folio_number, folio_prefix,
            folio_display, subtotal, discount, tax, total, status, payment_state,
            cancel_reason, notes, created_at
     FROM sales WHERE tenant_id = $1 AND id = $2`,
    [tenantId, saleId],
  )
  const sale = saleRows[0]
  if (!sale) throw new HttpError('NOT_FOUND', 'Venta no encontrada')

  const [{ rows: items }, { rows: payments }] = await Promise.all([
    db.query<SaleItem>(
      `SELECT id, product_id, product_name, product_barcode, price_type_id,
              quantity, base_quantity, alternate_quantity, unit_id, unit_price,
              discount_applied, subtotal
       FROM sale_items WHERE tenant_id = $1 AND sale_id = $2
       ORDER BY created_at ASC`,
      [tenantId, saleId],
    ),
    db.query<SalePayment>(
      `SELECT id, method, amount, reference_code, change_amount, created_at
       FROM sale_payments WHERE tenant_id = $1 AND sale_id = $2
       ORDER BY created_at ASC`,
      [tenantId, saleId],
    ),
  ])

  return {
    id: sale.id,
    tenant_id: sale.tenant_id,
    device_id: sale.device_id,
    seller_id: sale.seller_id,
    customer_id: sale.customer_id,
    folio_number: sale.folio_number,
    folio_prefix: sale.folio_prefix,
    folio: sale.folio_display,
    subtotal: sale.subtotal,
    discount: sale.discount,
    tax: sale.tax,
    total: sale.total,
    status: sale.status,
    payment_state: sale.payment_state,
    cancel_reason: sale.cancel_reason,
    notes: sale.notes,
    created_at: sale.created_at,
    items,
    payments,
  }
}

/** Fila de stored_tickets para reimpresión. */
export interface StoredTicket {
  id: string
  sale_id: string
  ticket_type: string
  content: string
  content_format: string
  printed_at: string | null
  reprinted_count: number
  created_at: string
}

/** Obtiene el ticket almacenado de una venta para reimprimir (RF-CC-003, RF-IM). */
export async function getTicket(tenantId: string, saleId: string): Promise<StoredTicket> {
  const { rows } = await db.query<StoredTicket>(
    `SELECT id, sale_id, ticket_type, content, content_format,
            printed_at, reprinted_count, created_at
     FROM stored_tickets
     WHERE tenant_id = $1 AND sale_id = $2 AND ticket_type = 'SALE'
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, saleId],
  )
  const ticket = rows[0]
  if (!ticket) throw new HttpError('NOT_FOUND', 'Ticket de venta no encontrado')
  return ticket
}

/* ── POST /sales/:id/cancel ───────────────────────────────────────────── */

/** Fila de venta mínima para cancelar (aislada por tenant). */
interface SaleCancelRow {
  id: string
  folio_display: string
  status: string
  payment_state: string
  subtotal: number
  discount: number
  total: number
  customer_id: string | null
}

/**
 * Cancela una venta COMPLETED (permiso `sales:cancel` en la ruta).
 * El trigger `trg_sales_restore_stock` restaura el stock y genera el
 * movimiento RETURN automáticamente (no se reimplementa en JS).
 * Adicionalmente:
 *   - Si la venta era a crédito (PENDING/PARTIAL), revierte el saldo del
 *     cliente con un customer_credits ADJUSTMENT positivo (deshace el débito
 *     de la venta).
 *   - El evento QoS pendiente se marca EXPIRED (skill sales-transaction).
 */
export async function cancelSale(
  actor: SaleActor,
  saleId: string,
  reason: string,
): Promise<SaleResponse> {
  const { tenant_id, seller_id } = actor

  return db.transaction(async (tx) => {
    const { rows } = await tx.query<SaleCancelRow>(
      `SELECT id, folio_display, status, payment_state, subtotal, discount, total, customer_id
       FROM sales WHERE tenant_id = $1 AND id = $2`,
      [tenant_id, saleId],
    )
    const sale = rows[0]
    if (!sale) throw new HttpError('NOT_FOUND', 'Venta no encontrada')

    if (sale.status !== 'COMPLETED') {
      throw new HttpError('CONFLICT', `La venta ${sale.folio_display} ya no puede cancelarse (estado: ${sale.status})`)
    }

    const now = new Date().toISOString()

    /* 1) Marcar cancelada — el trigger trg_sales_restore_stock restaura stock */
    await tx.query(
      `UPDATE sales
       SET status = 'CANCELLED', cancelled_at = $3, cancelled_by = $4,
           cancel_reason = $5, updated_at = $6
       WHERE tenant_id = $1 AND id = $2`,
      [tenant_id, saleId, now, seller_id, reason.trim(), now],
    )

    /* 2) Revertir crédito si la venta tenía saldo pendiente (RF-VE-005) */
    if (sale.payment_state !== 'PAID' && sale.customer_id) {
      const { rows: creditRows } = await tx.query<{ total: number }>(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM customer_credits
         WHERE tenant_id = $1 AND customer_id = $2 AND sale_id = $3 AND type = 'SALE'`,
        [tenant_id, sale.customer_id, saleId],
      )
      const creditApplied = Number(creditRows[0]?.total ?? 0)
      if (creditApplied < 0) {
        const reversal = Math.abs(creditApplied)
        await tx.query(
          `INSERT INTO customer_credits
             (tenant_id, customer_id, sale_id, amount, type, notes, created_by, created_at)
           VALUES ($1, $2, $3, $4, 'ADJUSTMENT', $5, $6, $7)`,
          [
            tenant_id,
            sale.customer_id,
            saleId,
            reversal,
            `Cancelación de venta ${sale.folio_display}`,
            seller_id,
            now,
          ],
        )
        await tx.query(
          `UPDATE customers SET current_balance = current_balance - $3, updated_at = $4
           WHERE tenant_id = $1 AND id = $2`,
          [tenant_id, sale.customer_id, reversal, now],
        )
      }
    }

    /* 3) Reset QoS: el evento pendiente de la venta se expira (no aplicar) */
    await tx.query(
      `UPDATE service_quality_events SET status = 'EXPIRED'
       WHERE tenant_id = $1 AND sale_id = $2 AND status = 'PENDING'`,
      [tenant_id, saleId],
    )

    return {
      id: sale.id,
      tenant_id,
      folio: sale.folio_display,
      status: 'CANCELLED',
      payment_state: 'PAID',
      subtotal: Number(sale.subtotal),
      total_discount: Number(sale.discount),
      total: Number(sale.total),
      created_at: now,
    }
  })
}

/* ── GET /sales (listado para "mis tickets" y reportes) ─────────────────── */

/** Fila de listado de ventas (incluye status para canceladas). */
export interface SaleListRow {
  id: string
  folio: string
  seller_id: string | null
  seller_name: string | null
  customer_name: string | null
  subtotal: number
  discount: number
  tax: number
  total: number
  payment_state: string
  status: string
  created_at: string
}

/**
 * Lista ventas del tenant con filtros opcionales (fecha, vendedor).
 * `sales:read_own` filtra por seller_id; `sales:read_all` ve todas.
 */
export async function listSales(
  tenantId: string,
  params: { from?: string; to?: string; seller_id?: string; folio?: string; limit?: number; offset?: number },
): Promise<{ items: SaleListRow[]; total: number }> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100)
  const offset = Math.max(params.offset ?? 0, 0)

  const conditions: string[] = ['s.tenant_id = $1']
  const values: unknown[] = [tenantId]
  let idx = 2

  if (params.seller_id) {
    conditions.push(`s.seller_id = $${idx++}`)
    values.push(params.seller_id)
  }
  if (params.from) {
    conditions.push(`s.created_at >= $${idx++}`)
    values.push(params.from)
  }
  if (params.to) {
    conditions.push(`s.created_at <= $${idx++}`)
    values.push(params.to)
  }
  if (params.folio) {
    const folio = params.folio.trim().toUpperCase()
    if (folio) {
      conditions.push(`UPPER(s.folio_display) LIKE UPPER($${idx++})`)
      values.push(`${folio}%`)
    }
  }

  const whereSql = conditions.join(' AND ')

  const [{ rows: countRows }, { rows }] = await Promise.all([
    db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM sales s WHERE ${whereSql}`,
      values,
    ),
    db.query<SaleListRow>(
      `SELECT s.id,
              s.folio_display AS folio,
              s.seller_id,
              u.name AS seller_name,
              c.name AS customer_name,
              s.subtotal, s.discount, s.tax, s.total,
              s.payment_state, s.status, s.created_at
       FROM sales s
       LEFT JOIN users u ON u.id = s.seller_id
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE ${whereSql}
       ORDER BY s.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset],
    ),
  ])

  return {
    items: rows,
    total: countRows[0]?.total ?? 0,
  }
}

/* ── Ticket ESC/POS (texto plano, content_format='ESC_POS') ───────────── */

interface TicketInput {
  businessName: string
  folio: string
  createdAt: string
  items: Array<{
    product: { name: string }
    quantity: number
    alternateQuantity: number | null
    unitPrice: number
    discountAmount: number
    subtotal: number
  }>
  subtotal: number
  discount: number
  total: number
  payments: CreateSalePayload['payments']
  change: number
  paymentState: string
}

/** Construye el contenido del ticket de venta (para reimpresión). */
function buildEscPosTicket(input: TicketInput): string {
  const lines: string[] = []
  lines.push('==============================')
  lines.push(input.businessName.toUpperCase())
  lines.push(`FOLIO: ${input.folio}`)
  lines.push(new Date(input.createdAt).toLocaleString('es-MX'))
  lines.push('------------------------------')
  for (const item of input.items) {
    const name = item.product.name
    const qty = item.alternateQuantity !== null ? `${item.alternateQuantity}kg` : String(item.quantity)
    lines.push(`${name}`)
    lines.push(
      `${qty} x $${item.unitPrice.toFixed(2)}  $${item.subtotal.toFixed(2)}`,
    )
    if (item.discountAmount > 0) {
      lines.push(`  Descuento: -$${item.discountAmount.toFixed(2)}`)
    }
  }
  lines.push('------------------------------')
  lines.push(`SUBTOTAL:   $${input.subtotal.toFixed(2)}`)
  if (input.discount > 0) {
    lines.push(`DESCUENTO: -$${input.discount.toFixed(2)}`)
  }
  lines.push(`TOTAL:      $${input.total.toFixed(2)}`)
  lines.push('------------------------------')
  lines.push('PAGOS:')
  for (const payment of input.payments) {
    const label: Record<string, string> = {
      CASH: 'EFECTIVO',
      CARD: 'TARJETA',
      TRANSFER: 'TRANSFERENCIA',
      CREDIT: 'CREDITO',
      VOUCHER: 'VOUCHER',
    }
    lines.push(`${label[payment.method] ?? payment.method}: $${Number(payment.amount).toFixed(2)}`)
  }
  if (input.change > 0) {
    lines.push(`VUELTO: $${input.change.toFixed(2)}`)
  }
  if (input.paymentState !== 'PAID') {
    lines.push(`ESTADO: ${input.paymentState}`)
  }
  lines.push('==============================')
  lines.push('Gracias por su compra')
  return lines.join('\n')
}
