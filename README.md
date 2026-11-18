# salao-atendimento

Atendimento com IA no WhatsApp e agenda para salões de beleza — **RMoro Desenvolvimento**.

A IA tira dúvidas, agenda, remarca e cancela serviços, avisa o cliente na véspera e passa para a equipe o que precisa de gente. A equipe atende pelo Chatwoot, no mesmo número oficial.

```
Cliente ⇄ WhatsApp Cloud API (Meta) ⇄ Chatwoot ⇄ agent-api / agent-worker ⇄ LLM
                                         ⇅                 ⇅
                                  Equipe do salão   Postgres · Redis (BullMQ)
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

## Cadastrar um salão

O agente só responde contas do Chatwoot cadastradas como salão (tenant). Exemplo:

```sql
insert into tenants (name, chatwoot_account_id) values ('Studio Aurora', 1);
insert into knowledge_items (tenant_id, category, content) values
  (1, 'Planos', 'Mensal: R$ ...'),
  (1, 'Horários', 'Segunda a sexta ...');
-- Ao mudar a base, incremente a versão para rastrear qual versão cada resposta usou:
update tenants set knowledge_version = knowledge_version + 1 where id = 1;
```

Depois, crie o acesso do salão ao painel, onde ele edita a base, os serviços, os profissionais e a agenda sem SQL:

```bash
ADMIN_PASSWORD='uma-senha-forte' npm run admin:create -- --tenant 1 --email recepcao@salao.com.br --role recepcao
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

`eval/base-exemplo.json` é uma base fictícia; troque pelos dados reais do salão e complete `eval/casos.json` com perguntas reais.

## Estado atual

Spec 0013 (`docs/specs/0013-agenda-salao.md`):

- Agenda: serviços, profissionais, horários de atendimento e folgas; os horários livres são calculados e um EXCLUDE no Postgres impede sobreposição.
- IA: consulta horários, agenda, remarca e cancela pelo WhatsApp; transfere para a equipe o que foge disso.
- Lembrete: na véspera às 18h (horário do salão) ou 3 horas antes, por template do WhatsApp. Agendamentos criados só no painel não têm conversa e, por isso, não recebem lembrete.
- Painel: agenda do dia, serviços e profissionais (só o dono edita), clientes, base de conhecimento e relatório mensal.
- Herdado da academia: LGPD (SAIR/VOLTAR, aviso de atendimento automatizado), limite de mensagens, alertas por webhook, deploy e importação do documento da base.

Antes do go-live: aprovar o template `lembrete_agendamento` no WhatsApp Manager (`{{1}}` nome, `{{2}}` serviço, `{{3}}` profissional, `{{4}}` data e hora).

Aviso de atraso (spec 0014): aprovar também o template `aviso_atraso` (`{{1}}` nome, `{{2}}` serviço, `{{3}}` minutos de atraso, `{{4}}` novo horário previsto; nome configurável em `APPOINTMENT_DELAY_TEMPLATE_NAME`). Texto sugerido: "Oi, {{1}}! Estamos com cerca de {{3}} minutos de atraso e seu horário de {{2}} passa a ser por volta das {{4}}. Você consegue chegar nesse horário? Se preferir, responda por aqui para remarcar, inclusive para um horário mais cedo."

Salão fictício para testes: `DATABASE_URL=... npm run salao:seed -- --tenant 1` (serviços, duas profissionais e expediente de `seed/salao-ficticio.json`; só carrega se o salão ainda não tiver serviços).

A migration `011_limpeza_academia.sql` apaga `trial_bookings`, `trial_slots` e as colunas de lead da academia (`goal`, `modality`, `status`, `enrolled_at`). É destrutiva: não rode em banco com dados da academia sem backup.
