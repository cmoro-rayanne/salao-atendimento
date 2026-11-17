# Spec 0007 — Deploy, backup e monitoramento

## Objetivo
Quando a VPS existir, colocar o atendimento no ar em minutos, com atualização segura, backup diário e aviso quando algo cai.

## Design
- **Imagem:** o CI (`release.yml`) publica `ghcr.io/cmoro-rayanne/whatsapp-ai-agent:sha-<commit>` e `:dev` a cada merge no `dev`. O CI dos PRs também compila a imagem, sem publicar.
- **Deploy:** `deploy/deploy.sh <tag>` baixa a imagem, sobe `agent-api` e `agent-worker`, espera `/health/ready` por até 2 min e volta para a versão anterior se falhar. Staging é automático a cada merge (se os secrets existirem); produção é manual, com aprovação no ambiente `production` do GitHub.
- **Saúde:** `/health` (o processo responde, usado pelo Docker) e `/health/ready` (banco, Redis e batimento do worker a cada 30 s), usado pelo deploy e por um monitor externo.
- **Compose:** healthchecks em Postgres, Redis e agent-api; o worker só sobe com a API saudável; imagem do Chatwoot configurável para fixar versão.
- **Backup:** serviço `backup` com `pg_dump` diário dos bancos `agent` e `chatwoot`, retenção configurável, script de restauração com confirmação e guia para cópia fora da VPS.
- **Guia:** `deploy/README.md`, da VPS vazia à primeira mensagem respondida.

## Critérios de aceite
- [x] `docker compose config` válido com o `.env.example`.
- [x] `/health/ready` responde 503 dizendo o que falhou.
- [x] Backup gera os dois arquivos e o dump do `agent` restaura num banco vazio.
- [x] Imagem compilando no CI (job `docker` passou no PR #6).
- [ ] Primeiro deploy real numa VPS seguindo o guia.
