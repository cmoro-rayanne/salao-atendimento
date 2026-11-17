import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Booking, type Me } from './api';
import { fmt, formatPhone, pct } from './format';
import { plateFor } from './plates';

const DAY = 24 * 60 * 60 * 1000;

function dayKey(d: Date, tz: string | undefined) {
  return fmt(d, tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function BookingsPage({ me }: { me: Me }) {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const now = Date.now();
    try {
      const res = await api.listBookings(new Date(now - 30 * DAY), new Date(now + 15 * DAY));
      setBookings(res.bookings);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível carregar as aulas.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const view = useMemo(() => {
    if (!bookings) return null;
    const tz = me.timeZone;
    const now = new Date();
    const today = dayKey(now, tz);
    const tomorrow = dayKey(new Date(now.getTime() + DAY), tz);

    const pending = bookings.filter((b) => b.status === 'agendada' && new Date(b.startsAt) < now && dayKey(new Date(b.startsAt), tz) !== today);
    const upcoming = bookings.filter((b) => dayKey(new Date(b.startsAt), tz) >= today);

    const groups = new Map<string, Booking[]>();
    for (const b of upcoming) {
      const k = dayKey(new Date(b.startsAt), tz);
      groups.set(k, [...(groups.get(k) ?? []), b]);
    }
    const days = [...groups.entries()].map(([k, items]) => {
      const first = new Date(items[0]!.startsAt);
      const title = k === today ? 'Hoje' : k === tomorrow ? 'Amanhã' : fmt(first, tz, { weekday: 'long' });
      return { key: k, title, date: fmt(first, tz, { day: 'numeric', month: 'long' }), items };
    });

    const marked = bookings.filter((b) => b.status !== 'agendada');
    const came = marked.filter((b) => b.status === 'compareceu').length;
    const weekEnd = now.getTime() + 7 * DAY;
    return {
      pending,
      days,
      todayCount: groups.get(today)?.length ?? 0,
      weekCount: upcoming.filter((b) => new Date(b.startsAt).getTime() < weekEnd).length,
      attendance: marked.length ? came / marked.length : null,
    };
  }, [bookings, me.timeZone]);

  async function mark(b: Booking, next: 'compareceu' | 'faltou') {
    const attendance = b.status === next ? 'agendada' : next;
    setBookings((list) => list && list.map((x) => (x.id === b.id ? { ...x, status: attendance } : x)));
    try {
      await api.setAttendance(b.id, attendance);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível marcar a presença.');
      await load();
    }
  }

  function row(b: Booking) {
    const started = new Date(b.startsAt) <= new Date();
    const name = b.leadName ?? 'Sem nome informado';
    return (
      <li key={b.id} className={started && b.status === 'agendada' ? 'booking unmarked' : 'booking'} style={{ ['--plate' as string]: plateFor(b.modality) }}>
        <span className="booking-time">{fmt(b.startsAt, me.timeZone, { hour: '2-digit', minute: '2-digit' })}</span>
        <span className="booking-who">
          <span className="strong">{name}</span>
          <span className="sub">
            {b.modality}
            {b.leadGoal ? `, ${b.leadGoal}` : ''}
          </span>
        </span>
        <a className="booking-phone num" href={`tel:${b.leadPhone}`}>
          {formatPhone(b.leadPhone)}
        </a>
        {started ? (
          <span className="attendance" role="group" aria-label={`${name} veio à aula?`}>
            <button className="att came" aria-pressed={b.status === 'compareceu'} onClick={() => void mark(b, 'compareceu')}>
              Veio
            </button>
            <button className="att missed" aria-pressed={b.status === 'faltou'} onClick={() => void mark(b, 'faltou')}>
              Faltou
            </button>
          </span>
        ) : (
          <span className="sub reminder">
            {b.reminderSentAt
              ? `Lembrete enviado ${fmt(b.reminderSentAt, me.timeZone, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
              : b.reminderScheduled
                ? 'Lembrete agendado'
                : 'Sem lembrete (agendada em cima da hora)'}
          </span>
        )}
        {me.chatwootAccountUrl && b.chatwootConversationId && (
          <a className="nowrap" href={`${me.chatwootAccountUrl}/conversations/${b.chatwootConversationId}`} target="_blank" rel="noreferrer">
            Abrir conversa
          </a>
        )}
      </li>
    );
  }

  return (
    <section className="page">
      <div className="page-head split">
        <div>
          <h1>Aulas agendadas</h1>
          <p className="hint">
            Aulas experimentais que a IA marcou. Depois da aula, marque se a pessoa veio: é isso que alimenta o relatório de
            comparecimento.
          </p>
        </div>
        {view && (
          <dl className="stats">
            <div>
              <dt>hoje</dt>
              <dd>{view.todayCount}</dd>
            </div>
            <div>
              <dt>próximos 7 dias</dt>
              <dd>{view.weekCount}</dd>
            </div>
            <div>
              <dt>vieram (últimos 30 dias)</dt>
              <dd>{pct(view.attendance)}</dd>
            </div>
          </dl>
        )}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!view ? (
        <p className="loading">Carregando as aulas…</p>
      ) : (
        <>
          {view.pending.length > 0 && (
            <section className="day-group">
              <h2>Falta marcar presença</h2>
              <ul className="booking-list">{view.pending.map(row)}</ul>
            </section>
          )}
          {view.days.length === 0 && (
            <div className="empty">
              <p>Nenhuma aula agendada para os próximos dias. A IA agenda a partir dos horários da grade.</p>
            </div>
          )}
          {view.days.map((d) => (
            <section key={d.key} className="day-group">
              <h2>
                {d.title} <span className="sub-date">{d.date}</span>
              </h2>
              <ul className="booking-list">{d.items.map(row)}</ul>
            </section>
          ))}
        </>
      )}
    </section>
  );
}
