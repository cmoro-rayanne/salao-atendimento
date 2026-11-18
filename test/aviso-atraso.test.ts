import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/modules/agent/ports.js';
import { bookService, confirmLateArrival, listMine, reportClientDelay, rescheduleAppointment, type AgendaDeps } from '../src/modules/appointments/agenda.js';
import { delayStatus, requestDelayNotice, sendDelayNotice, type RequestDelayDeps } from '../src/modules/appointments/delay-notice.js';
import { InMemoryAgenda } from '../src/modules/appointments/in-memory.js';

const TZ = 'America/Sao_Paulo';
const PHONE = '+5541999990000';
const BOOKED_AT = new Date('2026-11-16T14:00:00-03:00');
// Terça, 17/11: o salão está atrasado e a cliente tem horário às 10:00.
const NOW = new Date('2026-11-17T09:30:00-03:00');
const ctx: ToolContext = {
  tenantId: 1,
  timeZone: TZ,
  accountId: 1,
  conversationId: 77,
  contact: { chatwootContactId: 5, phone: PHONE, name: 'Ana Souza' },
};

let agenda: InMemoryAgenda;
let now: Date;
let enqueued: number[];
let enqueueFails: boolean;
let sentMessages: Array<{ accountId: number; conversationId: number; params: { name: string; service: string; delayMin: number; expected: string } }>;
let sendFails: boolean;
let aiDeps: AgendaDeps;
let reqDeps: RequestDelayDeps;

const sender = {
  sendDelayNotice: async (accountId: number, conversationId: number, params: (typeof sentMessages)[number]['params']) => {
    if (sendFails) throw new Error('Meta fora do ar');
    sentMessages.push({ accountId, conversationId, params });
  },
};

beforeEach(async () => {
  agenda = new InMemoryAgenda();
  const corte = agenda.addService({ name: 'Corte', durationMin: 60, priceCents: 8000 }).id;
  agenda.addProfessional('Bia', [corte], [{ weekday: 2, startMin: 9 * 60, endMin: 18 * 60 }]);
  now = NOW;
  enqueued = [];
  enqueueFails = false;
  sentMessages = [];
  sendFails = false;
  const bookingDeps: AgendaDeps = { catalog: agenda, appointments: agenda, reminders: { schedule: async () => 'job', cancel: async () => {} }, now: () => BOOKED_AT };
  await bookService(bookingDeps, ctx, { serviceId: 1, professionalId: 1, start: '2026-11-17T10:00' });
  aiDeps = { ...bookingDeps, delayNotices: agenda, now: () => now };
  reqDeps = {
    admin: { getPhone: async (tenantId, id) => (tenantId === 1 && id === 1 ? { phone: PHONE } : null) },
    appointments: agenda,
    notices: agenda,
    scheduler: {
      enqueue: async (id) => {
        if (enqueueFails) throw new Error('redis fora do ar');
        enqueued.push(id);
      },
    },
    now: () => now,
  };
});

const request = (delayMin = 20, appointmentId = 1, tenantId = 1) => requestDelayNotice(reqDeps, { tenantId, appointmentId, delayMin });
const send = (id = 1) => sendDelayNotice({ notices: agenda, sender }, id);

