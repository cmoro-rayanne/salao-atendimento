#!/bin/sh
# Atualiza o agente para uma imagem nova e volta para a anterior se ela não ficar saudável.
# Uso (na VPS, dentro de deploy/): ./deploy.sh <tag>   ex.: ./deploy.sh sha-1a2b3c4
set -eu
cd "$(dirname "$0")"
tag="${1:?informe a tag da imagem (ex.: sha-1a2b3c4)}"
repo="${AGENT_REPO:-ghcr.io/cmoro-rayanne/whatsapp-ai-agent}"
new="$repo:$tag"
state=.deployed-image
previous=$(cat "$state" 2>/dev/null || echo "")

echo "→ baixando $new"
docker pull "$new"

up() {
  AGENT_IMAGE="$1" docker compose up -d --no-deps agent-api agent-worker
}

ready() {
  # Até 2 min esperando /health/ready (banco, Redis e worker) responder 200.
  i=0
  while [ $i -lt 24 ]; do
    if docker compose exec -T agent-api wget -qO- http://127.0.0.1:3000/health/ready >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 5
  done
  return 1
}

up "$new"
if ready; then
  echo "$new" > "$state"
  echo "✓ no ar: $new"
  docker image prune -f >/dev/null
  exit 0
fi

echo "✗ $new não ficou saudável" >&2
docker compose logs --tail=80 agent-api agent-worker >&2 || true
if [ -n "$previous" ]; then
  echo "↩ voltando para $previous" >&2
  up "$previous"
  ready && echo "✓ voltou para $previous" >&2
fi
exit 1
