import type { ToolContext } from '../agent/ports.js';
import { formatLocal } from '../../shared/time-zone.js';
import { computeFreeSlots, pickProfessional, type FreeSlot } from './availability.js';
import { formatMoney, parseLocalDateTime, parseLocalDay, toLocalIso } from './local-time.js';
import { clock } from './delay-notice.js';
import type {
  Appointment,
  AppointmentRepository,
  CatalogRepository,
  ClientDelayRepository,
  DelayNoticeRepository,
  ReminderScheduler,
  SalonService,
} from './ports.js';
import { reminderTime } from './reminder-time.js';

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 7;
const MAX_LISTED = 12;

export interface AgendaDeps {
  catalog: CatalogRepository;
  appointments: AppointmentRepository;
  reminders: ReminderScheduler;
  /** Avisos de atraso (spec 0014). Sem isso, a IA ignora o assunto. */
  delayNotices?: Pick<DelayNoticeRepository, 'latestSent' | 'confirmLatest'>;
  /** Atraso informado pela cliente (spec 0014, parte 2): grava e avisa a equipe numa nota privada. */
  clientDelays?: Pick<ClientDelayRepository, 'record'>;
  inbox?: { addPrivateNote(accountId: number, conversationId: number, note: string): Promise<void> };
  now: () => Date;
}

const describe = (a: Appointment, tz: string) =>
  `${a.serviceName} com ${a.professionalName}, ${formatLocal(a.startsAt, tz)}`;

const price = (s: SalonService) => (s.priceCents === null ? 'valor a combinar (não informe valor)' : formatMoney(s.priceCents));

/** Query: serviços do salão e quem faz cada um. */
export async function listServices(deps: AgendaDeps, ctx: ToolContext): Promise<string> {
  const services = await deps.catalog.listServices(ctx.tenantId);
  if (!services.length) return 'O salão ainda não cadastrou serviços. Transfira para a equipe.';
  const professionals = await deps.catalog.listProfessionals(ctx.tenantId);
  const lines = services.map((s) => {
    const who = professionals.filter((p) => p.serviceIds.includes(s.id));
    const names = who.length ? who.map((p) => `${p.name} (profissional_id ${p.id})`).join(', ') : 'sem profissional cadastrada';
    return `servico_id ${s.id}: ${s.name}, ${s.durationMin} min, ${price(s)}${s.description ? `. ${s.description}` : ''}. Quem faz: ${names}`;
  });
  return ['Serviços do salão:', ...lines].join('\n');
}

interface SlotQuery {
  serviceId: number;
  professionalId?: number | undefined;
  /** "2026-11-17"; sem data, olha os próximos 7 dias. */
  day?: string | undefined;
}

/** Query: horários livres de um serviço, com quem atende em cada um. */
export async function listFreeSlots(deps: AgendaDeps, ctx: ToolContext, q: SlotQuery): Promise<string> {
  const service = await deps.catalog.getService(ctx.tenantId, q.serviceId);
  if (!service) return 'Serviço não encontrado. Use listar_servicos para ver os serviços e seus ids.';

  const settings = await deps.catalog.settings(ctx.tenantId);
  const now = deps.now();
  let from = now;
  let to = new Date(now.getTime() + DEFAULT_WINDOW_DAYS * DAY);
  if (q.day) {
    const day = parseLocalDay(q.day, settings.timeZone);
    if (!day) return 'Data inválida. Use o formato AAAA-MM-DD, por exemplo 2026-11-17.';
    from = day.from;
    to = day.to;
  }

  const eligible = await deps.catalog.listProfessionals(ctx.tenantId, q.serviceId);
  const chosen = q.professionalId ? eligible.filter((p) => p.id === q.professionalId) : eligible;
  if (!chosen.length) {
    return q.professionalId
      ? 'Essa profissional não faz esse serviço (ou não existe). Use listar_servicos para ver quem faz cada serviço.'
      : 'Nenhuma profissional cadastrada para esse serviço. Transfira para a equipe.';
  }

  const schedules = await deps.catalog.loadSchedules(ctx.tenantId, chosen.map((p) => p.id), from, to);
  const free = computeFreeSlots({
    schedules,
    durationMin: service.durationMin,
    stepMin: settings.slotStepMin,
    from,
    to,
    now,
    minNoticeMin: settings.minNoticeMin,
    maxDaysAhead: settings.maxDaysAhead,
    timeZone: settings.timeZone,
  });

  if (!free.length) {
    return q.day
      ? `Não há horários livres de ${service.name} nesse dia. Ofereça outro dia ou transfira para a equipe.`
      : `Não há horários livres de ${service.name} nos próximos ${DEFAULT_WINDOW_DAYS} dias. Ofereça outra data (consulte_horarios com data) ou transfira para a equipe.`;
  }

  // Um horário por instante, com todas as profissionais livres nele.
  const byStart = new Map<number, string[]>();
  for (const s of free) {
    const name = chosen.find((p) => p.id === s.professionalId)!.name;
    byStart.set(s.startsAt.getTime(), [...(byStart.get(s.startsAt.getTime()) ?? []), name]);
  }
  const lines = [...byStart.entries()].slice(0, MAX_LISTED).map(([ms, names]) => {
    const at = new Date(ms);
    return `inicio ${toLocalIso(at, settings.timeZone)}: ${formatLocal(at, settings.timeZone)} (${names.join(', ')})`;
  });
  const more = byStart.size > MAX_LISTED ? ` Há mais horários além destes; peça um dia específico para ver os demais.` : '';
  return [`Horários livres de ${service.name} (${service.durationMin} min). Use o valor de "inicio" para agendar:`, ...lines].join('\n') + more;
}

