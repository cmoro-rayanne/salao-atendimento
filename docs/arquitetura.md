> **Atenção:** este documento foi escrito para a academia (Cia da Forma). No salão, `trial-classes` virou `appointments` e `trial_slots`/`trial_bookings` viraram serviços, profissionais e agendamentos; o que mudou está em `docs/specs/0013-agenda-salao.md`.

# Arquitetura — Atendimento com IA no WhatsApp

Versão viva (com diagrama e comentários): https://claude.ai/artifact/R8fAJFNCCBQbzCDENvA9v3 · 13/11/2026 · Rayanne Carvalho Moro

## Visão geral

O Chatwoot fica no meio: recebe tudo do número oficial, entrega ao agente as conversas que estão com o bot e à equipe as que foram transferidas.

```
Cliente ⇄ WhatsApp Cloud API (Meta) ⇄ Chatwoot ⇄ Serviço do agente (Node.js + TypeScript) ⇄ API do LLM
                                          ⇅                     ⇅
                                  Equipe da academia    PostgreSQL · Redis + BullMQ
                                  (app do Chatwoot)
                     └──────────── VPS · Docker Compose ────────────┘
```

O serviço do agente é o único código nosso; o resto é software pronto rodando na mesma VPS.

## Componentes e stack

O núcleo é um serviço próprio em **Node.js + TypeScript**, e a equipe atende pelo **Chatwoot**, uma caixa de entrada open source ligada ao número oficial. Assim a IA e as pessoas usam o mesmo número sem conflito.

| Componente | Tecnologia | Responsabilidade |
| --- | --- | --- |
| Canal | WhatsApp Cloud API (Meta) | Receber e entregar mensagens no número oficial da academia |
| Caixa de entrada | Chatwoot (self-hosted) | Histórico das conversas, contatos, atendimento humano e templates |
| Agente | Node.js LTS + TypeScript strict (Fastify) | Recebe eventos do Chatwoot, conversa com a IA, executa as ferramentas e responde |
| Fila e jobs | Redis + BullMQ | Processamento assíncrono, agrupamento de mensagens, retentativas, lembretes agendados |
| Banco | PostgreSQL | Leads, aulas experimentais, base de conhecimento, execuções da IA |
| Modelo de IA | API de LLM com tool use (modelo leve, ex.: Claude Haiku) | Entender a mensagem e decidir resposta ou ferramenta |
| Proxy | Caddy | HTTPS automático e roteamento |

Isso substitui o n8n citado na proposta: o fluxo tem regras de negócio (agendamento, idempotência, transferência) que ficam melhor em código testado. O cliente não percebe diferença.

**Estrutura do serviço** (hexagonal, um módulo por domínio):

```text
src/
  modules/
    conversation/   # evento recebido -> job; agrupamento; lock por conversa
    agent/          # loop da IA, prompt, definição das ferramentas
    leads/          # commands e queries de leads
    trial-classes/  # horários livres, agendamento, lembretes
    knowledge/      # base de conhecimento da academia
    handoff/        # transferência para humano
  adapters/
    chatwoot/       # cliente HTTP + validação dos webhooks (Zod)
    llm/            # porta LlmClient + implementação do provedor
    queue/          # BullMQ
    db/             # repositórios + migrations
  config/           # env validado com Zod
  http/             # rotas Fastify, middleware de erros, healthcheck
```

A regra de negócio não importa Chatwoot, BullMQ nem o SDK do LLM: tudo entra por portas, o que permite trocar o provedor de IA ou a caixa de entrada sem reescrever o domínio.

## Fluxo de uma mensagem

O webhook responde 200 na hora e todo o trabalho acontece num worker, para a Meta e o Chatwoot nunca reenviarem por timeout.

1. **Cliente envia** a mensagem; a Meta entrega ao Chatwoot, que grava e dispara o evento `message_created` para o agente (conversas novas ficam com status `pending`, ou seja, com o bot).
2. **Rota `POST /webhooks/chatwoot/:secret`** valida o segredo com `crypto.timingSafeEqual`, valida o payload com Zod e ignora o que não for mensagem recebida de conversa `pending`.
3. **Idempotência:** grava o id do evento em `processed_events` (PK); se já existe, devolve 200 e para.
4. **Agrupamento:** enfileira um job BullMQ deduplicado por conversa, com atraso de ~4 s, para juntar mensagens enviadas em sequência ("oi" + "quanto custa?") numa resposta só.
5. **Worker** pega um lock por conversa no Redis (TTL), carrega as últimas mensagens pela API do Chatwoot, o lead e a base de conhecimento.
6. **Loop da IA** (no máximo 5 passos): o modelo responde em texto ou chama uma ferramenta; cada ferramenta é um command do domínio, idempotente.
7. **Resposta** sai pela API do Chatwoot, que entrega via Meta; a execução é registrada em `agent_runs`.
8. **Falha:** 3 tentativas com backoff exponencial; depois o job vai para a DLQ, o cliente recebe "já vou te passar para a equipe" e a conversa é transferida.

