# Deploy na VPS

Passo a passo para colocar o atendimento no ar numa VPS. Uma VPS atende várias academias.

**O que você precisa antes:**
- VPS Ubuntu 24.04 com 2 vCPU e 4–8 GB de RAM (o Chatwoot pede pelo menos 4 GB).
- Dois subdomínios apontando (registro A) para o IP da VPS: um para o Chatwoot (ex.: `chat.rmoro.com.br`) e um para o painel (ex.: `painel.rmoro.com.br`).
- Conta na Meta com o app do WhatsApp e o número de teste (Phone Number ID, WABA ID e token permanente).
- Chave da API da Anthropic.

## 1. Preparar a VPS

```bash
# Docker oficial
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # saia e entre de novo

# Usuário só para deploy (o GitHub Actions entra por ele)
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy

# Pasta do projeto: só a pasta deploy/ é necessária na VPS
sudo mkdir -p /opt/whatsapp-ai-agent && sudo chown deploy:deploy /opt/whatsapp-ai-agent
sudo -u deploy git clone --depth 1 -b dev https://github.com/cmoro-rayanne/whatsapp-ai-agent /opt/whatsapp-ai-agent
```

Firewall: libere só 22, 80 e 443 (`sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable`).

## 2. Configurar

```bash
cd /opt/whatsapp-ai-agent/deploy
cp .env.example .env
nano .env
```

Preencha pelo menos: `CHATWOOT_DOMAIN`, `PANEL_DOMAIN`, `POSTGRES_PASSWORD`, `SECRET_KEY_BASE` (`openssl rand -hex 64`), `FRONTEND_URL`, `CHATWOOT_PUBLIC_URL`, `WEBHOOK_SECRET` (`openssl rand -hex 32`), `JWT_SECRET` (`openssl rand -hex 32`), `LLM_API_KEY` e `ALERT_WEBHOOK_URL`. O `CHATWOOT_BOT_TOKEN` vem no passo 4.

A imagem do agente fica no GitHub Container Registry (privado). Crie um token do GitHub com permissão só `read:packages` e faça login uma vez:

```bash
echo <TOKEN> | docker login ghcr.io -u cmoro-rayanne --password-stdin
```

## 3. Subir

```bash
docker compose up -d
docker compose ps        # tudo "healthy" em 1–2 minutos
```

O Caddy emite os certificados HTTPS sozinho. Teste `https://<PANEL_DOMAIN>/health/ready`: deve responder `{"status":"ok", ...}`.

## 4. Chatwoot

1. Abra `https://<CHATWOOT_DOMAIN>`, crie a conta de administrador.
2. **Caixa de entrada:** Settings → Inboxes → Add Inbox → WhatsApp → WhatsApp Cloud. Informe Phone Number ID, WABA ID e o token da Meta. Copie a URL de webhook e o token de verificação que o Chatwoot mostrar e cadastre no app da Meta (WhatsApp → Configuration → Webhook), assinando o campo `messages`.
3. **Agent Bot:** Settings → Bots → Add Bot. URL do webhook: `http://agent-api:3000/webhooks/chatwoot/<WEBHOOK_SECRET>` (rede interna do Docker; não passa pela internet). Copie o token de acesso do bot para `CHATWOOT_BOT_TOKEN` no `.env`.
4. Na caixa de entrada do WhatsApp → Bot Configuration, escolha o bot criado.
5. Reinicie o agente: `docker compose up -d agent-api agent-worker`.

## 5. Cadastrar a academia

```bash
docker compose exec postgres psql -U postgres agent
```

```sql
insert into tenants (name, chatwoot_account_id, reception_hours, privacy_url)
values ('Cia da Forma', 1, '{"open": 7, "close": 21}', 'https://ciadaformacuritiba.com.br/privacidade');
```

`chatwoot_account_id` é o número que aparece na URL do Chatwoot (`/app/accounts/1/...`). Depois crie o acesso ao painel:

