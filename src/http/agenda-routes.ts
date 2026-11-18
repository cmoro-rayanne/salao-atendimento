import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { HoursBlock } from '../modules/appointments/admin-ports.js';
import { delayStatus, requestDelayNotice, MAX_DELAY_MIN, MIN_DELAY_MIN } from '../modules/appointments/delay-notice.js';
import type { DelayNoticeRepository, DelayNoticeScheduler } from '../modules/appointments/ports.js';
import { normalizePhone, panelBook, panelCancel, panelFreeSlots, panelReschedule, type PanelAgendaDeps } from '../modules/appointments/panel.js';

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const TimeOffParams = IdParams.extend({ timeOffId: z.coerce.number().int().positive() });
const iso = z.iso.datetime({ offset: true });

const ServiceBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullable().transform((v) => (v ? v : null)),
  durationMin: z.number().int().min(5).max(480),
  priceCents: z.number().int().min(0).max(10_000_000).nullable(),
  active: z.boolean(),
});

const HoursBody = z
  .array(
    z
      .object({
        weekday: z.number().int().min(0).max(6),
        startMin: z.number().int().min(0).max(1439),
        endMin: z.number().int().min(1).max(1440),
      })
      .refine((h) => h.startMin < h.endMin, 'A hora de saída precisa ser depois da entrada.'),
  )
  .max(35);

export function overlappingHours(hours: HoursBlock[]): boolean {
  const sorted = [...hours].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  return sorted.some((h, i) => i > 0 && sorted[i - 1]!.weekday === h.weekday && sorted[i - 1]!.endMin > h.startMin);
}

const ProfessionalBody = z.object({
  name: z.string().trim().min(1).max(80),
  active: z.boolean(),
  serviceIds: z.array(z.number().int().positive()).max(60),
  hours: HoursBody,
});
const TimeOffBody = z.object({ startsAt: iso, endsAt: iso, reason: z.string().trim().max(120).nullable().transform((v) => (v ? v : null)) });
const RangeQuery = z.object({ from: iso, to: iso });
const SlotsQuery = z.object({
  serviceId: z.coerce.number().int().positive(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  professionalId: z.coerce.number().int().positive().optional(),
});
const NewAppointmentBody = z.object({
  serviceId: z.number().int().positive(),
  professionalId: z.number().int().positive(),
  startsAt: iso,
  phone: z.string().max(30),
  name: z.string().trim().max(120).nullable().transform((v) => (v ? v : null)),
});
const StatusBody = z.object({ status: z.enum(['concluido', 'faltou', 'agendado']) });
const DelayBody = z.object({ delayMin: z.number().int().min(MIN_DELAY_MIN).max(MAX_DELAY_MIN) });
const RescheduleBody = z.object({ startsAt: iso, professionalId: z.number().int().positive().optional() });

const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });

const BOOK_MESSAGES = {
  busy: 'Esse horário acabou de ser ocupado. Escolha outro.',
  client_busy: 'Essa cliente já tem outro agendamento nesse horário.',
  not_available: 'Esse horário não está disponível (fora do expediente, folga, já passou ou muito em cima da hora).',
} as const;

