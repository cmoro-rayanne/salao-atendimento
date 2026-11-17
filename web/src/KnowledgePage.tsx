import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type KnowledgeItem, type KnowledgeVersion, type Me } from './api';
import { KnowledgeHistory } from './KnowledgeHistory';
import { KnowledgeImport } from './KnowledgeImport';
import { KnowledgeTest } from './KnowledgeTest';

const MAX_TOTAL = 30_000;
const STARTER: KnowledgeItem[] = [
  { category: 'Endereço e estacionamento', content: '', active: true },
  { category: 'Horário de funcionamento e da recepção', content: '', active: true },
  { category: 'Formas de pagamento', content: '', active: true },
  { category: 'Política de cancelamento e atraso', content: '', active: true },
  { category: 'Cuidados antes e depois dos serviços', content: '', active: true },
  { category: 'Regras do salão', content: '', active: true },
];

interface Row extends KnowledgeItem {
  key: string;
}

let seq = 0;
const withKey = (i: KnowledgeItem): Row => ({ ...i, key: `k${++seq}` });

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

type Panel = 'historico' | 'importar' | 'testar' | null;

const PANELS: Array<{ id: Exclude<Panel, null>; label: string }> = [
  { id: 'testar', label: 'Testar a IA' },
  { id: 'importar', label: 'Importar documento' },
  { id: 'historico', label: 'Histórico' },
];

