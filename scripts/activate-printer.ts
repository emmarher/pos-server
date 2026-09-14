/**
 * scripts/activate-printer.ts — Activa un dispositivo como impresora (can_print=1).
 *
 * Uso: npx tsx scripts/activate-printer.ts 9d15b88c-b2e0-4bc8-9890-52fa18254b22 USB001
 * Por defecto activa el device 9d15b88c-b2e0-4bc8-9890-52fa18254b22 (PC emma-desk USB001)
 * para reimpresión delegada (POST /print-jobs auto-resuelve target).
 */
import Database from 'better-sqlite3';
import { env } from '../src/config/env.js';

const deviceId = process.argv[2] ?? '9d15b88c-b2e0-4bc8-9890-52fa18254b22';
const port = process.argv[3] ?? 'USB001';
const db = new Database(env.sqlitePath);
const info = db.prepare('SELECT device_id, can_print FROM device_capabilities WHERE device_id=?').get(deviceId) as { device_id: string; can_print: number } | undefined;
console.log('Antes:', info);
db.prepare(
  'UPDATE device_capabilities SET can_print=1, printer_type=?, printer_protocol=?, printer_address=?, updated_at=? WHERE device_id=?',
).run('USB', 'ESC_POS_USB', port, new Date().toISOString(), deviceId);
console.log('Después:', db.prepare('SELECT device_id, can_print, printer_type, printer_address FROM device_capabilities WHERE device_id=?').get(deviceId));
db.close();
console.log(`✓ Device ${deviceId} activado como impresora en ${port}`);
