import { useEffect, useState } from 'react';
import { api, ApiError, type Me, type Report, type UnansweredQuestion } from './api';
import { brl, fmt, pct } from './format';

const FUNNEL_COLORS = ['var(--ink)', 'var(--plate-blue)', 'var(--plate-green)'];

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const name = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 15)));
  return `${name[0]!.toUpperCase()}${name.slice(1)} de ${y}`;
}

function headline(r: Report): string {
  if (r.conversations === 0) return 'Nenhuma conversa atendida pela IA neste período.';
  const { scheduled } = r.appointments;
  const first = `A IA atendeu ${r.conversations} ${r.conversations === 1 ? 'conversa' : 'conversas'}${
    r.resolvedByAiShare !== null ? ` e resolveu ${pct(r.resolvedByAiShare)} sem precisar da equipe` : ''
  }.`;
  if (!scheduled) return first;
  return `${first} ${scheduled === 1 ? 'Há 1 agendamento' : `Há ${scheduled} agendamentos`} no mês.`;
}

export function ReportPage({ me }: { me: Me }) {
  const [month, setMonth] = useState<string | undefined>();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReport(null);
    api.report(month).then(
      (r) => {
        setReport(r);
        setError(null);
      },
      (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar o relatório.'),
    );
  }, [month]);

  if (!report) return error ? <p className="error page-pad">{error}</p> : <p className="loading">Calculando o relatório…</p>;

  const max = Math.max(1, report.funnel[0]?.count ?? 1);
  const maxHour = Math.max(1, ...report.conversationsByHour);
  const maxReason = Math.max(1, ...report.handoffs.byCategory.map((c) => c.count));
  const rh = report.receptionHours;
  const hours = report.conversationsByHour.map((n, h) => ({ h, n, open: !rh || (h >= rh.open && h < rh.close) }));
  const lastDay = new Date(new Date(report.to).getTime() - 1);

  return (
    <section className="page report">
      <div className="report-head">
        <div className="month-nav">
          <button className="icon-btn" aria-label="Mês anterior" onClick={() => setMonth(shiftMonth(report.month, -1))}>
            ‹
          </button>
          <h1>{monthTitle(report.month)}</h1>
          <button
            className="icon-btn"
            aria-label="Próximo mês"
            disabled={report.partial}
            onClick={() => setMonth(shiftMonth(report.month, 1))}
          >
            ›
          </button>
        </div>
        {report.partial && (
          <p className="hint">
            Parcial: até {fmt(lastDay, report.timeZone, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
          </p>
        )}
        <button className="primary no-print" onClick={() => window.print()}>
          Baixar PDF do mês
        </button>
      </div>

      <p className="headline">{headline(report)}</p>

      <section className="card" aria-labelledby="funil-titulo">
        <div className="card-head">
          <h2 id="funil-titulo">Da conversa ao atendimento</h2>
          <p className="hint">Barras na mesma escala; ao lado, quanto passou para a etapa seguinte</p>
        </div>
        <ol className="funnel">
          {report.funnel.map((s, i) => {
            const next = report.funnel[i + 1];
            return (
              <li key={s.key}>
                <span className="strong">{s.label}</span>
                <span className="funnel-bar-wrap">
                  <span
                    className="funnel-bar"
                    aria-hidden="true"
                    style={{ width: `calc((100% - 4.5rem) * ${s.count / max})`, background: FUNNEL_COLORS[i] }}
                  />
                  <span className="funnel-n num">{s.count}</span>
                </span>
                <span className="sub right">{next && s.count > 0 ? `${pct(next.count / s.count)} seguiram` : ''}</span>
              </li>
            );
          })}
        </ol>
        <p className="hint small">
          Agendamentos e atendimentos contam pelo dia do horário marcado; cancelados ficam de fora do funil.
        </p>
      </section>

      <div className="report-grid">
        <section className="card" aria-labelledby="agenda-titulo">
          <h2 id="agenda-titulo">Agenda do mês</h2>
          <ul className="reasons">
            <li>
              <span className="reason-line">
                <span className="strong">Faltas</span>
                <span className="strong num">{report.appointments.noShow}</span>
              </span>
              <span className="sub">
                {report.noShowShare === null ? 'Marque concluído ou faltou na agenda para ver a taxa.' : `${pct(report.noShowShare)} dos horários já encerrados`}
              </span>
            </li>
            <li>
              <span className="reason-line">
                <span className="strong">Cancelados</span>
                <span className="strong num">{report.appointments.cancelled}</span>
              </span>
            </li>
          </ul>
        </section>
        <section className="card" aria-labelledby="servicos-titulo">
          <h2 id="servicos-titulo">Serviços mais pedidos</h2>
          {report.topServices.length === 0 ? (
            <p className="hint">Nenhum agendamento neste período.</p>
          ) : (
            <ul className="reasons">
              {report.topServices.map((t) => (
                <li key={t.name}>
                  <span className="reason-line">
                    <span className="strong">{t.name}</span>
                    <span className="strong num">{t.count}</span>
                  </span>
                  <span className="meter" aria-hidden="true">
                    <span style={{ width: `${(t.count / (report.topServices[0]?.count || 1)) * 100}%` }} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="report-grid">
        <section className="card" aria-labelledby="motivos-titulo">
          <h2 id="motivos-titulo">Por que a IA chamou a equipe</h2>
          {report.handoffs.total === 0 ? (
            <p className="hint">Nenhuma transferência neste período.</p>
          ) : (
            <>
              <p className="hint">
                {report.handoffs.total} {report.handoffs.total === 1 ? 'transferência' : 'transferências'}. "Dúvida fora da base"
                mostra o que falta ensinar à IA.
              </p>
              <ul className="reasons">
                {report.handoffs.byCategory.map((c) => (
                  <li key={c.label}>
                    <span className="reason-line">
                      <span className="strong">{c.label}</span>
                      <span className="strong num">{c.count}</span>
                    </span>
                    <span className="meter" aria-hidden="true">
                      <span style={{ width: `${(c.count / maxReason) * 100}%` }} />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="card" aria-labelledby="horas-titulo">
          <h2 id="horas-titulo">Quando as pessoas chamam</h2>
          <p className="hint">
            {rh
              ? `${pct(report.outsideReceptionShare)} das conversas começaram com a recepção fechada (barras claras).`
              : 'Conversas pela hora em que começaram. Cadastre o horário da recepção para ver quantas chegam com ela fechada.'}
          </p>
          <div
            className="hours"
            role="img"
            aria-label={`Conversas por hora do dia${rh ? `; ${pct(report.outsideReceptionShare)} fora do horário da recepção` : ''}`}
          >
            {hours.map((x) => (
              <span
                key={x.h}
                className={x.open ? 'hour open' : 'hour closed'}
                style={{ height: `${(x.n / maxHour) * 100}%` }}
                title={`${x.h}h: ${x.n}`}
              />
            ))}
          </div>
          <div className="hours-axis" aria-hidden="true">
            <span>0h</span>
            <span>6h</span>
            <span>12h</span>
            <span>18h</span>
            <span>23h</span>
          </div>
        </section>
      </div>

      <UnansweredSection report={report} me={me} />

      <section className="card" aria-labelledby="custos-titulo">
        <h2 id="custos-titulo">Custo e velocidade da IA</h2>
        <dl className="cost-grid">
          <div>
            <dt>Custo de IA no mês (incluído na mensalidade)</dt>
            <dd className="big">{brl(report.aiCostBrl)}</dd>
            <dd className="sub">{report.aiCostPerConversationBrl !== null ? `${brl(report.aiCostPerConversationBrl)} por conversa` : 'Configure o preço do modelo e a cotação para ver'}</dd>
          </div>
          <div>
            <dt>Tempo de resposta da IA</dt>
            <dd className="big">{report.medianLatencyMs === null ? '—' : `${(report.medianLatencyMs / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`}</dd>
            <dd className="sub">mediana, a qualquer hora do dia</dd>
          </div>
          <div>
            <dt>Mensagens do WhatsApp</dt>
            <dd className="big">Na Meta</dd>
            <dd className="sub">O valor cobrado pela Meta aparece no WhatsApp Manager do salão</dd>
          </div>
        </dl>
      </section>
    </section>
  );
}

function UnansweredSection({ report, me }: { report: Report; me: Me }) {
  const [items, setItems] = useState<UnansweredQuestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    api.listUnanswered(report.from, report.to).then(
      (r) => setItems(r.items),
      (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar as perguntas.'),
    );
  }, [report.from, report.to]);

  async function toggle(q: UnansweredQuestion) {
    const resolved = q.resolvedAt === null;
    setError(null);
    try {
      await api.setUnansweredResolved(q.id, resolved);
      setItems((list) => list?.map((x) => (x.id === q.id ? { ...x, resolvedAt: resolved ? new Date().toISOString() : null } : x)) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    }
  }

  const sorted = items ? [...items.filter((q) => !q.resolvedAt), ...items.filter((q) => q.resolvedAt)] : [];
  const open = sorted.filter((q) => !q.resolvedAt).length;

  return (
    <section className="card" aria-labelledby="perguntas-titulo">
      <h2 id="perguntas-titulo">Perguntas que a IA não soube responder</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {items === null && !error && <p className="hint">Carregando…</p>}
      {items?.length === 0 && <p className="hint">Nenhuma neste período: a base deu conta das dúvidas.</p>}
      {items && items.length > 0 && (
        <>
          <p className="hint">
            {open === 0
              ? 'Todas já foram ensinadas à IA.'
              : `${open} ${open === 1 ? 'pergunta espera' : 'perguntas esperam'} uma resposta em "O que a IA sabe". Depois de ensinar, marque como resolvida.`}
          </p>
          <ul className="questions">
            {sorted.map((q) => (
              <li key={q.id} className={q.resolvedAt ? 'question done' : 'question'}>
                <span className="question-text">{q.question}</span>
                <span className="sub">
                  {fmt(new Date(q.createdAt), report.timeZone, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  {me.chatwootAccountUrl && (
                    <>
                      {' '}
                      <a className="no-print" href={`${me.chatwootAccountUrl}/conversations/${q.conversationId}`} target="_blank" rel="noreferrer">
                        Ver conversa
                      </a>
                    </>
                  )}
                </span>
                <label className="switch no-print">
                  <input type="checkbox" checked={q.resolvedAt !== null} onChange={() => void toggle(q)} />
                  Já ensinei à IA
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
