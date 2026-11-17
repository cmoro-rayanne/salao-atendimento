import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, LEAD_STATUSES, type Lead, type LeadStatus, type Me } from './api';
import { fmt, formatPhone } from './format';

export const STATUS_LABEL: Record<LeadStatus, string> = {
  novo: 'Novo',
  qualificado: 'Qualificado',
  experimental_agendada: 'Experimental agendada',
  matriculado: 'Matriculado',
  perdido: 'Perdido',
};

const PERIODS = [
  { id: '30d', label: 'Últimos 30 dias' },
  { id: 'month', label: 'Este mês' },
  { id: 'prev', label: 'Mês passado' },
  { id: '90d', label: 'Últimos 90 dias' },
] as const;
type Period = (typeof PERIODS)[number]['id'];

function range(p: Period): { from: Date; to: Date } {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (p === 'month') return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: tomorrow };
  if (p === 'prev') return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 1) };
  const days = p === '30d' ? 30 : 90;
  return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - days), to: tomorrow };
}

export function LeadsPage({ me }: { me: Me }) {
  const [period, setPeriod] = useState<Period>('30d');
  const [status, setStatus] = useState<LeadStatus | undefined>();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [data, setData] = useState<{ items: Lead[]; counts: Record<LeadStatus, number> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    try {
      setData(await api.listLeads({ ...range(period), status, q: debounced }));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível carregar os leads.');
    }
  }, [period, status, debounced]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = useMemo(() => (data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0), [data]);

  async function changeStatus(lead: Lead, next: LeadStatus) {
    try {
      const res = await api.setLeadStatus(lead.id, next, lead.version);
      setData((d) =>
        d && {
          counts: { ...d.counts, [lead.status]: d.counts[lead.status] - 1, [next]: d.counts[next] + 1 },
          items: d.items
            .map((l) => (l.id === lead.id ? { ...l, status: next, version: res.version } : l))
            .filter((l) => !status || l.status === status),
        },
      );
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível mudar a situação.');
      await load();
    }
  }

  return (
    <section className="page">
      <div className="page-head">
        <h1>Leads</h1>
        <p className="hint">
          Quem falou com a academia pelo WhatsApp. A IA preenche nome, objetivo e modalidade durante a conversa; a recepção
          marca quem se matriculou.
        </p>
      </div>

      <div className="funnel-strip" role="group" aria-label="Filtrar por situação">
        {LEAD_STATUSES.map((s) => (
          <button
            key={s}
            className={`funnel-cell st-${s}`}
            aria-pressed={status === s}
            onClick={() => setStatus(status === s ? undefined : s)}
          >
            <span className="funnel-label">
              <span className="dot" aria-hidden="true" />
              {STATUS_LABEL[s]}
            </span>
            <span className="funnel-count">{data ? data.counts[s] : '–'}</span>
          </button>
        ))}
      </div>

      <div className="filters">
        <label className="grow">
          Buscar por nome ou telefone
          <input type="search" placeholder="Ex.: Carla ou 99999" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label>
          Período
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIODS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <p className="hint shown">
          {data && (status ? `${data.items.length} de ${total}, só ${STATUS_LABEL[status].toLowerCase()}` : `${total} no período`)}
          {data && data.items.length >= 100 && ' (mostrando os 100 mais recentes)'}
        </p>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!data ? (
        <p className="loading">Carregando os leads…</p>
      ) : data.items.length === 0 ? (
        <div className="empty">
          <p>
            {query || status
              ? 'Nenhum lead com esse filtro. Limpe a busca ou escolha outra situação.'
              : 'Nenhum contato neste período. Os leads aparecem aqui assim que a IA conversar com alguém.'}
          </p>
        </div>
      ) : (
        <div className="table-box">
          <table className="data-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Telefone</th>
                <th>Interesse</th>
                <th>Situação</th>
                <th>Último contato</th>
                <th>
                  <span className="sr-only">Conversa</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((l) => (
                <tr key={l.id}>
                  <td className="strong">{l.name ?? 'Sem nome informado'}</td>
                  <td className="nowrap num">{formatPhone(l.phone)}</td>
                  <td>
                    <span className="block">{l.goal ?? '—'}</span>
                    <span className="block sub">{l.modality ?? 'Modalidade não informada'}</span>
                  </td>
                  <td>
                    <label className="sr-only" htmlFor={`situacao-${l.id}`}>
                      Situação de {l.name ?? 'contato sem nome'}
                    </label>
                    <select
                      id={`situacao-${l.id}`}
                      className={`status-select st-${l.status}`}
                      value={l.status}
                      onChange={(e) => void changeStatus(l, e.target.value as LeadStatus)}
                    >
                      {LEAD_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="nowrap sub">
                    {fmt(l.updatedAt, me.timeZone, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="nowrap right">
                    {me.chatwootAccountUrl && l.chatwootContactId && (
                      <a href={`${me.chatwootAccountUrl}/contacts/${l.chatwootContactId}`} target="_blank" rel="noreferrer">
                        Abrir no Chatwoot
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
