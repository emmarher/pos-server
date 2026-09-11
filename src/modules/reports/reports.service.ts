/**
 * src/modules/reports/reports.service.ts — Reportes (RF-PR).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Provee:
 *   - quickStats: totales de ventas (hoy/ayer), ticket promedio, conteo,
 *     desglose por método de pago y por categoría.
 *   - salesHistory: historial de ventas con filtros (fecha, vendedor).
 * MULTI-TENANT: toda query filtra tenant_id (del JWT).
 * ────────────────────────────────────────────────────────────────────────
 */
import { db } from '../../database/client.js'

/** Desglose por método de pago. */
export interface PaymentBreakdown {
  method: string
  total: number
  count: number
}

/** Desglose por categoría. */
export interface CategoryBreakdown {
  category_id: string | null
  category_name: string | null
  total: number
}

/** Resultado de /reports/quick-stats. */
export interface QuickStats {
  today: {
    total_sales: number
    transactions: number
    average_ticket: number
  }
  yesterday: {
    total_sales: number
    transactions: number
  }
  by_payment_method: PaymentBreakdown[]
  by_category: CategoryBreakdown[]
}

/** Fila de una venta en el historial. */
export interface SaleHistoryRow {
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
  created_at: string
}

/** Resumen con paginación del historial. */
export interface SalesHistoryResult {
  items: SaleHistoryRow[]
  total: number
}

/** Redondeo a 2 decimales para montos. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Totales rápidos de ventas (RF-PR / "sumar dinero"). */
export async function quickStats(tenantId: string): Promise<QuickStats> {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(yesterdayStart.getDate() - 1)

  // Totales por día (hoy y ayer) sobre ventas COMPLETADAS
  const { rows: dayRows } = await db.query<{
    day: string
    total: number
    count: number
  }>(
    `SELECT
       CASE WHEN created_at >= $2 THEN 'today'
            WHEN created_at >= $3 AND created_at < $2 THEN 'yesterday'
            ELSE 'older' END AS day,
       COALESCE(SUM(total), 0) AS total,
       COUNT(*) AS count
     FROM sales
     WHERE tenant_id = $1 AND status = 'COMPLETED'
       AND created_at >= $3
     GROUP BY day`,
    [tenantId, todayStart.toISOString(), yesterdayStart.toISOString()],
  )

  const todayRow = dayRows.find((r) => r.day === 'today')
  const yesterdayRow = dayRows.find((r) => r.day === 'yesterday')
  const todayTotal = round2(todayRow?.total ?? 0)
  const todayCount = todayRow?.count ?? 0
  const yesterdayTotal = round2(yesterdayRow?.total ?? 0)
  const yesterdayCount = yesterdayRow?.count ?? 0

  // Desglose por método de pago (hoy)
  const { rows: paymentRows } = await db.query<{ method: string; total: number; count: number }>(
    `SELECT sp.method, COALESCE(SUM(sp.amount), 0) AS total, COUNT(*) AS count
     FROM sale_payments sp
     JOIN sales s ON s.id = sp.sale_id AND s.tenant_id = $1
     WHERE sp.tenant_id = $1 AND s.status = 'COMPLETED' AND s.created_at >= $2
     GROUP BY sp.method
     ORDER BY total DESC`,
    [tenantId, todayStart.toISOString()],
  )
  const by_payment_method: PaymentBreakdown[] = paymentRows.map((r) => ({
    method: r.method,
    total: round2(r.total),
    count: r.count,
  }))

  // Desglose por categoría (hoy)
  const { rows: catRows } = await db.query<{
    category_id: string | null
    category_name: string | null
    total: number
  }>(
    `SELECT p.category_id, c.name AS category_name, COALESCE(SUM(si.subtotal), 0) AS total
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id AND s.tenant_id = $1
     JOIN products p ON p.id = si.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE si.tenant_id = $1 AND s.status = 'COMPLETED' AND s.created_at >= $2
     GROUP BY p.category_id, c.name
     ORDER BY total DESC`,
    [tenantId, todayStart.toISOString()],
  )
  const by_category: CategoryBreakdown[] = catRows.map((r) => ({
    category_id: r.category_id,
    category_name: r.category_name,
    total: round2(r.total),
  }))

  return {
    today: {
      total_sales: todayTotal,
      transactions: todayCount,
      average_ticket: todayCount > 0 ? round2(todayTotal / todayCount) : 0,
    },
    yesterday: {
      total_sales: yesterdayTotal,
      transactions: yesterdayCount,
    },
    by_payment_method,
    by_category,
  }
}

/** Historial de ventas con filtros (RF-PR). */
export async function salesHistory(
  tenantId: string,
  params: { from?: string; to?: string; seller_id?: string; limit?: number; offset?: number },
): Promise<SalesHistoryResult> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100)
  const offset = Math.max(params.offset ?? 0, 0)

  const conditions: string[] = ["s.tenant_id = $1"]
  const values: unknown[] = [tenantId]
  let idx = 2

  if (params.from) {
    conditions.push(`s.created_at >= $${idx++}`)
    values.push(params.from)
  }
  if (params.to) {
    conditions.push(`s.created_at <= $${idx++}`)
    values.push(params.to)
  }
  if (params.seller_id) {
    conditions.push(`s.seller_id = $${idx++}`)
    values.push(params.seller_id)
  }

  const whereSql = conditions.join(' AND ')

  const [{ rows: countRows }, { rows }] = await Promise.all([
    db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM sales s WHERE ${whereSql}`,
      values,
    ),
    db.query<SaleHistoryRow>(
      `SELECT s.id,
              s.folio_display AS folio,
              s.seller_id,
              u.name AS seller_name,
              c.name AS customer_name,
              s.subtotal, s.discount, s.tax, s.total, s.payment_state, s.created_at
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
