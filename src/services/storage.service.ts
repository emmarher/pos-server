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
 *   - La URL pública de lectura se construye con env.s3PublicUrl; la
 *     columna `products.imagen_url` guarda esa URL completa.
 *   - Este módulo NO toca la base de datos: solo el bucket. La escritura
 *     en `products.imagen_url` vive en el módulo que llama (uploads).
 * ────────────────────────────────────────────────────────────────────────
 */
import { randomUUID } from 'node:crypto'
import {
  DeleteObjectCommand,
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
  /** URL pública directa para leer la imagen (`{publicUrl}/{key}`) */
  url: string
}

/* ── 3) OPERACIONES DE IMÁGENES DE PRODUCTO ──────────────────────────── */

/**
 * Optimiza y sube la imagen de un producto al bucket.
 *
 * Flujo: sharp (WebP q80, máx 1000×1000 sin agrandar) → key multi-tenant
 * → PutObject → URL pública. Lanza si sharp o S3 fallan (el caller decide
 * cómo responder); la BD no se modifica aquí.
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

  return { key, url: `${env.s3PublicUrl}/${key}` }
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
 * Extrae la key de una URL pública guardada en BD.
 * Retorna null si la URL no pertenece a este bucket/tenant (defensa
 * extra: nunca borrar un objeto fuera de `{s3PublicUrl}/{tenantId}/…`).
 */
export function keyFromUrl(url: string | null | undefined, tenantId: string): string | null {
  if (!url) return null
  const prefix = `${env.s3PublicUrl}/${tenantId}/`
  if (!url.startsWith(prefix)) return null
  return `${tenantId}/${url.slice(prefix.length)}`
}

/* ── 4) HELPERS ──────────────────────────────────────────────────────── */

/** Detecta errores "el objeto no existe" (borrar dos veces no es error). */
function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    ((err as { name?: string }).name === 'NoSuchKey' ||
      (err as { name?: string }).name === 'NotFound')
  )
}