## Agente de IA

A IA só responde com o que está na base de conhecimento e age apenas por ferramentas; tudo o que muda dados passa pelo domínio, nunca por texto livre do modelo.

**Prompt de sistema:** papel (atendente da Cia da Forma), tom (simpático, frases curtas, sem emojis em excesso), regras (não inventar preço, horário ou política; na dúvida, transferir) e a base de conhecimento inteira. A base é pequena (algumas páginas), então vai toda no prompt com cache de prompt, sem necessidade de busca vetorial.

| Ferramenta | O que faz | Regra |
| --- | --- | --- |
| `registrar_lead` | Salva nome, objetivo e modalidade de interesse | Upsert pelo telefone; idempotente |
| `listar_horarios_experimental` | Devolve os próximos horários livres | Só leitura (query) |
| `agendar_experimental` | Reserva um horário e agenda o lembrete | UNIQUE (slot, lead); falha se o horário lotou |
| `cancelar_experimental` | Cancela e remove o lembrete | Só aulas do próprio contato |
| `transferir_para_humano` | Passa a conversa para a equipe com um motivo | Sempre disponível |

**Limites:**

- No máximo 5 chamadas de ferramenta por mensagem; passou disso, transfere.
- Matrícula, pagamento, reclamação, cancelamento de plano, saúde/lesão e pedido explícito de falar com alguém sempre transferem.
- Fora do horário da recepção, a IA avisa que a equipe responde no próximo turno.
- A base de conhecimento é editada pela academia (planilha ou painel simples) e versionada; toda resposta registra qual versão usou.
- Testes de avaliação: um conjunto de ~30 perguntas reais com resposta esperada roda no CI a cada mudança de prompt.

## Modelo de dados

O Chatwoot guarda conversas e mensagens; o banco do agente guarda só o domínio da academia e o rastro da IA. As tabelas de domínio têm `tenant_id`, para o mesmo serviço atender outras academias depois. Ver `src/adapters/db/migrations/001_init.sql`.

| Tabela | Campos principais | Restrições |
| --- | --- | --- |
| `tenants` | id, nome, horário da recepção, ids do Chatwoot | — |
| `leads` | id, tenant_id, chatwoot_contact_id, telefone, nome, objetivo, modalidade, status, version | UNIQUE (tenant_id, telefone); lock otimista por `version` |
| `trial_slots` | id, tenant_id, modalidade, início, vagas | — |
| `trial_bookings` | id, slot_id, lead_id, status, reminder_job_id | UNIQUE (slot_id, lead_id); vagas decrementadas com update atômico |
| `knowledge_items` | id, tenant_id, categoria, conteúdo, ativo, versão | — |
| `processed_events` | event_id, recebido_em | PK em event_id (idempotência) |
| `agent_runs` | id, conversation_id, modelo, tokens, custo, latência, ferramentas usadas, versão da base, erro | — |
| `handoffs` | id, conversation_id, motivo, criado_em | — |

Status do lead: `novo` → `qualificado` → `experimental_agendada` → `matriculado` ou `perdido`. Migrations versionadas; nada de alteração manual no banco de produção.

## Transferência para humano e lembretes

Transferir é só mudar o status da conversa no Chatwoot de `pending` para `open`: o bot para de responder e a conversa aparece para a equipe.

**Transferência:**

- O agente envia uma nota privada no Chatwoot com o resumo (nome, objetivo, motivo) e muda o status para `open`.
- A equipe recebe o aviso no app do Chatwoot (celular ou computador).
- Quando a equipe resolve a conversa, ela volta para o bot na próxima mensagem do cliente (comportamento a validar no Chatwoot na fase 1).
- O cliente pode pedir atendente a qualquer momento ("falar com alguém").

**Lembretes da aula experimental:**

- Ao agendar, cria um job BullMQ atrasado para a véspera, às 18h; o id do job fica em `trial_bookings` para poder cancelar.
- Se a última mensagem do cliente tem mais de 24 h, o WhatsApp só aceita **template aprovado** pela Meta (categoria utilidade, cobrado por mensagem). O lembrete usa sempre template, para não depender da janela.
- Templates previstos: lembrete da aula, confirmação de agendamento e retomada de contato (este último é marketing, mais caro, e só com autorização).

## Infraestrutura, deploy e ambientes

Tudo roda numa única VPS com Docker Compose (2 vCPU, 4–8 GB de RAM, ~R$ 80–120/mês), que depois pode atender outras academias. Ver `deploy/`.

| Serviço | Imagem | Exposto? |
| --- | --- | --- |
| caddy | caddy | Sim: 443 (domínio do Chatwoot) |
| chatwoot-web + chatwoot-sidekiq | chatwoot/chatwoot | Via Caddy |
| agent-api | imagem própria (Node LTS) | Não: só rede interna |
| agent-worker | mesma imagem, outro comando | Não |
| postgres | pgvector/pgvector (bancos separados: chatwoot e agent) | Não |
| redis | redis | Não |

