import { describe, expect, it } from 'vitest';
import { ChatwootGateway, DEFAULT_REMINDER_BODY } from '../src/adapters/chatwoot/chatwoot-gateway.js';
import type { ChatwootClient } from '../src/adapters/chatwoot/chatwoot-client.js';
import type { ToolContext } from '../src/modules/agent/ports.js';
import { bookTrialClass, cancelTrialClass, listAvailableSlots, type BookingDeps } from '../src/modules/trial-classes/booking.js';
import type { BookingRepository, BookResult, ReminderInfo, TrialSlot } from '../src/modules/trial-classes/ports.js';
import { reminderTime } from '../src/modules/trial-classes/reminder-time.js';
import { sendTrialReminder } from '../src/modules/trial-classes/send-reminder.js';
import { zonedTimeToUtc } from '../src/shared/time-zone.js';

const TZ = 'America/Sao_Paulo';
const NOW = new Date('2026-11-16T14:00:00-03:00'); // segunda, 14h

const ctx: ToolContext = {
  tenantId: 1,
  timeZone: TZ,
  accountId: 1,
  conversationId: 77,
  contact: { chatwootContactId: 5, phone: '+5541999990000', name: 'Ana Souza' },
};

function deps(over: Partial<BookingRepository> = {}) {
  const scheduled: Array<{ bookingId: number; at: Date }> = [];
  const cancelled: string[] = [];
  const jobs: Array<[number, string | null]> = [];
  const repo: BookingRepository = {
    listAvailable: async () => [],
    book: async () => ({ kind: 'not_available' }),
    setReminderJob: async (id, job) => {
      jobs.push([id, job]);
    },
    cancelActive: async () => ({ kind: 'none' }),
    getForReminder: async () => null,
    markReminderSent: async () => true,
    clearReminderSent: async () => {},
    ...over,
  };
  const d: BookingDeps = {
    bookings: repo,
    now: () => NOW,
    reminders: {
      schedule: async (bookingId, at) => {
        scheduled.push({ bookingId, at });
        return `job-${bookingId}`;
      },
      cancel: async (id) => {
        cancelled.push(id);
      },
    },
  };
  return { d, scheduled, cancelled, jobs };
}

describe('fuso horário', () => {
  it('converte horário de parede de São Paulo para UTC', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 11, day: 16, hour: 18, minute: 0 }, TZ).toISOString()).toBe(
      '2026-11-16T21:00:00.000Z',
    );
  });
});

describe('reminderTime', () => {
  it('véspera às 18h no fuso da academia', () => {
    const at = reminderTime(new Date('2026-11-18T08:00:00-03:00'), TZ, NOW);
    expect(at?.toISOString()).toBe(new Date('2026-11-17T18:00:00-03:00').toISOString());
  });

  it('se a véspera já passou, 3h antes', () => {
    const at = reminderTime(new Date('2026-11-17T08:00:00-03:00'), TZ, new Date('2026-11-16T19:00:00-03:00'));
    expect(at?.toISOString()).toBe(new Date('2026-11-17T05:00:00-03:00').toISOString());
  });

  it('sem lembrete quando falta menos de 3h', () => {
    expect(reminderTime(new Date('2026-11-16T16:30:00-03:00'), TZ, NOW)).toBeNull();
  });
});

describe('listar horários', () => {
  it('formata no fuso da academia, com vagas livres e o id para agendar', async () => {
    let window: [Date, Date] | null = null;
    const slots: TrialSlot[] = [{ id: 12, modality: 'Pilates', startsAt: new Date('2026-11-17T18:00:00-03:00'), capacity: 4, booked: 3 }];
    const { d } = deps({
      listAvailable: async (_t, from, to) => {
        window = [from, to];
        return slots;
      },
    });
    const text = await listAvailableSlots(d, ctx);
    expect(text).toContain('horario_id 12: Pilates, terça-feira, 17/11, 18:00 (1 vaga)');
    expect(window![0].getTime() - NOW.getTime()).toBe(60 * 60 * 1000); // pelo menos 1h de antecedência
  });

  it('sem horários orienta a transferir', async () => {
    const { d } = deps();
    expect(await listAvailableSlots(d, ctx)).toContain('Transfira');
  });
});

