import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/modules/agent/ports.js';
import {
  bookService,
  cancelAppointment,
  listFreeSlots,
  listMine,
  listServices,
  rescheduleAppointment,
  type AgendaDeps,
} from '../src/modules/appointments/agenda.js';
import { InMemoryAgenda } from '../src/modules/appointments/in-memory.js';
import { parseLocalDateTime, parseLocalDay, toLocalIso } from '../src/modules/appointments/local-time.js';
import { buildTools } from '../src/modules/agent/tools.js';

const TZ = 'America/Sao_Paulo';
const NOW = new Date('2026-11-16T14:00:00-03:00'); // segunda 14h

const ctx: ToolContext = {
  tenantId: 1,
  timeZone: TZ,
  accountId: 1,
  conversationId: 77,
  contact: { chatwootContactId: 5, phone: '+5541999990000', name: 'Ana Souza' },
};

const tuesday = [2].flatMap((weekday) => [
  { weekday, startMin: 9 * 60, endMin: 12 * 60 },
  { weekday, startMin: 13 * 60, endMin: 18 * 60 },
]);

let agenda: InMemoryAgenda;
let jobs: Array<{ appointmentId: number; at: Date }>;
let cancelledJobs: string[];
let deps: AgendaDeps;
let corte: number;
let escova: number;

beforeEach(() => {
  agenda = new InMemoryAgenda();
  corte = agenda.addService({ name: 'Corte', durationMin: 60, priceCents: 8000 }).id;
  escova = agenda.addService({ name: 'Escova', durationMin: 30, priceCents: null, description: 'Escova modelada' }).id;
  agenda.addProfessional('Ana', [corte], tuesday);
  agenda.addProfessional('Bia', [corte, escova], tuesday);
  jobs = [];
  cancelledJobs = [];
  deps = {
    catalog: agenda,
    appointments: agenda,
    reminders: {
      schedule: async (appointmentId, at) => {
        jobs.push({ appointmentId, at });
        return `job-${appointmentId}`;
      },
      cancel: async (id) => {
        cancelledJobs.push(id);
      },
    },
    now: () => NOW,
  };
});

describe('fuso do salão', () => {
  it('converte "AAAA-MM-DDTHH:MM" e volta igual', () => {
    const d = parseLocalDateTime('2026-11-17T10:00', TZ)!;
    expect(d.toISOString()).toBe('2026-11-17T13:00:00.000Z');
    expect(toLocalIso(d, TZ)).toBe('2026-11-17T10:00');
  });
  it('recusa data inexistente e formato errado', () => {
    expect(parseLocalDateTime('2026-02-31T10:00', TZ)).toBeNull();
    expect(parseLocalDateTime('2026-11-17T25:00', TZ)).toBeNull();
    expect(parseLocalDateTime('17/11 10h', TZ)).toBeNull();
    expect(parseLocalDay('amanhã', TZ)).toBeNull();
  });
  it('dia local tem 24 h', () => {
    const d = parseLocalDay('2026-11-17', TZ)!;
    expect(d.to.getTime() - d.from.getTime()).toBe(24 * 3600 * 1000);
  });
});

describe('listar serviços', () => {
  it('mostra duração, valor, "a combinar" e quem faz', async () => {
    const out = await listServices(deps, ctx);
    expect(out).toContain('Corte, 60 min, R$');
    expect(out).toContain('80,00');
    expect(out).toContain('Quem faz: Ana (profissional_id 1), Bia (profissional_id 2)');
    expect(out).toContain('valor a combinar (não informe valor)');
    expect(out).toContain('Escova modelada');
  });
  it('sem serviços cadastrados, manda transferir', async () => {
    expect(await listServices({ ...deps, catalog: new InMemoryAgenda() }, ctx)).toContain('Transfira');
  });
});

