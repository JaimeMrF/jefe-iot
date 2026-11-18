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

Opcionales:

| Secreto | Valor |
|---|---|
| `VPS_PORT` | puerto SSH si no es 22 |
| `VPS_KNOWN_HOSTS` | **recomendado**: salida de `ssh-keyscan -H IP_DEL_VPS` hecha una vez desde una red de confianza. Fija la huella del servidor; sin él, el pipeline la acepta a ciegas en cada despliegue |

Puedes configurar el *environment* `production` (Settings → Environments) para exigir aprobación manual antes de desplegar.
Telegram **no** necesita secretos en GitHub: sus variables viven solo en el `.env` del VPS (sección 7).

## 4. Desplegar
```bash
git branch -M main
git remote add origin git@github.com:TU_USUARIO/TU_REPO.git
git push -u origin main
```
El pipeline (`.github/workflows/ci-cd.yml`) tiene cuatro trabajos:

| Trabajo | Qué hace |
|---|---|
| `validate` | `docker compose config` (dev y prod), `caddy validate`, `nginx -t` del edge, `shellcheck` de los scripts, pruebas del bridge (`npm test`, con caché de npm), sintaxis del panel, dashboard regenerado = el del repo y `check_dashboard.py` (estructura) |
| `integration` | levanta el stack de desarrollo completo, espera los healthchecks y ejecuta **todas** las consultas Flux del dashboard contra Grafana |
| `firmware` | compila el firmware (artefacto `firmware-esp32cam`, con caché de PlatformIO) |
| `deploy` | solo en `main`/`master` y si los tres anteriores pasan: `rsync` al VPS y `deploy/deploy.sh` |

`deploy.sh` levanta los servicios (las dependencias esperan a estar *healthy*), recarga Mosquitto/Telegraf/nginx/Caddy si
cambió su configuración, comprueba que `https://tudominio.com` responda y falla si algún contenedor queda `unhealthy`.
Los despliegues nunca corren en paralelo (concurrency `deploy-production`) y un push nuevo no interrumpe uno en curso.
Un push que rompe algo **no se despliega**.

## 5. Claves y accesos
```bash
ssh deploy@VPS "cat /opt/jefe-iot/.env"
```
- Panel: `https://tudominio.com` → usuario **panel**, clave `MQTT_PANEL_PASS`.
- Grafana: `https://grafana.tudominio.com` → `GRAFANA_USER` / `GRAFANA_PASSWORD`.
- Placa: usuario **esp32**, clave `MQTT_ESP_PASS`, servidor `mqtt.tudominio.com`, puerto **443**, TLS activado
  (el panel ya trae esos valores por defecto; solo pegas usuario y clave en el formulario Bluetooth).
- InfluxDB no es público: `ssh -L 8086:localhost:8086 deploy@VPS` y abre `http://localhost:8086`.

## 6. Cambios típicos
| Quiero... | Hago... |
|---|---|
| Cambiar de VPS / IP | Corro `bootstrap.sh` en el nuevo, cambio el DNS y el secreto `VPS_HOST` |
| Cambiar de dominio | `DOMAIN` en `/opt/jefe-iot/.env`, DNS nuevo, `deploy.sh`; reconfigurar la placa por BLE |
| Cambiar la clave MQTT | Editar `.env`, `deploy.sh`; reenviar la config a la placa desde el panel |
| Actualizar el firmware | Descargar el artefacto del pipeline o compilar con `pio run -t upload` |
| Actualizar una imagen (Grafana, InfluxDB...) | Cambiar la versión fijada en `docker-compose*.yml`, probar en local y hacer push |
| Agregar otra placa real | Nuevo usuario en `mosquitto/entrypoint.sh` + bloque en `mosquitto/acl` con su `<id>` |

## 7. Telegram (opcional)
El bridge puede mandar alertas (severidad ≥ `TELEGRAM_MIN_SEVERITY`), logros y los reportes diario y semanal a un chat.
1. En Telegram habla con **@BotFather** → `/newbot` → elige nombre y usuario (debe terminar en `bot`). Te da el **token**
   (`123456789:AA...`). Trátalo como una contraseña.