describe('agendar', () => {
  const booked = { bookingId: 9, slotId: 12, modality: 'Pilates', startsAt: new Date('2026-11-18T08:00:00-03:00') };

  it('agenda, agenda o lembrete na véspera e guarda o id do job', async () => {
    let request: Parameters<BookingRepository['book']>[0] | null = null;
    const { d, scheduled, jobs } = deps({
      book: async (req) => {
        request = req;
        return { kind: 'booked', booking: booked };
      },
    });
    const text = await bookTrialClass(d, ctx, 12);

    expect(text).toContain('Agendado: Pilates, quarta-feira, 18/11, 08:00');
    expect(request).toMatchObject({ tenantId: 1, slotId: 12, conversation: { accountId: 1, conversationId: 77 } });
    expect(scheduled).toEqual([{ bookingId: 9, at: new Date('2026-11-17T18:00:00-03:00') }]);
    expect(jobs).toEqual([[9, 'job-9']]);
  });

  it.each<[BookResult, string]>([
    [{ kind: 'already_booked', booking: booked }, 'já estava agendada'],
    [{ kind: 'has_other', booking: booked }, 'cancelar_experimental'],
    [{ kind: 'full' }, 'lotar'],
    [{ kind: 'not_available' }, 'não está disponível'],
  ])('%o não agenda lembrete', async (result, expected) => {
    const { d, scheduled } = deps({ book: async () => result });
    expect(await bookTrialClass(d, ctx, 12)).toContain(expected);
    expect(scheduled).toHaveLength(0);
  });

  it('sem telefone não agenda', async () => {
    const { d } = deps({
      book: async () => {
        throw new Error('não deveria chamar');
      },
    });
    expect(await bookTrialClass(d, { ...ctx, contact: { ...ctx.contact, phone: null } }, 12)).toContain('Transfira');
  });
});

describe('cancelar', () => {
  it('cancela e remove o lembrete', async () => {
    const { d, cancelled } = deps({
      cancelActive: async () => ({
        kind: 'cancelled',
        booking: { bookingId: 9, slotId: 12, modality: 'Pilates', startsAt: new Date('2026-11-18T08:00:00-03:00') },
        reminderJobId: 'job-9',
      }),
    });
    expect(await cancelTrialClass(d, ctx)).toContain('Cancelado');
    expect(cancelled).toEqual(['job-9']);
  });
});

describe('enviar lembrete', () => {
  const info: ReminderInfo = {
    bookingId: 9,
    status: 'agendada',
    reminderSentAt: null,
    startsAt: new Date('2026-11-18T08:00:00-03:00'),
    modality: 'Pilates',
    leadName: 'Ana Souza',
    optedOut: false,
    accountId: 1,
    conversationId: 77,
    timeZone: TZ,
  };

  function sender() {
    const sent: unknown[] = [];
    return { sent, sendTrialReminder: async (...args: unknown[]) => void sent.push(args) };
  }

  it('envia com o primeiro nome e marca como enviado', async () => {
    const s = sender();
    const { d } = deps({ getForReminder: async () => info });
    expect(await sendTrialReminder({ bookings: d.bookings, sender: s, now: () => NOW }, 9)).toBe('sent');
    expect(s.sent).toEqual([[1, 77, { name: 'Ana', modality: 'Pilates', when: 'quarta-feira, 18/11, 08:00' }]]);
  });

  it('não envia para reserva cancelada, já enviada ou de aula que já passou', async () => {
    for (const over of [
      { status: 'cancelada' },
      { reminderSentAt: NOW },
      { startsAt: new Date('2026-11-16T10:00:00-03:00') },
      { optedOut: true },
    ]) {
      const s = sender();
      const { d } = deps({ getForReminder: async () => ({ ...info, ...over }) });
      expect(await sendTrialReminder({ bookings: d.bookings, sender: s, now: () => NOW }, 9)).toMatch(/^skipped/);
      expect(s.sent).toHaveLength(0);
    }
  });

  it('se o envio falha, desmarca para a fila tentar de novo', async () => {
    let cleared = false;
    const { d } = deps({
      getForReminder: async () => info,
      clearReminderSent: async () => {
        cleared = true;
      },
    });
    const failing = {
      sendTrialReminder: async () => {
        throw new Error('Chatwoot fora');
      },
    };
    await expect(sendTrialReminder({ bookings: d.bookings, sender: failing, now: () => NOW }, 9)).rejects.toThrow();
    expect(cleared).toBe(true);
  });

  it('template do Chatwoot: parâmetros na ordem e texto preenchido', async () => {
    const calls: unknown[] = [];
    const client = { sendTemplate: async (...a: unknown[]) => void calls.push(a) } as unknown as ChatwootClient;
    await new ChatwootGateway(client, { name: 'lembrete', language: 'pt_BR', body: DEFAULT_REMINDER_BODY }).sendTrialReminder(
      1,
      77,
      { name: 'Ana', modality: 'Pilates', when: 'quarta-feira, 18/11, 08:00' },
    );
    expect(calls[0]).toEqual([
      1,
      77,
      {
        name: 'lembrete',
        language: 'pt_BR',
        category: 'UTILITY',
        params: ['Ana', 'Pilates', 'quarta-feira, 18/11, 08:00'],
        content: 'Olá, Ana! Lembrete da sua aula experimental de Pilates: quarta-feira, 18/11, 08:00. Se precisar remarcar, é só responder aqui.',
      },
    ]);
  });
});
