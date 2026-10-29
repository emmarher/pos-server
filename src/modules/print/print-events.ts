/**
 * print-events.ts — Bus en memoria de trabajos de impresión.
 *
 * El dispositivo con `can_print` se suscribe por SSE; al encolar se le
 * empuja el job sin polling. Es por proceso: el POS corre en un solo
 * servidor local, así que no hace falta un broker externo.
 */
import type { PrintJobRow } from './print.service.js'

type Listener = (job: PrintJobRow) => void

const listeners = new Map<string, Set<Listener>>()

/** Clave por tenant + dispositivo destino (nunca cruza tenants). */
function channel(tenantId: string, deviceId: string): string {
  return `${tenantId}\u0000${deviceId}`
}

/** Suscribe un dispositivo; devuelve la función para desuscribirse. */
export function subscribePrintJobs(
  tenantId: string,
  deviceId: string,
  listener: Listener,
): () => void {
  const key = channel(tenantId, deviceId)
  const set = listeners.get(key) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(key, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }
}

/** Notifica un job nuevo al dispositivo destino (si está conectado). */
export function emitPrintJob(job: PrintJobRow): void {
  const set = listeners.get(channel(job.tenant_id, job.target_device_id))
  if (!set) return
  for (const listener of set) listener(job)
}
