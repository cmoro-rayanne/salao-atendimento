import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type HoursBlock, type Me, type Professional, type SalonService } from './api';
import { fmt, minutesToTime, salonDay, salonTimeToIso, timeToMinutes } from './format';

const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const ORDER = [1, 2, 3, 4, 5, 6, 0];
const DEFAULT_BLOCKS: HoursBlock[] = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startMin: 9 * 60, endMin: 12 * 60 },
  { weekday, startMin: 13 * 60, endMin: 18 * 60 },
]);

interface Draft {
  name: string;
  active: boolean;
  serviceIds: number[];
  hours: HoursBlock[];
}

function summarize(hours: HoursBlock[]): string {
  if (!hours.length) return 'Sem expediente cadastrado';
  return ORDER.filter((d) => hours.some((h) => h.weekday === d))
    .map((d) => `${WEEKDAYS[d]!.slice(0, 3)} ${hours.filter((h) => h.weekday === d).sort((a, b) => a.startMin - b.startMin).map((h) => `${minutesToTime(h.startMin)}–${minutesToTime(h.endMin)}`).join(', ')}`)
    .join(' · ');
}

function TimeOffForm({ me, professional, onChanged }: { me: Me; professional: Professional; onChanged: (note?: string) => Promise<void> }) {
  const tz = me.timeZone ?? 'America/Sao_Paulo';
  const today = salonDay(tz);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [allDay, setAllDay] = useState(true);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('18:00');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      // Dia inteiro: do início do primeiro dia até o início do dia seguinte ao último.
      const startsAt = salonTimeToIso(from, allDay ? '00:00' : start, tz);
      const lastDay = new Date(Date.parse(`${to}T00:00:00Z`) + 24 * 3_600_000).toISOString().slice(0, 10);
      const endsAt = allDay ? salonTimeToIso(lastDay, '00:00', tz) : salonTimeToIso(to, end, tz);
      const res = await api.addTimeOff(professional.id, startsAt, endsAt, reason.trim() || null);
      setError(null);
      setReason('');
      await onChanged(
        res.affected > 0
          ? `${res.affected === 1 ? 'Há 1 agendamento' : `Há ${res.affected} agendamentos`} nesse período. Eles continuam valendo: remarque pela Agenda.`
          : undefined,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível registrar a folga.');
    }
  }

  return (
    <form className="time-off-form" onSubmit={add}>
      <h3>Nova folga ou bloqueio</h3>
      <label>De <input type="date" required min={today} value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} /></label>
      <label>Até <input type="date" required min={from} value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <label className="check">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        Dia inteiro
      </label>
      {!allDay && (
        <>
          <label>Das <input type="time" required value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label>Às <input type="time" required value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        </>
      )}
      <label>Motivo (opcional) <input maxLength={120} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Férias, consulta…" /></label>
      <button className="primary">Bloquear</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

