import { zonedTimeToUtc } from '../../shared/time-zone.js';
import { categorizeHandoff } from './handoff-categories.js';
import type { ReportRepository } from './ports.js';

export interface MonthlyReport {
  month: string;
  from: string;
  to: string;
  /** `true` enquanto o mês não terminou. */
  partial: boolean;
  conversations: number;
  resolvedByAiShare: number | null;
  funnel: Array<{ key: string; label: string; count: number }>;
  handoffs: { total: number; byCategory: Array<{ label: string; count: number }> };
  conversationsByHour: number[];
  receptionHours: { open: number; close: number } | null;
  outsideReceptionShare: number | null;
  aiCostUsd: number | null;
  aiCostBrl: number | null;
  aiCostPerConversationBrl: number | null;
  medianLatencyMs: number | null;
}

export function monthRange(month: string, timeZone: string): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const from = zonedTimeToUtc({ year: y, month: m, day: 1, hour: 0, minute: 0 }, timeZone);
  const next = m === 12 ? { year: y + 1, month: 1 } : { year: y, month: m + 1 };
  const to = zonedTimeToUtc({ ...next, day: 1, hour: 0, minute: 0 }, timeZone);
  return { from, to };
}

const share = (part: number, total: number) => (total > 0 ? part / total : null);

/** Use case: relatório mensal de uma academia, no fuso dela. */
export async function buildMonthlyReport(
  repo: ReportRepository,
  input: { tenantId: number; timeZone: string; month: string; now: Date; usdBrl: number | null },
): Promise<MonthlyReport> {
  const { from, to } = monthRange(input.month, input.timeZone);
  const until = input.now < to ? input.now : to;
  const raw = await repo.monthlyRaw({ tenantId: input.tenantId, from, to: until, timeZone: input.timeZone });

  const categories = new Map<string, number>();
  for (const r of raw.handoffReasons) {
    const label = categorizeHandoff(r.reason);
    categories.set(label, (categories.get(label) ?? 0) + r.count);
  }
  const byCategory = [...categories.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  const totalByHour = raw.conversationsByHour.reduce((a, b) => a + b, 0);
  const outside = raw.receptionHours
    ? raw.conversationsByHour.reduce(
        (n, c, h) => (h < raw.receptionHours!.open || h >= raw.receptionHours!.close ? n + c : n),
        0,
      )
    : null;

  const aiCostBrl = raw.aiCostUsd !== null && input.usdBrl ? raw.aiCostUsd * input.usdBrl : null;

  return {
    month: input.month,
    from: from.toISOString(),
    to: until.toISOString(),
    partial: input.now < to,
    conversations: raw.conversations,
    resolvedByAiShare: share(raw.conversationsWithoutHandoff, raw.conversations),
    funnel: [
      { key: 'conversations', label: 'Conversas atendidas', count: raw.conversations },
      { key: 'interested', label: 'Contatos com interesse', count: raw.interestedLeads },
      { key: 'trial', label: 'Aulas experimentais', count: raw.trialClasses },
      { key: 'attended', label: 'Vieram à aula', count: raw.attended },
      { key: 'enrolled', label: 'Matrículas', count: raw.enrollments },
    ],
    handoffs: { total: byCategory.reduce((n, c) => n + c.count, 0), byCategory },
    conversationsByHour: raw.conversationsByHour,
    receptionHours: raw.receptionHours,
    outsideReceptionShare: outside === null ? null : share(outside, totalByHour),
    aiCostUsd: raw.aiCostUsd,
    aiCostBrl,
    aiCostPerConversationBrl: aiCostBrl !== null && raw.conversations > 0 ? aiCostBrl / raw.conversations : null,
    medianLatencyMs: raw.medianLatencyMs,
  };
}
