/**
 * src/modules/cashier/cashier.service.js — Lógica de negocio de cortes de caja.
 *
 * ────────────────────────────────────────────────────────────────────────
 * RF-CC-001: Corte por Turno (Vendedor)
 * RF-CC-002: Corte Diario Global (Admin)
 * RF-CC-003: Retiros de Caja y Reimpresión
 *
 * MULTI-TENANT: todas las queries filtran tenant_id (del JWT).
 * ────────────────────────────────────────────────────────────────────────
 */

import { db } from '../../database/client.js'
import { HttpError } from '../../types/errors.js'

/* ── Interfaces de entrada (exportadas para su uso en routes) ───────────── */

export interface StartCutInput {
  cut_type: 'TURN' | 'DAILY'
  branch_id?: string | null
}

export interface EndCutInput {
  cut_type: 'TURN' | 'DAILY'
  counted_cash: number    // efectivo físico que contó el cajero
  notes?: string | null
}

export interface WithdrawalInput {
  amount: number
  reason: string
}

export interface ReprintCutInput {
  cashier_cut_id: string
}

/* ── Tipos de filas de BD ──────────────────────────────────────────────── */

interface CashierCutRow {
  id: string
  tenant_id: string
  cut_type: 'TURN' | 'DAILY'
  start_at: string
  end_at: string | null
  status: 'OPEN' | 'CLOSED'
  total_sales: number | null
  total_transactions: number | null
  cash_amount: number | null
  card_amount: number | null
  transfer_amount: number | null
  credit_amount: number | null
  expected_cash: number | null
  counted_cash: number | null
  difference: number | null
}

interface SalePaymentRow {
  method: string
  amount: number | null
  change_amount: number | null
}

interface SaleRow {
  id: string
  folio_display: string
  subtotal: number | null
  total: number | null
  status: string
}

interface SaleItemRow {
  product_name: string
  quantity: number
  unit_price: number
  subtotal: number
}

interface WithdrawalRow {
  id: string
  tenant_id: string
  cashier_cut_id: string
  amount: number
  reason: string
  created_by: string
  created_at: string
}

/* ── Iniciar un corte (TURN o DAILY) ────────────────────────────────────── */

export async function startCut(tenantId: string, input: StartCutInput): Promise<CashierCutRow> {
  const cutType = input.cut_type
  const now = new Date().toISOString()
  const branchId = input.branch_id ?? null

  const { rows } = await db.query<CashierCutRow>(`
    INSERT INTO cashier_cuts
      (tenant_id, branch_id, cut_type, start_at, status, cloud_sync_status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'OPEN', 'PENDING', $5, $5)
    RETURNING id, tenant_id, branch_id, cut_type, start_at, status, cloud_sync_status, created_at
  `, [tenantId, branchId, cutType, now, now])

  const cut = rows[0]
  if (!cut) throw new HttpError('INTERNAL', 'No se pudo iniciar el corte')
  return cut
}

/* ── Finalizar un corte (TURN o DAILY) ──────────────────────────────────── */

export interface EndCutResult {
  id: string
  cut_type: 'TURN' | 'DAILY'
  start_at: string
  end_at: string
  status: 'CLOSED'
  total_transactions: number
  cash_received: number
  card_amount: number
  transfer_amount: number
  credit_amount: number
  expected_cash: number
  counted_cash: number
  difference: number
  notes?: string | null
}