2. Abre el chat con tu bot y envíale cualquier mensaje (o agrégalo a un grupo y escribe algo allí).
3. Obtén el **chat_id** desde el VPS (no lo pegues en ningún sitio web):
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":-\?[0-9]*'
   ```
   Un chat privado da un número positivo; un grupo, uno negativo (`-100...`).
4. En `/opt/jefe-iot/.env` del VPS:
   ```bash
   TELEGRAM_BOT_TOKEN=123456789:AA...
   TELEGRAM_CHAT_ID=123456789
   TELEGRAM_MIN_SEVERITY=warning   # info | warning | critical
   REPORT_HOUR=18                  # reporte diario
   REPORT_WEEKDAY=5                # reporte semanal (0=domingo ... 5=viernes)
   TZ=America/Bogota
   ```
5. `bash /opt/jefe-iot/deploy/deploy.sh` (o el próximo push). Sin token o sin chat_id, Telegram queda apagado sin errores.

## 8. Retención, logs y recursos
- **InfluxDB**: los servidores nuevos crean el bucket con retención `INFLUX_RETENTION` (90 días por defecto). En un VPS que ya
  existía el bucket conserva la que tenía (infinita). Para cambiarla:
  ```bash
  cd /opt/jefe-iot && C="docker compose -f docker-compose.prod.yml"
  ID=$($C exec -T influxdb sh -c 'influx bucket list -n "$DOCKER_INFLUXDB_INIT_BUCKET" --hide-headers' | cut -f1)
  $C exec -T influxdb influx bucket update --id "$ID" --retention 90d
  ```
- **Logs**: cada contenedor guarda como máximo 3 archivos de 10 MB (`json-file` con rotación).
- **Memoria**: límites por servicio (`mem_limit`): InfluxDB 1 GB, Grafana 512 MB, Caddy/Telegraf/bridge 256 MB, Mosquitto 128 MB, nginx 64 MB.
- **Datos del bridge** (xp, logros, reportes, personalidad): volumen `bridge-data` → `/data/jefe-state.json`.
- **Copia de seguridad** rápida de InfluxDB:
  ```bash
  docker compose -f docker-compose.prod.yml exec influxdb influx backup /var/lib/influxdb2/backup-$(date +%F)
  ```

## 9. Solución de problemas
| Síntoma | Causa probable y solución |
|---|---|
| `docker compose ps` muestra `unhealthy` | `docker compose -f docker-compose.prod.yml logs --tail 80 <servicio>`. Telegraf y el bridge no arrancan hasta que Mosquitto e InfluxDB están sanos |
| Mosquitto se queda en "Esperando certificado de mqtt..." | El registro DNS `mqtt.` no apunta al VPS, tiene proxy (nube naranja) o el 80/443 están cerrados. Caddy lo emite solo cuando el DNS es correcto |
| La placa no conecta (`rc=5` / no autorizada) | Clave `MQTT_ESP_PASS` distinta a la enviada por BLE, o la placa usa otro `DEVICE_ID`: la ACL solo deja escribir en `jefe/esp32cam-01/...` |
| La placa conecta pero no aparecen datos | Publica en un tópico fuera de la ACL (Mosquitto lo descarta en silencio). Revisa con `mosquitto_sub` como `backend` |
| El panel no conecta al MQTT | `wss://tudominio.com/mqtt` debe responder; revisa `caddy` y la clave `MQTT_PANEL_PASS` |
| Grafana sin datos | `docker compose logs telegraf` (token de InfluxDB) y que el bridge esté `healthy`. Ejecuta `python tools/check_dashboard.py https://grafana.tudominio.com usuario clave` |
| Paneles de Azure vacíos | Falta `AZURE_MAPS_KEY` en `.env` (hay una alerta `api_error`) |
| El pipeline falla en `deploy` con "Host key verification failed" | Cambió el VPS: actualiza `VPS_KNOWN_HOSTS` (o bórralo) y `VPS_HOST` |
| El pipeline falla en `validate` por el dashboard | Editaste `jefe.json` a mano: cambia `tools/gen_dashboard.py`, ejecútalo y sube ambos |
| Disco lleno | `docker system df`; `docker image prune -af`; revisa la retención de InfluxDB (sección 8) |

## Seguridad en breve
- Solo salen a internet 80 (Caddy) y 443 (nginx reparte por SNI: web a Caddy, MQTT con TLS a Mosquitto). InfluxDB queda en `127.0.0.1`.
- MQTT sin acceso anónimo. ACL: la placa solo publica en `jefe/esp32cam-01/...` y lee su `cmd`; el panel lee todo y solo manda comandos.
- Caddy envía HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` y `Permissions-Policy`, y oculta la cabecera `Server`.
- El bridge corre como usuario `node` (sin root) y con `no-new-privileges`; su `/health` (8081) no se publica.
- Imágenes con versión fijada, healthchecks, límites de memoria y logs rotados en todos los servicios.
- La cámara solo se transmite mientras un panel autenticado la pide, y viaja cifrada.
- Los secretos viven únicamente en el `.env` del servidor y en los secretos de GitHub; nunca en el repositorio.
