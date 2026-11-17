#!/bin/sh
# Faz o dump dos bancos uma vez por dia (às 3h, horário do container em UTC = 0h em Brasília)
# e apaga os arquivos com mais de BACKUP_KEEP_DAYS dias. Roda dentro do serviço "backup".
set -eu
KEEP="${BACKUP_KEEP_DAYS:-14}"

dump() {
  stamp=$(date -u +%Y-%m-%dT%H%M)
  for db in agent chatwoot; do
    file="/backups/${db}-${stamp}.sql.gz"
    if pg_dump --no-owner --format=plain "$db" | gzip -9 > "${file}.tmp"; then
      mv "${file}.tmp" "$file"
      echo "backup ok: $file ($(du -h "$file" | cut -f1))"
    else
      rm -f "${file}.tmp"
      echo "BACKUP FALHOU: $db" >&2
    fi
  done
  find /backups -name '*.sql.gz' -mtime +"$KEEP" -delete
}

# Um backup logo ao subir, depois todo dia às 03:00 UTC.
dump
while true; do
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) 03:00" +%s 2>/dev/null || echo $((now + 86400)))
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  dump
done
