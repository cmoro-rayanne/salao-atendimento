# whatsapp-ai-agent

Atendimento com IA no WhatsApp para academias — **RMoro Desenvolvimento**.

A IA tira dúvidas, registra leads, agenda aula experimental e passa para a equipe o que precisa de gente. A equipe atende pelo Chatwoot, no mesmo número oficial.

```
Cliente ⇄ WhatsApp Cloud API (Meta) ⇄ Chatwoot ⇄ agent-api / agent-worker ⇄ LLM
                                         ⇅                 ⇅
                                  Equipe da academia   Postgres · Redis (BullMQ)
```

Arquitetura completa em [`docs/arquitetura.md`](docs/arquitetura.md); specs em [`docs/specs/`](docs/specs).

## Rodando localmente

```bash
nvm use
npm install
cp .env.example .env          # preencha as variáveis
docker run -d -p 5432:5432 -e POSTGRES_USER=agent -e POSTGRES_PASSWORD=agent -e POSTGRES_DB=agent postgres:16-alpine
docker run -d -p 6379:6379 redis:7-alpine
npm run migrate
npm run dev                   # API em http://localhost:3000
npm run dev:worker            # em outro terminal
```

No Chatwoot, crie um **Agent Bot** com a URL `http://<host-do-agente>:3000/webhooks/chatwoot/<WEBHOOK_SECRET>` e ligue-o à caixa de entrada do WhatsApp.

## Deploy

Guia completo, da VPS vazia à primeira mensagem respondida: [`deploy/README.md`](deploy/README.md). Resumo: o CI publica a imagem no GitHub Container Registry a cada merge no `dev`; na VPS, `deploy/deploy.sh <tag>` atualiza e volta sozinho se a versão nova não ficar saudável. Backup diário dos bancos já vem no compose.

## Cadastrar uma academia

O agente só responde contas do Chatwoot cadastradas como academia (tenant). Exemplo:

```sql
insert into tenants (name, chatwoot_account_id) values ('Cia da Forma', 1);
insert into knowledge_items (tenant_id, category, content) values
  (1, 'Planos', 'Mensal: R$ ...'),
  (1, 'Horários', 'Segunda a sexta ...');
-- Ao mudar a base, incremente a versão para rastrear qual versão cada resposta usou:
update tenants set knowledge_version = knowledge_version + 1 where id = 1;
```

Depois, crie o acesso da academia ao painel, onde ela edita a base e a grade sem SQL:

```bash
ADMIN_PASSWORD='uma-senha-forte' npm run admin:create -- --tenant 1 --email recepcao@academia.com.br --role recepcao
# em produção, dentro do container: node dist/scripts/create-admin.js ...
```

## Painel

React + Vite em `web/`. Em desenvolvimento: `npm run dev` (API) e `npm run dev:web` (painel em http://localhost:5173, com proxy para a API). Em produção, `npm run build:web` gera `web/dist`, servido pelo `agent-api` em `painel.<domínio>`.

## Testes e avaliação

```bash
npm test                                   # unitários
TEST_DATABASE_URL=... TEST_REDIS_URL=... npm test   # + integração com Postgres e Redis reais
LLM_API_KEY=... npm run eval               # avaliação do prompt contra o LLM (eval/casos.json)
```

`eval/base-exemplo.json` é uma base fictícia; troque pelos dados reais da academia e complete `eval/casos.json` com perguntas reais.

## Estado atual

- Fase 1 (fundação): webhook validado e idempotente, agrupamento de mensagens pela fila.
- Fase 2 (agente): IA da Anthropic com cache de prompt, base de conhecimento por academia, `registrar_lead`, `transferir_para_humano`, lock por conversa, registro de cada execução em `agent_runs` e transferência automática quando algo falha.

- Painel (spec 0004): login, edição da base de conhecimento com controle de versão e grade da aula experimental.

- Agendamento (spec 0003): a IA lista horários livres, agenda e cancela a aula experimental, com lembrete na véspera por template do WhatsApp.

- Painel completo (spec 0005): leads com funil e situação, aulas agendadas com presença, relatório mensal com PDF.

- LGPD e proteção (spec 0006): SAIR/VOLTAR para lembretes, aviso de atendimento automatizado com link de privacidade (`tenants.privacy_url`), limite de mensagens por conversa e alertas de falha por webhook (`ALERT_WEBHOOK_URL`).

Antes do go-live: criar e aprovar o template `lembrete_aula_experimental` no WhatsApp Manager (texto em `docs/specs/0003-agendamento-experimental.md`).
