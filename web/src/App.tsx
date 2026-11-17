import { useEffect, useState } from 'react';
import { api, type Me } from './api';
import { AgendaPage } from './AgendaPage';
import { KnowledgePage } from './KnowledgePage';
import { ClientsPage } from './ClientsPage';
import { LoginPage } from './LoginPage';
import { PasswordPage } from './PasswordPage';
import { ProfessionalsPage } from './ProfessionalsPage';
import { ReportPage } from './ReportPage';
import { ServicesPage } from './ServicesPage';
import { SettingsPage } from './SettingsPage';

const TABS = [
  { id: 'agenda', label: 'Agenda' },
  { id: 'servicos', label: 'Serviços' },
  { id: 'profissionais', label: 'Profissionais' },
  { id: 'clientes', label: 'Clientes' },
  { id: 'base', label: 'O que a IA sabe' },
  { id: 'relatorio', label: 'Relatório' },
  { id: 'config', label: 'Configurações', ownerOnly: true },
] as const;
type Tab = (typeof TABS)[number]['id'] | 'senha';

function tabFromHash(): Tab {
  const id = location.hash.slice(1);
  if (id === 'senha') return 'senha';
  return TABS.find((t) => t.id === id)?.id ?? 'agenda';
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>(tabFromHash);

  useEffect(() => {
    api.me().then(setMe, () => setMe(null));
    const expired = () => setMe(null);
    window.addEventListener('painel:sessao-expirada', expired);
    return () => window.removeEventListener('painel:sessao-expirada', expired);
  }, []);

  useEffect(() => {
    history.replaceState(null, '', `#${tab}`);
  }, [tab]);

  if (me === undefined) return <p className="loading">Carregando…</p>;
  if (me === null) return <LoginPage onLogin={setMe} />;

  async function logout() {
    await api.logout().catch(() => undefined);
    setMe(null);
  }

  if (me.mustChangePassword) {
    return (
      <PasswordPage
        forced
        email={me.email}
        onLogout={() => void logout()}
        onDone={() => void api.me().then(setMe, () => setMe(null))}
      />
    );
  }

  const tabs = TABS.filter((t) => !('ownerOnly' in t) || me.role === 'dono');
  const current = tab === 'config' && me.role !== 'dono' ? 'agenda' : tab;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Atendimento com IA</span>
        <nav className="tabs" aria-label="Seções do painel">
          {tabs.map((t) => (
            <button key={t.id} aria-current={current === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="account">
          <button className="quiet" aria-current={current === 'senha' ? 'page' : undefined} onClick={() => setTab('senha')} title={me.email}>
            Minha senha
          </button>
          <button className="quiet" onClick={logout} title={me.email}>
            Sair
          </button>
        </div>
      </header>
      <main>
        {current === 'agenda' && <AgendaPage me={me} />}
        {current === 'servicos' && <ServicesPage me={me} />}
        {current === 'profissionais' && <ProfessionalsPage me={me} />}
        {current === 'clientes' && <ClientsPage me={me} />}
        {current === 'base' && <KnowledgePage me={me} />}
        {current === 'relatorio' && <ReportPage me={me} />}
        {current === 'config' && <SettingsPage />}
        {current === 'senha' && <PasswordPage forced={false} email={me.email} onDone={() => undefined} />}
      </main>
    </div>
  );
}
