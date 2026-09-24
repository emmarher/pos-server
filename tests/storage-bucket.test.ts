/**
 * tests/storage-bucket.test.ts — ensureImagesBucket (G1 instalador Garage).
 *
 * Cobertura (S3 mockeado, sin requerir Garage corriendo):
 *   1. HeadBucket OK → 'ready' sin crear nada.
 *   2. HeadBucket NoSuchBucket → CreateBucket → 'ready'.
 *   3. HeadBucket 403 (credenciales) → 'unavailable' sin crear.
 *   4. IMAGES_ENABLED=false → 'disabled' sin tocar S3.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/* Cola programable de respuestas del S3 mockeado. */
type S3Behavior = { head: 'ok' | 'missing' | 'denied'; created: string[] }
const behavior: S3Behavior = { head: 'ok', created: [] }

function s3Error(name: string) {
  const err = new Error(name) as Error & { name: string }
  err.name = name
  return err
}

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@aws-sdk/client-s3')>()
  class MockS3Client {
    async send(command: { constructor: { name: string } }) {
      const kind = command.constructor.name
      if (kind === 'HeadBucketCommand') {
        if (behavior.head === 'ok') return {}
        if (behavior.head === 'missing') throw s3Error('NoSuchBucket')
        throw s3Error('Forbidden')
      }
      if (kind === 'CreateBucketCommand') {
        behavior.created.push('created')
        return {}
      }
      throw s3Error('UnexpectedCommand')
    }
  }
  return { ...actual, S3Client: MockS3Client }
})

import { ensureImagesBucket } from '../src/services/storage.service.js'
import { env } from '../src/config/env.js'

describe('ensureImagesBucket', () => {
  beforeEach(() => {
    behavior.head = 'ok'
    behavior.created = []
  })

  it('1. bucket existente → ready sin crear', async () => {
    const status = await ensureImagesBucket()
    expect(status).toBe('ready')
    expect(behavior.created).toEqual([])
  })

  it('2. bucket inexistente → lo crea y ready', async () => {
    behavior.head = 'missing'
    const status = await ensureImagesBucket()
    expect(status).toBe('ready')
    expect(behavior.created).toEqual(['created'])
  })

  it('3. credenciales inválidas → unavailable sin crear', async () => {
    behavior.head = 'denied'
    const status = await ensureImagesBucket()
    expect(status).toBe('unavailable')
    expect(behavior.created).toEqual([])
  })

  it('4. IMAGES_ENABLED=false → disabled sin tocar S3', async () => {
    const prev = env.imagesEnabled
    ;(env as { imagesEnabled: boolean }).imagesEnabled = false
    try {
      behavior.head = 'denied' // aunque S3 fallaría, no debe ni intentarlo
      const status = await ensureImagesBucket()
      expect(status).toBe('disabled')
    } finally {
      ;(env as { imagesEnabled: boolean }).imagesEnabled = prev
    }
  })
})
