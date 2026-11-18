#!/usr/bin/env bash
# Prepara un VPS Ubuntu/Debian NUEVO. Se ejecuta una sola vez como root:
#   sudo bash bootstrap.sh midominio.com tu@correo.com "ssh-ed25519 AAAA... llave-publica-de-CI"
# Es idempotente: si el .env ya existe no lo toca.
set -euo pipefail
DOMAIN="${1:?uso: bootstrap.sh DOMINIO [CORREO] [LLAVE_PUBLICA_CI]}"
EMAIL="${2:-}"   # opcional
PUBKEY="${3:-}"
APP=/opt/jefe-iot
USER_CI=deploy

command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
apt-get install -y -qq rsync ufw curl openssl >/dev/null

# Usuario sin privilegios para el pipeline (solo docker)
id "$USER_CI" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$USER_CI"
usermod -aG docker "$USER_CI"
mkdir -p "$APP" "/home/$USER_CI/.ssh"
if [ -n "$PUBKEY" ]; then
  grep -qxF "$PUBKEY" "/home/$USER_CI/.ssh/authorized_keys" 2>/dev/null || echo "$PUBKEY" >> "/home/$USER_CI/.ssh/authorized_keys"
fi
chmod 700 "/home/$USER_CI/.ssh"; touch "/home/$USER_CI/.ssh/authorized_keys"; chmod 600 "/home/$USER_CI/.ssh/authorized_keys"
chown -R "$USER_CI:$USER_CI" "/home/$USER_CI/.ssh" "$APP"

# Firewall: SSH y web (el MQTT/TLS viaja por el 443)
ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null

# .env con secretos aleatorios (solo la primera vez)
if [ ! -f "$APP/.env" ]; then
  r() { openssl rand -hex "$1"; }
  cat > "$APP/.env" <<ENV
DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
INFLUX_USER=admin
INFLUX_PASSWORD=$(r 12)
INFLUX_ORG=jefe-iot
INFLUX_BUCKET=iot
INFLUX_TOKEN=$(r 24)
GRAFANA_USER=admin
GRAFANA_PASSWORD=$(r 10)
MQTT_ESP_PASS=$(r 10)
MQTT_PANEL_PASS=$(r 10)
MQTT_BACKEND_PASS=$(r 12)
AZURE_MAPS_KEY=
TZ=America/Bogota
INFLUX_RETENTION=90d
# Telegram opcional (docs/DEPLOY.md, seccion 7)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ENV
  chown "$USER_CI:$USER_CI" "$APP/.env"; chmod 600 "$APP/.env"
  echo ">> .env creado en $APP/.env (ahi estan tus claves; guardalas)."
fi

# Mosquitto lee el certificado solo al arrancar: reiniciarlo cada domingo recoge las renovaciones
CRON="0 4 * * 0 cd $APP && docker compose -f docker-compose.prod.yml restart mosquitto >/dev/null 2>&1"
( { crontab -u "$USER_CI" -l 2>/dev/null || true; } | { grep -vF "restart mosquitto" || true; }; echo "$CRON" ) | crontab -u "$USER_CI" -

IP=$(curl -fsS https://api.ipify.org || echo "TU_IP")
cat <<MSG

Listo. Falta:
1) DNS (registros A, SIN proxy/nube naranja) apuntando a $IP :
     $DOMAIN
     grafana.$DOMAIN
     mqtt.$DOMAIN
2) Primer despliegue: haz push a GitHub (el pipeline copia los archivos y levanta todo)
   o copia el repo a $APP y ejecuta: sudo -u $USER_CI bash $APP/deploy/deploy.sh
3) Tus claves: sudo cat $APP/.env
MSG
