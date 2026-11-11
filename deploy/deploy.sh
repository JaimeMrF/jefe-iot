#!/usr/bin/env bash
# Corre EN EL VPS (lo invoca el pipeline despues de copiar los archivos). Tambien sirve a mano.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "ERROR: falta .env (ejecuta deploy/bootstrap.sh primero)"; exit 1; }
set -a; . ./.env; set +a
C="docker compose -f docker-compose.prod.yml"

$C pull --quiet
$C up -d --remove-orphans

# Los archivos montados no recrean contenedores: recargar/reiniciar solo si cambiaron
NEW=$(cat mosquitto/* telegraf/* 2>/dev/null | sha256sum | cut -d' ' -f1)
OLD=$(cat .deploy-hash 2>/dev/null || true)
if [ "$NEW" != "$OLD" ]; then
  echo ">> Config de broker/telegraf cambio: reiniciando"
  $C restart mosquitto telegraf
  echo "$NEW" > .deploy-hash
fi
$C exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
$C restart grafana >/dev/null 2>&1 || true
docker image prune -f >/dev/null

echo ">> Esperando que https://${DOMAIN} responda..."
for i in $(seq 1 40); do
  if curl -fsS -o /dev/null "https://${DOMAIN}/"; then echo ">> OK: https://${DOMAIN}"; $C ps; exit 0; fi
  sleep 3
done
echo "ERROR: el sitio no respondio. Logs:"; $C logs --tail 40 caddy mosquitto; exit 1
