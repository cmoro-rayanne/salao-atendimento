import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, type Slot } from './api';
import { plateFor } from './plates';

function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // segunda = 0
  x.setDate(x.getDate() - dow);
  return x;
}
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const fmtWeekday = new Intl.DateTimeFormat('pt-BR', { weekday: 'long' });
const fmtDate = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' });
const fmtTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtShort = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' });

export function SlotsPage() {
  const [week, setWeek] = useState(() => startOfWeek(new Date()));
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listSlots(week, addDays(week, 7));
      setSlots(res.slots);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível carregar a grade.');
    }
  }, [week]);

  useEffect(() => {
    setSlots(null);
    void load();
  }, [load]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(week, i)), [week]);
  const byDay = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of slots ?? []) {
      const k = dayKey(new Date(s.startsAt));
      map.set(k, [...(map.get(k) ?? []), s]);
    }
    return map;
  }, [slots]);
  const modalities = useMemo(() => [...new Set((slots ?? []).map((s) => s.modality))].sort(), [slots]);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível concluir.');
    }
    await load();
  }

  return (
    <section className="page">
      <div className="page-head">
        <h1>Grade da experimental</h1>
        <p className="hint">
          A IA só oferece os horários desta grade. Cada bolinha é uma vaga; as cheias já foram reservadas.
        </p>
      </div>

      <div className="week-nav">
        <button className="quiet" onClick={() => setWeek(addDays(week, -7))} aria-label="Semana anterior">
          ‹ Anterior
        </button>
        <strong>
          {fmtShort.format(week)} a {fmtShort.format(addDays(week, 6))}
        </strong>
        <button className="quiet" onClick={() => setWeek(addDays(week, 7))} aria-label="Próxima semana">
          Próxima ›
        </button>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {slots === null ? (
        <p className="loading">Carregando a grade…</p>
      ) : (
        <div className="board">
          {days.map((d) => {
            const list = byDay.get(dayKey(d)) ?? [];
            return (
              <div key={dayKey(d)} className="day">
                <h2>
                  {fmtWeekday.format(d)} <span className="day-date">{fmtDate.format(d)}</span>
                </h2>
                {list.length === 0 && <p className="day-empty">Sem horários</p>}
                <ul>
                  {list.map((s) => (
                    <SlotRow key={s.id} slot={s} act={act} />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      <NewSlotForm week={week} modalities={modalities} onCreated={load} />
    </section>
  );
}

function SlotRow({ slot, act }: { slot: Slot; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const past = new Date(slot.startsAt).getTime() < Date.now();
  const free = slot.capacity - slot.booked;
  return (
    <li className={past ? 'slot past' : 'slot'} style={{ ['--plate' as string]: plateFor(slot.modality) }}>
      <span className="slot-time">{fmtTime.format(new Date(slot.startsAt))}</span>
      <span className="slot-modality">{slot.modality}</span>
      <span className="pips" aria-label={`${slot.booked} reservadas de ${slot.capacity} vagas; ${free} livres`}>
        {Array.from({ length: slot.capacity }, (_, i) => (
          <i key={i} className={i < slot.booked ? 'pip on' : 'pip'} />
        ))}
      </span>
      {!past && (
        <span className="slot-actions">
          <button
            className="step"
            aria-label="Uma vaga a menos"
            disabled={slot.capacity <= slot.booked}
            onClick={() => void act(() => api.setCapacity(slot.id, slot.capacity - 1))}
          >
            −
          </button>
          <button
            className="step"
            aria-label="Uma vaga a mais"
            onClick={() => void act(() => api.setCapacity(slot.id, slot.capacity + 1))}
          >
            +
          </button>
          {slot.booked === 0 && (
            <button
              className="quiet danger"
              onClick={() => {
                if (confirm(`Excluir ${slot.modality} às ${fmtTime.format(new Date(slot.startsAt))}?`)) {
                  void act(() => api.deleteSlot(slot.id));
                }
              }}
            >
              Excluir
            </button>
          )}
        </span>
      )}
    </li>
  );
}

function NewSlotForm({ week, modalities, onCreated }: { week: Date; modalities: string[]; onCreated: () => Promise<void> }) {
  const [modality, setModality] = useState('');
  const [when, setWhen] = useState('');
  const [capacity, setCapacity] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createSlot(modality, new Date(when), capacity);
      setError(null);
      setWhen('');
      await onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar o horário.');
    } finally {
      setBusy(false);
    }
  }

  const min = new Date(Math.max(Date.now(), week.getTime()));
  const minLocal = new Date(min.getTime() - min.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

  return (
    <form className="new-slot" onSubmit={submit}>
      <h2>Novo horário</h2>
      <label>
        Modalidade
        <input list="modalidades" required maxLength={80} value={modality} onChange={(e) => setModality(e.target.value)} />
        <datalist id="modalidades">
          {modalities.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      <label>
        Dia e hora
        <input type="datetime-local" required min={minLocal} value={when} onChange={(e) => setWhen(e.target.value)} />
      </label>
      <label>
        Vagas
        <input
          type="number"
          required
          min={1}
          max={100}
          value={capacity}
          onChange={(e) => setCapacity(Number(e.target.value))}
        />
      </label>
      <button className="primary" disabled={busy}>
        {busy ? 'Criando…' : 'Criar horário'}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
