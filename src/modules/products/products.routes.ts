/**
 * src/modules/products/products.routes.ts — Rutas del catálogo (RF-CA).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Endpoints (contrato con pos-mobile):
 *   GET    /products             búsqueda: q, category_id, limit(20), offset
 *   POST   /products             crear producto (products:create)
 *   GET    /products/:id         detalle con precios (products:read)
 *   PATCH  /products/:id         actualizar (products:update)
 *   GET    /products/:id/prices  precios por tipo de precio (products:read)
 *   GET    /categories           listar categorías (categories:read)
 *   POST   /categories           crear categoría (categories:manage)
 *   PATCH  /categories/:id       actualizar categoría (categories:manage)
 *   GET    /measurement-units    unidades de medida (products:read)
 *   GET    /price-types          tipos de precio (products:read)
 *
 * SEGURIDAD: TODAS usan [authenticate, requirePermission(...)]. El tenant
 * sale del JWT (request.user.tenant_id) — nunca del body/query.
 * ────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, requirePermission } from '../../middleware/auth.js'
import { okEnvelope, okEnvelopeSchema } from '../../types/response.js'
import {
  categoryCreateBodySchema,
  categorySchema,
  categoryUpdateBodySchema,
  idParamsSchema,
  measurementUnitSchema,
  priceTypeSchema,
  productCreateBodySchema,
  productPriceSchema,
  productQuerySchema,
  productSchema,
  productSearchSchema,
  productUpdateBodySchema,
} from './products.schema.js'
import {
  createCategory,
  createProduct,
  deactivateProduct,
  getProduct,
  getProductPrices,
  listCategories,
  listMeasurementUnits,
  listPriceTypes,
  searchProducts,
  updateCategory,
  updateProduct,
  type CategoryInput,
  type ProductInput,
} from './products.service.js'

/** Auth JWT: todo handler lee el tenant desde aquí. */
type AuthedRequest = FastifyRequest & { user: { tenant_id: string } }