- **Ambientes:** `staging` com o número de teste da Meta e `prod` com o número da academia; mesma imagem, só variáveis de ambiente diferentes.
- **CI (GitHub Actions):** lint, typecheck, testes, build e `npm audit`; depois, avaliação do prompt e deploy (staging automático, prod com aprovação manual).
- **Backup:** `pg_dump` diário para armazenamento externo, retenção de 30 dias, restauração testada uma vez por mês.
- **Config:** variáveis validadas com Zod na inicialização; segredos (token da Meta, chave do LLM, token do Chatwoot) só no `.env` do servidor, nunca no repositório.

## Segurança, LGPD e observabilidade

A academia é a controladora dos dados e a RMoro Desenvolvimento a operadora; isso vai num anexo do contrato.

**Segurança:**

- Webhook com segredo comparado por `crypto.timingSafeEqual`; agente fora da internet pública.
- Rate limit por contato (ex.: 20 mensagens/min no Redis) contra spam e gasto de IA.
- Respeitar 429 da Meta e do LLM com backoff + jitter.
- Limite de gasto mensal configurado no painel do provedor de IA.

**LGPD:**

- Primeira mensagem do bot avisa que é um atendimento automatizado e linka a política de privacidade.
- "SAIR" bloqueia mensagens ativas para aquele contato.
- Dados de clientes nunca entram em prompts de desenvolvimento nem em logs (telefone mascarado).
- Retenção proposta: conversas e leads inativos apagados após 12 meses (a confirmar com a academia).

**Observabilidade:**

- Logs estruturados (pino) com `correlationId` = id da conversa.
- Healthcheck `/health` + Uptime Kuma avisando no WhatsApp da RMoro se cair.
- Alerta a cada job na DLQ.
- Painel mensal a partir de `agent_runs`: conversas, transferências, aulas agendadas e custo de IA — é o relatório da proposta.

## Painel de gerenciamento

O painel é onde a academia cuida do que a IA usa e acompanha os resultados. As conversas continuam no Chatwoot, sem refazer a caixa de entrada.

| Tela | O que a academia faz | Prioridade |
| --- | --- | --- |
| Base de conhecimento | Edita preços, horários, modalidades e regras; cada salvamento gera uma nova versão | Go-live |
| Grade da experimental | Cria horários e vagas por modalidade | Go-live |
| Aulas agendadas | Vê quem vem e marca compareceu/faltou | Depois do go-live |
| Leads | Lista e funil (novo → agendada → matriculado/perdido), com link para a conversa no Chatwoot | Depois do go-live |
| Relatório | Conversas, transferências, aulas agendadas e custo de IA por mês | Depois do go-live |

**Como se encaixa:**

- **Frontend:** React + Vite + TypeScript na pasta `web/` do mesmo repositório; o build é servido pelo próprio `agent-api`, e o Caddy publica em `painel.<domínio>` bloqueando `/webhooks/*`.
- **API:** rotas `/admin/api/*` no próprio `agent-api`, separadas em commands (salvar base, criar horário) e queries (listas e relatório). O Caddy expõe só esse prefixo; o webhook continua interno.
- **Login:** e-mail e senha com hash scrypt (embutido no Node), sessão em cookie `HttpOnly` + `Secure` + `SameSite=Strict` guardada no Redis, 5 tentativas a cada 15 min e mensagem genérica no login. Papéis `dono` e `recepcao`; todo acesso filtra por `tenant_id`.
- **Dados novos:** `admin_users` (tenant_id, e-mail, hash, papel) e um campo de versão da base por tenant, que o agente lê a cada resposta.

O painel acrescenta 7 a 10 dias ao plano; para não atrasar o go-live, entram primeiro só a base de conhecimento e a grade.

## Plano de implementação

Quatro semanas, alinhadas ao cronograma da proposta; cada fase começa com uma spec curta em `docs/specs/` e termina com algo testável.

1. **Semana 1 — Fundação:** cadastro na Meta (WABA, número, templates), VPS + Compose + Caddy, Chatwoot conectado ao número de teste, repositório com CI e esqueleto hexagonal.
   - Pronto quando: mensagem no número de teste chega ao Chatwoot e o agente responde "eco".
2. **Semana 2 — Agente:** adapter do LLM, prompt, base de conhecimento, `registrar_lead`, `transferir_para_humano`.
   - Pronto quando: as 30 perguntas de avaliação passam e duplicatas não geram duas respostas.
3. **Semana 3 — Agendamento:** horários, agendar/cancelar experimental, lembretes por template, DLQ e alertas.
   - Pronto quando: agendamento concorrente na última vaga resulta em só uma reserva (teste automatizado).
4. **Semana 4 — Piloto e go-live:** equipe da academia testa no staging, ajustes de tom e base, migração para o número oficial, acompanhamento diário na primeira semana.
   - Pronto quando: 1 semana em produção sem job na DLQ sem tratamento.

**Pendências com a academia:** CNPJ e acesso ao Meta Business, base de conhecimento (preços, horários, modalidades, regras), grade de horários da experimental e horário da recepção.