export function KnowledgePage({ me }: { me: Me }) {
  const [query, setQuery] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<{
    kind: 'ok' | 'error' | 'conflict';
    text: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setStatus(null);
    try {
      const kb = await api.getKnowledge();
      setVersion(kb.version);
      setRows(kb.items.map(withKey));
      setDirty(false);
    } catch (err) {
      setStatus({
        kind: 'error',
        text: err instanceof ApiError ? err.message : 'Não foi possível carregar a base.',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const used = useMemo(
    () => rows.filter((r) => r.active).reduce((n, r) => n + r.category.trim().length + r.content.trim().length, 0),
    [rows],
  );

  function update(key: string, patch: Partial<KnowledgeItem>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
    setStatus(null);
  }

  function remove(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
    setDirty(true);
  }

  function move(key: string, delta: -1 | 1) {
    setRows((rs) => {
      const i = rs.findIndex((r) => r.key === key);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
    setDirty(true);
    // Mantém o foco no botão que a pessoa usou, que agora está no item na nova posição.
    requestAnimationFrame(() => document.getElementById(`mv-${delta}-${key}`)?.focus());
  }

  function loadVersion(v: KnowledgeVersion) {
    setRows(v.items.map(withKey));
    setDirty(true);
    setPanel(null);
    setQuery('');
    setStatus({
      kind: 'ok',
      text: `Versão ${v.version} carregada no editor. Salve para a IA passar a usar.`,
    });
  }

  function loadImported(items: KnowledgeItem[]) {
    setRows(items.map(withKey));
    setDirty(true);
    setPanel(null);
    setQuery('');
    setStatus({ kind: 'ok', text: 'Documento carregado no editor. Revise e salve para a IA passar a usar.' });
  }

  function add(items: KnowledgeItem[]) {
    setRows((rs) => [...rs, ...items.map(withKey)]);
    setDirty(true);
  }

  async function save() {
    if (version === null) return;
    setSaving(true);
    try {
      const res = await api.saveKnowledge(version, rows);
      setVersion(res.version);
      setDirty(false);
      setStatus({
        kind: 'ok',
        text: 'Base salva. A IA já usa esta versão na próxima resposta.',
      });
    } catch (err) {
      const text = err instanceof ApiError ? err.message : 'Não foi possível salvar.';
      setStatus({
        kind: err instanceof ApiError && err.status === 409 ? 'conflict' : 'error',
        text,
      });
    } finally {
      setSaving(false);
    }
  }

  const q = norm(query.trim());
  const visible = q ? rows.filter((r) => norm(`${r.category} ${r.content}`).includes(q)) : rows;

  if (version === null) {
    return status ? <p className="error page-pad">{status.text}</p> : <p className="loading">Carregando a base…</p>;
  }

  return (
    <section className="page">
      <div className="page-head">
        <h1>O que a IA sabe</h1>
        <p className="hint">
          A IA responde só com o que está aqui. Escreva como você explicaria para alguém novo na recepção: preços com
          valores, horários com dias e horas. Itens desligados ficam guardados, mas a IA não usa.
        </p>
      </div>

      <div className="kb-toolbar">
        <label className="kb-search">
          <span className="sr-only">Buscar na base</span>
          <input
            type="search"
            placeholder="Buscar na base, ex.: estacionamento"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {PANELS.map((p) => (
          <button
            key={p.id}
            className={panel === p.id ? 'tool on' : 'tool'}
            aria-pressed={panel === p.id}
            onClick={() => setPanel(panel === p.id ? null : p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {panel === 'testar' && <KnowledgeTest items={rows} onClose={() => setPanel(null)} />}
      {panel === 'importar' && (
        <KnowledgeImport editorCount={rows.length} role={me.role} onUse={loadImported} onClose={() => setPanel(null)} />
      )}
      {panel === 'historico' && (
        <KnowledgeHistory
          current={rows}
          currentVersion={version}
          timeZone={me.timeZone}
          onLoad={loadVersion}
          onClose={() => setPanel(null)}
        />
      )}

      {rows.length > 3 && !q && (
        <nav className="kb-index" aria-label="Assuntos da base">
          {rows.map((r, n) => (
            <a key={r.key} href={`#kb-${r.key}`} className={r.active ? undefined : 'off'}>
              {r.category.trim() || `Assunto ${n + 1}`}
            </a>
          ))}
        </nav>
      )}

      {q && (
        <p className="hint" role="status">
          {visible.length === 0
            ? `Nada na base fala de "${query.trim()}". Se a IA receber essa pergunta, vai passar para a equipe.`
            : `${visible.length} de ${rows.length} assuntos falam de "${query.trim()}".`}{' '}
          <button className="link" onClick={() => setQuery('')}>
            Limpar busca
          </button>
        </p>
      )}

      {rows.length === 0 && (
        <div className="empty">
          <p>A base está vazia, então a IA vai passar toda pergunta para a equipe.</p>
          <button className="primary" onClick={() => add(STARTER)}>
            Começar com os tópicos mais perguntados
          </button>
        </div>
      )}

      <ol className="kb-list">
        {visible.map((r) => {
          const pos = rows.indexOf(r);
          return (
            <li key={r.key} id={`kb-${r.key}`} className={r.active ? 'kb-item' : 'kb-item off'}>
              <input
                className="kb-category"
                aria-label="Assunto"
                placeholder="Assunto, ex.: Planos e preços"
                value={r.category}
                onChange={(e) => update(r.key, { category: e.target.value })}
              />
              <textarea
                aria-label={`Conteúdo de ${r.category || 'item'}`}
                placeholder="O que a IA deve saber sobre este assunto"
                rows={Math.min(12, Math.max(3, r.content.split('\n').length + 1))}
                value={r.content}
                onChange={(e) => update(r.key, { content: e.target.value })}
              />
              <div className="kb-actions">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={r.active}
                    onChange={(e) => update(r.key, { active: e.target.checked })}
                  />
                  {r.active ? 'A IA usa este item' : 'Desligado'}
                </label>
                <span className="kb-item-tools">
                  {!q && (
                    <>
                      <button
                        id={`mv--1-${r.key}`}
                        className="icon-btn small"
                        aria-label={`Subir ${r.category || 'item'}`}
                        disabled={pos === 0}
                        onClick={() => move(r.key, -1)}
                      >
                        ↑
                      </button>
                      <button
                        id={`mv-1-${r.key}`}
                        className="icon-btn small"
                        aria-label={`Descer ${r.category || 'item'}`}
                        disabled={pos === rows.length - 1}
                        onClick={() => move(r.key, 1)}
                      >
                        ↓
                      </button>
                    </>
                  )}
                  <button className="quiet danger" onClick={() => remove(r.key)}>
                    Remover
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      {rows.length > 0 && !q && (
        <button className="add" onClick={() => add([{ category: '', content: '', active: true }])}>
          Adicionar assunto
        </button>
      )}

      <div className="savebar" role="region" aria-label="Salvar base">
        <div className="budget" title="Quanto da base a IA lê a cada resposta">
          <div className="budget-track">
            <div
              className={used > MAX_TOTAL ? 'budget-fill over' : 'budget-fill'}
              style={{ width: `${Math.min(100, (used / MAX_TOTAL) * 100)}%` }}
            />
          </div>
          <span>
            {used.toLocaleString('pt-BR')} de {MAX_TOTAL.toLocaleString('pt-BR')} caracteres
          </span>
          <span className="version">Versão {version}</span>
        </div>
        {status && (
          <p className={`status ${status.kind}`} role={status.kind === 'ok' ? 'status' : 'alert'}>
            {status.text}{' '}
            {status.kind === 'conflict' && (
              <button className="link" onClick={() => void load()}>
                Recarregar (descarta suas mudanças)
              </button>
            )}
          </p>
        )}
        <button className="primary" disabled={!dirty || saving || used > MAX_TOTAL} onClick={() => void save()}>
          {saving ? 'Salvando…' : dirty ? 'Salvar base' : 'Base salva'}
        </button>
      </div>
    </section>
  );
}
