import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Client, type Me } from './api';
import { fmt, formatPhone } from './format';

export function ClientsPage({ me }: { me: Me }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [clients, setClients] = useState<Client[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    try {
      setClients((await api.listClients(debounced)).clients);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível carregar os clientes.');
    }
  }, [debounced]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="page">
      <div className="page-head">
        <h1>Clientes</h1>
        <p className="hint">
          Quem já falou com o salão pelo WhatsApp ou foi agendado pela recepção. A IA guarda o nome durante a conversa; os atendimentos e as faltas vêm do que você marca na Agenda.
        </p>
      </div>

      <div className="filters">
        <label className="grow">
          Buscar por nome ou telefone
          <input type="search" placeholder="Ex.: Maria ou 99999" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <p className="hint shown">
          {clients && `${clients.length} ${clients.length === 1 ? 'cliente' : 'clientes'}`}
          {clients && clients.length >= 200 && ' (mostrando os 200 mais recentes)'}
        </p>
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      {!clients ? (
        <p className="loading">Carregando os clientes…</p>
      ) : clients.length === 0 ? (
        <div className="empty">
          <p>
            {query
              ? 'Nenhum cliente com essa busca. Confira o nome ou os números do telefone.'
              : 'Nenhum cliente ainda. Eles aparecem aqui assim que a IA conversar com alguém ou a recepção agendar.'}
          </p>
        </div>
      ) : (
        <div className="table-box">
          <table className="data-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Telefone</th>
                <th>Próximo horário</th>
                <th>Atendimentos</th>
                <th>Faltas</th>
                <th>
                  <span className="sr-only">Conversa</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td className="strong">
                    {c.name ?? 'Sem nome informado'}
                    {c.optedOut && <span className="block sub">Pediu para não receber mensagens</span>}
                  </td>
                  <td className="nowrap num">{formatPhone(c.phone)}</td>
                  <td>
                    {c.nextAppointment ? (
                      <>
                        <span className="block">
                          {fmt(c.nextAppointment.startsAt, me.timeZone, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span className="block sub">
                          {c.nextAppointment.serviceName} com {c.nextAppointment.professionalName}
                        </span>
                      </>
                    ) : (
                      <span className="sub">Nada marcado</span>
                    )}
                  </td>
                  <td className="num">{c.completed}</td>
                  <td className="num">{c.noShows}</td>
                  <td className="nowrap right">
                    {me.chatwootAccountUrl && c.chatwootContactId && (
                      <a href={`${me.chatwootAccountUrl}/contacts/${c.chatwootContactId}`} target="_blank" rel="noreferrer">
                        Abrir no Chatwoot
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
