import { useState, type FormEvent } from 'react';
import { api, ApiError } from './api';

const MIN = 10;

/**
 * Troca da própria senha. `forced` = primeiro acesso com senha provisória:
 * ocupa a tela inteira e é o único caminho até o painel.
 */
export function PasswordPage({
  forced,
  email,
  onDone,
  onLogout,
}: {
  forced: boolean;
  email: string;
  onDone: () => void;
  onLogout?: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < MIN) return setError(`A nova senha precisa ter pelo menos ${MIN} caracteres.`);
    if (next !== confirm) return setError('A confirmação não é igual à nova senha.');
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      if (forced) onDone();
      else setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível trocar a senha.');
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form onSubmit={submit} className="login-form">
      <h1>{forced ? 'Crie sua senha' : 'Trocar minha senha'}</h1>
      <p className="hint">
        {forced
          ? `Você entrou com uma senha provisória (${email}). Escolha uma senha só sua para continuar.`
          : `Acesso de ${email}. Ao trocar, você continua conectado aqui e sai dos outros aparelhos.`}
      </p>
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      <label>
        {forced ? 'Senha provisória' : 'Senha atual'}
        <input
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </label>
      <label>
        Nova senha
        <input
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          aria-describedby="pw-rule"
        />
      </label>
      <p id="pw-rule" className="hint small">
        Pelo menos {MIN} caracteres. Uma frase curta é mais fácil de lembrar.
      </p>
      <label>
        Repita a nova senha
        <input
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="status ok" role="status">
          Senha trocada.
        </p>
      )}
      <button className="primary" disabled={busy}>
        {busy ? 'Salvando…' : 'Salvar senha'}
      </button>
      {forced && onLogout && (
        <button type="button" className="quiet" onClick={onLogout}>
          Sair
        </button>
      )}
    </form>
  );

  return forced ? <main className="login">{form}</main> : <div className="page narrow">{form}</div>;
}
