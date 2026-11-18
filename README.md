# Jefe IoT

Un jefe virtual vigila tu escritorio con una ESP32-CAM. Proyecto final de **IoT a la medida**.

- **Arquitectura, dispositivos, tópicos y reglas:** [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)
- **Contrato v2 (gamificación, reportes, personalidades, Telegram):** [docs/CONTRATO-V2.md](docs/CONTRATO-V2.md)
- **Despliegue en VPS, CI/CD, Telegram y solución de problemas:** [docs/DEPLOY.md](docs/DEPLOY.md)

## Estructura
| Carpeta | Contenido |
|---|---|
| `firmware/` | ESP32-CAM: BLE, WiFi/MQTT con TLS, cámara, recuperación de errores |
| `panel/` | Panel 3D (three.js) con Web Bluetooth, cámara y control de dispositivos |
| `bridge/` | Gemelos digitales, APIs, datasets, lógica del jefe, gamificación, reportes, alertas y Telegram (Node.js) |
| `grafana/` | Datasource y dashboard aprovisionados (el JSON lo genera `tools/gen_dashboard.py`) |
| `mosquitto/` | Bróker: config de desarrollo, config de producción, ACL y entrypoint (usuarios + TLS) |
| `telegraf/` | Ingesta MQTT → InfluxDB (telemetría y alertas) |
| `deploy/` | Caddyfile, nginx de borde (SNI en el 443), `bootstrap.sh` y `deploy.sh` del VPS |
| `tools/` | Generador y verificador del dashboard |
| `datasets/` | Datasets reales de UCI recortados |

## Local (desarrollo)
```bash
cp .env.example .env        # y edita las claves
docker compose up -d --build --wait     # --wait: espera a que todo este "healthy"
docker compose ps
# Panel http://localhost:8080 · Grafana http://localhost:3000 · MQTT 1883 (LAN) y 9001 (WebSocket)
# InfluxDB http://localhost:8086 (solo desde este PC)
cd bridge && npm ci && npm test
```
En desarrollo Mosquitto acepta conexiones **anónimas** (solo para la LAN). Producción exige usuario, clave, ACL y TLS.

Para apagar sin perder datos: `docker compose down` (con `-v` se borran InfluxDB, Grafana y el estado del bridge).

## Dashboard de Grafana
```bash
python tools/gen_dashboard.py                    # regenera grafana/provisioning/dashboards/jefe.json
python tools/check_dashboard.py                  # valida la estructura (ids, posiciones, consultas, descripciones)
python tools/check_dashboard.py http://localhost:3000 admin CLAVE now-1h   # ejecuta cada consulta Flux contra Grafana
```
No edites `jefe.json` a mano: el CI comprueba que coincida con el generador.

## Firmware
```bash
cd firmware && python -m platformio run -t upload   # GPIO0 a GND mientras sube
```
Después abre el panel, conecta por Bluetooth a **JefeCAM** y envía WiFi + servidor MQTT.

### Conectar la placa en producción (3 pasos)
1. Abre `https://<tu dominio>` en **Chrome o Edge** (Web Bluetooth) y entra con tu usuario del panel
   (`MQTT_PANEL_USER` / `MQTT_PANEL_PASS`; ver abajo).
2. Enciende la ESP32-CAM cerca del PC y pulsa **Conectar por Bluetooth** → elige **JefeCAM**.
3. Pulsa **Buscar redes**, elige tu WiFi (**2.4 GHz**), escribe su clave y pulsa **Enviar a la placa**.

El servidor, el puerto 443, TLS y el usuario/clave MQTT de la placa se rellenan solos: el bridge los publica
en `jefe/provision/esp32cam-01`, que solo puede leer el usuario del panel (la placa no). Si el aviso verde
"automáticos" no aparece, revisa que hayas iniciado sesión. Los campos siguen disponibles en "Servidor MQTT (avanzado)".

### Usuario del panel
Se define con los secrets **opcionales** de GitHub `PANEL_USER` y `PANEL_PASS`: en cada deploy se escriben en
`/opt/jefe-iot/.env` del VPS (por stdin, nunca en logs) como `MQTT_PANEL_USER` / `MQTT_PANEL_PASS`. Sin esos secrets
se usa lo que ya haya en el `.env` (por defecto el usuario `panel`). Para cambiarlos:
```bash
gh secret set PANEL_USER     # pega el usuario
gh secret set PANEL_PASS     # pega la clave
gh workflow run ci-cd.yml    # o haz push a main
```

## Producción
Ver [docs/DEPLOY.md](docs/DEPLOY.md). Cada `git push` a `main` valida, prueba (incluida una prueba de integración con el stack
completo) y, si todo pasa, despliega en el VPS.

## Solución de problemas (local)
| Síntoma | Qué revisar |
|---|---|
| `docker compose up` dice `dependency failed to start` | Un servicio quedó `unhealthy`: `docker compose ps` y `docker compose logs --tail 80 <servicio>` |
| `port is already allocated` | Otro programa (u otra copia del stack) usa 1883, 3000, 8080, 8086 o 9001 |
| Grafana vacío | `docker compose logs telegraf`: si el token de InfluxDB no coincide, borraste el `.env` pero no el volumen; vuelve a poner el token original o recrea con `docker compose down -v` (borra datos) |
| Paneles de Azure vacíos | Falta `AZURE_MAPS_KEY` en `.env` (es normal en pruebas: hay una alerta `api_error`) |
| La placa no llega al bróker local | La IP del PC en la LAN y el puerto 1883 abiertos en el firewall de Windows |
| El panel no ve el Bluetooth | Usa Chrome/Edge en `http://localhost:8080` o HTTPS (Web Bluetooth exige contexto seguro) |
| "ESP32-CAM: SIMULADA" en Grafana | Normal si la placa no envía datos en 90 s; al llegar datos reales cambia sola a REAL |

Más casos de producción en [docs/DEPLOY.md](docs/DEPLOY.md#9-solución-de-problemas).