/** Query: agendamentos futuros da pessoa. */
export async function listMine(deps: AgendaDeps, ctx: ToolContext): Promise<string> {
  if (!ctx.contact.phone) return 'Não há agendamentos para este contato.';
  const list = await deps.appointments.listUpcoming(ctx.tenantId, ctx.contact.phone, deps.now());
  if (!list.length) return 'A pessoa não tem agendamentos futuros.';
  const notices = new Map(
    (await deps.delayNotices?.latestSent(list.map((a) => a.id)))?.map((n) => [n.appointmentId, n] as const) ?? [],
  );
  return [
    'Agendamentos futuros:',
    ...list.map((a) => {
      const n = notices.get(a.id);
      // Só vale enquanto o início é o mesmo do aviso e a cliente ainda não respondeu.
      const pending = n && !n.response && n.originalStartsAt.getTime() === a.startsAt.getTime();
      const note = pending
        ? ` | AVISO DE ATRASO enviado pelo salão: atraso de ${n.delayMin} min, novo horário previsto ${clock(new Date(a.startsAt.getTime() + n.delayMin * 60_000), ctx.timeZone)}. Aguardando a cliente dizer se pode nesse horário ou prefere remarcar`
        : '';
      return `agendamento_id ${a.id}: ${describe(a, ctx.timeZone)}${note}`;
    }),
  ].join('\n');
}

/** Command: a cliente topou chegar no horário previsto do aviso de atraso. Não mexe na agenda. */
export async function confirmLateArrival(deps: AgendaDeps, ctx: ToolContext, appointmentId: number): Promise<string> {
  if (!deps.delayNotices || !ctx.contact.phone) return 'Não há aviso de atraso para este contato.';
  const mine = await deps.appointments.listUpcoming(ctx.tenantId, ctx.contact.phone, deps.now());
  if (!mine.some((a) => a.id === appointmentId)) return 'Agendamento não encontrado entre os da pessoa. Use meus_agendamentos.';
  const [notice] = await deps.delayNotices.latestSent([appointmentId]);
  if (!notice) return 'O salão não enviou aviso de atraso para este agendamento.';
  if (notice.response === 'chegara_depois') return 'Já está confirmado: a pessoa chega no horário previsto.';
  const ok = await deps.delayNotices.confirmLatest(appointmentId);
  if (!ok) return 'Não há aviso de atraso pendente para este agendamento.';
  return 'Confirmado. Agradeça e diga que a equipe espera a pessoa no horário previsto.';
}

export async function scheduleReminder(deps: AgendaDeps, a: Appointment, tz: string): Promise<void> {
  const at = reminderTime(a.startsAt, tz, deps.now());
  if (!at) return;
  const jobId = await deps.reminders.schedule(a.id, at);
  await deps.appointments.setReminderJob(a.id, jobId);
}

interface BookInput {
  serviceId: number;
  /** Sem profissional = qualquer uma livre. */
  professionalId?: number | undefined;
  start: string;
}

