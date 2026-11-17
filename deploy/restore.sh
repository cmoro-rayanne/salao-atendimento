#!/bin/sh
# Restaura um backup no banco indicado. ATENÇÃO: apaga os dados atuais desse banco.
# Uso (na VPS, dentro de deploy/): ./restore.sh agent backups/agent-2026-11-20T0300.sql.gz
set -eu
db="${1:?informe o banco: agent ou chatwoot}"
file="${2:?informe o arquivo .sql.gz}"
[ -f "$file" ] || { echo "arquivo não existe: $file" >&2; exit 1; }

printf 'Isso APAGA o banco "%s" e restaura %s. Digite o nome do banco para confirmar: ' "$db" "$file"
read -r confirm
[ "$confirm" = "$db" ] || { echo "cancelado"; exit 1; }

docker compose stop agent-api agent-worker chatwoot-web chatwoot-sidekiq
docker compose exec -T postgres sh -c "dropdb -U \"\$POSTGRES_USER\" --if-exists \"$db\" && createdb -U \"\$POSTGRES_USER\" \"$db\""
gunzip -c "$file" | docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -v ON_ERROR_STOP=1 \"$db\"" >/dev/null
docker compose up -d
echo "restaurado: $db <- $file"
