#!/usr/bin/env bash
# Corre EN EL VPS. Lee lineas CLAVE=valor por stdin (para que los secretos no aparezcan en "ps" ni en logs)
# y las escribe o reemplaza en /opt/jefe-iot/.env. Solo acepta las claves de la lista.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "ERROR: falta .env (ejecuta deploy/bootstrap.sh primero)"; exit 1; }
ALLOWED=" MQTT_PANEL_USER MQTT_PANEL_PASS TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TZ "
changed=0
while IFS= read -r line || [ -n "$line" ]; do
  [ -z "$line" ] && continue
  key=${line%%=*}
  val=${line#*=}
  case "$ALLOWED" in *" $key "*) ;; *) echo "ERROR: clave no permitida: $key"; exit 1 ;; esac
  [ -z "$val" ] && continue
  case "$val" in *"'"*|*$'\r'*) echo "ERROR: $key contiene comillas simples o retorno de carro"; exit 1 ;; esac
  new="${key}='${val}'"
  if grep -q "^${key}=" .env; then
    cur=$(grep "^${key}=" .env | head -n1)
    [ "$cur" = "$new" ] && continue
    tmp=$(mktemp .env.XXXXXX)
    awk -v k="$key" -v n="$new" 'index($0, k "=") == 1 { print n; next } { print }' .env > "$tmp"
    chmod --reference=.env "$tmp" 2>/dev/null || chmod 600 "$tmp"
    mv "$tmp" .env
  else
    printf '%s\n' "$new" >> .env
  fi
  echo ">> .env: $key actualizado"
  changed=1
done
[ "$changed" = 1 ] || echo ">> .env sin cambios"
