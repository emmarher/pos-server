/**
 * src/modules/inventory/inventory.routes.ts — Rutas del inventario (RF-IN).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Endpoints (contrato con pos-mobile + panel de administración):
 *   GET  /inventory/locations        listar ubicaciones (RF-IN-001)
 *   POST /inventory/locations        crear ubicación
 *   PATCH /inventory/locations/:id   actualizar ubicación
 *   GET  /inventory/lots             lotes, filtro product_id (RF-IN-002)
 *   POST /inventory/lots             alta manual de lote
 *   GET  /inventory/movements        movimientos con filtros (RF-IN-003)
 *   POST /inventory/adjustments      ajuste con motivo obligatorio (RF-IN-005)
 *   GET  /purchase-orders            entradas de mercancía (RF-IN-004)
 *   POST /purchase-orders            registrar entrada (stock+lote+mov IN)
 *   GET  /purchase-orders/:id        detalle con ítems
 *   GET  /inventory/alerts           bandeja de alertas (RF-IN-006)
 *   PATCH /inventory/alerts/:id      resolver alerta
 *   GET  /suppliers                  proveedores (RF-IN-004)
 *   POST /suppliers                  crear proveedor
 *
 * PERMISOS: inventory:read (lectura), inventory:adjust (ajustes/ubicaciones/
 * lotes/alertas), inventory:purchase (entradas), suppliers:manage (proveedores).
 * El tenant sale del JWT (request.user.tenant_id) — nunca del body/query.
 * ────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, requirePermission } from '../../middleware/auth.js'
import { okEnvelope, okEnvelopeSchema } from '../../types/response.js'
import {
  adjustmentCreateBodySchema,
  alertListResultSchema,
  alertQuerySchema,
  idParamsSchema,
  inventoryAlertSchema,
  inventoryLocationListSchema,
  inventoryLocationSchema,
  inventoryLotListSchema,
  inventoryLotSchema,
  inventoryMovementSchema,
  lotCreateBodySchema,
  lotQuerySchema,
  locationCreateBodySchema,
  locationUpdateBodySchema,
  movementListResultSchema,
  movementQuerySchema,
  purchaseOrderCreateBodySchema,
  purchaseOrderListSchema,
  purchaseOrderSchema,
  supplierCreateBodySchema,
  supplierListSchema,
  supplierSchema,
} from './inventory.schema.js'
import {
  createAdjustment,
  createLocation,
  createLot,
  createPurchaseOrder,
  createSupplier,
  getPurchaseOrder,
  listAlerts,
  listLocations,
  listLots,
  listMovements,
  listPurchaseOrders,
  listSuppliers,
  resolveAlert,
  updateLocation,
  type AdjustmentInput,
  type LocationInput,
  type LotInput,
  type PurchaseOrderInput,
  type SupplierInput,
} from './inventory.service.js'

/** Auth JWT: todo handler lee el tenant y el sub desde aquí. */
type AuthedRequest = FastifyRequest & {
  user: { tenant_id: string; sub: string }
}

