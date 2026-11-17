# salao-atendimento

Agente de atendimento com IA no WhatsApp com agenda para salões de beleza (modelo para oferecer; sem cliente real ainda).
Cópia adaptada do `whatsapp-ai-agent` (academia, commit `b1d0d02`): aqui a IA agenda, remarca e cancela serviços em vez de aula experimental. Plano e entregas: `docs/specs/0013-agenda-salao.md`.
O código de aula experimental (`trial-classes`) continua até a entrega 6 da spec 0013.
Fluxo: WhatsApp Cloud API → Chatwoot → este serviço (Agent Bot) → LLM → resposta pelo Chatwoot.
Arquitetura completa: `docs/arquitetura.md` (versão viva: https://claude.ai/artifact/R8fAJFNCCBQbzCDENvA9v3)

## Comandos
- `npm run dev` / `npm run dev:worker` / `npm run dev:web` — API, worker e painel em modo watch
- `npm run build:web` — build do painel (`web/dist`)
- `ADMIN_PASSWORD=... npm run admin:create -- --tenant 1 --email x --role dono` — cria acesso ao painel
- `npm test` · `npm run lint` · `npm run typecheck` · `npm run build`
- `npm run kb:import -- --file base.md [--tenant 1 --apply]` — importa o documento da base exportado em Markdown (sem `--apply` só mostra o relatório)
- `npm run migrate` — aplica migrations em `src/adapters/db/migrations`
- `TEST_DATABASE_URL=... TEST_REDIS_URL=... npm test` — inclui testes de integração (pulados sem as variáveis)
- `LLM_API_KEY=... npm run eval` — avaliação do prompt; rode a cada mudança em `prompt.ts`, ferramentas ou base

## Regras do projeto
- Hexagonal: `src/modules/<dominio>` não importa Fastify, BullMQ, Chatwoot, Postgres nem SDK de LLM. Tudo entra por portas (`ports.ts`); implementações ficam em `src/adapters`.
- TypeScript strict, ESM, Node LTS fixado no `.nvmrc`.
- Validação de toda entrada externa com Zod na borda (webhooks, respostas de API, env).
- Webhook responde 200 rápido; trabalho pesado só no worker.
- Idempotência: todo evento processado passa por `processed_events`; ferramentas do agente são idempotentes; UNIQUE no banco como última defesa.
- Concorrência: update atômico no banco; lock otimista com coluna `version`.
- Segredos só em variáveis de ambiente; comparação de segredos com `safeCompare` (timingSafeEqual).
- Logs estruturados (pino) com `correlationId = conversation:<id>`; nunca logar telefone completo nem conteúdo sensível.
- Sem dados reais de clientes em prompts de desenvolvimento.

## Como trabalhar
- Toda feature começa por uma spec curta em `docs/specs/` (Specify → Design → Tasks → Execute).
- Teste antes ou junto da implementação; regra de negócio sem teste não entra.
- Mudanças pequenas e cirúrgicas; commits convencionais; PRs pequenos para o `dev` (branch principal).
- Pense antes de codar e exponha suposições; prefira a solução mais simples que passa nos critérios.
- Verifique se um pacote existe e é mantido antes de instalar.
- Comandos destrutivos (drop, reset, force push, deploy em produção) só com aprovação humana.