export async function endCut(actor: { tenant_id: string; user_id: string },
                            input: EndCutInput,
                            cutId: string): Promise<EndCutResult> {
  const { tenant_id } = actor
  const countedCash = Number(input.counted_cash)
  const now = new Date().toISOString()

  // 1) Obtener el corte actual
  const { rows: cutRows } = await db.query<CashierCutRow>(`
    SELECT id, tenant_id, cut_type, start_at, end_at, status,
           total_sales, total_transactions, cash_amount, card_amount, transfer_amount, credit_amount,
           expected_cash, counted_cash, difference
    FROM cashier_cuts WHERE id = $1 AND tenant_id = $2
  `, [cutId, tenant_id])

  const cut = cutRows[0]
  if (!cut) throw new HttpError('NOT_FOUND', 'Corte no encontrado')
  if (cut.status !== 'OPEN') {
    throw new HttpError('CONFLICT', `El corte ${cut.id} ya está finalizado (status: ${cut.status})`)
  }

  // 2) Calcular totales de ventas asociadas a este corte
  const { rows: salesRows } = await db.query<SalePaymentRow>(`
    SELECT sp.method, sp.amount, sp.change_amount
    FROM sale_payments sp
    JOIN cashier_cut_sales ccs ON ccs.sale_id = sp.sale_id
    WHERE ccs.cashier_cut_id = $1
    ORDER BY sp.created_at ASC
  `, [cutId])

  // 3) Desglose por método de pago
  let cashReceived = 0
  let cardAmount = 0
  let transferAmount = 0
  let creditAmount = 0
  let transactionCount = 0

  for (const r of salesRows) {
    transactionCount++
    if (r.method === 'CASH') {
      cashReceived += Number(r.amount ?? 0)
    } else if (r.method === 'CARD') {
      cardAmount += Number(r.amount ?? 0)
    } else if (r.method === 'TRANSFER') {
      transferAmount += Number(r.amount ?? 0)
    } else if (r.method === 'CREDIT') {
      creditAmount += Number(r.amount ?? 0)
    }
  }

  // 4) Calcular diferencia (faltante/sobrante)
  const expectedCash = round2(cashReceived)
  const difference = round2(countedCash - expectedCash)

  // 5) Actualizar el corte con los totales
  await db.query(`
    UPDATE cashier_cuts
       SET end_at = $3,
           total_sales = $4,
           total_transactions = $5,
           cash_amount = $6,
           card_amount = $7,
           transfer_amount = $8,
           credit_amount = $9,
           expected_cash = $10,
           counted_cash = $11,
           difference = $12,
           status = 'CLOSED',
           updated_at = $13
    WHERE id = $1 AND tenant_id = $2
  `, [cutId, tenant_id, now,
       cashReceived,    // total_sales (efectivo + no efectivo se desglosa abajo)
       transactionCount,
       cashReceived,
       cardAmount,
       transferAmount,
       creditAmount,
       expectedCash,
       countedCash,
       difference,
       now]
  )

  return {
    id: cut.id,
    cut_type: cut.cut_type,
    start_at: cut.start_at,
    end_at: now,
    status: 'CLOSED',
    total_transactions: transactionCount,
    cash_received: cashReceived,
    card_amount: cardAmount,
    transfer_amount: transferAmount,
    credit_amount: creditAmount,
    expected_cash: expectedCash,
    counted_cash: countedCash,
    difference,
    notes: input.notes,
  }
}

/* ── Registrar un retiro de caja ────────────────────────────────────────── */

export async function createWithdrawal(actor: { tenant_id: string; user_id: string },
                                      input: WithdrawalInput,
                                      cashierCutId: string): Promise<WithdrawalRow> {
  const { tenant_id, user_id } = actor
  const { amount, reason } = input
  const now = new Date().toISOString()
  const amountNum = Number(amount)

  // Verificar que el corte existe y está cerrado
  const { rows: cutRows } = await db.query<CashierCutRow>(`
    SELECT id, status, counted_cash, difference FROM cashier_cuts WHERE id = $1 AND tenant_id = $2
  `, [cashierCutId, tenant_id])

  const cut = cutRows[0]
  if (!cut) throw new HttpError('NOT_FOUND', 'Corte no encontrado')
  if (cut.status !== 'CLOSED') {
    throw new HttpError('CONFLICT', `No se puede retirar de un corte abierto (status: ${cut.status})`)
  }
  if (amountNum > Number(cut.counted_cash ?? 0)) {
    throw new HttpError('VALIDATION_ERROR', `El retiro $${amountNum} excede el efectivo disponible $${Number(cut.counted_cash ?? 0)} en el corte`)
  }

  const { rows } = await db.query<WithdrawalRow>(`
    INSERT INTO cashier_withdrawals
      (tenant_id, cashier_cut_id, amount, reason, created_by, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, tenant_id, cashier_cut_id, amount, reason, created_by, created_at
  `, [tenant_id, cashierCutId, amountNum, reason, user_id, now])

  const withdrawal = rows[0]
  if (!withdrawal) throw new HttpError('INTERNAL', 'No se pudo registrar el retiro')

  // Actualizar counted_cash del corte restando el retiro
  await db.query(`
    UPDATE cashier_cuts SET counted_cash = counted_cash - $3, difference = difference - $3, updated_at = $4
    WHERE id = $1 AND tenant_id = $2
  `, [cashierCutId, tenant_id, amountNum, new Date().toISOString()])

  return withdrawal
}

