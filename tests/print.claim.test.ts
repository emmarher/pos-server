/**
 * tests/print.claim.test.ts — Impresión: claim atómico y bus SSE.
 *
 * 1) Dos dispositivos no pueden reclamar el mismo job (segundo → 409).
 * 2) Al encolar se notifica al suscriptor del dispositivo (SSE).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { TestSession } from './helpers.js'

const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/database/client.js')
const { subscribePrintJobs } = await import('../src/modules/print/print-events.js')
const { login } = await import('./helpers.js')

describe('Impresión: claim y eventos', () => {
  let app: FastifyInstance
  let session: TestSession

  beforeAll(async () => {
    app = buildApp()
    await app.ready()
    session = await login(app, 'DEMO-0001')
    // El dispositivo de login debe poder imprimir para recibir jobs.
    await db.query(
      `UPDATE device_capabilities SET can_print = 1 WHERE device_id = $1`,
      [session.deviceId],
    )
  })

  function auth() {
    return { authorization: `Bearer ${session.token}` }
  }

  async function insertJob(): Promise<string> {
    const id = randomUUID()
    const now = new Date().toISOString()
    await db.query(
      `INSERT INTO print_jobs
         (id, tenant_id, source_device_id, target_device_id, sale_id, cashier_cut_id,
          job_type, content, content_format, status, retry_count, max_retries,
          created_at, updated_at)
       VALUES ($1, $2, $2, $2, NULL, NULL, 'TEST', 'hola', 'ESC_POS', 'PENDING', 0, 3, $3, $3)`,
      [id, session.tenantId, now],
    )
    return id
  }

  it('1) solo el primer PATCH PRINTING gana; el segundo recibe 409', async () => {
    const id = await insertJob()
    const first = await app.inject({
      method: 'PATCH',
      url: `/print-jobs/${id}`,
      headers: auth(),
      payload: { status: 'PRINTING' },
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'PATCH',
      url: `/print-jobs/${id}`,
      headers: auth(),
      payload: { status: 'PRINTING' },
    })
    expect(second.statusCode).toBe(409)
  })

  it('2) encolar notifica al dispositivo suscrito', async () => {
    const received: string[] = []
    const unsubscribe = subscribePrintJobs(
      session.tenantId,
      session.deviceId,
      job => received.push(job.id),
    )
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/print-jobs',
        headers: auth(),
        payload: {
          target_device_id: session.deviceId,
          content: 'ticket de prueba',
          job_type: 'TEST',
        },
      })
      expect(res.statusCode).toBe(200)
      expect(received).toContain(res.json().data.id)
    } finally {
      unsubscribe()
    }
  })
})
