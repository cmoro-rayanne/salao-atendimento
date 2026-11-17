import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Me, type SalonService, type ServiceInput } from './api';
import { brl } from './format';

const EMPTY = { name: '', description: '', duration: '60', price: '', active: true };
type Draft = typeof EMPTY;

const toDraft = (s: SalonService): Draft => ({
  name: s.name,
  description: s.description ?? '',
  duration: String(s.durationMin),
  price: s.priceCents === null ? '' : (s.priceCents / 100).toFixed(2).replace('.', ','),
  active: s.active,
});

function toInput(d: Draft): ServiceInput | string {
  const durationMin = Number(d.duration);
  if (!Number.isInteger(durationMin) || durationMin < 5 || durationMin > 480) return 'A duração precisa ficar entre 5 e 480 minutos.';
  let priceCents: number | null = null;
  if (d.price.trim()) {
    const value = Number(d.price.replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(value) || value < 0) return 'Valor inválido. Deixe em branco para "a combinar".';
    priceCents = Math.round(value * 100);
  }
  return { name: d.name.trim(), description: d.description.trim() || null, durationMin, priceCents, active: d.active };
}

export function ServicesPage({ me }: { me: Me }) {
  const owner = me.role === 'dono';
  const [services, setServices] = useState<SalonService[] | null>(null);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setServices((await api.listServices()).services);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível carregar os serviços.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function edit(s: SalonService | null) {
    setEditing(s ? s.id : 'new');
    setDraft(s ? toDraft(s) : EMPTY);
    setError(null);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const input = toInput(draft);
    if (typeof input === 'string') return setError(input);
    setBusy(true);
    try {
      if (editing === 'new') await api.createService(input);
      else if (editing !== null) await api.updateService(editing, input);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <div className="page-head split">
        <div>
          <h1>Serviços</h1>
          <p className="hint">
            A IA só oferece e agenda o que está aqui, com esta duração. Sem valor, ela diz que o preço é combinado e não inventa um.
          </p>
        </div>
        {owner && (
          <button className="primary" onClick={() => edit(null)}>
            Novo serviço
          </button>
        )}
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      {editing !== null && (
        <form className="new-slot stack" onSubmit={save}>
          <h2>{editing === 'new' ? 'Novo serviço' : 'Editar serviço'}</h2>
          <label>
            Nome
            <input required maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            Duração (minutos)
            <input required type="number" min={5} max={480} step={5} value={draft.duration} onChange={(e) => setDraft({ ...draft, duration: e.target.value })} />
          </label>
          <label>
            Valor (R$)
            <input inputMode="decimal" placeholder="A combinar" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
          </label>
          <label>
            Descrição para a IA (opcional)
            <textarea rows={2} maxLength={300} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
            Ativo (a IA oferece e dá para agendar)
          </label>
          <span className="form-actions">
            <button className="primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
            <button type="button" className="quiet" onClick={() => setEditing(null)}>Cancelar</button>
          </span>
        </form>
      )}

      {services === null ? (
        <p className="loading">Carregando os serviços…</p>
      ) : services.length === 0 ? (
        <div className="empty">
          <p>Nenhum serviço cadastrado. Cadastre o primeiro para a IA poder agendar.</p>
        </div>
      ) : (
        <ul className="booking-list">
          {services.map((s) => (
            <li key={s.id} className={s.active ? 'booking' : 'booking unmarked muted'}>
              <span className="booking-who">
                <span className="strong">{s.name}{s.active ? '' : ' (inativo)'}</span>
                <span className="sub">{s.description ?? 'Sem descrição'}</span>
              </span>
              <span className="num">{s.durationMin} min</span>
              <span className="num">{s.priceCents === null ? 'A combinar' : brl(s.priceCents / 100)}</span>
              {owner && <button className="quiet" onClick={() => edit(s)}>Editar</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
