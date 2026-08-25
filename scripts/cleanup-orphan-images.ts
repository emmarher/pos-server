/**
 * scripts/cleanup-orphan-images.ts — Borra del bucket objetos que ya no
 * están referenciados por products.imagen_url. Solo lectura de BD + S3.
 */
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { db } from '../src/database/client.js'

async function main(): Promise<void> {
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: true,
  })

  const { rows } = await db.query<{ imagen_url: string }>(
    'SELECT imagen_url FROM products WHERE imagen_url IS NOT NULL',
  )
  const referenced = new Set(
    rows.map((r) => r.imagen_url.replace('/images/', '')),
  )

  const res = await s3.send(
    new ListObjectsV2Command({ Bucket: process.env.S3_BUCKET }),
  )
  let deleted = 0
  for (const obj of res.Contents ?? []) {
    if (!referenced.has(obj.Key!)) {
      await s3.send(
        new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: obj.Key }),
      )
      deleted++
      console.log(`✖ huérfano: ${obj.Key}`)
    }
  }
  console.log(
    `Total en bucket: ${res.Contents?.length} | referenciados: ${referenced.size} | borrados: ${deleted}`,
  )
  await db.end()
}

main().catch(async (err) => {
  console.error('Error:', err)
  await db.end()
  process.exit(1)
})
