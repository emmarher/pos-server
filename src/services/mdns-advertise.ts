/**
 * src/services/mdns-advertise.ts — Anuncio mDNS del servidor (descubrimiento, RF-DS).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Publica `_pos-server._tcp.local` para que el desktop lo encuentre SIN
 * depender solo de broadcast UDP (que algunas redes/AV filtran). El desktop
 * resuelve con la crate `mdns-sd` (comando Tauri `mdns_discover`) y obtiene
 * IP+puerto del registro SRV + TXT (tenant_code, api_version).
 *
 * Best-effort: si mDNS falla (red sin multicast), solo se loguea; UDP
 * discovery + IP manual siguen disponibles. Nunca tumba el arranque.
 * ────────────────────────────────────────────────────────────────────────
 */
import { Bonjour } from 'bonjour-service'
import { env } from '../config/env.js'

/** Tipo de servicio DNS-SD (lo busca el desktop). */
export const MDNS_SERVICE_TYPE = 'pos-server'
export const MDNS_PROTOCOL = 'tcp'

let published: { stop: () => void } | null = null

/**
 * Publica el servicio. `info` viaja en el TXT (el puerto va en el SRV).
 * Idempotente: republicar detiene lo anterior.
 */
export function startMdnsAdvertise(info: {
  tenantCode?: string | null
  apiVersion?: string
  deviceName?: string
}): void {
  try {
    stopMdnsAdvertise()
    const bonjour = new Bonjour()
    const name = info.tenantCode
      ? `POS Server (${info.tenantCode})`
      : 'POS Server'
    const txt: Record<string, string> = {
      api_version: info.apiVersion ?? '0.2.3',
    }
    if (info.tenantCode) txt.tenant_code = info.tenantCode
    if (info.deviceName) txt.device_name = info.deviceName
    const service = bonjour.publish({
      name,
      type: MDNS_SERVICE_TYPE,
      protocol: MDNS_PROTOCOL,
      port: env.port,
      txt,
    })
    published = {
      stop: () => {
        try {
          service.stop(() => bonjour.destroy())
        } catch {
          try {
            bonjour.destroy()
          } catch {
            /* best-effort */
          }
        }
      },
    }
  } catch (err) {
    // mDNS es opcional: sin multicast en la red, solo loguear.
    console.warn('[mdns] no se pudo publicar el servicio:', err)
  }
}

/** Deja de anunciar (apagado ordenado). */
export function stopMdnsAdvertise(): void {
  try {
    published?.stop()
  } catch {
    /* best-effort */
  }
  published = null
}
