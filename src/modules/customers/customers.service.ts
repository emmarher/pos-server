/**
 * src/modules/customers/customers.service.ts — Clientes y Crédito (RF-VE-005).
 *
 * ────────────────────────────────────────────────────────────────────────
 * RF-VE-005: Clientes a crédito.
 *
 * MULTI-TENANT: TODAS las consultas filtran por tenant_id = $x; el tenant
 * SIEMPRE viene del JWT (request.user.tenant_id), nunca del body/query.
 * ────────────────────────────────────────────────────────────────────────
 */
import { db } from '../../database/client.js'
import { HttpError } from '../../types/errors.js'
import type {
  Customer,
  CustomerSearchResult,
  CustomerInput,
  CustomerCreditAdjustment,
  CustomerCreditResponse,
  CustomerPaymentPayload,
} from '../../types/customers.js'

/* ── SELECT con balance ────────────────────────────────────────────────── */

const CUSTOMER_BALANCE_SELECT =
  'SELECT c.id, c.tenant_id, c.name, c.description, c.phone, c.email, c.address, c.rfc, c.credit_limit, c.current_balance, c.loyalty_points, c.loyalty_points_value, c.is_active, c.created_at, c.updated_at, COALESCE(SUM(cc.amount), 0) AS total_credit FROM customers c LEFT JOIN customer_credits cc ON cc.tenant_id = c.tenant_id AND cc.customer_id = c.id AND cc.type = \'SALE\' WHERE c.tenant_id = $1 GROUP BY c.id';

/* ── Listado ──────────────────────────────────────────────────────────── */

export async function listCustomers(
  tenantId: string,
  params: CustomerQuery = {},
): Promise<CustomerSearchResult> {
  const activeOnly = params.activeOnly !== false;
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);
  const q = params.q?.trim() ?? '';

  const values: unknown[] = [tenantId];
  let cond = 2;

  if (activeOnly) {
    values.push(1);
  }

  const searchCond = q
    ? 'AND (c.name LIKE \'%\' || $' + cond + ' OR c.rfc LIKE \'%\' || $' + (cond + 1) + ')'
    : '';

  values.push('%' + q + '%', '%' + q + '%');

  const whereSql =
    (activeOnly ? 'AND c.is_active = 1 AND' : '') + ' c.tenant_id = $1 ' + (q ? searchCond : '');

  const [{ rows: countRows }, { rows }] = await Promise.all([
    db.query<{ total: number }>(`
      SELECT COUNT(*) AS total FROM customers c ${whereSql} GROUP BY c.id`,
      values,
    ),
    db.query(`
      SELECT c.id, c.tenant_id, c.name, c.description, c.phone, c.email, c.address,
        c.rfc, c.credit_limit, c.current_balance, c.loyalty_points,
        c.loyalty_points_value, c.is_active, c.created_at, c.updated_at,
        COALESCE(SUM(cc.amount), 0) AS total_credit
      FROM customers c
      LEFT JOIN customer_credits cc ON cc.tenant_id = c.tenant_id AND cc.customer_id = c.id AND cc.type = \'SALE\'
      WHERE ${whereSql} GROUP BY c.id`,
      values,
    ),
  ]);

  const items = rows.map(r => ({
    id: r.id,
    tenant_id: r.tenant_id,
    name: r.name,
    description: r.description,
    phone: r.phone,
    email: r.email,
    address: r.address,
    rfc: r.rfc,
    credit_limit: r.credit_limit,
    current_balance: Number(r.current_balance) + Number(r.total_credit),
    loyalty_points: r.loyalty_points,
    loyalty_points_value: r.loyalty_points_value,
    is_active: r.is_active === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  } as Customer));

  return { items, total: countRows[0]?.total ?? 0 };
}

/** Obtiene un cliente por ID con balance calculado. */
export async function getCustomer(tenantId: string, id: string): Promise<Customer> {
  const { rows } = await db.query(`
    SELECT c.id, c.tenant_id, c.name, c.description, c.phone, c.email, c.address,
      c.rfc, c.credit_limit, c.current_balance, c.loyalty_points, c.loyalty_points_value,
      c.is_active, c.created_at, c.updated_at,
      COALESCE(SUM(cc.amount), 0) AS total_credit
    FROM customers c
    LEFT JOIN customer_credits cc ON cc.tenant_id = c.tenant_id AND cc.customer_id = c.id AND cc.type = \'SALE\'
    WHERE c.tenant_id = $1 AND c.id = $2 GROUP BY c.id`,
    [tenantId, id],
  );
  const customer = rows[0];
  if (!customer) {
    throw new HttpError('NOT_FOUND', 'Cliente no encontrado');
  }
  return {
    id: customer.id,
    tenant_id: customer.tenant_id,
    name: customer.name,
    description: customer.description,
    phone: customer.phone,
    email: customer.email,
    address: customer.address,
    rfc: customer.rfc,
    credit_limit: customer.credit_limit,
    current_balance: Number(customer.current_balance) + Number(customer.total_credit),
    loyalty_points: customer.loyalty_points,
    loyalty_points_value: customer.loyalty_points_value,
    is_active: customer.is_active === 1,
    created_at: customer.created_at,
    updated_at: customer.updated_at,
  };
}

/** Crea un nuevo cliente. */
export async function createCustomer(
  tenantId: string,
  input: CustomerInput,
): Promise<Customer> {
  const now = 'now';
  const { rows } = await db.query<{ id: string }>(`
    INSERT INTO customers
       (tenant_id, name, description, phone, email, address, rfc,
        credit_limit, current_balance, loyalty_points, loyalty_points_value,
        is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, $9, $10, $10)
     RETURNING id, tenant_id, name, description, phone, email, address,
               rfc, credit_limit, current_balance, loyalty_points,
               loyalty_points_value, is_active, created_at, updated_at`,
    [
      tenantId,
      input.name.trim(),
      input.description ?? null,
      input.phone ?? null,
      input.email ?? null,
      input.address ?? null,
      input.rfc ?? null,
      input.credit_limit ?? 0,
      0,
      0,
      0,
      input.is_active === false ? 0 : 1,
      now,
    ],
  );
  const customer = rows[0];
  if (!customer) throw new HttpError('INTERNAL', 'No se pudo crear el cliente');
  return {
    ...customer,
    is_active: customer.is_active === 1,
    current_balance: Number(customer.current_balance),
  };
}

/** Actualiza un cliente. */
export async function updateCustomer(
  tenantId: string,
  id: string,
  input: Partial<CustomerInput>,
): Promise<Customer> {
  const current = await getCustomer(tenantId, id);
  const now = 'now';

  const updateQ =
    'UPDATE customers SET name = $3, description = $4, phone = $5, email = $5, address = $6, rfc = $7, credit_limit = $8, is_active = $9, updated_at = $10 WHERE tenant_id = $1 AND id = $2 RETURNING id, tenant_id, name, description, phone, email, address, rfc, credit_limit, current_balance, loyalty_points, loyalty_points_value, is_active, created_at, updated_at';
  const vals = [tenantId, id,
    input.name ?? current.name,
    input.description ?? current.description,
    input.phone ?? current.phone,
    input.email ?? current.email,
    input.address ?? current.address,
    input.rfc ?? current.rfc,
    input.credit_limit !== undefined ? input.credit_limit : current.credit_limit,
    input.is_active !== undefined ? (input.is_active ? 1 : 0) : current.is_active ? 1 : 0,
    now,
  ];

  const { rows } = await db.query<{ id: string }>(updateQ, vals);
  const customer = rows[0];
  if (!customer) throw new HttpError('NOT_FOUND', 'Cliente no encontrado');
  return {
    ...customer,
    is_active: customer.is_active === 1,
    current_balance: Number(customer.current_balance),
  };
}

/** Verifica si el cliente tiene crédito disponible. */
export async function checkCredit(
  tenantId: string,
  customerId: string,
  chargeAmount: number,
): Promise<{ ok: boolean; newBalance: number; exceededLimit: boolean; message: string }> {
  const customer = await getCustomer(tenantId, customerId);
  const newBalance = Number(customer.current_balance) + chargeAmount;
  const exceededLimit = newBalance > customer.credit_limit;

  if (exceededLimit) {
    return {
      ok: false,
      newBalance,
      exceededLimit: true,
      message: 'Límites de crédito excedido: ' + newBalance + ' > ' + customer.credit_limit,
    };
  }

  return {
    ok: true,
    newBalance,
    exceededLimit: false,
    message: 'Crédito disponible',
  };
}

/** Realiza un cargo o abono al crédito del cliente (RF-VE-005). */
export async function makeCreditAdjustment(
  actor: { tenant_id: string; user_id: string; customer_id: string },
  input: CustomerCreditAdjustment,
): Promise<CustomerCreditResponse> {
  if (!input.reason || input.reason.trim() === '') {
    throw new HttpError('VALIDATION_ERROR', 'El motivo es obligatorio');
  }
  if (!Number.isFinite(input.amount) || input.amount === 0) {
    throw new HttpError('VALIDATION_ERROR', 'El monto no puede ser cero');
  }

  const { tenant_id, user_id, customer_id } = actor;
  const creditCheck = await checkCredit(tenant_id, customer_id, input.amount);

  if (!creditCheck.ok) {
    throw new HttpError('CONFLICT', creditCheck.message);
  }

  const now = 'now';
  const newBalance = creditCheck.newBalance;

  db.query(
    'INSERT INTO customer_credits (tenant_id, customer_id, amount, type, notes, created_by, created_at) VALUES ($1, $2, $3, \'ADJUSTMENT\', $4, $5, $6)',
    [tenant_id, customer_id, input.amount, input.reason.trim(), user_id, now],
  );

  db.query(
    'UPDATE customers SET current_balance = $3, updated_at = $4 WHERE tenant_id = $1 AND id = $2',
    [tenant_id, customer_id, newBalance, now],
  );

  return {
    new_balance: newBalance,
    exceeded_limit: false,
    message: input.amount > 0 ? 'Cargo registrado correctamente' : 'Abono registrado correctamente',
  );
}

/** Realiza un pago a crédito (RF-VE-005). */
export async function makeCreditPayment(
  actor: { tenant_id: string; user_id: string; customer_id: string },
  input: CustomerPaymentPayload,
): Promise<CustomerCreditResponse> {
  return await makeCreditAdjustment(actor, {
    customer_id: input.customer_id,
    amount: input.amount,
    reason: input.reason,
  });
}

/* ── Conversión de errores de la BD ───────────────────────────────────── */

function toHttpError(err: unknown, fallback: string): HttpError {
  if (err instanceof HttpError) return err;
  const message = err instanceof Error ? err.message : '';
  const code = (err as { code?: string })?.code ?? '';

  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/i.test(message)) {
    return new HttpError('CONFLICT', 'Ya existe un cliente con ese RFC o nombre');
  }
  if (code === 'SQLITE_CONSTRAINT_CHECK' || /CHECK/i.test(message)) {
    return new HttpError('VALIDATION_ERROR', 'El registro no cumple las reglas de validación');
  }
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY/i.test(message)) {
    return new HttpError('CONFLICT', 'Referencia no válida o recurso en uso');
  }
  return new HttpError('INTERNAL', fallback);
}