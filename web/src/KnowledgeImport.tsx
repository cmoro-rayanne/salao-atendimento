import { useState, type ChangeEvent } from 'react';
import { api, ApiError, type ImportPreview, type KnowledgeItem, type Role } from './api';


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
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setPreview(null);
    setFileName(file.name);
    if (file.size > 200_000) return setError('Arquivo grande demais para ser o documento da base (máx. 200 KB).');
    const text = await file.text();
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
