import { useState, type FormEvent } from 'react';
import { api, ApiError, type AgentTestResult, type KnowledgeItem } from './api';

function describeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'registrar_lead':
      return 'Guardaria os dados do interessado em Leads';
    case 'listar_horarios_experimental':
      return 'Consultaria os horários livres da aula experimental';
    case 'agendar_experimental':
      return 'Agendaria a aula experimental (no teste, nada é agendado)';
    case 'cancelar_experimental':
      return 'Cancelaria a aula experimental da pessoa';
    case 'transferir_para_humano':
      return `Passaria a conversa para a equipe: ${String(input.motivo ?? '')}`;
    default:
      return name;
  }
}

export function KnowledgeTest({ items, onClose }: { items: KnowledgeItem[]; onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState('');
  const [result, setResult] = useState<AgentTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setAsked(question.trim());
      setResult(await api.testAgent(question.trim(), items));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível testar agora.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel kb-panel" aria-labelledby="teste-titulo">
      <div className="panel-head">
        <h2 id="teste-titulo">Testar a IA</h2>
        <button className="quiet" onClick={onClose}>
          Fechar
        </button>
      </div>
      <p className="hint">
        Pergunte como um cliente perguntaria no WhatsApp. A IA responde com o que está no editor agora, mesmo sem
        salvar. Nada é registrado, agendado nem enviado para a equipe.
      </p>
      <form className="test-form" onSubmit={(e) => void ask(e)}>
        <label className="grow">
          <span className="sr-only">Pergunta</span>
          <input
            required
            minLength={2}
            maxLength={500}
            placeholder="Ex.: quanto ta a mensalidade?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <button className="primary" disabled={busy || question.trim().length < 2}>
          {busy ? 'Perguntando…' : 'Perguntar'}
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="chat" aria-live="polite">
          <p className="bubble in">{asked}</p>
          {result.reply && <p className="bubble out">{result.reply}</p>}
          {result.handoff && (
            <div className="handoff-note">
              <span className="strong">A IA passaria para a equipe.</span> {result.handoff.reason}
              {result.handoff.question && (
                <span className="block sub">
                  Iria para "Perguntas que a IA não soube responder": {result.handoff.question}
                </span>
              )}
            </div>
          )}
          {result.toolCalls.some((c) => c.name !== 'transferir_para_humano') && (
            <ul className="plain sub">
              {result.toolCalls
                .filter((c) => c.name !== 'transferir_para_humano')
                .map((c, n) => (
                  <li key={n}>{describeTool(c.name, c.input)}</li>
                ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
