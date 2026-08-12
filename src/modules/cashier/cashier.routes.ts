/**
 * src/modules/cashier/cashier.routes.ts — Rutas de cortes de caja.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Endpoints (contrato con pos-mobile y panel admin):
 *   POST /cashier/turn-start       — Iniciar corte por turno (vendedor)
 *   POST /cashier/turn-end         — Finalizar corte por turno (vendedor)
 *   POST /cashier/daily-start      — Iniciar corte diario (admin)
 *   POST /cashier/daily-end        — Finalizar corte diario (admin)
 *   POST /cashier/withdrawal       — Registrar retiro de caja
 *   POST /cashier/reprint-ticket   — Reimprimir ticket de corte
 *
 * PERMISOS:
 *   - `cashier:cut_own` → start/end TURN (solo el vendedor propio)
 *   - `cashier:cut_all` → start/end DAILY y withdrawal/reprint (admin)
 * El tenant sale del JWT (request.user.tenant_id) — nunca del body/query.
 * ────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthJwtPayload } from '../../types/auth.js'
import { authenticate, requirePermission } from '../../middleware/auth.js'
import { okEnvelope, okEnvelopeSchema } from '../../types/response.js'
import {
  startCutBodySchema,
  endCutBodySchema,
  withdrawalBodySchema,
  reprintTicketBodySchema,
} from './cashier.schema.js'

import type {
  StartCutInput,
  EndCutInput,
  WithdrawalInput,
  ReprintCutInput,
} from './cashier.service.js'
import {
  startCut,
  endCut,
  createWithdrawal,
  getCutTicketContent,
} from './cashier.service.js'

/** Request autenticado: el JWT trae tenant_id, sub (seller) y permisos. */
type AuthedRequest = FastifyRequest & { user: AuthJwtPayload }

/** Params de rutas con :id (turn-end, daily-end, withdrawal). */
type ParamsWithId = { id: string }

/** Plugin Fastify que registra las rutas del módulo de caja. */
export function cashierRoutes(app: FastifyInstance): void {
  /* ── POST /cashier/turn-start ───────────────────────────────────────── */
  app.post(
    '/cashier/turn-start',
    {
      preHandler: [
        authenticate,
        requirePermission('cashier:cut_own'),
      ],
      schema: {
        body: startCutBodySchema,
        response: { 200: okEnvelopeSchema({ type: 'object', properties: {} }) },
      },
    },
    async (request: AuthedRequest) => {
      const input = request.body as StartCutInput
      const cut = await startCut(request.user.tenant_id, input)
      return okEnvelope(cut, 'Corte de turno iniciado', 200)
    },
  )

  /* ── POST /cashier/turn-end ─────────────────────────────────────────── */
  app.post(
    '/cashier/turn-end/:id',
    {
      preHandler: [
        authenticate,
        requirePermission('cashier:cut_own'),
      ],
      schema: {
        body: endCutBodySchema,
        response: { 200: okEnvelopeSchema({ type: 'object', properties: {} }) },
      },
    },
    async (request: AuthedRequest) => {
      const input = request.body as EndCutInput
      const cut = await endCut(
        { tenant_id: request.user.tenant_id, user_id: request.user.sub },
        input,
        (request.params as ParamsWithId).id,
      )
      return okEnvelope(cut, 'Corte de turno finalizado', 200)
    },
  )

  /* ── POST /cashier/daily-start ──────────────────────────────────────── */
  app.post(
    '/cashier/daily-start',
    {
      preHandler: [
        authenticate,
        requirePermission('cashier:cut_all'),
      ],
      schema: {
        body: startCutBodySchema,
        response: { 200: okEnvelopeSchema({ type: 'object', properties: {} }) },
      },
    },
    async (request: AuthedRequest) => {
      const input = request.body as StartCutInput
      const cut = await startCut(request.user.tenant_id, input)
      return okEnvelope(cut, 'Corte diario iniciado', 200)
    },
  )

  /* ── POST /cashier/daily-end ────────────────────────────────────────── */
  app.post(
    '/cashier/daily-end/:id',
    {
      preHandler: [
        authenticate,
        requirePermission('cashier:cut_all'),
      ],
      schema: {
        body: endCutBodySchema,
        response: { 200: okEnvelopeSchema({ type: 'object', properties: {} }) },
      },
    },
    async (request: AuthedRequest) => {
      const input = request.body as EndCutInput
      const cut = await endCut(
        { tenant_id: request.user.tenant_id, user_id: request.user.sub },
        input,
        (request.params as ParamsWithId).id,
      )
      return okEnvelope(cut, 'Corte diario finalizado', 200)
    },
  )

  /* ── POST /cashier/withdrawal ────────────────────────────────────────── */
  app.post(
    '/cashier/withdrawal/:id',
    {
      preHandler: [
        authenticate,
        requirePermission('cashier:cut_all'),
      ],
      schema: {
        body: withdrawalBodySchema,
        response: { 200: okEnvelopeSchema({ type: 'object', properties: {} }) },
      },
    },
    async (request: AuthedRequest) => {
      const input = request.body as WithdrawalInput
      const withdrawal = await createWithdrawal(
        { tenant_id: request.user.tenant_id, user_id: request.user.sub },
        input,
        (request.params as ParamsWithId).id, // cashier_cut_id
      )
      return okEnvelope(withdrawal, 'Retiro de caja registrado', 200)
    },
  )

  /* ── POST /cashier/reprint-ticket ────────────────────────────────────── */
  app.post(
    '/cashier/reprint-ticket',
    {
      preHandler: [
        authenticate,
        requirePermission('cashier:cut_all'),
      ],
      schema: {
        body: reprintTicketBodySchema,
        response: { 200: okEnvelopeSchema({ type: 'object', properties: {} }) },
      },
    },
    async (request: AuthedRequest) => {
      const input = request.body as ReprintCutInput
      const ticket = await getCutTicketContent(request.user.tenant_id, input)
      return okEnvelope(ticket, 'Ticket de corte reimpreso', 200)
    },
  )
}