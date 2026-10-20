#!/usr/bin/env node
/**
 * pos-server/scripts/generatePublicKey.js — Embed the Ed25519 public key at build time.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Qué hace:
 *   Reads the public key PEM (main + trial families) and generates:
 *     src/keys/publicKey.ts       → PUBLIC_KEY_PEM
 *     src/keys/trialPublicKey.ts  → TRIAL_PUBLIC_KEY_PEM
 *
 * This file GENERATES those two .ts files — they are not hand-edited.
 * It runs in prebuild so the server has the public key at compile time.
 *
 * The public key MUST NEVER come from an env var editable by the client
 * (an attacker could swap it for their own key and accept fake licenses).
 * PUBLIC_KEY_PATH only selects WHICH FILE is read at build time; the
 * resulting PEM is frozen into the bundle.
 *
 * ── Dónde se busca la clave (en orden) ────────────────────────────────
 *   1. PUBLIC_KEY_PATH / TRIAL_PUBLIC_KEY_PATH (env, relativo a cwd)
 *   2. <pos-server>/keys/            → repo autocontenido (la pública SÍ es
 *                                      pública: se puede versionar)
 *   3. <workspace>/tools/keys/       → ruta canónica documentada
 *   4. <workspace>/tools-posky/keys/ → repo real del toolkit de licencias
 *
 * ─────────────────────────────────────────────────────────────────────
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

// Resuelve rutas relativas a este script
const __dirnameESM = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.resolve(__dirnameESM, '..')
const workspaceRoot = path.resolve(serverRoot, '..')
const outputPath = path.join(serverRoot, 'src', 'keys', 'publicKey.ts')
const trialOutputPath = path.join(serverRoot, 'src', 'keys', 'trialPublicKey.ts')

/**
 * Devuelve el primer path existente entre los candidatos.
 * @param {string} envPath  valor crudo de la env var (relativo a cwd)
 * @param {string[]} fallbacks  rutas absolutas de respaldo
 * @returns {{ path: string, from: string } | null}
 */
function resolveKeyPath(envPath, fallbacks) {
  if (envPath && envPath.trim()) {
    const raw = envPath.trim()
    // Relativas: primero contra cwd, luego contra la raíz de pos-server
    // (así funciona aunque el script se ejecute desde otro directorio).
    const candidates = path.isAbsolute(raw)
      ? [raw]
      : [path.resolve(process.cwd(), raw), path.resolve(serverRoot, raw)]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return { path: candidate, from: 'env' }
    }
    // Si la env var apunta a algo inexistente NO caemos a los defaults en
    // silencio: el usuario la fijó explícitamente y hay que reportarlo.
    return { path: candidates[0], from: 'env-missing' }
  }
  for (const candidate of fallbacks) {
    if (fs.existsSync(candidate)) return { path: candidate, from: 'default' }
  }
  return null
}