describe('pedido de aviso de atraso (painel)', () => {
  it('enfileira o aviso', async () => {
    expect(await request()).toEqual({ kind: 'queued', noticeId: 1 });
    expect(enqueued).toEqual([1]);
  });

  it('o mesmo atraso duas vezes vira um aviso só; outro atraso é outro aviso', async () => {
    await request(20);
    expect(await request(20)).toEqual({ kind: 'already_requested' });
    expect(await request(30)).toMatchObject({ kind: 'queued' });
    expect(enqueued).toHaveLength(2);
  });

  it.each([4, 121, 20.5])('recusa atraso inválido (%s)', async (min) => {
    expect(await request(min)).toEqual({ kind: 'invalid_delay' });
  });

  it('não acha agendamento de outro salão nem inexistente', async () => {
    expect(await request(20, 1, 2)).toEqual({ kind: 'not_found' });
    expect(await request(20, 99)).toEqual({ kind: 'not_found' });
  });

  it('recusa agendamento fora da janela de 30 min atrás a 6 h à frente', async () => {
    now = new Date('2026-11-17T03:30:00-03:00');
    expect(await request()).toEqual({ kind: 'out_of_window' });
    now = new Date('2026-11-17T10:31:00-03:00');
    expect(await request()).toEqual({ kind: 'out_of_window' });
    now = new Date('2026-11-17T10:29:00-03:00');
    expect(await request()).toMatchObject({ kind: 'queued' });
  });

  it('recusa agendamento cancelado', async () => {
    await agenda.cancel(1, 1, PHONE, NOW);
    expect(await request()).toEqual({ kind: 'not_active' });
  });

  it('recusa quem não tem conversa no WhatsApp e quem pediu SAIR', async () => {
    agenda.stored[0]!.conversationId = null;
    expect(await request()).toEqual({ kind: 'no_whatsapp' });
    agenda.stored[0]!.conversationId = 77;
    agenda.optedOut.add(PHONE);
    expect(await request()).toEqual({ kind: 'opted_out' });
    expect(enqueued).toHaveLength(0);
  });

  it('se não conseguir enfileirar, apaga o registro para valer outra tentativa', async () => {
    enqueueFails = true;
    await expect(request()).rejects.toThrow('redis');
    enqueueFails = false;
    expect(await request()).toMatchObject({ kind: 'queued' });
  });
});

describe('envio do aviso (worker)', () => {
  it('manda o template com nome, serviço, atraso e novo horário no fuso do salão', async () => {
    await request(20);
    expect(await send()).toBe('sent');
    expect(sentMessages).toEqual([
      { accountId: 1, conversationId: 77, params: { name: 'Ana', service: 'Corte', delayMin: 20, expected: '10:20' } },
    ]);
  });

  it('não envia duas vezes', async () => {
    await request();
    await send();
    expect(await send()).toBe('skipped_already_sent');
    expect(sentMessages).toHaveLength(1);
  });

  it('se o envio falhar, desfaz a marca e a nova tentativa envia', async () => {
    await request();
    sendFails = true;
    await expect(send()).rejects.toThrow('Meta');
    sendFails = false;
    expect(await send()).toBe('sent');
    expect(sentMessages).toHaveLength(1);
  });

  it('não envia se o agendamento foi cancelado ou a cliente pediu SAIR depois do pedido', async () => {
    await request(20);
    await request(30);
    await agenda.cancel(1, 1, PHONE, NOW);
    expect(await send(1)).toBe('skipped_inactive');
    expect(await send(99)).toBe('skipped_missing');

    agenda.stored[0]!.status = 'agendado';
    agenda.optedOut.add(PHONE);
    expect(await send(2)).toBe('skipped_opted_out');
    expect(sentMessages).toHaveLength(0);
  });
});

describe('resposta da cliente (IA)', () => {
  const notified = async () => {
    await request(20);
    await send();
  };

  it('meus_agendamentos mostra o aviso pendente com o novo horário previsto', async () => {
    await notified();
    const text = await listMine(aiDeps, ctx);
    expect(text).toContain('agendamento_id 1');
    expect(text).toContain('AVISO DE ATRASO');
    expect(text).toContain('20 min');
    expect(text).toContain('10:20');
  });

  it('sem aviso enviado, nada muda na listagem', async () => {
    await request(20); // só pedido, ainda não enviado
    expect(await listMine(aiDeps, ctx)).not.toContain('AVISO');
  });

  it('confirmar chegada registra a resposta e não mexe na agenda', async () => {
    await notified();
    expect(await confirmLateArrival(aiDeps, ctx, 1)).toContain('Confirmado');
    expect(agenda.stored[0]!.startsAt).toEqual(new Date('2026-11-17T10:00:00-03:00'));
    expect(await listMine(aiDeps, ctx)).not.toContain('AVISO');
    expect(await confirmLateArrival(aiDeps, ctx, 1)).toContain('Já está confirmado');
    const [n] = await agenda.latestSent([1]);
    expect(delayStatus(n!, agenda.stored[0]!)).toBe('confirmou');
  });

  it('não confirma agendamento de outra pessoa nem sem aviso', async () => {
    await notified();
    const other: ToolContext = { ...ctx, contact: { ...ctx.contact, phone: '+5541888880000' } };
    expect(await confirmLateArrival(aiDeps, other, 1)).toContain('não encontrado');
    await agenda.cancel(1, 1, PHONE, NOW);
    expect(await confirmLateArrival(aiDeps, ctx, 1)).toContain('não encontrado');
  });

  it('remarcar para mais cedo tira o aviso da listagem e o painel mostra "remarcou"', async () => {
    await notified();
    now = new Date('2026-11-17T09:30:00-03:00');
    const result = await rescheduleAppointment(aiDeps, ctx, { appointmentId: 1, start: '2026-11-17T10:30' });
    expect(result).toContain('10:30');
    expect(await listMine(aiDeps, ctx)).not.toContain('AVISO');
    const [n] = await agenda.latestSent([1]);
    expect(delayStatus(n!, agenda.stored[0]!)).toBe('remarcou');
  });
});

