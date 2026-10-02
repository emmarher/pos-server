/**
 * UDP Discovery Service
 *
 * - Listens for UDP broadcast on port 5000 for message "POS_DISCOVER"
 * - Responds with { ip, port, tenant_id, device_name, api_version }
 * - Falls back to QR code pairing and manual IP entry if broadcast not available
 *
 * RF-DS: Discovery UDP
 */

import * as dgram from 'dgram'
import * as os from 'node:os'
import type { FastifyInstance } from 'fastify'
import { db } from '../database/client.js'
import { env } from '../config/env.js'

// Configuración del descubrimiento
const DISCOVER_PORT = 5000;
const DISCOVER_MESSAGE = "POS_DISCOVER";

// Puerto HTTP del API Fastify — el que el cliente usará para conectarse.
// Debe ser el puerto REAL del server (env.port), no un 3000 fijo: si la
// instalación usa otro puerto, la respuesta con 3000 hacía que el cliente
// probara /health en un puerto muerto y descartara el servidor.
const API_PORT = env.port;

// Interfaz para la respuesta de descubrimiento
export interface DiscoveryResponse {
  ip: string;
  port: number;
  tenant_id: string;
  device_name: string;
  api_version: string;
}

// Instancia del socket y bandera de control
let discoverSocket: dgram.Socket | null = null;
let isRunning = false;

// Cache del tenant activo (se obtiene al iniciar el servicio)
let activeTenantId: string | null = null;
let activeTenantName: string | null = null;

/** IPv4 → entero de 32 bits (null si no es IPv4 válida). */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    acc = (acc << 8) | v;
  }
  return acc >>> 0;
}

/** ¿Ambas IPv4 están en la misma /24? */
function sameSubnet24(a: string, b: string): boolean {
  const ia = ipv4ToInt(a);
  const ib = ipv4ToInt(b);
  if (ia === null || ib === null) return false;
  return (ia & 0xffffff00) === (ib & 0xffffff00);
}

/** Primera IPv4 no-loopback de cualquier interfaz (fallback). */
function firstNonInternalIpv4(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

/**
 * Devuelve la IP local del servidor que el cliente puede alcanzar.
 * Prefiere la interfaz cuya /24 coincide con la del solicitante (evita
 * anunciar una IP de adaptador virtual inalcanzable cuando hay varias
 * interfaces); si ninguna coincide, cae a la primera IPv4 no-loopback.
 */
function resolveIpForClient(remoteAddress: string): string {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name] ?? []) {
        if (
          net.family === 'IPv4' &&
          !net.internal &&
          sameSubnet24(net.address, remoteAddress)
        ) {
          return net.address;
        }
      }
    }
  } catch {
    /* sin red local → fallback */
  }
  return firstNonInternalIpv4() ?? '127.0.0.1';
}

/**
 * Obtiene el tenant_id del tenant activo desde la base de datos
 * Para un servidor POS single-tenant, retorna el primer tenant activo
 */
async function fetchActiveTenant(): Promise<{ id: string; name: string } | null> {
  try {
    const result = await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM tenants WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1"
    );
    if (result.rows.length > 0) {
      const tenant = result.rows[0]!
      return { id: tenant.id, name: tenant.name }
    }
    console.warn("⚠️ No active tenant found in database");
    return null;
  } catch (err) {
    console.error("❌ Error fetching active tenant:", err);
    return null;
  }
}

/**
 * Inicializa el tenant activo (se llama al iniciar el servicio)
 */
async function initializeTenant(): Promise<void> {
  const tenant = await fetchActiveTenant()
  if (tenant) {
    activeTenantId = tenant.id
    activeTenantName = tenant.name
    console.log(`🏢 Active tenant for discovery: ${tenant.name} (${tenant.id})`)
  } else {
    // Fallback para desarrollo si no hay tenant en BD
    activeTenantId = 'DEMO-0001'
    activeTenantName = 'Demo Tenant'
    console.warn('⚠️ Using fallback tenant for discovery')
  }
}

/**
 * Inicia el servicio de descubrimiento UDP
 */