/** Rotas de agenda, serviços e profissionais do painel. Registradas já dentro do escopo com sessão. */
export function agendaRoutes(
  auth: FastifyInstance,
  deps: PanelAgendaDeps & {
    tenantTimeZone: (tenantId: number) => Promise<string>;
    delayNotice?: { notices: DelayNoticeRepository; scheduler: DelayNoticeScheduler } | undefined;
  },
  ownerOnly: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): void {
  const tenantOf = (req: FastifyRequest) => req.adminSession!.tenantId;

  auth.get('/services', async (req) => ({ services: await deps.admin.listServices(tenantOf(req)) }));

  auth.post('/services', { preHandler: ownerOnly }, async (req, reply) => {
    const body = ServiceBody.safeParse(req.body);
    if (!body.success) return bad(reply, 'Confira nome, duração (5 a 480 min) e valor do serviço.');
    return reply.code(201).send(await deps.admin.createService(tenantOf(req), body.data));
  });

  auth.put('/services/:id', { preHandler: ownerOnly }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = ServiceBody.safeParse(req.body);
    if (!params.success || !body.success) return bad(reply, 'Confira nome, duração (5 a 480 min) e valor do serviço.');
    const result = await deps.admin.updateService(tenantOf(req), params.data.id, body.data);
    if (result === 'not_found') return reply.code(404).send({ error: 'Serviço não encontrado.' });
    return { ok: true };
  });

  auth.get('/professionals', async (req) => ({ professionals: await deps.admin.listProfessionals(tenantOf(req)) }));

  auth.post('/professionals', { preHandler: ownerOnly }, async (req, reply) => {
    const body = ProfessionalBody.safeParse(req.body);
    if (!body.success) return bad(reply, 'Confira o nome e o expediente (a saída precisa ser depois da entrada).');
    if (overlappingHours(body.data.hours)) return bad(reply, 'Há faixas de expediente que se sobrepõem no mesmo dia.');
    const id = await deps.admin.createProfessional(tenantOf(req), body.data);
    if (id === 'invalid_services') return bad(reply, 'Algum serviço escolhido não existe.');
    return reply.code(201).send({ id });
  });

  auth.put('/professionals/:id', { preHandler: ownerOnly }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = ProfessionalBody.safeParse(req.body);
    if (!params.success || !body.success) return bad(reply, 'Confira o nome e o expediente (a saída precisa ser depois da entrada).');
    if (overlappingHours(body.data.hours)) return bad(reply, 'Há faixas de expediente que se sobrepõem no mesmo dia.');
    const result = await deps.admin.updateProfessional(tenantOf(req), params.data.id, body.data);
    if (result === 'not_found') return reply.code(404).send({ error: 'Profissional não encontrada.' });
    if (result === 'invalid_services') return bad(reply, 'Algum serviço escolhido não existe.');
    return { ok: true };
  });

  auth.post('/professionals/:id/time-off', async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = TimeOffBody.safeParse(req.body);
    if (!params.success || !body.success) return bad(reply, 'Informe início e fim da folga.');
    const startsAt = new Date(body.data.startsAt);
    const endsAt = new Date(body.data.endsAt);
    if (endsAt <= startsAt) return bad(reply, 'O fim da folga precisa ser depois do início.');
    if (endsAt.getTime() - startsAt.getTime() > 366 * 24 * 3_600_000) return bad(reply, 'A folga pode ter no máximo um ano.');
    const id = await deps.admin.addTimeOff(tenantOf(req), params.data.id, startsAt, endsAt, body.data.reason);
    if (id === 'not_found') return reply.code(404).send({ error: 'Profissional não encontrada.' });
    // Agendamentos que já estavam nesse período continuam valendo: a recepção decide se remarca.
    const affected = await deps.admin.countActiveInRange(tenantOf(req), params.data.id, startsAt, endsAt);
    return reply.code(201).send({ id, affected });
  });

  auth.delete('/professionals/:id/time-off/:timeOffId', async (req, reply) => {
    const params = TimeOffParams.safeParse(req.params);
    if (!params.success) return bad(reply, 'Folga inválida.');
    const result = await deps.admin.removeTimeOff(tenantOf(req), params.data.id, params.data.timeOffId);
    if (result === 'not_found') return reply.code(404).send({ error: 'Folga não encontrada.' });
    return { ok: true };
  });

  auth.get('/appointments', async (req, reply) => {
    const q = RangeQuery.safeParse(req.query);
    if (!q.success) return bad(reply, 'Informe o período (from, to).');
    const list = await deps.admin.listAppointments(tenantOf(req), new Date(q.data.from), new Date(q.data.to));
    const sent = deps.delayNotice ? await deps.delayNotice.notices.latestSent(list.map((a) => a.id)) : [];
    const byAppointment = new Map(sent.map((n) => [n.appointmentId, n] as const));
    return {
      appointments: list.map((a) => {
        const n = byAppointment.get(a.id);
        if (!n) return a;
        const status = a.status === 'cancelado' ? 'cancelou' : delayStatus(n, a);
        return {
          ...a,
          delayNotice: { delayMin: n.delayMin, status, expectedAt: new Date(n.originalStartsAt.getTime() + n.delayMin * 60_000) },
        };
      }),
    };
  });

  auth.post('/appointments/:id/delay-notice', async (req, reply) => {
    if (!deps.delayNotice) return reply.code(503).send({ error: 'O aviso de atraso não está ativo neste ambiente.' });
    const params = IdParams.safeParse(req.params);
    const body = DelayBody.safeParse(req.body);
    if (!params.success || !body.success) return bad(reply, `Informe o atraso em minutos (de ${MIN_DELAY_MIN} a ${MAX_DELAY_MIN}).`);
    const tenantId = tenantOf(req);
    const result = await requestDelayNotice(
      {
        admin: deps.admin,
        appointments: deps.agenda.appointments,
        notices: deps.delayNotice.notices,
        scheduler: deps.delayNotice.scheduler,
        now: deps.agenda.now,
      },
      { tenantId, appointmentId: params.data.id, delayMin: body.data.delayMin },
    );
    switch (result.kind) {
      case 'queued':
        req.log.info({ tenantId, appointmentId: params.data.id, delayMin: body.data.delayMin }, 'aviso de atraso enfileirado');
        return reply.code(202).send({ ok: true });
      case 'already_requested':
        return reply.code(200).send({ ok: true, duplicate: true });
      case 'not_found':
        return reply.code(404).send({ error: 'Agendamento não encontrado.' });
      case 'invalid_delay':
        return bad(reply, `Informe o atraso em minutos (de ${MIN_DELAY_MIN} a ${MAX_DELAY_MIN}).`);
      case 'not_active':
        return reply.code(409).send({ error: 'Só dá para avisar agendamentos ativos (não cancelados nem concluídos).' });
      case 'out_of_window':
        return reply.code(409).send({ error: 'O aviso vale para agendamentos que começam de 30 minutos atrás até 6 horas à frente.' });
      case 'no_whatsapp':
        return reply.code(409).send({ error: 'Essa cliente não tem WhatsApp neste sistema. Ligue para ela.' });
      case 'opted_out':
        return reply.code(409).send({ error: 'Essa cliente pediu para não receber mensagens. Ligue para ela.' });
    }
  });

  auth.get('/free-slots', async (req, reply) => {
    const q = SlotsQuery.safeParse(req.query);
    if (!q.success) return bad(reply, 'Informe o serviço e o dia.');
    const result = await panelFreeSlots(deps.agenda, { tenantId: tenantOf(req), ...q.data });
    if ('error' in result) {
      return result.error === 'service' ? reply.code(404).send({ error: 'Serviço não encontrado.' }) : bad(reply, 'Dia inválido.');
    }
    return result;
  });

  auth.post('/appointments', async (req, reply) => {
    const body = NewAppointmentBody.safeParse(req.body);
    if (!body.success) return bad(reply, 'Confira serviço, profissional, horário e telefone.');
    const tenantId = tenantOf(req);
    const result = await panelBook(deps, {
      tenantId,
      ...body.data,
      startsAt: new Date(body.data.startsAt),
      timeZone: await deps.tenantTimeZone(tenantId),
    });
    switch (result.kind) {
      case 'invalid_phone':
        return bad(reply, 'Telefone inválido. Use DDD + número, por exemplo (41) 99999-0000.');
      case 'booked':
      case 'already_booked':
        req.log.info({ tenantId, appointmentId: result.appointment.id }, 'agendamento criado pelo painel');
        return reply.code(result.kind === 'booked' ? 201 : 200).send({ id: result.appointment.id });
      default:
        return reply.code(409).send({ error: BOOK_MESSAGES[result.kind] });
    }
  });

  auth.patch('/appointments/:id', async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = StatusBody.safeParse(req.body);
    if (!params.success || !body.success) return bad(reply, 'Dados inválidos.');
    const result = await deps.admin.markStatus(tenantOf(req), params.data.id, body.data.status, deps.agenda.now());
    if (result === 'not_found') return reply.code(404).send({ error: 'Agendamento não encontrado.' });
    if (result === 'not_started') return reply.code(409).send({ error: 'Só dá para concluir ou marcar falta depois que o horário começa.' });
    if (result === 'cancelled') return reply.code(409).send({ error: 'Esse agendamento foi cancelado.' });
    if (result === 'busy') return reply.code(409).send({ error: 'Esse horário já foi ocupado por outro agendamento.' });
    return { ok: true };
  });

  auth.post('/appointments/:id/reschedule', async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = RescheduleBody.safeParse(req.body);
    if (!params.success || !body.success) return bad(reply, 'Dados inválidos.');
    const tenantId = tenantOf(req);
    const result = await panelReschedule(deps, {
      tenantId,
      id: params.data.id,
      startsAt: new Date(body.data.startsAt),
      professionalId: body.data.professionalId,
      timeZone: await deps.tenantTimeZone(tenantId),
    });
    switch (result.kind) {
      case 'rescheduled':
      case 'unchanged':
        return { ok: true };
      case 'not_found':
        return reply.code(404).send({ error: 'Agendamento não encontrado ou já passou.' });
      default:
        return reply.code(409).send({ error: BOOK_MESSAGES[result.kind] });
    }
  });

  auth.delete('/appointments/:id', async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return bad(reply, 'Agendamento inválido.');
    const result = await panelCancel(deps, tenantOf(req), params.data.id);
    if (result === 'not_found') return reply.code(404).send({ error: 'Agendamento não encontrado ou já passou.' });
    return { ok: true };
  });
}

export { normalizePhone };