describe('delayStatus', () => {
  const at = new Date('2026-11-17T10:00:00-03:00');
  it('enviado, confirmou e remarcou', () => {
    expect(delayStatus({ response: null, originalStartsAt: at }, { startsAt: at })).toBe('enviado');
    expect(delayStatus({ response: 'chegara_depois', originalStartsAt: at }, { startsAt: at })).toBe('confirmou');
    expect(delayStatus({ response: null, originalStartsAt: at }, { startsAt: new Date(at.getTime() - 1800_000) })).toBe('remarcou');
  });
});

describe('cliente avisa o próprio atraso (IA)', () => {
  let notes: string[];
  let withClient: AgendaDeps;
  beforeEach(() => {
    notes = [];
    withClient = { ...aiDeps, clientDelays: agenda, inbox: { addPrivateNote: async (_a, _c, note) => void notes.push(note) } };
  });
  const report = (delayMin: number, id = 1, c = ctx) => reportClientDelay(withClient, c, { appointmentId: id, delayMin });

  it('até 15 min: registra, avisa a equipe e mantém o horário', async () => {
    const text = await report(10);
    expect(text).toContain('dentro da tolerância do salão (15 min)');
    expect(text).toContain('mantido');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('10 min');
    expect(notes[0]).toContain('10:10');
    expect(notes[0]).toContain('horário mantido');
    expect(agenda.stored[0]!.startsAt).toEqual(new Date('2026-11-17T10:00:00-03:00'));
  });

  it('usa a tolerância configurada pelo salão', async () => {
    agenda.config.lateToleranceMin = 5;
    expect(await report(5)).toContain('dentro da tolerância do salão (5 min)');
    expect(await report(10)).toContain('passa da tolerância de 5 min');
    agenda.config.lateToleranceMin = 30;
    expect(await report(25)).toContain('dentro da tolerância do salão (30 min)');
    agenda.config.lateToleranceMin = 0;
    expect(await report(5)).toContain('passa da tolerância de 0 min');
  });

  it('exatamente 15 min (padrão) ainda é tolerado; 16 não', async () => {
    expect(await report(15)).toContain('dentro da tolerância do salão');
    const text = await report(16);
    expect(text).toContain('passa da tolerância');
    expect(text).toContain('Não prometa manter');
    expect(notes.at(-1)).toContain('a equipe decide');
  });

  it('o mesmo aviso duas vezes não duplica a nota para a equipe', async () => {
    await report(10);
    await report(10);
    expect(notes).toHaveLength(1);
  });

  it('não aceita agendamento de outra pessoa, distante (mais de 6 h) nem atraso acima de 60 min', async () => {
    const other: ToolContext = { ...ctx, contact: { ...ctx.contact, phone: '+5541888880000' } };
    expect(await report(10, 1, other)).toContain('não encontrado');
    now = new Date('2026-11-17T03:00:00-03:00');
    expect(await report(10)).toContain('longe');
    now = NOW;
    expect(await report(90)).toContain('remarcar');
    expect(notes).toHaveLength(0);
  });

  it('sem os recursos ligados, manda transferir para a equipe', async () => {
    expect(await reportClientDelay(aiDeps, ctx, { appointmentId: 1, delayMin: 10 })).toContain('Transfira');
  });
});
