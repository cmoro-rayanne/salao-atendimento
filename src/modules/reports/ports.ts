export interface ReportRange {
  tenantId: number;
  from: Date;
  to: Date;
  timeZone: string;
}

/** Números brutos do mês, vindos do banco. O use case transforma em relatório. */
export interface MonthlyRawData {
  conversations: number;
  conversationsWithoutHandoff: number;
  handoffReasons: Array<{ reason: string; count: number }>;
  interestedLeads: number;
  trialClasses: number;
  attended: number;
  enrollments: number;
  /** 24 posições: conversas pela hora local em que começaram. */
  conversationsByHour: number[];
  aiCostUsd: number | null;
  medianLatencyMs: number | null;
  receptionHours: { open: number; close: number } | null;
}

export interface ReportRepository {
  monthlyRaw(range: ReportRange): Promise<MonthlyRawData>;
}
