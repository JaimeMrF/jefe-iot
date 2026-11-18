'use strict';
// Bridge de Jefe IoT: gemelos digitales, APIs, datasets, logica del jefe y alertas, todo sobre MQTT.
//  - La ESP32-CAM real (esp32cam-01) manda su telemetria directo al broker.
//  - Mientras la real NO envie datos, este servicio simula esp32cam-01 (campo sim=1). Al llegar datos reales, la simulacion se apaga sola.
// Este archivo solo conecta piezas: MQTT, servidor de salud y apagado limpio. La logica vive en bridge.js / logic.js / models.js.
const mqtt = require('mqtt');
const { createBridge, createHealthServer, loadConfig } = require('./bridge');
const { createLogger } = require('./log');
const { createStore } = require('./store');

const cfg = loadConfig(process.env);
const log = createLogger({ level: cfg.logLevel, format: cfg.logFormat });

const RECONNECT_MIN_MS = 2000, RECONNECT_MAX_MS = 30000;
const client = mqtt.connect(cfg.mqttUrl, {
  username: cfg.mqttUser, password: cfg.mqttPass, clientId: cfg.clientId,
  reconnectPeriod: RECONNECT_MIN_MS, connectTimeout: 10000, keepalive: 30,
  queueQoSZero: false, // sin broker no se acumula telemetria vieja en memoria (lo retenido se re-publica al reconectar)
  will: { topic: 'jefe/bridge/status', payload: 'offline', retain: true, qos: 1 }
});

// Estado persistido (personalidad, xp, logros, historial por dia) en DATA_DIR/jefe-state.json
const store = createStore({ dir: cfg.dataDir, log });
log.info('estado persistido en', { file: store.file, tz: cfg.tz || 'proceso' });
const bridge = createBridge({ client, config: cfg, log, store });

// Reconexion con backoff exponencial (2 s -> 30 s), se reinicia al conectar
let shuttingDown = false, wasConnected = false;
client.on('connect', () => {
  wasConnected = true;
  client.options.reconnectPeriod = RECONNECT_MIN_MS;
  bridge.onConnect();
});
client.on('close', () => {
  if (shuttingDown) return;
  if (wasConnected) log.warn('MQTT desconectado, reintentando...');
  wasConnected = false;
  client.options.reconnectPeriod = Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_MIN_MS, client.options.reconnectPeriod * 2));
});
client.on('reconnect', () => log.debug('MQTT reintento', { next_ms: client.options.reconnectPeriod }));
client.on('error', (e) => log.warn('MQTT error', { err: e })); // fallos de conexion: se reintenta solo
client.on('message', (topic, buf) => bridge.handleMessage(topic, buf));

bridge.start();

let server = null;
if (cfg.healthPort > 0) {
  server = createHealthServer(bridge, log);
  server.listen(cfg.healthPort, cfg.healthHost, () => log.info('health en /health y reporte en /report', { port: cfg.healthPort }));
}

// Apagado limpio: detener bucles, marcar offline (retenido, QoS 1) y cerrar el cliente esperando la entrega
function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('apagando', { reason });
  bridge.stop();
  bridge.persist();
  if (server) server.close();
  const force = setTimeout(() => process.exit(code), 4000);
  force.unref();
  const finish = () => process.exit(code);
  if (!client.connected) { client.end(true, {}, finish); return; }
  const msgs = bridge.offlineMessages();
  let pending = msgs.length;
  const done = () => { if (--pending <= 0) client.end(false, {}, finish); };
  if (!pending) { client.end(false, {}, finish); return; }
  for (const [topic, payload] of msgs) client.publish(topic, payload, { retain: true, qos: 1 }, done);
}

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));
process.on('unhandledRejection', (e) => log.error('promesa rechazada sin manejar', { err: e instanceof Error ? e : String(e) }));
process.on('uncaughtException', (e) => { log.error('excepcion no capturada', { err: e, stack: e && e.stack }); shutdown('uncaughtException', 1); });
