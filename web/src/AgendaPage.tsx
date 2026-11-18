import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, type Appointment, type FreeSlot, type Me, type Professional, type SalonService } from './api';
import { fmt, formatPhone, salonDay } from './format';
import { plateFor } from './plates';

const DAY = 24 * 60 * 60 * 1000;

const time = (iso: string, tz: string | undefined) => fmt(iso, tz, { hour: '2-digit', minute: '2-digit' });

function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** Escolhe um horário livre: dia + botões de horário (com a profissional ao lado quando há mais de uma). */
function SlotPicker({
  me,
  serviceId,
  professionalId,
  initialDay,
  onPick,
}: {
  me: Me;
  serviceId: number;
  professionalId?: number | undefined;
  initialDay: string;
  onPick: (slot: FreeSlot) => void;
}) {
  const [day, setDay] = useState(initialDay);
  const [slots, setSlots] = useState<FreeSlot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSlots(null);
    api.freeSlots(serviceId, day, professionalId).then(
      (r) => alive && (setSlots(r.slots), setError(null)),
      (err) => alive && setError(err instanceof ApiError ? err.message : 'Não foi possível carregar os horários.'),
    );
    return () => {
      alive = false;
    };
  }, [serviceId, day, professionalId]);

  return (
    <div className="slot-picker">
      <label>
        Dia
        <input type="date" value={day} min={salonDay(me.timeZone)} onChange={(e) => e.target.value && setDay(e.target.value)} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      {slots === null && !error && <p className="loading">Buscando horários…</p>}
      {slots?.length === 0 && <p className="hint">Sem horários livres nesse dia. Tente outro dia ou veja o expediente da profissional.</p>}
      <ul className="slot-buttons">
        {slots?.map((s) => (
          <li key={`${s.startsAt}-${s.professionalId}`}>
            <button type="button" onClick={() => onPick(s)}>
              <span className="strong num">{time(s.startsAt, me.timeZone)}</span>
              <span className="sub">{s.professionalName}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewAppointment({
  me,
  services,
  day,
  onCreated,
}: {
  me: Me;
  services: SalonService[];
  day: string;
  onCreated: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = services.filter((s) => s.active);

  async function pick(slot: FreeSlot) {
    if (!serviceId) return;
    setBusy(true);
    try {
      await api.createAppointment({ serviceId, professionalId: slot.professionalId, startsAt: slot.startsAt, phone, name: name.trim() || null });
      setError(null);
      setOpen(false);
      setName('');
      setPhone('');
      await onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível agendar.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="primary" onClick={() => setOpen(true)} disabled={!active.length}>
        Novo agendamento
      </button>
    );
  }

  const ready = serviceId !== null && phone.replace(/\D/g, '').length >= 10;
  return (
    <form className="new-slot stack" onSubmit={(e: FormEvent) => e.preventDefault()}>
      <h2>Novo agendamento</h2>
      <label>
        Cliente
        <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Nome (opcional)" />
      </label>
      <label>
        WhatsApp
        <input required inputMode="tel" value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} placeholder="(41) 99999-0000" />
      </label>
      <label>
        Serviço
        <select value={serviceId ?? ''} onChange={(e) => setServiceId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Escolha…</option>
          {active.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.durationMin} min)
            </option>
          ))}
        </select>
      </label>
      {ready ? (
        <SlotPicker me={me} serviceId={serviceId} initialDay={day} onPick={(s) => void pick(s)} />
      ) : (
        <p className="hint">Informe o WhatsApp e o serviço para ver os horários livres.</p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button type="button" className="quiet" onClick={() => setOpen(false)} disabled={busy}>
        Fechar
      </button>
    </form>
  );
}

export function AgendaPage({ me }: { me: Me }) {
  const tz = me.timeZone;
  const [day, setDay] = useState(() => salonDay(tz));
  const [items, setItems] = useState<Appointment[] | null>(null);
  const [pending, setPending] = useState<Appointment[]>([]);
  const [services, setServices] = useState<SalonService[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [filter, setFilter] = useState<number | null>(null);
  const [moving, setMoving] = useState<number | null>(null);
  const [delaying, setDelaying] = useState<number | null>(null);
  const [delayMin, setDelayMin] = useState(15);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const noon = Date.parse(`${day}T12:00:00Z`);
      const [today, late] = await Promise.all([
        api.listAppointments(new Date(noon - 15 * 3_600_000), new Date(noon + 15 * 3_600_000)),
        api.listAppointments(new Date(Date.now() - 14 * DAY), new Date()),
      ]);
      // A janela de ±15h pega o dia inteiro mesmo com fuso; filtra pelo dia do salão.
      setItems(today.appointments.filter((a) => salonDay(tz, Date.parse(a.startsAt)) === day));
      setPending(late.appointments.filter((a) => a.status === 'agendado' && Date.parse(a.endsAt) < Date.now() && salonDay(tz, Date.parse(a.startsAt)) !== day));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível carregar a agenda.');
    }
  }, [day, tz]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  useEffect(() => {
    void Promise.all([api.listServices(), api.listProfessionals()]).then(([s, p]) => {
      setServices(s.services);
      setProfessionals(p.professionals);
    }, () => undefined);
  }, []);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      setError(null);
      setMoving(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível concluir.');
    }
    await load();
  }

  const visible = useMemo(
    () => (items ?? []).filter((a) => a.status !== 'cancelado' && (!filter || a.professionalId === filter)),
    [items, filter],
  );
  const cancelled = (items ?? []).filter((a) => a.status === 'cancelado' && (!filter || a.professionalId === filter));
  const title = day === salonDay(tz) ? 'Hoje' : day === salonDay(tz, Date.now() + DAY) ? 'Amanhã' : fmt(`${day}T12:00:00Z`, 'UTC', { weekday: 'long' });

  function row(a: Appointment) {
    const started = Date.parse(a.startsAt) <= Date.now();
    const ended = Date.parse(a.endsAt) <= Date.now();
    const name = a.clientName ?? 'Sem nome informado';
    const untilStart = Date.parse(a.startsAt) - Date.now();
    const canWarn = a.status === 'agendado' && a.chatwootConversationId !== null && untilStart > -30 * 60_000 && untilStart < 6 * 3_600_000;
    const delayText = a.delayNotice
      ? {
          enviado: `Avisada do atraso de ${a.delayNotice.delayMin} min (por volta das ${time(a.delayNotice.expectedAt, tz)}). Aguardando resposta`,
          confirmou: `Avisada do atraso: chega por volta das ${time(a.delayNotice.expectedAt, tz)}`,
          remarcou: 'Avisada do atraso e remarcou',
          cancelou: 'Avisada do atraso e cancelou',
        }[a.delayNotice.status]
      : null;
    return (
      <li key={a.id} className={a.status === 'agendado' && ended ? 'booking unmarked' : 'booking'} style={{ ['--plate' as string]: plateFor(a.professionalName) }}>
        <span className="booking-time">
          {time(a.startsAt, tz)}
          <span className="sub">{time(a.endsAt, tz)}</span>
        </span>
        <span className="booking-who">
          <span className="strong">{name}</span>
          <span className="sub">
            {a.serviceName} com {a.professionalName}
            {a.source === 'painel' ? ', marcado pela recepção' : ''}
          </span>
        </span>
        <a className="booking-phone num" href={`tel:${a.clientPhone}`}>
          {formatPhone(a.clientPhone)}
        </a>
        {started ? (
          <span className="attendance" role="group" aria-label={`${name} veio?`}>
            <button className="att came" aria-pressed={a.status === 'concluido'} onClick={() => void act(() => api.setAppointmentStatus(a.id, a.status === 'concluido' ? 'agendado' : 'concluido'))}>
              Veio
            </button>
            <button className="att missed" aria-pressed={a.status === 'faltou'} onClick={() => void act(() => api.setAppointmentStatus(a.id, a.status === 'faltou' ? 'agendado' : 'faltou'))}>
              Faltou
            </button>
          </span>
        ) : (
          <span className="slot-actions">
            {canWarn && (
              <button className="quiet" onClick={() => setDelaying(delaying === a.id ? null : a.id)}>
                Avisar atraso
              </button>
            )}
            <button className="quiet" onClick={() => setMoving(moving === a.id ? null : a.id)}>
              Remarcar
            </button>
            <button
              className="quiet danger"
              onClick={() => {
                if (confirm(`Cancelar ${a.serviceName} de ${name} às ${time(a.startsAt, tz)}?`)) void act(() => api.cancelAppointment(a.id));
              }}
            >
              Cancelar
            </button>
          </span>
        )}
        {me.chatwootAccountUrl && a.chatwootConversationId && (
          <a className="nowrap" href={`${me.chatwootAccountUrl}/conversations/${a.chatwootConversationId}`} target="_blank" rel="noreferrer">
            Abrir conversa
          </a>
        )}
        {a.clientDelay && (
          <span className="sub">
            Cliente avisou atraso de {a.clientDelay.delayMin} min (chega por volta das {time(a.clientDelay.expectedAt, tz)}
            {a.clientDelay.withinTolerance ? ', dentro da tolerância)' : ', passa da tolerância: veja se atende ou remarque)'}
          </span>
        )}
        {delayText && <span className="sub">{delayText}</span>}
        {delaying === a.id && (
          <div className="move-panel">
            <h3>Avisar {name} do atraso</h3>
            <label>
              Atraso previsto
              <select value={delayMin} onChange={(e) => setDelayMin(Number(e.target.value))}>
                {[10, 15, 20, 30, 45, 60].map((m) => (
                  <option key={m} value={m}>
                    {m} minutos
                  </option>
                ))}
              </select>
            </label>
            <p className="sub">A cliente recebe um aviso no WhatsApp com o novo horário previsto e pode confirmar ou remarcar, inclusive para mais cedo.</p>
            <button
              onClick={() =>
                void act(async () => {
                  await api.sendDelayNotice(a.id, delayMin);
                  setDelaying(null);
                  setNotice(`Aviso a caminho de ${name}.`);
                })
              }
            >
              Enviar aviso
            </button>
          </div>
        )}
        {moving === a.id && (
          <div className="move-panel">
            <h3>Novo horário para {name}</h3>
            <SlotPicker
              me={me}
              serviceId={a.serviceId}
              initialDay={day < salonDay(tz) ? salonDay(tz) : day}
              onPick={(s) => void act(() => api.rescheduleAppointment(a.id, s.startsAt, s.professionalId))}
            />
          </div>
        )}
      </li>
    );
  }

  return (
    <section className="page">
      <div className="page-head split">
        <div>
          <h1>Agenda</h1>
          <p className="hint">
            O que a IA marcou pelo WhatsApp e o que a recepção marca aqui aparece junto. Depois do horário, marque se a pessoa veio: é isso que alimenta as faltas do relatório.
          </p>
        </div>
        <NewAppointment me={me} services={services} day={day} onCreated={load} />
      </div>

      <div className="week-nav">
        <button className="quiet" onClick={() => setDay(shiftDay(day, -1))} aria-label="Dia anterior">
          ‹ Anterior
        </button>
        <input type="date" aria-label="Escolher dia" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
        <button className="quiet" onClick={() => setDay(salonDay(tz))}>
          Hoje
        </button>
        <button className="quiet" onClick={() => setDay(shiftDay(day, 1))} aria-label="Próximo dia">
          Próximo ›
        </button>
        <label className="inline">
          Profissional
          <select value={filter ?? ''} onChange={(e) => setFilter(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Todas</option>
            {professionals.filter((p) => p.active).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {notice && !error && <p className="sub" role="status">{notice}</p>}

      {pending.length > 0 && (
        <section className="day-group">
          <h2>Falta marcar se veio</h2>
          <ul className="booking-list">{pending.map(row)}</ul>
        </section>
      )}

      {items === null ? (
        <p className="loading">Carregando a agenda…</p>
      ) : (
        <section className="day-group">
          <h2>
            {title} <span className="sub-date">{fmt(`${day}T12:00:00Z`, 'UTC', { day: 'numeric', month: 'long' })}</span>
          </h2>
          {visible.length === 0 ? (
            <div className="empty">
              <p>Nenhum agendamento neste dia.</p>
            </div>
          ) : (
            <ul className="booking-list">{visible.map(row)}</ul>
          )}
          {cancelled.length > 0 && (
            <p className="hint small">
              {cancelled.length === 1 ? '1 cancelado' : `${cancelled.length} cancelados`} neste dia:{' '}
              {cancelled.map((a) => `${time(a.startsAt, tz)} ${a.clientName ?? formatPhone(a.clientPhone)}`).join(', ')}
            </p>
          )}
        </section>
      )}
    </section>
  );
}