describe('consultar horários', () => {
  it('lista horários com as profissionais livres e o "inicio" para agendar', async () => {
    const out = await listFreeSlots(deps, ctx, { serviceId: corte });
    expect(out).toContain('inicio 2026-11-17T09:00');
    expect(out).toContain('(Ana, Bia)');
    expect(out.split('\n').length).toBeLessThanOrEqual(14);
  });
  it('filtra por profissional e por dia', async () => {
    const out = await listFreeSlots(deps, ctx, { serviceId: corte, professionalId: 1, day: '2026-11-17' });
    expect(out).toContain('(Ana)');
    expect(out).not.toContain('Bia');
  });
  it('profissional que não faz o serviço e serviço inexistente', async () => {
    expect(await listFreeSlots(deps, ctx, { serviceId: escova, professionalId: 1 })).toContain('não faz esse serviço');
    expect(await listFreeSlots(deps, ctx, { serviceId: 99 })).toContain('Serviço não encontrado');
  });
  it('data inválida e dia sem horário', async () => {
    expect(await listFreeSlots(deps, ctx, { serviceId: corte, day: '17/11' })).toContain('Data inválida');
    expect(await listFreeSlots(deps, ctx, { serviceId: corte, day: '2026-11-18' })).toContain('Não há horários livres');
  });
  it('horário já ocupado some da lista da profissional', async () => {
    await bookService(deps, ctx, { serviceId: corte, professionalId: 1, start: '2026-11-17T09:00' });
    const out = await listFreeSlots(deps, ctx, { serviceId: corte, professionalId: 1, day: '2026-11-17' });
    expect(out).not.toContain('inicio 2026-11-17T09:00');
    expect(out).toContain('inicio 2026-11-17T10:00');
  });
});

describe('agendar', () => {
  it('agenda com a profissional pedida, informa valor e agenda o lembrete', async () => {
    const out = await bookService(deps, ctx, { serviceId: corte, professionalId: 2, start: '2026-11-17T10:00' });
    expect(out).toContain('Agendado (agendamento_id 1)');
    expect(out).toContain('Corte com Bia');
    expect(out).toContain('R$');
    expect(jobs).toHaveLength(1);
    // véspera às 18h, fuso do salão
    expect(jobs[0]!.at.toISOString()).toBe('2026-11-16T21:00:00.000Z');
  });

  it('não informa valor quando o serviço é "a combinar"', async () => {
    const out = await bookService(deps, ctx, { serviceId: escova, professionalId: 2, start: '2026-11-17T10:00' });
    expect(out).toContain('Agendado');
    expect(out).not.toContain('R$');
  });

  it('"qualquer profissional" escolhe quem tem menos agendamentos no dia', async () => {
    const other = { ...ctx, contact: { ...ctx.contact, phone: '+5541999991111', chatwootContactId: 6 } };
    await bookService(deps, other, { serviceId: corte, professionalId: 1, start: '2026-11-17T09:00' }); // Ana já tem 1
    const out = await bookService(deps, ctx, { serviceId: corte, start: '2026-11-17T14:00' });
    expect(out).toContain('Corte com Bia');
  });

  it('"qualquer profissional" usa a outra quando uma está ocupada no horário', async () => {
    const other = { ...ctx, contact: { ...ctx.contact, phone: '+5541999991111', chatwootContactId: 6 } };
    await bookService(deps, other, { serviceId: corte, professionalId: 1, start: '2026-11-17T10:00' });
    await bookService(deps, other, { serviceId: corte, professionalId: 2, start: '2026-11-17T15:00' });
    const out = await bookService(deps, ctx, { serviceId: corte, start: '2026-11-17T10:00' });
    expect(out).toContain('Corte com Bia');
  });

  it('horário ocupado para a profissional pedida pede nova consulta', async () => {
    const other = { ...ctx, contact: { ...ctx.contact, phone: '+5541999991111', chatwootContactId: 6 } };
    await bookService(deps, other, { serviceId: corte, professionalId: 1, start: '2026-11-17T10:00' });
    const out = await bookService(deps, ctx, { serviceId: corte, professionalId: 1, start: '2026-11-17T10:00' });
    expect(out).toContain('acabou de ser ocupado');
  });

  it('todas ocupadas no horário: "não está disponível" para quem aceita qualquer uma', async () => {
    const other = { ...ctx, contact: { ...ctx.contact, phone: '+5541999991111', chatwootContactId: 6 } };
    await bookService(deps, other, { serviceId: corte, professionalId: 1, start: '2026-11-17T10:00' });
    const third = { ...ctx, contact: { ...ctx.contact, phone: '+5541999992222', chatwootContactId: 7 } };
    await bookService(deps, third, { serviceId: corte, professionalId: 2, start: '2026-11-17T10:00' });
    expect(await bookService(deps, ctx, { serviceId: corte, start: '2026-11-17T10:00' })).toContain('não está disponível');
  });

  it('repetir o pedido não duplica', async () => {
    await bookService(deps, ctx, { serviceId: corte, professionalId: 1, start: '2026-11-17T10:00' });
    const out = await bookService(deps, ctx, { serviceId: corte, professionalId: 1, start: '2026-11-17T10:00' });
    expect(out).toContain('já estava agendado');
    expect((await agenda.listUpcoming(1, ctx.contact.phone!, NOW)).length).toBe(1);
  });

  it('recusa fora do expediente, horário inválido, serviço que a profissional não faz e contato sem telefone', async () => {
    expect(await bookService(deps, ctx, { serviceId: corte, professionalId: 1, start: '2026-11-17T08:00' })).toContain('não está disponível');
    expect(await bookService(deps, ctx, { serviceId: corte, professionalId: 1, start: 'amanhã 10h' })).toContain('Horário inválido');
    expect(await bookService(deps, ctx, { serviceId: escova, professionalId: 1, start: '2026-11-17T10:00' })).toContain('não está disponível');
    expect(await bookService(deps, { ...ctx, contact: { ...ctx.contact, phone: null } }, { serviceId: corte, start: '2026-11-17T10:00' })).toContain('não tem telefone');
  });

  it('a mesma pessoa não marca dois serviços ao mesmo tempo', async () => {
    await bookService(deps, ctx, { serviceId: corte, professionalId: 1, start: '2026-11-17T10:00' });
    expect(await bookService(deps, ctx, { serviceId: escova, professionalId: 2, start: '2026-11-17T10:30' })).toContain('já tem outro agendamento');
  });
});

