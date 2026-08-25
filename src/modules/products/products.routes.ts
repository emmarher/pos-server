/**
 * src/modules/products/products.routes.ts — Rutas del catálogo (RF-CA).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Endpoints (contrato con pos-mobile):
 *   GET    /products             búsqueda: q, category_id, limit(20), offset
 *   POST   /products             crear producto (products:create)
 *   GET    /products/:id         detalle con precios (products:read)
 *   PATCH  /products/:id         actualizar (products:update)
 *   DELETE /products/:id         desactivar (products:delete)
 *   GET    /products/:id/prices  precios por tipo de precio (products:read)
 *   POST   /products/:id/image   subir imagen (products:update)
 *   DELETE /products/:id/image   quitar imagen (products:update)
 *   GET    /images/:t/:f         proxy de lectura hacia Garage (sin auth:
 *                                los <Image> de RN no pueden mandar headers)
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
import multipart from '@fastify/multipart'
import { authenticate, requirePermission } from '../../middleware/auth.js'
import { env } from '../../config/env.js'
import { okEnvelope, okEnvelopeSchema, errorEnvelope } from '../../types/response.js'
import {
  deleteImage,
  getImageStream,
  keyFromUrl,
  uploadProductImage,
} from '../../services/storage.service.js'
import { HttpError } from '../../types/errors.js'
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
  getProductImageState,
  getProductPrices,
  listCategories,
  listMeasurementUnits,
  listPriceTypes,
  searchProducts,
  setProductImageUrl,
  updateCategory,
  updateProduct,
  type CategoryInput,
  type ProductInput,
} from './products.service.js'

/** Auth JWT: todo handler lee el tenant desde aquí. */
type AuthedRequest = FastifyRequest & { user: { tenant_id: string } }

/* ── Imágenes (proxy Garage S3) ──────────────────────────────────────── */

/** MIME types aceptados para la imagen de producto. */
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

/**
 * Key válida en el bucket: `{tenant}/prod_{uuid}.webp`.
 * Acepta tenant_id con o sin guiones (pg usa UUID con guiones; sqlite
 * puede guardarlos sin guiones) y uuid de archivo SIEMPRE con guiones
 * (lo genera crypto.randomUUID()).
 * El proxy SOLO sirve keys que cumplen esto (nada más del bucket es
 * alcanzable desde fuera).
 */
const TENANT_ID = String.raw`(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`
const FILE_UUID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`
const IMAGE_KEY_RE = new RegExp(`^${TENANT_ID}/prod_${FILE_UUID}\\.webp$`)

/** `data` de la respuesta de subir/quitar imagen. */
const productImageStateSchema = {
  type: 'object',
  required: ['imagen_url'],
  additionalProperties: false,
  properties: { imagen_url: { type: ['string', 'null'] } },
}

/**
 * Plugin Fastify que registra las rutas del catálogo.
 * Registra @fastify/multipart dentro de este contexto de encapsulamiento
 * (solo las rutas de imagen lo necesitan; así no se toca app.ts global).
 */
export function productsRoutes(app: FastifyInstance): void {
  /* Multipart solo en este scope: subida de imágenes (límite desde env) */
  app.register(multipart, {
    limits: { fileSize: env.s3MaxFileSizeMb * 1024 * 1024 },
  })
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

  /* ── POST /products/:id/image (subir/reemplazar imagen) ─────────────── */
  app.post(
    '/products/:id/image',
    {
      preHandler: [authenticate, requirePermission('products:update')],
      schema: {
        params: idParamsSchema,
        response: { 200: okEnvelopeSchema(productImageStateSchema) },
      },
    },
    async (request: AuthedRequest, reply) => {
      if (!env.imagesEnabled) {
        return reply
          .code(503)
          .send(errorEnvelope('Almacenamiento de imágenes no disponible', 503))
      }

      const tenantId = request.user.tenant_id
      const { id } = request.params as { id: string }

      // Aislamiento multi-tenant: producto ajeno → NOT_FOUND (lanza)
      const current = await getProductImageState(tenantId, id)

      let data
      try {
        data = await request.file()
      } catch {
        // FST_INVALID_MULTIPART_CONTENT_TYPE: llegó JSON u otro content-type
        throw new HttpError(
          'VALIDATION_ERROR',
          'La imagen debe enviarse como multipart/form-data',
        )
      }
      if (!data) {
        throw new HttpError('VALIDATION_ERROR', 'No se envió ninguna imagen')
      }
      if (!ALLOWED_IMAGE_MIME.has(data.mimetype)) {
        throw new HttpError(
          'VALIDATION_ERROR',
          'Formato no permitido. Usa JPEG, PNG o WebP',
        )
      }

      let buffer: Buffer
      try {
        buffer = await data.toBuffer()
      } catch {
        // El límite de @fastify/multipart rechaza el stream al excederlo
        return reply.code(413).send(
          errorEnvelope(
            `La imagen supera el máximo de ${env.s3MaxFileSizeMb} MB`,
            413,
          ),
        )
      }

      // Sube el objeto NUEVO primero; la BD se actualiza solo si S3 OK.
      // La anterior se borra al final (BD ya consistente).
      const uploaded = await uploadProductImage(tenantId, buffer)
      await setProductImageUrl(tenantId, id, uploaded.url)

      const oldKey = keyFromUrl(current.imagen_url, tenantId)
      if (oldKey && oldKey !== uploaded.key) {
        await deleteImage(oldKey)
      }

      return okEnvelope({ imagen_url: uploaded.url }, 'Imagen guardada', 200)
    },
  )

  /* ── DELETE /products/:id/image (quitar imagen) ─────────────────────── */
  app.delete(
    '/products/:id/image',
    {
      preHandler: [authenticate, requirePermission('products:update')],
      schema: {
        params: idParamsSchema,
        response: { 200: okEnvelopeSchema(productImageStateSchema) },
      },
    },
    async (request: AuthedRequest, reply) => {
      if (!env.imagesEnabled) {
        return reply
          .code(503)
          .send(errorEnvelope('Almacenamiento de imágenes no disponible', 503))
      }

      const tenantId = request.user.tenant_id
      const { id } = request.params as { id: string }

      const current = await getProductImageState(tenantId, id)
      await setProductImageUrl(tenantId, id, null)

      const oldKey = keyFromUrl(current.imagen_url, tenantId)
      if (oldKey) await deleteImage(oldKey)

      return okEnvelope({ imagen_url: null }, 'Imagen eliminada', 200)
    },
  )

  /* ── GET /images/:tenantId/:fileName (proxy de lectura Garage) ──────── */
  app.get('/images/:tenantId/:fileName', async (request, reply) => {
    if (!env.imagesEnabled) {
      return reply.code(503).send(errorEnvelope('Imágenes no disponibles', 503))
    }

    const { tenantId, fileName } = request.params as {
      tenantId: string
      fileName: string
    }

    // Solo keys de imagen de producto válidas; cualquier otra cosa → 404
    const key = `${tenantId}/${fileName}`
    if (!IMAGE_KEY_RE.test(key)) {
      return reply.code(404).send(errorEnvelope('Imagen no encontrada', 404))
    }

    try {
      const obj = await getImageStream(key)
      reply.header('Content-Type', obj.contentType ?? 'image/webp')
      // Keys inmutables (uuid nuevo por subida): cache agresivo es seguro
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      return reply.send(obj.body)
    } catch (err) {
      // Log del fallo real (S3 caído, credenciales…) pero al cliente: 404
      request.log.warn({ err }, 'Proxy de imagen: objeto no legible')
      return reply.code(404).send(errorEnvelope('Imagen no encontrada', 404))
    }
  })
}