/** Command: agenda o serviço para a pessoa da conversa. */
export async function bookService(deps: AgendaDeps, ctx: ToolContext, input: BookInput): Promise<string> {
  if (!ctx.contact.phone) return 'Não foi possível agendar: o contato não tem telefone. Transfira para a equipe.';
  const settings = await deps.catalog.settings(ctx.tenantId);
  const startsAt = parseLocalDateTime(input.start, settings.timeZone);
  if (!startsAt) return 'Horário inválido. Use o valor de "inicio" que veio de consultar_horarios (AAAA-MM-DDTHH:MM).';

  const service = await deps.catalog.getService(ctx.tenantId, input.serviceId);
  if (!service) return 'Serviço não encontrado. Use listar_servicos.';

  const now = deps.now();
  const professionalIds = await candidates(deps, ctx, service, startsAt, input.professionalId, settings, now);
  if (!professionalIds.length) {
    return 'Esse horário não está disponível (fora do expediente, folga, já passou ou é muito em cima da hora). Consulte os horários de novo.';
  }

  let lastBusy = false;
  for (const professionalId of professionalIds) {
    const result = await deps.appointments.book({
      tenantId: ctx.tenantId,
      serviceId: service.id,
      professionalId,
      startsAt,
      contact: { phone: ctx.contact.phone, chatwootContactId: ctx.contact.chatwootContactId, name: ctx.contact.name },
      conversation: { accountId: ctx.accountId, conversationId: ctx.conversationId },
      source: 'ia',
      now,
    });
    switch (result.kind) {
      case 'booked': {
        await scheduleReminder(deps, result.appointment, ctx.timeZone);
        const value = service.priceCents === null ? '' : ` Valor: ${formatMoney(service.priceCents)}.`;
        return `Agendado (agendamento_id ${result.appointment.id}): ${describe(result.appointment, ctx.timeZone)}, ${service.durationMin} min.${value} Confirme com a pessoa e lembre de chegar uns 5 minutos antes.`;
      }
      case 'already_booked':
        return `Esse horário já estava agendado para a pessoa (agendamento_id ${result.appointment.id}): ${describe(result.appointment, ctx.timeZone)}.`;
      case 'client_busy':
        return `A pessoa já tem outro agendamento nesse horário (agendamento_id ${result.appointment.id}): ${describe(result.appointment, ctx.timeZone)}. Ofereça outro horário ou remarque o existente.`;
      case 'busy':
        lastBusy = true;
        continue; // tenta a próxima profissional, se a pessoa aceitou qualquer uma
      case 'not_available':
        return 'Esse horário não está disponível. Consulte os horários de novo e ofereça outro.';
    }
  }
  return lastBusy ? 'Esse horário acabou de ser ocupado. Consulte os horários de novo e ofereça outro.' : 'Não foi possível agendar. Consulte os horários de novo.';
}

/** Profissionais a tentar, em ordem. Com profissional pedida, só ela; sem, as livres naquele instante (menos carregadas primeiro). */
async function candidates(
  deps: AgendaDeps,
  ctx: ToolContext,
  service: SalonService,
  startsAt: Date,
  professionalId: number | undefined,
  settings: Awaited<ReturnType<CatalogRepository['settings']>>,
  now: Date,
): Promise<number[]> {
  if (professionalId) return [professionalId];

  const eligible = await deps.catalog.listProfessionals(ctx.tenantId, service.id);
  if (!eligible.length) return [];
  const ids = eligible.map((p) => p.id);
  const schedules = await deps.catalog.loadSchedules(ctx.tenantId, ids, startsAt, new Date(startsAt.getTime() + 1));
  const free: FreeSlot[] = computeFreeSlots({
    schedules,
    durationMin: service.durationMin,
    stepMin: settings.slotStepMin,
    from: startsAt,
    to: new Date(startsAt.getTime() + 1),
    now,
    minNoticeMin: settings.minNoticeMin,
    maxDaysAhead: settings.maxDaysAhead,
    timeZone: settings.timeZone,
  }).filter((s) => s.startsAt.getTime() === startsAt.getTime());
  if (!free.length) return [];

  const dayStart = new Date(startsAt.getTime() - 12 * 60 * 60 * 1000);
  const dayEnd = new Date(startsAt.getTime() + 12 * 60 * 60 * 1000);
  const loads = await deps.catalog.dayLoads(ctx.tenantId, free.map((s) => s.professionalId), dayStart, dayEnd);
  const pool = free.map((s) => ({ professionalId: s.professionalId, dayLoad: loads.get(s.professionalId) ?? 0 }));
  const ordered: number[] = [];
  while (pool.length) {
    const id = pickProfessional(pool)!;
    ordered.push(id);
    pool.splice(pool.findIndex((c) => c.professionalId === id), 1);
  }
  return ordered;
}

