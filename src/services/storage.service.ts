/**
 * src/services/storage.service.ts — Almacenamiento de imágenes (Garage S3).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Qué hace este módulo:
 *   - Expone un cliente S3-compatible (Garage) como singleton para todo
 *     el servidor, con `forcePathStyle: true` (requerido por Garage).
 *   - `uploadProductImage()` optimiza el buffer con sharp (resize máx
 *     1000×1000, WebP q80) y lo sube al bucket bajo una key MULTI-TENANT:
 *     `{tenant_id}/prod_{uuid}.webp`. Nunca se escribe en la raíz.
 *   - `deleteImage()` borra un objeto del bucket (para reemplazo/borrado).
 *
 * Notas:
 *   - LECTURA VÍA PROXY: las tablets de la LAN no pueden resolver el vhost
 *     público de Garage (`productos.web.garage.localhost:3902`), así que la
 *     columna `products.imagen_url` guarda una RUTA RELATIVA servida por
 *     Fastify: `/images/{tenant_id}/prod_{uuid}.webp`. La tablet la resuelve
 *     contra la URL base del servidor POS que ya conoce.
 *   - Este módulo NO toca la base de datos: solo el bucket. La escritura
 *     en `products.imagen_url` vive en el módulo que llama (products).
 * ────────────────────────────────────────────────────────────────────────
 */
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { env } from '../config/env.js'

/* ── 1) CLIENTE S3 SINGLETON ─────────────────────────────────────────── */

/** Instancia única del cliente (se crea al primer uso, no al importar). */
let s3Client: S3Client | null = null

/** Devuelve el cliente S3 configurado para Garage (creación perezosa). */
function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: env.s3Endpoint,
      region: env.s3Region,
      credentials: {
        accessKeyId: env.s3AccessKeyId,
        secretAccessKey: env.s3SecretAccessKey,
      },
      // Garage y la mayoría de S3-compatibles self-hosted usan path-style
      // (http://endpoint/bucket/key) en lugar de virtual-hosted style.
      forcePathStyle: true,
    })
  }
  return s3Client
}

/* ── 2) TIPOS PÚBLICOS ───────────────────────────────────────────────── */

/** Resultado de una subida exitosa de imagen de producto. */
export interface UploadedImage {
  /** Key completa dentro del bucket: `{tenant_id}/prod_{uuid}.webp` */
  key: string
  /** Ruta relativa servida por el proxy Fastify: `/images/{key}` */
  url: string
}

/* ── 3) OPERACIONES DE IMÁGENES DE PRODUCTO ──────────────────────────── */

/**
 * Optimiza y sube la imagen de un producto al bucket.
 *
 * Flujo: sharp (WebP q80, máx 1000×1000 sin agrandar) → key multi-tenant
 * → PutObject → ruta relativa del proxy. Lanza si sharp o S3 fallan (el
 * caller decide cómo responder); la BD no se modifica aquí.
 */
export async function uploadProductImage(
  tenantId: string,
  buffer: Buffer,
): Promise<UploadedImage> {
  const optimized = await sharp(buffer)
    .rotate() // respeta el EXIF antes de re-encodar
    .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
    .toFormat('webp', { quality: 80 })
    .toBuffer()

  const key = `${tenantId}/prod_${randomUUID()}.webp`

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: env.s3Bucket,
      Key: key,
      Body: optimized,
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  )

  return { key, url: `/images/${key}` }
}

/**
 * Borra un objeto del bucket por su key completa.
 * Errores de "NoSuchKey" se toleran (el objeto ya no existe → OK).
 */
export async function deleteImage(key: string): Promise<void> {
  try {
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: env.s3Bucket, Key: key }),
    )
  } catch (err) {
    if (isNotFoundError(err)) return
    throw err
  }
}

/**
 * Lee un objeto del bucket como stream (para el proxy GET /images/*).
 * Lanza el error original si no existe (el caller mapea a 404).
 */
export async function getImageStream(
  key: string,
): Promise<{ body: Readable; contentType: string | undefined }> {
  const res = await getS3Client().send(
    new GetObjectCommand({ Bucket: env.s3Bucket, Key: key }),
  )
  return { body: res.Body as Readable, contentType: res.ContentType }
}

/**
 * Extrae la key de una ruta de imagen guardada en BD.
 * Formato esperado: `/images/{tenantId}/{archivo}` (proxy Fastify) o, por
 * compatibilidad, `{s3PublicUrl}/{tenantId}/{archivo}`.
 * Retorna null si la ruta no pertenece a este tenant (defensa extra:
 * nunca borrar un objeto fuera del prefijo del tenant dueño).
 */
export function keyFromUrl(url: string | null | undefined, tenantId: string): string | null {
  if (!url) return null
  const proxyPrefix = `/images/${tenantId}/`
  if (url.startsWith(proxyPrefix)) {
    return `${tenantId}/${url.slice(proxyPrefix.length)}`
  }
  const publicPrefix = `${env.s3PublicUrl}/${tenantId}/`
  if (url.startsWith(publicPrefix)) {
    return `${tenantId}/${url.slice(publicPrefix.length)}`
  }
  return null
}

/* ── 4) HELPERS ──────────────────────────────────────────────────────── */

/**
 * Estado del bucket al arrancar (G1 instalador Garage).
 * - 'disabled': IMAGES_ENABLED=false, no se toca S3.
 * - 'ready': el bucket existe o se creó ahora.
 * - 'unavailable': Garage no responde o credenciales inválidas. NUNCA lanza:
 *   las imágenes son un extra y el servidor debe arrancar igual (la venta
 *   no depende de Garage; los endpoints responden 503 controlado).
 */
export type ImagesBucketStatus = 'disabled' | 'ready' | 'unavailable'

export async function ensureImagesBucket(): Promise<ImagesBucketStatus> {
  if (!env.imagesEnabled) return 'disabled'
  const client = getS3Client()
  try {
    await client.send(new HeadBucketCommand({ Bucket: env.s3Bucket }))
    return 'ready'
  } catch (err) {
    if (!isNotFoundError(err) && !isNoSuchBucketError(err)) {
      console.warn(
        `[images] bucket no verificable (${describeS3Error(err)}); ` +
          'arrancando sin imágenes.',
      )
      return 'unavailable'
    }
    // El bucket no existe (instalación fresca) → crearlo una vez.
    try {
      await client.send(new CreateBucketCommand({ Bucket: env.s3Bucket }))
      return 'ready'
    } catch (createErr) {
      console.warn(
        `[images] no se pudo crear el bucket (${describeS3Error(createErr)}); ` +
          'arrancando sin imágenes.',
      )
      return 'unavailable'
    }
  }
}

/** Detecta "el objeto no existe" (borrar dos veces no es error). */
function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    ((err as { name?: string }).name === 'NoSuchKey' ||
      (err as { name?: string }).name === 'NotFound')
  )
}

/** Detecta "bucket inexistente" (HeadBucket en instalación fresca). */
function isNoSuchBucketError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    ((err as { name?: string }).name === 'NoSuchBucket' ||
      (err as { name?: string }).name === 'NotFound')
  )
}

/** Mensaje corto para logs sin volcar el objeto de error completo. */
function describeS3Error(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const e = err as { name?: string; message?: string }
    return `${e.name ?? 'Error'}: ${e.message ?? ''}`.trim()
  }
  return String(err)
}