export function ProfessionalsPage({ me }: { me: Me }) {
  const owner = me.role === 'dono';
  const tz = me.timeZone;
  const [list, setList] = useState<Professional[] | null>(null);
  const [services, setServices] = useState<SalonService[]>([]);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: '', active: true, serviceIds: [], hours: DEFAULT_BLOCKS });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([api.listProfessionals(), api.listServices()]);
      setList(p.professionals);
      setServices(s.services);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível carregar as profissionais.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function edit(p: Professional | null) {
    setEditing(p ? p.id : 'new');
    setDraft(p ? { name: p.name, active: p.active, serviceIds: p.serviceIds, hours: p.hours } : { name: '', active: true, serviceIds: [], hours: DEFAULT_BLOCKS });
    setError(null);
  }

  function setBlock(i: number, patch: Partial<HoursBlock>) {
    setDraft((d) => ({ ...d, hours: d.hours.map((h, j) => (j === i ? { ...h, ...patch } : h)) }));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (draft.hours.some((h) => h.startMin >= h.endMin)) return setError('Em cada faixa, a saída precisa ser depois da entrada.');
    setBusy(true);
    try {
      const input = { name: draft.name.trim(), active: draft.active, serviceIds: draft.serviceIds, hours: draft.hours };
      if (editing === 'new') await api.createProfessional(input);
      else if (editing !== null) await api.updateProfessional(editing, input);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  }

  const sortedHours = draft.hours.map((h, i) => ({ h, i })).sort((a, b) => ORDER.indexOf(a.h.weekday) - ORDER.indexOf(b.h.weekday) || a.h.startMin - b.h.startMin);

  return (
    <section className="page">
      <div className="page-head split">
        <div>
          <h1>Profissionais</h1>
          <p className="hint">
            A IA só oferece horários dentro do expediente de quem faz o serviço, e nunca em folgas ou em horários já ocupados.
          </p>
        </div>
        {owner && (
          <button className="primary" onClick={() => edit(null)}>
            Nova profissional
          </button>
        )}
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="notice" role="status">{note}</p>}

      {editing !== null && (
        <form className="new-slot stack" onSubmit={save}>
          <h2>{editing === 'new' ? 'Nova profissional' : 'Editar profissional'}</h2>
          <label>
            Nome
            <input required maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <fieldset>
            <legend>Serviços que faz</legend>
            {services.length === 0 && <p className="hint">Cadastre os serviços primeiro.</p>}
            {services.map((s) => (
              <label key={s.id} className="check">
                <input
                  type="checkbox"
                  checked={draft.serviceIds.includes(s.id)}
                  onChange={(e) => setDraft({ ...draft, serviceIds: e.target.checked ? [...draft.serviceIds, s.id] : draft.serviceIds.filter((x) => x !== s.id) })}
                />
                {s.name}{s.active ? '' : ' (inativo)'}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Expediente</legend>
            {sortedHours.length === 0 && <p className="hint">Sem faixas: a IA não oferece horários para esta profissional.</p>}
            <ul className="hours-list">
              {sortedHours.map(({ h, i }) => (
                <li key={i}>
                  <select aria-label="Dia da semana" value={h.weekday} onChange={(e) => setBlock(i, { weekday: Number(e.target.value) })}>
                    {ORDER.map((d) => (
                      <option key={d} value={d}>{WEEKDAYS[d]}</option>
                    ))}
                  </select>
                  <input type="time" aria-label="Entrada" value={minutesToTime(h.startMin)} onChange={(e) => e.target.value && setBlock(i, { startMin: timeToMinutes(e.target.value) })} />
                  <span>até</span>
                  <input type="time" aria-label="Saída" value={minutesToTime(h.endMin === 1440 ? 1439 : h.endMin)} onChange={(e) => e.target.value && setBlock(i, { endMin: timeToMinutes(e.target.value) })} />
                  <button type="button" className="quiet danger" onClick={() => setDraft({ ...draft, hours: draft.hours.filter((_, j) => j !== i) })}>
                    Remover
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="quiet" onClick={() => setDraft({ ...draft, hours: [...draft.hours, { weekday: 1, startMin: 9 * 60, endMin: 18 * 60 }] })}>
              Adicionar faixa
            </button>
          </fieldset>
          <label className="check">
            <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
            Ativa (aparece na agenda e para a IA)
          </label>
          <span className="form-actions">
            <button className="primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
            <button type="button" className="quiet" onClick={() => setEditing(null)}>Cancelar</button>
          </span>
        </form>
      )}

      {list === null ? (
        <p className="loading">Carregando as profissionais…</p>
      ) : list.length === 0 ? (
        <div className="empty">
          <p>Nenhuma profissional cadastrada. Cadastre a primeira, com serviços e expediente, para a IA poder agendar.</p>
        </div>
      ) : (
        <ul className="pro-list">
          {list.map((p) => (
            <li key={p.id} className={p.active ? 'card' : 'card muted'}>
              <div className="card-head split">
                <h2>{p.name}{p.active ? '' : ' (inativa)'}</h2>
                {owner && <button className="quiet" onClick={() => edit(p)}>Editar</button>}
              </div>
              <p className="sub">{services.filter((s) => p.serviceIds.includes(s.id)).map((s) => s.name).join(', ') || 'Nenhum serviço marcado'}</p>
              <p className="sub">{summarize(p.hours)}</p>
              {p.timeOff.length > 0 && (
                <ul className="time-off">
                  {p.timeOff.map((o) => (
                    <li key={o.id}>
                      <span>
                        {fmt(o.startsAt, tz, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} a{' '}
                        {fmt(o.endsAt, tz, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        {o.reason ? `, ${o.reason}` : ''}
                      </span>
                      <button
                        className="quiet danger"
                        onClick={() => void api.removeTimeOff(p.id, o.id).then(() => load(), (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível remover.'))}
                      >
                        Remover
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <details>
                <summary>Registrar folga ou bloqueio</summary>
                <TimeOffForm me={me} professional={p} onChanged={async (n) => { setNote(n ?? null); await load(); }} />
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
