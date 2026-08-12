/**
 * src/modules/cashier/cashier.schema.ts — JSON Schemas del módulo de caja.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Body schemas para POST /cashier/...
 *
 * Respuestas SIEMPRE envueltas en { statusCode, message, data } (types/response).
 * ────────────────────────────────────────────────────────────────────────
 */

import type { ApiDataSchema } from '../../types/response.js'

/* ── Body de POST /cashier/turn-start y daily-start ─────────────────────── */

export const startCutBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['cut_type'],
  additionalProperties: false,
  properties: {
    cut_type: { type: 'string', enum: ['TURN', 'DAILY'] },
    branch_id: { type: ['string', 'null'], minLength: 1 },
  },
}

/* ── Body de POST /cashier/turn-end y daily-end ─────────────────────────── */

export const endCutBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['counted_cash'],
  additionalProperties: false,
  properties: {
    counted_cash: { type: 'number', minimum: 0 },
    notes: { type: ['string', 'null'], maxLength: 500 },
  },
}

/* ── Body de POST /cashier/withdrawal ──────────────────────────────────── */

export const withdrawalBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['amount', 'reason'],
  additionalProperties: false,
  properties: {
    amount: { type: 'number', minimum: 0 },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
}

/* ── Body de POST /cashier/reprint-ticket ──────────────────────────────── */

export const reprintTicketBodySchema: ApiDataSchema = {
  type: 'object',
  required: ['cashier_cut_id'],
  additionalProperties: false,
  properties: {
    cashier_cut_id: { type: 'string', minLength: 1 },
  },
}