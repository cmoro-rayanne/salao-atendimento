import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SalaoFicticio } from '../src/scripts/seed-salao-ficticio.js';
import type { ToolContext } from '../src/modules/agent/ports.js';
import { bookService, listFreeSlots, listServices, type AgendaDeps } from '../src/modules/appointments/agenda.js';
import { InMemoryAgenda } from '../src/modules/appointments/in-memory.js';

const data = SalaoFicticio.parse(JSON.parse(readFileSync('seed/salao-ficticio.json', 'utf8')));
const NOW = new Date('2026-11-16T14:00:00-03:00'); // segunda; o salão abre terça
const ctx = (phone: string, name: string): ToolContext => ({
  tenantId: 1,
  timeZone: 'America/Sao_Paulo',
  accountId: 1,
  conversationId: 1,
  contact: { chatwootContactId: 1, phone, name },
});

function build() {
  const agenda = new InMemoryAgenda();
  const ids = new Map(data.servicos.map((s) => [s.nome, agenda.addService({ name: s.nome, durationMin: s.duracaoMin, priceCents: s.precoCentavos, description: s.descricao }).id]));
  for (const p of data.profissionais) agenda.addProfessional(p.nome, p.servicos.map((n) => ids.get(n)!), p.expediente);
  const deps: AgendaDeps = { catalog: agenda, appointments: agenda, reminders: { schedule: async () => 'j', cancel: async () => {} }, now: () => NOW };
  return { agenda, deps, id: (nome: string) => ids.get(nome)! };
}

describe('salão fictício (carga de teste)', () => {
  it('tem os serviços pedidos, duas profissionais e tempos fixos', () => {
    expect(data.profissionais).toHaveLength(2);
    const dur = (n: string) => data.servicos.find((s) => s.nome === n)?.duracaoMin;
    expect(dur('Manicure (mão normal, esmalte comum)')).toBe(45);
    expect(dur('Esmaltação em gel mão')).toBe(60);
    expect(dur('Unha em gel mão')).toBe(90);
    for (const c of ['curto', 'médio', 'longo']) {
      expect(data.servicos.some((s) => s.nome === `Corte cabelo ${c}`)).toBe(true);
      expect(data.servicos.some((s) => s.nome === `Escova cabelo ${c}`)).toBe(true);
    }
    for (const p of data.profissionais) expect(p.servicos.every((n) => data.servicos.some((s) => s.nome === n))).toBe(true);
  });

  it('lista serviços com duração e valor, e oferece horário das duas profissionais', async () => {
    const { deps, id } = build();
    const c = ctx('+5541999990001', 'Ana');
    const text = await listServices(deps, c);
    expect(text).toContain('Unha em gel mão, 90 min');
    expect(text).toContain('Corte cabelo longo, 75 min');
    const slots = await listFreeSlots(deps, c, { serviceId: id('Unha em gel mão'), day: '2026-11-17' });
    expect(slots).toContain('Bia');
    expect(slots).toContain('Carla');
  });

  it('a mesma hora serve duas clientes (uma com cada profissional) e a terceira vai para outro horário', async () => {
    const { deps, id, agenda } = build();
    const gel = id('Unha em gel mão');
    const start = '2026-11-17T10:00';
    const a = await bookService(deps, ctx('+5541999990001', 'Ana'), { serviceId: gel, start });
    const b = await bookService(deps, ctx('+5541999990002', 'Bruna'), { serviceId: gel, start });
    const c = await bookService(deps, ctx('+5541999990003', 'Carol'), { serviceId: gel, start });
    expect(a).toContain('Agendado');
    expect(b).toContain('Agendado');
    expect(c).not.toContain('Agendado');
    expect(new Set(agenda.stored.map((x) => x.professionalId)).size).toBe(2);
  });

  it('o horário do serviço respeita o tempo fixo: unha em gel (1h30) não cabe no fim do expediente da manhã', async () => {
    const { deps, id } = build();
    const slots = await listFreeSlots(deps, ctx('+5541999990001', 'Ana'), { serviceId: id('Unha em gel mão'), day: '2026-11-17' });
    expect(slots).toContain('T10:30'); // termina 12:00
    expect(slots).not.toContain('T11:00'); // terminaria 12:30, invade o almoço
  });
});
