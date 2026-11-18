#!/bin/sh
# Genera config, usuarios y ACL desde variables de entorno y espera el certificado de Caddy.
set -e
: "${DOMAIN:?falta DOMAIN}" "${MQTT_ESP_PASS:?falta MQTT_ESP_PASS}" "${MQTT_PANEL_PASS:?falta MQTT_PANEL_PASS}" "${MQTT_BACKEND_PASS:?falta MQTT_BACKEND_PASS}"
HOST="mqtt.${DOMAIN}"
PANEL_USER="${MQTT_PANEL_USER:-panel}"
case "$PANEL_USER" in
  esp32|backend) echo "ERROR: MQTT_PANEL_USER no puede ser esp32 ni backend"; exit 1 ;;
esac
if ! printf '%s' "$PANEL_USER" | grep -Eq '^[A-Za-z0-9_.-]{1,64}$'; then
  echo "ERROR: MQTT_PANEL_USER solo admite letras, numeros, punto, guion y guion bajo"; exit 1
fi
# Caddy guarda el certificado en una carpeta por emisor: Let's Encrypt normalmente, ZeroSSL si LE falla.
find_cert_dir() {
  for d in /caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/"${HOST}" /caddy/caddy/certificates/*/"${HOST}"; do
    if [ -f "${d}/${HOST}.crt" ] && [ -f "${d}/${HOST}.key" ]; then echo "$d"; return 0; fi
  done
  return 1
}
echo "Esperando certificado de ${HOST}..."
i=0
until DIR=$(find_cert_dir); do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then echo "ERROR: Caddy no emitio el certificado (revisa DNS de ${HOST} y puertos 80/443)"; exit 1; fi
  sleep 5
done
echo "Certificado: ${DIR}"

# Mosquitto baja privilegios antes de abrir los listeners TLS: la llave debe ser legible por su usuario.
# Se copia en cada arranque (el reinicio semanal recoge las renovaciones de Caddy).
mkdir -p /mosquitto/certs
cp "${DIR}/${HOST}.crt" /mosquitto/certs/tls.crt
cp "${DIR}/${HOST}.key" /mosquitto/certs/tls.key
chmod 600 /mosquitto/certs/tls.key

sed -e "s#__CERT__#/mosquitto/certs/tls.crt#" -e "s#__KEY__#/mosquitto/certs/tls.key#" /config-tpl/mosquitto.prod.conf > /mosquitto/config/mosquitto.conf
sed -e "s#__PANEL_USER__#${PANEL_USER}#" /config-tpl/acl > /mosquitto/config/acl
rm -f /mosquitto/config/passwd   # se recrea en cada arranque (dueno root mientras se escribe)
: > /mosquitto/config/passwd
chmod 600 /mosquitto/config/passwd   # antes de mosquitto_passwd: sin aviso "world readable"
mosquitto_passwd -b /mosquitto/config/passwd esp32 "${MQTT_ESP_PASS}"
mosquitto_passwd -b /mosquitto/config/passwd "${PANEL_USER}" "${MQTT_PANEL_PASS}"
echo "Usuario del panel: ${PANEL_USER}"
mosquitto_passwd -b /mosquitto/config/passwd backend "${MQTT_BACKEND_PASS}"

chown -R mosquitto:mosquitto /mosquitto/certs /mosquitto/config
chmod 600 /mosquitto/config/passwd /mosquitto/config/acl
exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf
