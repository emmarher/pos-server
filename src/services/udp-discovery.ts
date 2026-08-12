/**
 * UDP Discovery Service
 *
 * - Listens for UDP broadcast on port 5000 for message "POS_DISCOVER"
 * - Responds with { ip, port, tenant_id, device_name, api_version }
 * - Falls back to QR code pairing and manual IP entry if broadcast not available
 *
 * RF-DS: Discovery UDP
 */

import * as dgram from "dgram";

// Configuración del descubrimiento
const DISCOVER_PORT = 5000;
const DISCOVER_MESSAGE = "POS_DISCOVER";

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

/**
 * Inicia el servicio de descubrimiento UDP
 */
export function startDiscovery(): Promise<void> {
  if (isRunning) {
    console.warn("⚠️ Discovery service already running");
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    try {
      // Crear socket UDP
      discoverSocket = dgram.createSocket("udp4");

      // Cuando recibamos un paquete, respondemos
      discoverSocket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        if (msg.toString().trim() === DISCOVER_MESSAGE) {
          try {
            // Obtener tenant_id (usar placeholder para desarrollo)
            const tenantId = getCurrentTenantId();

            const response: DiscoveryResponse = {
              ip: rinfo.address,
              port: rinfo.port,
              tenant_id: tenantId,
              device_name: `POS-Server-${tenantId}`,
              api_version: "4.0.0",
            };

            // Enviar respuesta al cliente descubridor
            const responseBuf = Buffer.from(JSON.stringify(response));
            discoverSocket.send(responseBuf, 0, responseBuf.length, DISCOVER_PORT, rinfo.address);

            console.log(`📡 Discovery response sent to ${rinfo.address}:${rinfo.port}`);
          } catch (err) {
            console.error("❌ Error generating discovery response:", err);
          }
        }
      });

      // Cuando haya un error en el socket
      discoverSocket.on("error", (err) => {
        console.error(`❌ Discovery UDP socket error: ${err.message}`);
      });

      // Escuchar en todas las interfaces (0.0.0.0)
      discoverSocket.bind(DISCOVER_PORT, "0.0.0.0", () => {
        isRunning = true;
        console.log(`🟢 UDP Discovery listening on port ${DISCOVER_PORT}`);
        resolve();
      });

    } catch (err) {
      console.error("❌ Failed to start Discovery UDP service:", err);
      reject(err);
    }
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
 * Obtiene el tenant_id actual (placeholder para desarrollo)
 */
function getCurrentTenantId(): string {
  // En producción, esto debería venir del contexto de multi-tenant
  // Por ahora retornamos el tenant de demo por defecto
  return "DEMO-0001";
}

/**
 * Register discovery endpoint in Fastify app
 * Integrates with the main server setup
 */
export function registerDiscoveryRoutes(fastify: any, options: any): void {
  // Endpoint para verificar estado del servicio de descubrimiento
  fastify.get("/discovery/status", async () => {
    return {
      isRunning,
      port: DISCOVER_PORT,
      message: DISCOVER_MESSAGE,
    };
  });

  // Endpoint para obtener configuración de discovery (útil para QR/manual fallback)
  fastify.get("/discovery/config", async () => {
    return {
      udpPort: DISCOVER_PORT,
      discoverMessage: DISCOVER_MESSAGE,
      fallback: {
        qrCode: generateDiscoveryQR(),
        manualInput: {
          defaultIp: "127.0.0.1",
          defaultPort: 3000,
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
    tenantId: "DEMO-0001",
    connection: {
      protocol: "http",
      host: "localhost",
      port: 3000,
    },
  });
}

export default {
  startDiscovery,
  stopDiscovery,
  registerDiscoveryRoutes,
};

/**
 * Test: Send a discovery broadcast and log the response
 * Ejecutar con: node -e "const { startDiscovery, stopDiscovery } = require('./src/services/udp-discovery'); startDiscovery().then(() => setTimeout(stopDiscovery, 3000));"
 */
console.log("📡 UDP Discovery service module loaded successfully");
console.log(`   Listening on port ${DISCOVER_PORT} for message: "${DISCOVER_MESSAGE}"`);