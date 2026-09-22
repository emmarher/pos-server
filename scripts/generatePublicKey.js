#!/usr/bin/env node
/**
 * pos-server/scripts/generatePublicKey.js — Embed the Ed25519 public key at build time.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Qué hace:
 *   Reads the public key PEM from PUBLIC_KEY_PATH (default: ../../tools/keys/mipos_public.pem)
 *   and generates src/keys/publicKey.ts with the PEM content embedded as a string constant.
 *
 * This file GENERATES src/keys/publicKey.ts — it is not hand-edited.
 * It runs in prebuild so the server has the public key at compile time.
 *
 * The public key MUST NEVER come from an env var editable by the client
 * (an attacker could swap it for their own key and accept fake licenses).
 * ─────────────────────────────────────────────────────────────────────
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resuelve rutas relativas a este script
const __dirnameESM = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.resolve(__dirnameESM, '..')
const outputPath = path.join(serverRoot, 'src', 'keys', 'publicKey.ts')

function main() {
  // Claves públicas: main + trial (familias aisladas). Trial es solo para licencias trial 1d.
  const mainPemPath = process.env.PUBLIC_KEY_PATH
    ? path.resolve(process.cwd(), process.env.PUBLIC_KEY_PATH)
    : path.resolve(serverRoot, '../tools/keys/mipos_public.pem')
  const trialPemPath = process.env.TRIAL_PUBLIC_KEY_PATH
    ? path.resolve(process.cwd(), process.env.TRIAL_PUBLIC_KEY_PATH)
    : path.resolve(serverRoot, '../tools/keys/trial_public.pem')

  const trialOutputPath = path.join(serverRoot, 'src', 'keys', 'trialPublicKey.ts')

  const mainHeader = [
    '/**',
    ' * src/keys/publicKey.ts — Clave pública Ed25519 embebida en el build.',
    ' *',
    ' * AUTO-GENERATED por scripts/generatePublicKey.js — NO EDITAR A MANO.',
    ' * Se genera en prebuild leyendo tools/keys/mipos_public.pem.',
    ' * La clave pública nunca debe venir de .env (el cliente podría falsificar).',
    ' */',
    '',
  ].join('\n')

  const trialHeader = [
    '/**',
    ' * src/keys/trialPublicKey.ts — Clave pública trial Ed25519 (familia aislada).',
    ' *',
    ' * AUTO-GENERATED por scripts/generatePublicKey.js — NO EDITAR A MANO.',
    ' * Se genera en prebuild leyendo tools/keys/trial_public.pem.',
    ' * Sirve solo para verificar licencias trial 1 día (POST /license/trial).',
    ' * Rotar esta clave no impacta licencias productivas (familia main).',
    ' */',
    '',
  ].join('\n')

  // --- main ---
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  if (!fs.existsSync(mainPemPath)) {
    const warning =
      '\x1b[33m⚠  No se encontró la clave pública en ' + mainPemPath + '\x1b[0m\n' +
      '\x1b[33m   El server arrancará en modo degradado (no verificará firmas de licencias).\x1b[0m\n' +
      '\x1b[33m   Genera las claves con: node tools/generate-keys.js\x1b[0m\n' +
      '\x1b[33m   O configura PUBLIC_KEY_PATH en .env\x1b[0m\n'
    process.stderr.write(warning)
    fs.writeFileSync(
      outputPath,
      mainHeader + 'export const PUBLIC_KEY_PEM = \'\'; // CLAVE FALTANTE — regenerar: npm run build:keys\n',
      'utf8',
    )
    console.log('[generatePublicKey] ✓ Generado con clave vacía (modo degradado).')
  } else {
    const pem = fs.readFileSync(mainPemPath, 'utf8').trim()
    const escaped = pem.replace(/\\/g, '\\\\').replace(/`/g, '\\`')
    fs.writeFileSync(outputPath, mainHeader + `export const PUBLIC_KEY_PEM = \`${escaped}\`\n`, 'utf8')
    console.log('[generatePublicKey] ✓ src/keys/publicKey.ts generado desde ' + mainPemPath)
  }

  // --- trial (familia aislada, opcional en dev) ---
  fs.mkdirSync(path.dirname(trialOutputPath), { recursive: true })
  if (!fs.existsSync(trialPemPath)) {
    fs.writeFileSync(
      trialOutputPath,
      trialHeader + 'export const TRIAL_PUBLIC_KEY_PEM = \'\'; // TRIAL clave faltante — generar: node tools/generate-trial-keys.js\n',
      'utf8',
    )
    console.log('[generatePublicKey]   trial: clave faltante → trialPublicKey.ts vacío (trial no verificable).')
  } else {
    const pem = fs.readFileSync(trialPemPath, 'utf8').trim()
    const escaped = pem.replace(/\\/g, '\\\\').replace(/`/g, '\\`')
    fs.writeFileSync(trialOutputPath, trialHeader + `export const TRIAL_PUBLIC_KEY_PEM = \`${escaped}\`\n`, 'utf8')
    console.log('[generatePublicKey] ✓ src/keys/trialPublicKey.ts generado desde ' + trialPemPath)
  }
}

main()