/** Plugin Fastify que registra las rutas del catálogo. */
export function productsRoutes(app: FastifyInstance): void {
  /* ── GET /products (RF-CA-006: búsqueda, limit 20) ─────────────────── */
  app.get(
    '/products',
    {
      preHandler: [authenticate, requirePermission('products:read')],
      schema: {
        querystring: productQuerySchema,
        response: { 200: okEnvelopeSchema(productSearchSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const query = request.query as {
        q?: string
        category_id?: string
        limit?: number
        offset?: number
        active_only?: string
      }
      const result = await searchProducts(request.user.tenant_id, {
        q: query.q,
        category_id: query.category_id,
        limit: query.limit,
        offset: query.offset,
        activeOnly: query.active_only === undefined ? true : query.active_only === 'true',
      })
      return okEnvelope(result, 'Productos encontrados', 200)
    },
  )

  /* ── POST /products (RF-CA-002: crear) ─────────────────────────────── */
  app.post(
    '/products',
    {
      preHandler: [authenticate, requirePermission('products:create')],
      schema: {
        body: productCreateBodySchema,
        response: { 200: okEnvelopeSchema(productSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const product = await createProduct(
        request.user.tenant_id,
        request.body as ProductInput,
      )
      return okEnvelope(product, 'Producto creado', 200)
    },
  )

  /* ── GET /products/:id (detalle con precios) ───────────────────────── */
  app.get(
    '/products/:id',
    {
      preHandler: [authenticate, requirePermission('products:read')],
      schema: {
        params: idParamsSchema,
        response: { 200: okEnvelopeSchema(productSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const product = await getProduct(request.user.tenant_id, id)
      return okEnvelope(product, 'Producto encontrado', 200)
    },
  )

  /* ── PATCH /products/:id (RF-CA-002: actualizar) ───────────────────── */
  app.patch(
    '/products/:id',
    {
      preHandler: [authenticate, requirePermission('products:update')],
      schema: {
        params: idParamsSchema,
        body: productUpdateBodySchema,
        response: { 200: okEnvelopeSchema(productSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const product = await updateProduct(
        request.user.tenant_id,
        id,
        request.body as Partial<ProductInput>,
      )
      return okEnvelope(product, 'Producto actualizado', 200)
    },
  )

  /* ── DELETE /products/:id (borrado lógico, products:delete) ─────────── */
  app.delete(
    '/products/:id',
    {
      preHandler: [authenticate, requirePermission('products:delete')],
      schema: {
        params: idParamsSchema,
        response: { 200: okEnvelopeSchema(productSchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const product = await deactivateProduct(request.user.tenant_id, id)
      return okEnvelope(product, 'Producto desactivado', 200)
    },
  )

  /* ── GET /products/:id/prices (RF-CA-004: precios por tipo) ────────── */
  app.get(
    '/products/:id/prices',
    {
      preHandler: [authenticate, requirePermission('products:read')],
      schema: {
        params: idParamsSchema,
        response: {
          200: okEnvelopeSchema({
            type: 'array',
            items: productPriceSchema,
          }),
        },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const prices = await getProductPrices(request.user.tenant_id, id)
      return okEnvelope(prices, 'Precios del producto', 200)
    },
  )

  /* ── GET /categories (RF-CA-001: listar) ───────────────────────────── */
  app.get(
    '/categories',
    {
      preHandler: [authenticate, requirePermission('categories:read')],
      schema: {
        response: {
          200: okEnvelopeSchema({ type: 'array', items: categorySchema }),
        },
      },
    },
    async (request: AuthedRequest) => {
      const categories = await listCategories(request.user.tenant_id, true)
      return okEnvelope(categories, 'Categorías encontradas', 200)
    },
  )

  /* ── POST /categories (RF-CA-001: crear) ───────────────────────────── */
  app.post(
    '/categories',
    {
      preHandler: [authenticate, requirePermission('categories:manage')],
      schema: {
        body: categoryCreateBodySchema,
        response: { 200: okEnvelopeSchema(categorySchema) },
      },
    },
    async (request: AuthedRequest) => {
      const category = await createCategory(
        request.user.tenant_id,
        request.body as CategoryInput,
      )
      return okEnvelope(category, 'Categoría creada', 200)
    },
  )

  /* ── PATCH /categories/:id (RF-CA-001: actualizar) ─────────────────── */
  app.patch(
    '/categories/:id',
    {
      preHandler: [authenticate, requirePermission('categories:manage')],
      schema: {
        params: idParamsSchema,
        body: categoryUpdateBodySchema,
        response: { 200: okEnvelopeSchema(categorySchema) },
      },
    },
    async (request: AuthedRequest) => {
      const { id } = request.params as { id: string }
      const category = await updateCategory(
        request.user.tenant_id,
        id,
        request.body as Partial<CategoryInput>,
      )
      return okEnvelope(category, 'Categoría actualizada', 200)
    },
  )

  /* ── GET /measurement-units (catálogo base para la venta) ──────────── */
  app.get(
    '/measurement-units',
    {
      preHandler: [authenticate, requirePermission('products:read')],
      schema: {
        response: {
          200: okEnvelopeSchema({ type: 'array', items: measurementUnitSchema }),
        },
      },
    },
    async (request: AuthedRequest) => {
      const units = await listMeasurementUnits(request.user.tenant_id, true)
      return okEnvelope(units, 'Unidades de medida', 200)
    },
  )

  /* ── GET /price-types (RF-CA-003: tipos de precio) ─────────────────── */
  app.get(
    '/price-types',
    {
      preHandler: [authenticate, requirePermission('products:read')],
      schema: {
        response: {
          200: okEnvelopeSchema({ type: 'array', items: priceTypeSchema }),
        },
      },
    },
    async (request: AuthedRequest) => {
      const types = await listPriceTypes(request.user.tenant_id)
      return okEnvelope(types, 'Tipos de precio', 200)
    },
  )
}
