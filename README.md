# Jefe IoT

Un jefe virtual vigila tu escritorio con una ESP32-CAM. Proyecto final de **IoT a la medida**.

- **Arquitectura, dispositivos y reglas:** [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)
- **Despliegue en VPS y CI/CD:** [docs/DEPLOY.md](docs/DEPLOY.md)

## Estructura
| Carpeta | Contenido |
|---|---|
| `firmware/` | ESP32-CAM: BLE, WiFi/MQTT con TLS, cámara, recuperación de errores |
| `panel/` | Panel 3D (three.js) con Web Bluetooth, cámara y control de dispositivos |
| `bridge/` | Gemelos digitales, APIs, datasets, lógica del jefe y alertas (Node.js) |
| `grafana/` | Dashboard aprovisionado (generado por `tools/gen_dashboard.py`) |
| `mosquitto/`, `telegraf/`, `deploy/` | Bróker, ingesta y scripts de despliegue |
| `datasets/` | Datasets reales de UCI recortados |

## Local (desarrollo)
```bash
cp .env.example .env        # y edita las claves
docker compose up -d --build
# Panel http://localhost:8080 · Grafana http://localhost:3000 · MQTT 1883
cd bridge && npm ci && npm test
```

## Firmware
```bash
cd firmware && python -m platformio run -t upload   # GPIO0 a GND mientras sube
```
Después abre el panel, conecta por Bluetooth a **JefeCAM** y envía WiFi + servidor MQTT.

## Producción
Ver [docs/DEPLOY.md](docs/DEPLOY.md). Cada `git push` a `main` valida, prueba y despliega en el VPS.
