# Despliegue en VPS

Todo depende de **un dominio** y del archivo `.env` del servidor. Cambiar de VPS, de IP o de dominio
no requiere tocar código: se cambia el DNS (o `DOMAIN` en `.env`) y se reconfigura la placa por Bluetooth.

## 1. DNS (una sola vez)
Crea tres registros **A, sin proxy** (nube gris en Cloudflare) hacia la IP del VPS:

| Nombre | Para qué |
|---|---|
| `tudominio.com` | panel 3D + WebSocket MQTT |
| `grafana.tudominio.com` | Grafana |
| `mqtt.tudominio.com` | MQTT con TLS para la ESP32 (por el 443, nginx reparte por SNI) |

> Si la IP del VPS cambia, solo actualizas estos registros. La placa usa el **nombre**, no la IP.

## 2. Preparar el VPS (una sola vez)
Ubuntu/Debian nuevo, como root:
```bash
curl -fsSL https://raw.githubusercontent.com/TU_USUARIO/TU_REPO/main/deploy/bootstrap.sh -o bootstrap.sh
sudo bash bootstrap.sh tudominio.com tu@correo.com "ssh-ed25519 AAAA... llave-publica-de-CI"
```
Instala Docker, abre el firewall (22, 80, 443), crea el usuario `deploy`, genera `/opt/jefe-iot/.env`
con claves aleatorias y programa el reinicio semanal de Mosquitto (recoge los certificados renovados).

Llave de CI (en tu PC):
```bash
ssh-keygen -t ed25519 -f jefe_ci -N ""      # jefe_ci.pub va al bootstrap, jefe_ci (privada) a GitHub
```

## 3. Secretos en GitHub
Repo → Settings → Secrets and variables → Actions → *New repository secret*:

| Secreto | Valor |
|---|---|
| `VPS_HOST` | IP o dominio del VPS |
| `VPS_USER` | `deploy` |
| `VPS_SSH_KEY` | contenido de `jefe_ci` (llave privada) |

Opcional: crea el *environment* `production` para exigir aprobación manual antes de desplegar.

## 4. Desplegar
```bash
git branch -M main
git remote add origin git@github.com:TU_USUARIO/TU_REPO.git
git push -u origin main
```
El pipeline (`.github/workflows/ci-cd.yml`) valida los compose, el Caddyfile, la sintaxis del panel y
compila el firmware (queda como artefacto `firmware-esp32cam`). Si todo pasa, copia los archivos al VPS
con `rsync` y ejecuta `deploy/deploy.sh`, que levanta los servicios y comprueba que `https://tudominio.com` responda.
Cada `git push` posterior actualiza el VPS en menos de un minuto. Un push que rompe algo **no se despliega**.

## 5. Claves y accesos
```bash
ssh deploy@VPS "cat /opt/jefe-iot/.env"
```
- Panel: `https://tudominio.com` → usuario **panel**, clave `MQTT_PANEL_PASS`.
- Grafana: `https://grafana.tudominio.com` → `GRAFANA_USER` / `GRAFANA_PASSWORD`.
- Placa: usuario **esp32**, clave `MQTT_ESP_PASS`, servidor `mqtt.tudominio.com`, puerto **443**, TLS activado
  (el panel ya trae esos valores por defecto; solo pegas usuario y clave en el formulario Bluetooth).
- Node-RED e InfluxDB no son públicos: `ssh -L 1880:localhost:1880 -L 8086:localhost:8086 deploy@VPS`
  y abre `http://localhost:1880`.

## 6. Cambios típicos
| Quiero... | Hago... |
|---|---|
| Cambiar de VPS / IP | Corro `bootstrap.sh` en el nuevo, cambio el DNS y el secreto `VPS_HOST` |
| Cambiar de dominio | `DOMAIN` en `/opt/jefe-iot/.env`, DNS nuevo, `deploy.sh`; reconfigurar la placa por BLE |
| Cambiar la clave MQTT | Editar `.env`, `deploy.sh`; reenviar la config a la placa desde el panel |
| Actualizar el firmware | Descargar el artefacto del pipeline o compilar con `pio run -t upload` |

## Seguridad en breve
- Solo salen a internet 80 (Caddy) y 443 (nginx reparte por SNI: web a Caddy, MQTT con TLS a Mosquitto). InfluxDB y Node-RED quedan en `127.0.0.1`.
- MQTT sin acceso anónimo. ACL: la placa solo publica sus datos y lee comandos; el panel lee todo y solo manda comandos.
- La cámara solo se transmite mientras un panel autenticado la pide, y viaja cifrada.
- Los secretos viven únicamente en el `.env` del servidor y en los secretos de GitHub; nunca en el repositorio.