/** Plugin Fastify que registra las rutas de inventario. */
export function inventoryRoutes(app: FastifyInstance): void {
  /* ── RF-IN-001: Ubicaciones ─────────────────────────────────────────── */
  app.get(
    '/inventory/locations',
    {
      preHandler: [authenticate, requirePermission('inventory:read')],
      schema: {
        response: { 200: okEnvelopeSchema(inventoryLocationListSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const locations = await listLocations(request.user.tenant_id)
      return okEnvelope(locations, 'Ubicaciones de inventario', 200)
    },
  )

  app.post(
    '/inventory/locations',
    {
      preHandler: [authenticate, requirePermission('inventory:adjust')],
      schema: {
        body: locationCreateBodySchema,
        response: { 200: okEnvelopeSchema(inventoryLocationSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const location = await createLocation(
        request.user.tenant_id,
        request.body as LocationInput,
      )
      return okEnvelope(location, 'Ubicación creada', 200)
    },
  )

  app.patch(
    '/inventory/locations/:id',
    {
      preHandler: [authenticate, requirePermission('inventory:adjust')],
      schema: {
        params: idParamsSchema,
        body: locationUpdateBodySchema,
        response: { 200: okEnvelopeSchema(inventoryLocationSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const location = await updateLocation(
        request.user.tenant_id,
        id,
        request.body as Partial<LocationInput>,
      )
      return okEnvelope(location, 'Ubicación actualizada', 200)
    },
  )

  /* ── RF-IN-002: Lotes ───────────────────────────────────────────────── */
  app.get(
    '/inventory/lots',
    {
      preHandler: [authenticate, requirePermission('inventory:read')],
      schema: {
        querystring: lotQuerySchema,
        response: { 200: okEnvelopeSchema(inventoryLotListSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { product_id } = request.query as { product_id?: string }
      const lots = await listLots(request.user.tenant_id, product_id)
      return okEnvelope(lots, 'Lotes de inventario', 200)
    },
  )

  app.post(
    '/inventory/lots',
    {
      preHandler: [authenticate, requirePermission('inventory:adjust')],
      schema: {
        body: lotCreateBodySchema,
        response: { 200: okEnvelopeSchema(inventoryLotSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const lot = await createLot(request.user.tenant_id, request.body as LotInput)
      return okEnvelope(lot, 'Lote creado', 200)
    },
  )

  /* ── RF-IN-003: Movimientos ─────────────────────────────────────────── */
  app.get(
    '/inventory/movements',
    {
      preHandler: [authenticate, requirePermission('inventory:read')],
      schema: {
        querystring: movementQuerySchema,
        response: { 200: okEnvelopeSchema(movementListResultSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const query = request.query as {
        product_id?: string
        movement_type?: string
        limit?: number
        offset?: number
      }
      const result = await listMovements(request.user.tenant_id, {
        product_id: query.product_id,
        movement_type: query.movement_type,
        limit: query.limit,
        offset: query.offset,
      })
      return okEnvelope(result, 'Movimientos de inventario', 200)
    },
  )

  /* ── RF-IN-005: Ajustes ─────────────────────────────────────────────── */
  app.post(
    '/inventory/adjustments',
    {
      preHandler: [authenticate, requirePermission('inventory:adjust')],
      schema: {
        body: adjustmentCreateBodySchema,
        response: { 200: okEnvelopeSchema(inventoryMovementSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const movement = await createAdjustment(
        { tenant_id: request.user.tenant_id, user_id: request.user.sub },
        request.body as AdjustmentInput,
      )
      return okEnvelope(movement, 'Ajuste de inventario registrado', 200)
    },
  )

  /* ── RF-IN-004: Entradas de mercancía (purchase_orders) ─────────────── */
  app.get(
    '/purchase-orders',
    {
      preHandler: [authenticate, requirePermission('inventory:read')],
      schema: {
        response: { 200: okEnvelopeSchema(purchaseOrderListSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const orders = await listPurchaseOrders(request.user.tenant_id)
      return okEnvelope(orders, 'Entradas de mercancía', 200)
    },
  )

  app.post(
    '/purchase-orders',
    {
      preHandler: [authenticate, requirePermission('inventory:purchase')],
      schema: {
        body: purchaseOrderCreateBodySchema,
        response: { 200: okEnvelopeSchema(purchaseOrderSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const order = await createPurchaseOrder(
        { tenant_id: request.user.tenant_id, user_id: request.user.sub },
        request.body as PurchaseOrderInput,
      )
      return okEnvelope(order, 'Entrada de mercancía registrada', 200)
    },
  )

  app.get(
    '/purchase-orders/:id',
    {
      preHandler: [authenticate, requirePermission('inventory:read')],
      schema: {
        params: idParamsSchema,
        response: { 200: okEnvelopeSchema(purchaseOrderSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const order = await getPurchaseOrder(request.user.tenant_id, id)
      return okEnvelope(order, 'Entrada de mercancía', 200)
    },
  )

  /* ── RF-IN-006: Alertas ─────────────────────────────────────────────── */
  app.get(
    '/inventory/alerts',
    {
      preHandler: [authenticate, requirePermission('inventory:read')],
      schema: {
        querystring: alertQuerySchema,
        response: { 200: okEnvelopeSchema(alertListResultSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const query = request.query as {
        resolved?: string
        alert_type?: string
        limit?: number
        offset?: number
      }
      const result = await listAlerts(request.user.tenant_id, {
        resolved: query.resolved === undefined ? undefined : query.resolved === 'true',
        alert_type: query.alert_type,
        limit: query.limit,
        offset: query.offset,
      })
      return okEnvelope(result, 'Alertas de inventario', 200)
    },
  )

  app.patch(
    '/inventory/alerts/:id',
    {
      preHandler: [authenticate, requirePermission('inventory:adjust')],
      schema: {
        params: idParamsSchema,
        response: { 200: okEnvelopeSchema(inventoryAlertSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const alert = await resolveAlert(
        { tenant_id: request.user.tenant_id, user_id: request.user.sub },
        id,
      )
      return okEnvelope(alert, 'Alerta resuelta', 200)
    },
  )

  /* ── Proveedores (catálogo RF-IN-004) ───────────────────────────────── */
  app.get(
    '/suppliers',
    {
      preHandler: [authenticate, requirePermission('inventory:read')],
      schema: {
        response: { 200: okEnvelopeSchema(supplierListSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const suppliers = await listSuppliers(request.user.tenant_id)
      return okEnvelope(suppliers, 'Proveedores', 200)
    },
  )

  app.post(
    '/suppliers',
    {
      preHandler: [authenticate, requirePermission('suppliers:manage')],
      schema: {
        body: supplierCreateBodySchema,
        response: { 200: okEnvelopeSchema(supplierSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const supplier = await createSupplier(
        request.user.tenant_id,
        request.body as SupplierInput,
      )
      return okEnvelope(supplier, 'Proveedor creado', 200)
    },
  )
}