/* ── Reimprimir un corte o ticket ──────────────────────────────────────── */

interface TicketContent {
  businessName: string
  cutType: 'TURN' | 'DAILY'
  startAt: string
  endAt: string | null
  totalSales: number
  totalTransactions: number
  cashAmount: number
  cardAmount: number
  transferAmount: number
  creditAmount: number
  expectedCash: number
  countedCash: number
  difference: number
  items: Array<{ product_name: string; quantity: number; unit_price: number; subtotal: number }>
  payments: Array<{ method: string; amount: number }>
}

interface CutWithNamesRow extends CashierCutRow {
  seller_name: string | null
  branch_name: string | null
}

interface CutSaleRow extends SaleRow {
  method: string
  amount: number | null
  change_amount: number | null
}

export async function getCutTicketContent(tenantId: string, input: ReprintCutInput): Promise<TicketContent> {
  const { cashier_cut_id } = input

  // Obtener datos del corte
  const { rows: cutRows } = await db.query<CutWithNamesRow>(`
    SELECT cc.*, u.name AS seller_name, b.name AS branch_name
    FROM cashier_cuts cc
    LEFT JOIN users u ON u.id = cc.seller_id
    LEFT JOIN branches b ON b.id = cc.branch_id
    WHERE cc.id = $1 AND cc.tenant_id = $2
  `, [cashier_cut_id, tenantId])

  const cut = cutRows[0]
  if (!cut) throw new HttpError('NOT_FOUND', 'Corte no encontrado')

  // Obtener items (ventas asociadas al corte)
  const { rows: salesRows } = await db.query<CutSaleRow>(`
    SELECT s.id, s.folio_display, s.subtotal, s.total, s.status,
           sp.method, sp.amount, sp.change_amount
    FROM sales s
    JOIN sale_payments sp ON sp.sale_id = s.id AND sp.tenant_id = $1
    JOIN cashier_cut_sales ccs ON ccs.sale_id = s.id
    WHERE ccs.cashier_cut_id = $2
    ORDER BY s.created_at ASC
  `, [tenantId, cashier_cut_id])

  // Para cada sale, obtener sus items
  const items: Array<{ product_name: string; quantity: number; unit_price: number; subtotal: number }> = []
  const payments: Array<{ method: string; amount: number }> = []

  for (const s of salesRows) {
    const { rows: itemRows } = await db.query<SaleItemRow>(`
      SELECT product_name, quantity, unit_price, subtotal
      FROM sale_items WHERE tenant_id = $1 AND sale_id = $2
      ORDER BY created_at ASC
    `, [tenantId, s.id])

    for (const item of itemRows) {
      items.push({
        product_name: item.product_name,
        quantity: item.quantity,
        unit_price: item.unit_price,
        subtotal: item.subtotal,
      })
    }

    // Agrupar pagos por tipo para el resumen
    const methodCounts: Record<string, number> = {}
    for (const r of salesRows) {
      if (r.method && r.amount) {
        methodCounts[r.method] = (methodCounts[r.method] ?? 0) + Number(r.amount)
      }
    }

    for (const [method, amount] of Object.entries(methodCounts)) {
      payments.push({ method, amount: round2(amount) })
    }
  }

  // Calcular totales
  const totalSales = round2(salesRows.reduce((sum, s) => sum + Number(s.subtotal ?? 0), 0))
  const totalTransactions = salesRows.length
  const cashAmount = round2(payments.find(p => p.method === 'CASH')?.amount ?? 0)
  const cardAmount = round2(payments.find(p => p.method === 'CARD')?.amount ?? 0)
  const transferAmount = round2(payments.find(p => p.method === 'TRANSFER')?.amount ?? 0)
  const creditAmount = round2(payments.find(p => p.method === 'CREDIT')?.amount ?? 0)
  const expectedCash = round2(Number(cut.expected_cash ?? 0))
  const countedCash = round2(Number(cut.counted_cash ?? 0))
  const difference = round2(countedCash - expectedCash)

  return {
    businessName: cut.branch_name || 'POS',
    cutType: cut.cut_type,
    startAt: cut.start_at,
    endAt: cut.end_at ?? null,
    totalSales,
    totalTransactions,
    cashAmount,
    cardAmount,
    transferAmount,
    creditAmount,
    expectedCash,
    countedCash,
    difference,
    items,
    payments,
  }
}

/* ── Helper de redondeo ─────────────────────────────────────────────────── */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}