```bash
docker compose exec -e ADMIN_PASSWORD='uma-senha-forte' agent-api \
  node dist/scripts/create-admin.js --tenant 1 --email dono@academia.com.br --role dono
```

O dono cria os outros acessos (recepção) pelo painel, em Configurações.

Carregue a base a partir do documento que a academia preencheu (no Docs: Exportar → Markdown). Primeiro sem `--apply`, para ler o relatório de pendências:

```bash
docker compose cp base.md agent-api:/tmp/base.md
docker compose exec agent-api node dist/scripts/import-knowledge.js --file /tmp/base.md
docker compose exec agent-api node dist/scripts/import-knowledge.js --file /tmp/base.md --tenant 1 --apply
```

`--apply` grava a base, o horário da recepção e a grade da experimental das próximas 4 semanas (`--weeks`). Se a base já tiver itens, use `--replace`. Localmente, `npm run kb:import -- --file base.md --eval-dir eval/academia` também gera os arquivos para `EVAL_BASE`/`EVAL_CASOS`.

Mande uma mensagem para o número de teste: a IA deve responder com o aviso de atendimento automatizado no fim.

## 6. Deploy automático pelo GitHub

A cada merge no `dev`, o GitHub Actions publica a imagem `ghcr.io/cmoro-rayanne/whatsapp-ai-agent:sha-xxxxxxx` e, se o ambiente `staging` estiver configurado, roda `./deploy.sh` na VPS. O script troca a imagem, espera o `/health/ready` e **volta sozinho para a versão anterior** se a nova não ficar saudável.

Configuração (GitHub → Settings → Environments):

| Ambiente | Secrets | Observação |
| --- | --- | --- |
| `staging` | `DEPLOY_HOST`, `DEPLOY_USER` (`deploy`), `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` | Deploy automático a cada merge |
| `production` | os mesmos, da VPS de produção | Marque **Required reviewers**: o deploy espera sua aprovação |

- Chave SSH: `ssh-keygen -t ed25519 -f deploy_key -N ""`; a pública vai em `/home/deploy/.ssh/authorized_keys` na VPS, a privada no secret `DEPLOY_SSH_KEY`.
- `DEPLOY_KNOWN_HOSTS`: saída de `ssh-keyscan <IP-da-VPS>`.
- Produção: Actions → Release → Run workflow, com a tag testada em staging.

Deploy manual na VPS: `cd /opt/whatsapp-ai-agent/deploy && ./deploy.sh sha-1a2b3c4`.

## 7. Monitoramento e alertas

- **Alertas de falha** (IA sem conseguir responder, lembrete não enviado, conversa acima do limite): `ALERT_WEBHOOK_URL`. O jeito mais simples é o [ntfy](https://ntfy.sh): instale o app no celular, assine um tópico com nome difícil de adivinhar e use `https://ntfy.sh/<tópico>`.
- **Monitor externo** (VPS ou serviço fora do ar): cadastre `https://<PANEL_DOMAIN>/health/ready` num monitor gratuito como UptimeRobot ou Better Stack, verificando a cada 5 minutos. Ele confere banco, Redis e worker.

## 8. Backup

O serviço `backup` faz o dump dos bancos `agent` e `chatwoot` ao subir e todo dia às 00h (Brasília), em `deploy/backups/`, guardando `BACKUP_KEEP_DAYS` dias (padrão 14).

**Cópia fora da VPS (obrigatória para produção):** com o [rclone](https://rclone.org) configurado para Google Drive, Backblaze B2 ou S3, agende no `crontab -e` do usuário `deploy`:

```
30 3 * * * rclone copy /opt/whatsapp-ai-agent/deploy/backups remoto:whatsapp-ai-agent-backups --max-age 48h
```

**Restaurar** (apaga o banco atual e pede confirmação):

```bash
./restore.sh agent backups/agent-2026-11-20T0300.sql.gz
```

Faça um teste de restauração por mês numa VPS de teste: backup que nunca foi restaurado não é backup.