/** Command: muda o horário (e, se pedido, a profissional) de um agendamento da pessoa. */
export async function rescheduleAppointment(
  deps: AgendaDeps,
  ctx: ToolContext,
  input: { appointmentId: number; start: string; professionalId?: number | undefined },
): Promise<string> {
  if (!ctx.contact.phone) return 'Não há agendamento para este contato.';
  const startsAt = parseLocalDateTime(input.start, ctx.timeZone);
  if (!startsAt) return 'Horário inválido. Use o valor de "inicio" que veio de consultar_horarios (AAAA-MM-DDTHH:MM).';

  const result = await deps.appointments.reschedule({
    tenantId: ctx.tenantId,
    appointmentId: input.appointmentId,
    phone: ctx.contact.phone,
    startsAt,
    ...(input.professionalId ? { professionalId: input.professionalId } : {}),
    now: deps.now(),
  });

  switch (result.kind) {
    case 'rescheduled':
      if (result.reminderJobId) await deps.reminders.cancel(result.reminderJobId);
      await scheduleReminder(deps, result.appointment, ctx.timeZone);
      return `Remarcado (agendamento_id ${result.appointment.id}): ${describe(result.appointment, ctx.timeZone)}. O horário anterior foi liberado.`;
    case 'unchanged':
      return `O agendamento já está nesse horário: ${describe(result.appointment, ctx.timeZone)}.`;
    case 'busy':
      return 'Esse horário está ocupado. O agendamento original continua valendo. Consulte os horários e ofereça outro.';
    case 'client_busy':
      return `A pessoa já tem outro agendamento que bate com esse horário (agendamento_id ${result.appointment.id}). O original continua valendo.`;
    case 'not_available':
      return 'Esse horário não está disponível. O agendamento original continua valendo. Consulte os horários de novo.';
    case 'not_found':
      return 'Não encontrei esse agendamento futuro para a pessoa. Use meus_agendamentos para ver os ids.';
  }
}

/** Command: cancela um agendamento da pessoa. */
export async function cancelAppointment(deps: AgendaDeps, ctx: ToolContext, appointmentId: number): Promise<string> {
  if (!ctx.contact.phone) return 'Não há agendamento para este contato.';
  const result = await deps.appointments.cancel(ctx.tenantId, appointmentId, ctx.contact.phone, deps.now());
  if (result.kind === 'not_found') return 'Não encontrei esse agendamento futuro para a pessoa. Use meus_agendamentos para ver os ids.';
  if (result.reminderJobId) await deps.reminders.cancel(result.reminderJobId);
  return `Cancelado: ${describe(result.appointment, ctx.timeZone)}. O horário foi liberado.`;
}

export const CLIENT_DELAY_MAX_MIN = 60;
/** Command: a cliente avisa que vai se atrasar. Registra, avisa a equipe e não mexe na agenda. */
export async function reportClientDelay(
  deps: AgendaDeps,
  ctx: ToolContext,
  input: { appointmentId: number; delayMin: number },
): Promise<string> {
  if (!deps.clientDelays || !ctx.contact.phone) return 'Não foi possível registrar o atraso. Transfira para a equipe.';
  if (input.delayMin < 5 || input.delayMin > CLIENT_DELAY_MAX_MIN) {
    return `Atraso acima de ${CLIENT_DELAY_MAX_MIN} minutos: ofereça remarcar (consultar_horarios e remarcar_agendamento) ou transfira para a equipe.`;
  }
  const now = deps.now();
  const tolerance = (await deps.catalog.settings(ctx.tenantId)).lateToleranceMin;
  const mine = await deps.appointments.listUpcoming(ctx.tenantId, ctx.contact.phone, new Date(now.getTime() - 30 * 60_000));
  const a = mine.find((x) => x.id === input.appointmentId);
  if (!a) return 'Agendamento não encontrado entre os da pessoa. Use meus_agendamentos.';
  const untilStart = a.startsAt.getTime() - now.getTime();
  if (untilStart > 6 * 3_600_000) return 'Esse agendamento ainda está longe. Não precisa avisar atraso agora.';

  const expected = clock(new Date(a.startsAt.getTime() + input.delayMin * 60_000), ctx.timeZone);
  const fresh = await deps.clientDelays.record(ctx.tenantId, a.id, input.delayMin, now);
  if (fresh && deps.inbox) {
    await deps.inbox.addPrivateNote(
      ctx.accountId,
      ctx.conversationId,
      `Cliente avisou atraso: ${describe(a, ctx.timeZone)} (agendamento ${a.id}). Atraso de ${input.delayMin} min, chega por volta das ${expected} (${input.delayMin <= tolerance ? `dentro da tolerância de ${tolerance} min, horário mantido` : `passa da tolerância de ${tolerance} min, a equipe decide`}).`,
    );
  }
  if (input.delayMin <= tolerance) {
    return `Atraso de ${input.delayMin} min registrado, dentro da tolerância do salão (${tolerance} min): o horário está mantido e a equipe foi avisada (chegada prevista ${expected}). Diga que o horário está mantido e que ela pode vir com calma, sem passar de ${tolerance} minutos.`;
  }
  return `Atraso de ${input.delayMin} min registrado e a equipe foi avisada, mas passa da tolerância de ${tolerance} min. Não prometa manter o horário: explique que a equipe vai avaliar se consegue atender e pergunte se ela prefere remarcar (consultar_horarios e remarcar_agendamento).`;
}