export async function startDiscovery(): Promise<void> {
  if (isRunning) {
    console.warn("⚠️ Discovery service already running");
    return;
  }

  // Primero obtener el tenant activo
  await initializeTenant();

  // Crear socket UDP
  const socket = dgram.createSocket("udp4");
  discoverSocket = socket;

  // Cuando recibamos un paquete, respondemos
  socket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    if (msg.toString().trim() === DISCOVER_MESSAGE) {
      try {
        // Obtener tenant_id del tenant activo
        const tenantId = activeTenantId ?? "DEMO-0001";
        const deviceName = activeTenantName ? `POS-Server-${activeTenantName}` : `POS-Server-${tenantId}`;

        const response: DiscoveryResponse = {
          ip: resolveIpForClient(rinfo.address),
          port: API_PORT,
          tenant_id: tenantId,
          device_name: deviceName,
          api_version: "4.0.0",
        };

        // Enviar respuesta AL PUERTO DE ORIGEN del cliente (rinfo.port),
        // no al puerto de escucha. Así la tablet que hizo el broadcast
        // recibe la respuesta en su socket efímero.
        const responseBuf = Buffer.from(JSON.stringify(response))
        socket.send(responseBuf, 0, responseBuf.length, rinfo.port, rinfo.address)

        console.log(`📡 Discovery response sent to ${rinfo.address}:${rinfo.port} for tenant ${tenantId}`);
      } catch (err) {
        console.error("❌ Error generating discovery response:", err);
      }
    }
  });

  // Cuando haya un error en el socket
  socket.on("error", (err) => {
    console.error(`❌ Discovery UDP socket error: ${err.message}`);
  });

  // Escuchar en todas las interfaces (0.0.0.0)
  await new Promise<void>((resolve) => {
    socket.bind(DISCOVER_PORT, "0.0.0.0", () => {
      isRunning = true;
      console.log(`🟢 UDP Discovery listening on port ${DISCOVER_PORT}`);
      resolve();
    });
  });
}

/**
 * Detiene el servicio de descubrimiento UDP
 */
export function stopDiscovery(): Promise<void> {
  return new Promise((resolve) => {
    if (discoverSocket) {
      discoverSocket.close();
      discoverSocket = null;
    }
    isRunning = false;
    console.log("🔴 UDP Discovery stopped");
    resolve();
  });
}

/**
 * Obtiene el tenant_id actual (del cache inicializado al inicio)
 */
export function getCurrentTenantId(): string {
  return activeTenantId ?? "DEMO-0001";
}

/**
 * Obtiene el nombre del tenant activo
 */
export function getCurrentTenantName(): string {
  return activeTenantName ?? "Demo Tenant";
}

/**
 * Register discovery endpoint in Fastify app
 * Integrates with the main server setup
 */
export function registerDiscoveryRoutes(app: FastifyInstance): void {
  // Endpoint para verificar estado del servicio de descubrimiento
  app.get('/discovery/status', () => {
    return {
      isRunning,
      port: DISCOVER_PORT,
      message: DISCOVER_MESSAGE,
      tenant_id: getCurrentTenantId(),
      tenant_name: getCurrentTenantName(),
    };
  });

  // Endpoint para obtener configuración de discovery (útil para QR/manual fallback)
  app.get('/discovery/config', () => {
    return {
      udpPort: DISCOVER_PORT,
      discoverMessage: DISCOVER_MESSAGE,
      tenant_id: getCurrentTenantId(),
      tenant_name: getCurrentTenantName(),
      fallback: {
        qrCode: generateDiscoveryQR(),
        manualInput: {
          defaultIp: '127.0.0.1',
          defaultPort: API_PORT,
        },
      },
    };
  });
}

/**
 * Genera un QR code simple (texto) que contiene los datos de descubrimiento
 * Para usar en el fallback de emparejamiento
 */
function generateDiscoveryQR(): string {
  return JSON.stringify({
    type: "discovery",
    tenantId: getCurrentTenantId(),
    tenantName: getCurrentTenantName(),
    connection: {
      protocol: "http",
      host: "localhost",
      port: API_PORT,
    },
  });
}

export default {
  startDiscovery,
  stopDiscovery,
  registerDiscoveryRoutes,
  getCurrentTenantId,
  getCurrentTenantName,
};

/**
 * Test: Send a discovery broadcast and log the response
 * Ejecutar con: node -e "const { startDiscovery, stopDiscovery } = require('./src/services/udp-discovery'); startDiscovery().then(() => setTimeout(stopDiscovery, 3000));"
 */
console.log("📡 UDP Discovery service module loaded successfully");
console.log(`   Listening on port ${DISCOVER_PORT} for message: "${DISCOVER_MESSAGE}"`);