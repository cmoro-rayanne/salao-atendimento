import { useState, type ChangeEvent } from 'react';
import { api, ApiError, type ImportPreview, type KnowledgeItem, type Role } from './api';

const DAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const clock = (t: { hour: number; minute: number }) => `${t.hour}h${t.minute ? String(t.minute).padStart(2, '0') : ''}`;

export function KnowledgeImport({
  editorCount,
  role,
  onUse,
  onClose,
}: {
  editorCount: number;
  role: Role;
  onUse: (items: KnowledgeItem[]) => void;
  onClose: () => void;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setPreview(null);
    setSchedule(null);
    setFileName(file.name);
    if (file.size > 200_000) return setError('Arquivo grande demais para ser o documento da base (máx. 200 KB).');
    const text = await file.text();
    setMarkdown(text);
    setBusy(true);
    try {
      setPreview(await api.previewImport(text));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível ler o arquivo.');
    } finally {
      setBusy(false);
    }
  }

  function use() {
    if (!preview) return;
    if (
      editorCount > 0 &&
      !confirm(
        `Trocar os ${editorCount} assuntos do editor pelos ${preview.items.length} do documento? Nada é salvo até você clicar em Salvar base.`,
      )
    )
      return;
    onUse(preview.items.map((i) => ({ ...i, active: true })));
  }

  async function createSlots() {
    if (!markdown) return;
    setBusy(true);
    setSchedule(null);
    try {
      const r = await api.importSchedule(markdown);
      setSchedule(
        r.created === 0
          ? 'Esses horários já estavam na grade.'
          : `${r.created} horários criados na Grade da experimental${r.skipped ? ` (${r.skipped} já existiam)` : ''}.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar os horários.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel kb-panel" aria-labelledby="imp-titulo">
      <div className="panel-head">
        <h2 id="imp-titulo">Importar o documento da base</h2>
        <button className="quiet" onClick={onClose}>
          Fechar
        </button>
      </div>
      <p className="hint">
        No documento "Base de conhecimento da IA", use Exportar → Markdown e envie o arquivo aqui. Você vê o que entra
        antes de usar; nada é salvo sozinho.
      </p>
      <label className="file-pick">
        <span className="tool">{fileName ? 'Escolher outro arquivo' : 'Escolher arquivo .md'}</span>
        <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={(e) => void pick(e)} />
        {fileName && <span className="sub">{fileName}</span>}
      </label>
      {busy && <p className="hint">Lendo…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {preview && (
        <div className="import-result">
          {preview.items.length === 0 ? (
            <p className="error">O documento ainda não tem nada preenchido para a IA.</p>
          ) : (
            <div className="import-block">
              <h3>
                {preview.items.length} {preview.items.length === 1 ? 'assunto' : 'assuntos'} para a IA
              </h3>
              <p className="sub">{preview.items.map((i) => i.category).join(', ')}</p>
              <button className="primary" onClick={use}>
                Usar no editor
              </button>
            </div>
          )}

          {preview.trialRules.length > 0 && (
            <div className="import-block">
              <h3>Grade da experimental</h3>
              <ul className="plain">
                {preview.trialRules.map((r, n) => (
                  <li key={n}>
                    {r.modality}: {r.weekdays.map((d) => DAYS[d]).join('/')} {r.times.map(clock).join(', ')} (
                    {r.capacity} vagas)
                  </li>
                ))}
              </ul>
              <button className="tool" disabled={busy} onClick={() => void createSlots()}>
                Criar {preview.slotCount} horários (próximas 4 semanas)
              </button>
              {schedule && (
                <p className="status ok" role="status">
                  {schedule}
                </p>
              )}
            </div>
          )}

          {preview.receptionHours && (
            <div className="import-block">
              <h3>Horário da recepção</h3>
              <p>
                Dias úteis, {preview.receptionHours.open}h às {preview.receptionHours.close}h.{' '}
                {role === 'dono' ? <a href="#config">Conferir em Configurações</a> : 'O dono confere em Configurações.'}
              </p>
            </div>
          )}

          {preview.warnings.length > 0 && (
            <div className="import-block">
              <h3>Avisos</h3>
              <ul className="plain">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {preview.pending.length > 0 && (
            <details className="import-block">
              <summary>
                {preview.pending.length} campos ainda sem preencher (a IA vai passar essas perguntas para a equipe)
              </summary>
              <ul className="plain">
                {preview.pending.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
