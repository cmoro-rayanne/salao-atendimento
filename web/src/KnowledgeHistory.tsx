import { useEffect, useState } from 'react';
import { api, ApiError, type KnowledgeItem, type KnowledgeVersion, type KnowledgeVersionSummary } from './api';
import { fmt } from './format';

interface Change {
  kind: 'novo' | 'removido' | 'alterado';
  category: string;
}

/** O que muda no editor se esta versão for carregada, por assunto. */
export function diffItems(current: KnowledgeItem[], other: KnowledgeItem[]): Change[] {
  const key = (i: KnowledgeItem) => i.category.trim().toLowerCase();
  const now = new Map(current.map((i) => [key(i), i]));
  const then = new Map(other.map((i) => [key(i), i]));
  const changes: Change[] = [];
  for (const [k, i] of then) {
    const c = now.get(k);
    if (!c) changes.push({ kind: 'novo', category: i.category });
    else if (c.content.trim() !== i.content.trim() || c.active !== i.active)
      changes.push({ kind: 'alterado', category: i.category });
  }
  for (const [k, c] of now) if (!then.has(k)) changes.push({ kind: 'removido', category: c.category });
  return changes;
}

const CHANGE_LABEL: Record<Change['kind'], string> = {
  novo: 'Volta',
  removido: 'Sai',
  alterado: 'Muda',
};

export function KnowledgeHistory({
  current,
  currentVersion,
  timeZone,
  onLoad,
  onClose,
}: {
  current: KnowledgeItem[];
  currentVersion: number;
  timeZone: string | undefined;
  onLoad: (v: KnowledgeVersion) => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<KnowledgeVersionSummary[] | null>(null);
  const [open, setOpen] = useState<KnowledgeVersion | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listVersions().then(
      (r) => setVersions(r.versions),
      (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar o histórico.'),
    );
  }, [currentVersion]);

  async function view(v: number) {
    setError(null);
    try {
      setOpen(await api.getVersion(v));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível abrir a versão.');
    }
  }

  const changes = open ? diffItems(current, open.items) : [];

  return (
    <section className="panel kb-panel" aria-labelledby="hist-titulo">
      <div className="panel-head">
        <h2 id="hist-titulo">Histórico da base</h2>
        <button className="quiet" onClick={onClose}>
          Fechar
        </button>
      </div>
      <p className="hint">
        Cada vez que alguém salva, a versão anterior fica guardada aqui. Carregar uma versão só muda o editor; ela vale
        para a IA quando você salvar.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {versions === null && !error && <p className="hint">Carregando…</p>}
      {versions && (
        <ul className="versions">
          {versions.map((v) => (
            <li key={v.version} className={open?.version === v.version ? 'version-row on' : 'version-row'}>
              <span className="strong">
                Versão {v.version}
                {v.version === currentVersion && <span className="tag">em uso</span>}
              </span>
              <span className="sub">
                {fmt(v.createdAt, timeZone, {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                , por {v.author}
              </span>
              <span className="sub">
                {v.itemCount} {v.itemCount === 1 ? 'assunto' : 'assuntos'}
              </span>
              <button
                className="quiet"
                onClick={() => void view(v.version)}
                aria-expanded={open?.version === v.version}
              >
                Ver
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="version-detail">
          <h3>Versão {open.version} comparada com o editor</h3>
          {changes.length === 0 ? (
            <p className="hint">Igual ao que está no editor agora.</p>
          ) : (
            <ul className="changes">
              {changes.map((c) => (
                <li key={`${c.kind}-${c.category}`}>
                  <span className={`change ${c.kind}`}>{CHANGE_LABEL[c.kind]}</span> {c.category || '(sem assunto)'}
                </li>
              ))}
            </ul>
          )}
          <details>
            <summary>Ver o texto desta versão</summary>
            {open.items.map((i, n) => (
              <div key={n} className={i.active ? 'version-item' : 'version-item off'}>
                <span className="strong">{i.category}</span>
                {!i.active && <span className="sub"> (desligado)</span>}
                <p>{i.content}</p>
              </div>
            ))}
          </details>
          <button className="primary" disabled={changes.length === 0} onClick={() => onLoad(open)}>
            Carregar a versão {open.version} no editor
          </button>
        </div>
      )}
    </section>
  );
}
