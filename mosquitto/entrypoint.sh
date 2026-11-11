#!/bin/sh
# Genera config, usuarios y ACL desde variables de entorno y espera el certificado de Caddy.
set -e
HOST="mqtt.${DOMAIN}"
DIR="/caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${HOST}"
echo "Esperando certificado de ${HOST}..."
i=0
while [ ! -f "${DIR}/${HOST}.crt" ] || [ ! -f "${DIR}/${HOST}.key" ]; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then echo "ERROR: Caddy no emitio el certificado (revisa DNS de ${HOST} y puertos 80/443)"; exit 1; fi
  sleep 5
done

# Mosquitto baja privilegios antes de abrir los listeners TLS: la llave debe ser legible por su usuario.
# Se copia en cada arranque (el reinicio semanal recoge las renovaciones de Caddy).
mkdir -p /mosquitto/certs
cp "${DIR}/${HOST}.crt" /mosquitto/certs/tls.crt
cp "${DIR}/${HOST}.key" /mosquitto/certs/tls.key
chmod 600 /mosquitto/certs/tls.key

sed -e "s#__CERT__#/mosquitto/certs/tls.crt#" -e "s#__KEY__#/mosquitto/certs/tls.key#" /config-tpl/mosquitto.prod.conf > /mosquitto/config/mosquitto.conf
cp /config-tpl/acl /mosquitto/config/acl
: > /mosquitto/config/passwd
mosquitto_passwd -b /mosquitto/config/passwd esp32 "${MQTT_ESP_PASS}"
mosquitto_passwd -b /mosquitto/config/passwd panel "${MQTT_PANEL_PASS}"
mosquitto_passwd -b /mosquitto/config/passwd backend "${MQTT_BACKEND_PASS}"

chown -R mosquitto:mosquitto /mosquitto/certs /mosquitto/config
chmod 600 /mosquitto/config/passwd /mosquitto/config/acl
exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf
