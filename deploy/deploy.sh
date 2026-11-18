#!/usr/bin/env bash
# Corre EN EL VPS (lo invoca el pipeline despues de copiar los archivos). Tambien sirve a mano.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "ERROR: falta .env (ejecuta deploy/bootstrap.sh primero)"; exit 1; }
set -a; . ./.env; set +a
C="docker compose -f docker-compose.prod.yml"

$C pull --quiet
# "up" espera a que las dependencias marcadas con condition: service_healthy esten sanas
$C up -d --build --remove-orphans

# Los archivos montados no recrean contenedores: recargar/reiniciar solo si cambiaron
NEW=$(cat mosquitto/* telegraf/* 2>/dev/null | sha256sum | cut -d' ' -f1)
OLD=$(cat .deploy-hash 2>/dev/null || true)
if [ "$NEW" != "$OLD" ]; then
  echo ">> Config de broker/telegraf cambio: reiniciando"
  $C restart mosquitto telegraf
  echo "$NEW" > .deploy-hash
fi
# edge.conf (nginx del 443) tampoco se recarga solo
NEW_EDGE=$(sha256sum deploy/edge.conf | cut -d' ' -f1)
if [ "$NEW_EDGE" != "$(cat .deploy-hash-edge 2>/dev/null || true)" ]; then
  echo ">> edge.conf cambio: recargando nginx"
  $C exec -T edge nginx -s reload || $C restart edge
  echo "$NEW_EDGE" > .deploy-hash-edge
fi
$C exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
$C restart grafana >/dev/null 2>&1 || true
docker image prune -f >/dev/null

echo ">> Esperando que https://${DOMAIN} responda..."
ok=0
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "https://${DOMAIN}/"; then ok=1; break; fi
  sleep 3
done
if [ "$ok" != 1 ]; then
  echo "ERROR: el sitio no respondio. Logs:"; $C logs --tail 40 caddy edge mosquitto; exit 1
fi
echo ">> OK: https://${DOMAIN}"

# Healthchecks: esperar hasta 2 min a que nada quede en "starting" y fallar si algo quedo "unhealthy"
for _ in $(seq 1 24); do
  $C ps --format '{{.Status}}' | grep -q 'health: starting' || break
  sleep 5
done
$C ps
BAD=$($C ps --format '{{.Service}} {{.Status}}' | grep -E 'unhealthy|starting' | cut -d' ' -f1 || true)
if [ -n "$BAD" ]; then
  echo "ERROR: servicios sin salud: $BAD"
  # shellcheck disable=SC2086
  $C logs --tail 40 $BAD
  exit 1
fi
echo ">> Todos los servicios sanos"
