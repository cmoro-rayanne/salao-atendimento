import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/modules/agent/ports.js';
import { bookService, rescheduleAppointment, type AgendaDeps } from '../src/modules/appointments/agenda.js';
import { InMemoryAgenda } from '../src/modules/appointments/in-memory.js';
import type { ReminderSender } from '../src/modules/appointments/ports.js';
import { sendAppointmentReminder } from '../src/modules/appointments/send-reminder.js';
import { ChatwootGateway } from '../src/adapters/chatwoot/chatwoot-gateway.js';
import type { ChatwootClient } from '../src/adapters/chatwoot/chatwoot-client.js';

const TZ = 'America/Sao_Paulo';
const PHONE = '+5541999990000';
const NOW = new Date('2026-11-16T14:00:00-03:00');
const ctx: ToolContext = {
  tenantId: 1,
  timeZone: TZ,
  accountId: 1,
  conversationId: 77,
  contact: { chatwootContactId: 5, phone: PHONE, name: 'Ana Souza' },
};

let agenda: InMemoryAgenda;
let sent: Array<{ accountId: number; conversationId: number; params: Record<string, string> }>;
let sender: ReminderSender;
let deps: AgendaDeps;
let now: Date;

beforeEach(() => {
  now = NOW;
  agenda = new InMemoryAgenda();
  const corte = agenda.addService({ name: 'Corte', durationMin: 60, priceCents: 8000 }).id;
  agenda.addProfessional('Bia', [corte], [{ weekday: 2, startMin: 9 * 60, endMin: 18 * 60 }]);
  sent = [];
  sender = {
    sendAppointmentReminder: async (accountId, conversationId, params) => void sent.push({ accountId, conversationId, params }),
  };
  deps = { catalog: agenda, appointments: agenda, reminders: { schedule: async () => 'job', cancel: async () => {} }, now: () => NOW };
});

const book = () => bookService(deps, ctx, { serviceId: 1, professionalId: 1, start: '2026-11-17T10:00' });
const run = () => sendAppointmentReminder({ appointments: agenda, sender, now: () => now }, 1);

describe('lembrete de agendamento', () => {
  it('envia com nome, serviço, profissional e horário no fuso do salão', async () => {
    await book();
    expect(await run()).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ accountId: 1, conversationId: 77 });
    expect(sent[0]!.params).toMatchObject({ name: 'Ana', service: 'Corte', professional: 'Bia' });
    expect(sent[0]!.params.when).toContain('10:00');
  });

  it('não envia duas vezes', async () => {
    await book();
    expect(await run()).toBe('sent');
    expect(await run()).toBe('skipped_already_sent');
    expect(sent).toHaveLength(1);
  });

  it('ignora agendamento cancelado, inexistente ou já passado', async () => {
    await book();
    await agenda.cancel(1, 1, PHONE, NOW);
    expect(await run()).toBe('skipped_inactive');

    expect(await sendAppointmentReminder({ appointments: agenda, sender, now: () => now }, 999)).toBe('skipped_inactive');

    agenda = new InMemoryAgenda();
    agenda.addService({ name: 'Corte', durationMin: 60, priceCents: null });
    agenda.addProfessional('Bia', [1], [{ weekday: 2, startMin: 9 * 60, endMin: 18 * 60 }]);
    deps = { ...deps, catalog: agenda, appointments: agenda };
    await book();
    now = new Date('2026-11-17T11:00:00-03:00');
    expect(await run()).toBe('skipped_inactive');
    expect(sent).toHaveLength(0);
  });

  it('respeita quem pediu para não receber mensagens', async () => {
    await book();
    agenda.optedOut.add(PHONE);
    expect(await run()).toBe('skipped_opted_out');
    expect(sent).toHaveLength(0);
  });

  it('desmarca o envio se a mensagem falhar, para a retentativa conseguir mandar', async () => {
    await book();
    const failing: ReminderSender = {
      sendAppointmentReminder: async () => {
        throw new Error('Meta fora do ar');
      },
    };
    await expect(sendAppointmentReminder({ appointments: agenda, sender: failing, now: () => now }, 1)).rejects.toThrow('Meta');
    expect(await run()).toBe('sent');
  });

  it('remarcar libera um novo lembrete', async () => {
    await book();
    expect(await run()).toBe('sent');
    await rescheduleAppointment(deps, ctx, { appointmentId: 1, start: '2026-11-17T14:00' });
    expect(await run()).toBe('sent');
    expect(sent).toHaveLength(2);
  });
});

describe('ChatwootGateway.sendAppointmentReminder', () => {
  it('envia o template de agendamento com os 4 parâmetros', async () => {
    const calls: unknown[][] = [];
    const client = { sendTemplate: async (...a: unknown[]) => void calls.push(a) } as unknown as ChatwootClient;
    await new ChatwootGateway(client).sendAppointmentReminder(1, 77, {
      name: 'Ana',
      service: 'Corte',
      professional: 'Bia',
      when: 'terça, 17/11 às 10:00',
    });
    expect(calls).toHaveLength(1);
    const payload = calls[0]![2] as { name: string; params: string[]; content: string };
    expect(payload.name).toBe('lembrete_agendamento');
    expect(payload.params).toEqual(['Ana', 'Corte', 'Bia', 'terça, 17/11 às 10:00']);
    expect(payload.content).toContain('Corte com Bia');
  });
});