function main() {
  const mainHeader = [
    '/**',
    ' * src/keys/publicKey.ts — Clave pública Ed25519 embebida en el build.',
    ' *',
    ' * AUTO-GENERATED por scripts/generatePublicKey.js — NO EDITAR A MANO.',
    ' * Se genera en prebuild leyendo la clave pública de tools/keys (o tools-posky/keys).',
    ' * La clave pública nunca debe venir de .env (el cliente podría falsificar).',
    ' */',
    '',
  ].join('\n')

  const trialHeader = [
    '/**',
    ' * src/keys/trialPublicKey.ts — Clave pública trial Ed25519 (familia aislada).',
    ' *',
    ' * AUTO-GENERATED por scripts/generatePublicKey.js — NO EDITAR A MANO.',
    ' * Se genera en prebuild leyendo la clave pública trial de tools/keys.',
    ' * Sirve solo para verificar licencias trial 1 día (POST /license/trial).',
    ' * Rotar esta clave no impacta licencias productivas (familia main).',
    ' */',
    '',
  ].join('\n')

  // --- main ---
  const mainResolved = resolveKeyPath(process.env.PUBLIC_KEY_PATH, [
    path.join(serverRoot, 'keys', 'mipos_public.pem'),
    path.join(workspaceRoot, 'tools', 'keys', 'mipos_public.pem'),
    path.join(workspaceRoot, 'tools-posky', 'keys', 'mipos_public.pem'),
  ])

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  if (!mainResolved || mainResolved.from === 'env-missing') {
    const missingPath = mainResolved ? mainResolved.path : path.join(workspaceRoot, 'tools', 'keys', 'mipos_public.pem')
    const allowMissing = (process.env.ALLOW_MISSING_LICENSE_KEY ?? '').trim().toLowerCase()
    const allowed = allowMissing === '1' || allowMissing === 'true'
    const message =
      '\x1b[31m✗  No se encontró la clave pública de licencias en ' + missingPath + '\x1b[0m\n' +
      '\x1b[33m   Sin clave, el server NO puede verificar firmas Ed25519: rechazará todo .lic\n' +
      '   y con LICENSE_STRICT=true desactivará el tenant (login bloqueado).\x1b[0m\n' +
      '\x1b[33m   Genera las claves con: node tools-posky/generate-keys.js\x1b[0m\n' +
      '\x1b[33m   O copia la clave pública a tools/keys/mipos_public.pem\x1b[0m\n' +
      '\x1b[33m   O define PUBLIC_KEY_PATH en .env (o exporta la variable).\x1b[0m\n' +
      '\x1b[33m   Para permitir el build degradado (CI/tests): ALLOW_MISSING_LICENSE_KEY=1\x1b[0m\n'
    if (!allowed) {
      process.stderr.write(message)
      process.exit(1)
    }
    process.stderr.write(
      '\x1b[33m⚠  Sin clave pública de licencias — build degradado (ALLOW_MISSING_LICENSE_KEY).\x1b[0m\n',
    )
    fs.writeFileSync(
      outputPath,
      mainHeader +
        'export const PUBLIC_KEY_PEM = \'\'; // CLAVE FALTANTE — regenerar: npm run build:keys\n' +
        'export const IS_TEST_KEY = false\n',
      'utf8',
    )
    console.log('[generatePublicKey] ✓ Generado con clave vacía (modo degradado, ALLOW_MISSING_LICENSE_KEY=1).')
  } else {
    const pem = fs.readFileSync(mainResolved.path, 'utf8').trim()
    const escaped = pem.replace(/\\/g, '\\\\').replace(/`/g, '\\`')
    fs.writeFileSync(
      outputPath,
      mainHeader +
        `export const PUBLIC_KEY_PEM = \`${escaped}\`\n` +
        'export const IS_TEST_KEY = false\n',
      'utf8',
    )
    console.log('[generatePublicKey] ✓ src/keys/publicKey.ts generado desde ' + mainResolved.path)
  }

  // --- trial (familia aislada, opcional en dev) ---
  const trialResolved = resolveKeyPath(process.env.TRIAL_PUBLIC_KEY_PATH, [
    path.join(serverRoot, 'keys', 'trial_public.pem'),
    path.join(workspaceRoot, 'tools', 'keys', 'trial_public.pem'),
    path.join(workspaceRoot, 'tools-posky', 'keys', 'trial_public.pem'),
  ])

  fs.mkdirSync(path.dirname(trialOutputPath), { recursive: true })
  if (!trialResolved || trialResolved.from === 'env-missing') {
    fs.writeFileSync(
      trialOutputPath,
      trialHeader + 'export const TRIAL_PUBLIC_KEY_PEM = \'\'; // TRIAL clave faltante — generar: node tools-posky/generate-trial-keys.js\n',
      'utf8',
    )
    console.log('[generatePublicKey]   trial: clave faltante → trialPublicKey.ts vacío (trial no verificable).')
  } else {
    const pem = fs.readFileSync(trialResolved.path, 'utf8').trim()
    const escaped = pem.replace(/\\/g, '\\\\').replace(/`/g, '\\`')
    fs.writeFileSync(trialOutputPath, trialHeader + `export const TRIAL_PUBLIC_KEY_PEM = \`${escaped}\`\n`, 'utf8')
    console.log('[generatePublicKey] ✓ src/keys/trialPublicKey.ts generado desde ' + trialResolved.path)
  }
}

main()
