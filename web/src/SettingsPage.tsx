import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Role, type Settings, type TeamMember } from './api';

const ROLE_LABEL: Record<Role, string> = { dono: 'Dono', recepcao: 'Recepção' };
const HOURS = Array.from({ length: 25 }, (_, h) => h);
const ZONE_LABEL: Record<string, string> = {
  'America/Sao_Paulo': 'Brasília (Sul, Sudeste, Nordeste, GO, DF)',
  'America/Manaus': 'Amazonas (AM, RR, RO, MT, MS)',
  'America/Rio_Branco': 'Acre',
  'America/Noronha': 'Fernando de Noronha',
};
const msg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function SettingsPage() {
  return (
    <div className="page settings">
      <AcademySettings />
      <Team />
    </div>
  );
}

function AcademySettings() {
  const [form, setForm] = useState<Settings | null>(null);
  const [zones, setZones] = useState<string[]>([]);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getSettings().then(
      ({ timeZones, ...s }) => {
        setForm(s);
        setZones(timeZones);
      },
      (err) => setStatus({ ok: false, text: msg(err, 'Não foi possível carregar as configurações.') }),
    );
  }, []);

  if (!form) return <section className="panel">{status ? <p className="error">{status.text}</p> : <p className="hint">Carregando…</p>}</section>;

  const set = (patch: Partial<Settings>) => {
    setForm({ ...form, ...patch });
    setStatus(null);
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    try {
      await api.saveSettings({ ...form, privacyUrl: form.privacyUrl?.trim() || null });
      setStatus({ ok: true, text: 'Configurações salvas.' });
    } catch (err) {
      setStatus({ ok: false, text: msg(err, 'Não foi possível salvar.') });
    } finally {
      setBusy(false);
    }
  }

  const hours = form.receptionHours;
  return (
    <section className="panel">
      <div className="page-head">
        <h1>O salão</h1>
        <p className="hint">O nome aparece nas mensagens da IA. O horário da recepção entra no relatório e define quando a IA avisa que a equipe responde depois.</p>
      </div>
      <form className="settings-form" onSubmit={save}>
        <label>
          Nome do salão
          <input required minLength={2} maxLength={80} value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>
          Fuso horário
          <select value={form.timeZone} onChange={(e) => set({ timeZone: e.target.value })}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {ZONE_LABEL[z] ?? z}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Horário da recepção</legend>
          <label className="switch">
            <input
              type="checkbox"
              checked={hours !== null}
              onChange={(e) => set({ receptionHours: e.target.checked ? { open: 7, close: 21 } : null })}
            />
            A recepção tem horário fixo
          </label>
          {hours && (
            <div className="reception-hours">
              <label>
                Abre às
                <select value={hours.open} onChange={(e) => set({ receptionHours: { ...hours, open: Number(e.target.value) } })}>
                  {HOURS.slice(0, 24).map((h) => (
                    <option key={h} value={h}>{`${h}h`}</option>
                  ))}
                </select>
              </label>
              <label>
                Fecha às
                <select value={hours.close} onChange={(e) => set({ receptionHours: { ...hours, close: Number(e.target.value) } })}>
                  {HOURS.slice(1).map((h) => (
                    <option key={h} value={h}>{`${h}h`}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </fieldset>
        <label>
          Link da política de privacidade
          <input
            type="url"
            inputMode="url"
            placeholder="https://"
            value={form.privacyUrl ?? ''}
            onChange={(e) => set({ privacyUrl: e.target.value })}
            aria-describedby="privacy-hint"
          />
        </label>
        <p id="privacy-hint" className="hint small">
          Vai no rodapé da primeira resposta da IA para cada pessoa. Precisa começar com https://.
        </p>
        <div className="form-actions">
          {status && (
            <p className={status.ok ? 'status ok' : 'status error'} role={status.ok ? 'status' : 'alert'}>
              {status.text}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? 'Salvando…' : 'Salvar configurações'}
          </button>
        </div>
      </form>
    </section>
  );
}

function Team() {
  const [users, setUsers] = useState<TeamMember[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('recepcao');
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.listUsers().then(
      (r) => setUsers(r.users),
      (err) => setError(msg(err, 'Não foi possível carregar a equipe.')),
    );
  }, []);
  useEffect(load, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.createUser(email, role);
      setSecret({ email: r.email, password: r.tempPassword, isNew: true });
      setEmail('');
      load();
    } catch (err) {
      setError(msg(err, 'Não foi possível criar o acesso.'));
    } finally {
      setBusy(false);
    }
  }

  async function reset(u: TeamMember) {
    if (!confirm(`Gerar uma senha provisória nova para ${u.email}? A senha atual deixa de funcionar e a pessoa sai do painel.`)) return;
    setError(null);
    try {
      const r = await api.resetUserPassword(u.id);
      setSecret({ email: u.email, password: r.tempPassword, isNew: false });
      load();
    } catch (err) {
      setError(msg(err, 'Não foi possível redefinir a senha.'));
    }
  }

  async function remove(u: TeamMember) {
    if (!confirm(`Remover o acesso de ${u.email}? A pessoa sai do painel na hora.`)) return;
    setError(null);
    try {
      await api.removeUser(u.id);
      if (secret?.email === u.email) setSecret(null);
      load();
    } catch (err) {
      setError(msg(err, 'Não foi possível remover o acesso.'));
    }
  }

  return (
    <section className="panel">
      <div className="page-head">
        <h2 className="section-title">Equipe com acesso ao painel</h2>
        <p className="hint">A recepção usa a agenda, os clientes, a base e o relatório. Só o dono mexe nestas configurações, nos serviços, nas profissionais e na equipe.</p>
      </div>

      {secret && (
        <div className="secret" role="status">
          <p>
            {secret.isNew ? 'Acesso criado para' : 'Senha nova para'} <strong>{secret.email}</strong>. Envie esta senha
            provisória para a pessoa; no primeiro acesso ela escolhe a própria.
          </p>
          <code className="secret-value">{secret.password}</code>
          <div className="secret-actions">
            <button type="button" className="quiet" onClick={() => void navigator.clipboard?.writeText(secret.password)}>
              Copiar senha
            </button>
            <button type="button" className="quiet" onClick={() => setSecret(null)}>
              Já enviei, esconder
            </button>
          </div>
          <p className="hint small">Ela não aparece de novo. Se perder, gere outra em “Nova senha”.</p>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {users && (
        <ul className="team">
          {users.map((u) => (
            <li key={u.id} className="member">
              <div>
                <span className="strong">{u.email}</span>
                {u.isMe && <span className="tag">você</span>}
                <span className="sub block">{ROLE_LABEL[u.role]}</span>
                {u.mustChangePassword && <span className="sub block">Ainda não fez o primeiro acesso</span>}
              </div>
              {!u.isMe && (
                <div className="member-actions">
                  <button className="quiet" onClick={() => void reset(u)}>
                    Nova senha
                  </button>
                  <button className="quiet danger" onClick={() => void remove(u)}>
                    Remover
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <form className="new-member" onSubmit={add}>
        <label className="grow">
          E-mail da pessoa
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Papel
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="recepcao">Recepção</option>
            <option value="dono">Dono</option>
          </select>
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Criando…' : 'Dar acesso'}
        </button>
      </form>
    </section>
  );
}