describe('meus agendamentos, remarcar e cancelar', () => {
  beforeEach(async () => {
    await bookService(deps, ctx, { serviceId: corte, professionalId: 1, start: '2026-11-17T10:00' });
  });

  it('lista os agendamentos futuros com ids', async () => {
    const out = await listMine(deps, ctx);
    expect(out).toContain('agendamento_id 1: Corte com Ana');
    expect(await listMine(deps, { ...ctx, contact: { ...ctx.contact, phone: '+5541000000000' } })).toContain('não tem agendamentos');
  });

  it('remarcar troca o horário, cancela o lembrete antigo e agenda outro', async () => {
    const out = await rescheduleAppointment(deps, ctx, { appointmentId: 1, start: '2026-11-17T15:00' });
    expect(out).toContain('Remarcado');
    expect(cancelledJobs).toEqual(['job-1']);
    expect(jobs).toHaveLength(2);
    expect(await listMine(deps, ctx)).toContain('15:00');
  });

  it('remarcar para horário ocupado mantém o original', async () => {
    const other = { ...ctx, contact: { ...ctx.contact, phone: '+5541999991111', chatwootContactId: 6 } };
    await bookService(deps, other, { serviceId: corte, professionalId: 1, start: '2026-11-17T15:00' });
    const out = await rescheduleAppointment(deps, ctx, { appointmentId: 1, start: '2026-11-17T15:00' });
    expect(out).toContain('ocupado');
    expect(await listMine(deps, ctx)).toContain('10:00');
    expect(cancelledJobs).toEqual([]);
  });

  it('remarcar e cancelar só valem para agendamentos da própria pessoa', async () => {
    const stranger = { ...ctx, contact: { ...ctx.contact, phone: '+5541000000000' } };
    expect(await rescheduleAppointment(deps, stranger, { appointmentId: 1, start: '2026-11-17T15:00' })).toContain('Não encontrei');
    expect(await cancelAppointment(deps, stranger, 1)).toContain('Não encontrei');
    expect(await listMine(deps, ctx)).toContain('agendamento_id 1');
  });

  it('cancelar libera o horário e remove o lembrete', async () => {
    expect(await cancelAppointment(deps, ctx, 1)).toContain('Cancelado');
    expect(cancelledJobs).toEqual(['job-1']);
    const other = { ...ctx, contact: { ...ctx.contact, phone: '+5541999991111', chatwootContactId: 6 } };
    expect(await bookService(deps, other, { serviceId: corte, professionalId: 1, start: '2026-11-17T10:00' })).toContain('Agendado');
    expect(await cancelAppointment(deps, ctx, 1)).toContain('Não encontrei');
  });
});

describe('ferramentas do agente', () => {
  it('expõe as ferramentas do salão e nenhuma da academia', () => {
    const names = buildTools({
      leads: { upsertByPhone: async () => ({ id: 1, created: true }), setOptOut: async () => {} },
      handoff: { inbox: { addPrivateNote: async () => {}, assignToTeam: async () => {} }, handoffs: { record: async () => {} } },
      agenda: deps,
    }).map((t) => t.spec.name);
    expect(names).toEqual([
      'registrar_lead',
      'listar_servicos',
      'consultar_horarios',
      'meus_agendamentos',
    'confirmar_chegada_atrasada',
    'avisar_atraso_cliente',
      'agendar_servico',
      'remarcar_agendamento',
      'cancelar_agendamento',
      'transferir_para_humano',
    ]);
  });
});
