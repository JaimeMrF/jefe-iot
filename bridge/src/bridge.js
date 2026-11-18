'use strict';
// Nucleo del bridge: registro de dispositivos, bucles de publicacion, comandos, telemetria entrante, jefe, reglas y salud.
// No abre conexiones por si mismo: recibe un cliente MQTT (o uno falso en las pruebas), fetch y timers inyectables.
const fs = require('fs');
const path = require('path');
const http = require('http');
const M = require('./models');
const L = require('./logic');
const A = require('./apis');
const { parseJsonObject, sanitizeCmd, cmdSpec, toBool } = require('./commands');
const { silentLogger } = require('./log');

const REAL_ID = 'esp32cam-01';
const DATASETS = [['ds-energia', 'energia.csv'], ['ds-co2', 'co2.csv'], ['ds-ocupacion', 'ocupacion.csv']];

// ---------- Configuracion (todas las variables tienen default seguro) ----------
const numEnv = (v, def, min = -Infinity, max = Infinity) => {
  if (v === undefined || v === null || String(v).trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const coordEnv = (v, def, lim) => { const n = numEnv(v, NaN); return Number.isFinite(n) && Math.abs(n) <= lim ? String(n) : def; };

function resolveDatasetsDir(dir) {
  if (dir) return dir;
  const local = path.join(__dirname, '..', '..', 'datasets');
  return fs.existsSync('/datasets') || !fs.existsSync(local) ? '/datasets' : local;
}

function loadConfig(env = process.env) {
  return {
    mqttUrl: env.MQTT_URL || 'mqtt://mosquitto:1883',
    mqttUser: env.MQTT_USER || undefined,
    mqttPass: env.MQTT_PASS || undefined,
    clientId: env.MQTT_CLIENT_ID || 'jefe-bridge',
    lat: coordEnv(env.LAT, '4.711', 90),
    lon: coordEnv(env.LON, '-74.072', 180),
    datasetsDir: resolveDatasetsDir(env.DATASETS_DIR),
    azureKey: env.AZURE_MAPS_KEY || '',
    realTimeoutMs: numEnv(env.REAL_TIMEOUT_S, 90, 15, 3600) * 1000,
    healthPort: numEnv(env.HEALTH_PORT, 8081, 0, 65535),
    healthHost: env.HEALTH_HOST || '0.0.0.0',
    apiTimeoutMs: numEnv(env.API_TIMEOUT_MS, 10000, 1000, 60000),
    apiRetries: numEnv(env.API_RETRIES, 2, 0, 5),
    apiCacheMaxMs: numEnv(env.API_CACHE_MAX_S, 1800, 0, 86400) * 1000,
    eventsMaxPerMin: numEnv(env.EVENTS_MAX_PER_MIN, 30, 0, 10000),
    logLevel: env.LOG_LEVEL || 'info',
    logFormat: env.LOG_FORMAT || 'text'
  };
}

function createBridge({
  client, config = loadConfig({}), log = silentLogger(), fetchImpl = globalThis.fetch,
  now = Date.now, timers = globalThis, sleep, random = Math.random, readFile = (p) => fs.readFileSync(p, 'utf8')
}) {
  const cfg = config;
  const world = { present: false, tempOut: 14, tempSala: 19 };
  const boss = L.createBoss();
  const source = L.createSourceTracker(cfg.realTimeoutMs);
  const limiter = L.createEventLimiter(cfg.eventsMaxPerMin);
  const devices = new Map();
  const stats = { msgs_in: 0, msgs_invalid: 0, cmds: 0, cmds_invalid: 0, published: 0, publish_errors: 0 };
  const startedAt = now();
  let stopped = false, modeTimer = null;

  // ---------- Publicacion ----------
  function pub(topic, obj, { retain = false, qos = 0 } = {}) {
    const payload = typeof obj === 'string' ? obj : JSON.stringify(obj);
    try {
      client.publish(topic, payload, { retain, qos }, (err) => { if (err) { stats.publish_errors++; log.debug('publish no entregado', { topic, err }); } });
      stats.published++;
    } catch (e) { stats.publish_errors++; log.warn('publish lanzo excepcion', { topic, err: e }); }
  }
  const emit = (rule, severity, device, value, msg) => {
    if (!limiter.allow(now())) { log.warn('evento descartado (limite por minuto)', { rule, device }); return; }
    log.info('EVENTO', { rule, severity, device, value });
    pub(`jefe/${device}/event`, { rule, severity, device, value, msg });
  };
  const rules = L.createRules(emit, M.hourBogota);

  function publishState(dev) {
    if (dev.noState) return;
    let params = {};
    try { params = dev.model.params() || {}; } catch (e) { log.warn('params() fallo', { device: dev.id, err: e }); }
    pub(`jefe/${dev.id}/state`, { enabled: dev.enabled ? 1 : 0, interval_s: dev.intervalMs / 1000, kind: dev.kind, ...params }, { retain: true, qos: 1 });
  }
  function publishTelemetry(dev, f) {
    if (stopped) return false;
    const clean = L.cleanTelemetry(f);
    if (!Object.keys(clean).length) return false;
    pub(`jefe/${dev.id}/telemetry`, clean);
    dev.lastPublish = now();
    return true;
  }

  // ---------- Dispositivos ----------
  function register(id, kind, model, intervalMs, opts = {}) {
    const minInterval = opts.minInterval || 1000;
    const dev = {
      id, kind, model, intervalMs, enabled: true, gate: opts.gate, noState: !!opts.noState, noStatus: !!opts.noStatus,
      minInterval, delay: opts.delay ?? 1000, timer: null, busy: false,
      ticks: 0, errors: 0, lastTick: 0, lastPublish: 0, lastError: null,
      spec: cmdSpec(id, kind, { minIntervalS: minInterval / 1000, maxIntervalS: 3600 })
    };
    devices.set(id, dev);
    return dev;
  }

  function schedule(dev, ms) {
    if (dev.timer) timers.clearTimeout(dev.timer);
    dev.timer = null;
    if (stopped) return;
    dev.timer = timers.setTimeout(() => { dev.timer = null; runDevice(dev); }, Math.max(0, ms));
  }

  // Ejecuta un tick y devuelve la espera hasta el siguiente (con backoff si una API falla)
  async function tickDevice(dev) {
    const t = now(); dev.lastTick = t; dev.ticks++;
    try {
      const f = await dev.model.tick(t);
      if (dev.kind === 'api') rules.onApi(dev.id, true, '', now());
      if (f) publishTelemetry(dev, f);
      dev.lastError = null;
      return dev.intervalMs;
    } catch (e) {
      dev.errors++; dev.lastError = e.message;
      if (dev.kind !== 'api') { log.error('fallo en tick', { device: dev.id, err: e }); return dev.intervalMs; }
      const fails = dev.model.fails || 1;
      log.warn('API fallo', { device: dev.id, err: e, fails, cache: e.cached ? `${e.cached.age_s}s` : 'no' });
      rules.onApi(dev.id, false, e.message, now());
      // Ultimo valor bueno (stale=1) a la cadencia normal, para no dejar huecos ni duplicar puntos
      if (e.cached && now() - dev.lastPublish >= dev.intervalMs) publishTelemetry(dev, e.cached);
      if (e.permanent) return dev.intervalMs;
      return Math.min(dev.intervalMs, dev.minInterval * 2 ** (fails - 1)); // 60 s, 120 s, 240 s... hasta el intervalo
    }
  }

  async function runDevice(dev) {
    if (stopped) return;
    if (dev.busy) return; // el tick en curso reprograma al terminar
    let wait = dev.intervalMs;
    if (dev.enabled && (!dev.gate || dev.gate())) {
      dev.busy = true;
      try { wait = await tickDevice(dev); } finally { dev.busy = false; }
    }
    if (!dev.timer) schedule(dev, wait); // si un comando ya reprogramo, respetarlo
  }

  // ---------- Registro ----------
  const getJson = (url) => A.fetchJson(url, { timeoutMs: cfg.apiTimeoutMs, retries: cfg.apiRetries, fetchImpl, ...(sleep ? { sleep } : {}) });
  const azureWeather = A.createApiModel(async () => {
    if (!cfg.azureKey) throw new A.ApiError('falta AZURE_MAPS_KEY', { retryable: false, permanent: true });
    return A.parseAzure(await getJson(A.azureUrl(cfg.lat, cfg.lon, cfg.azureKey)));
  }, { cacheMaxMs: cfg.apiCacheMaxMs, onValue: (f) => { world.tempOut = f.temperature; } });
  const openMeteoAq = A.createApiModel(async () => A.parseOpenMeteo(await getJson(A.openMeteoUrl(cfg.lat, cfg.lon))), { cacheMaxMs: cfg.apiCacheMaxMs });

  register(REAL_ID, 'real', M.createEsp32Sim(), 10000, {
    noStatus: true, noState: true, delay: 500,
    gate: () => !source.isReal(now()) // solo simula si la real no esta enviando
  });
  register('cam-sala-twin', 'twin', M.createCamSala(), 10000);
  register('termostato-twin', 'twin', M.createTermostato(world), 15000);
  register('enchufe-twin', 'twin', M.createEnchufe(world), 10000);
  register('puerta-twin', 'twin', M.createPuerta(world), 10000);
  register('luz-twin', 'twin', M.createLuz(world), 15000);
  register('api-azure-weather', 'api', azureWeather, 300000, { minInterval: 60000, delay: 2000 });
  register('api-openmeteo-aq', 'api', openMeteoAq, 300000, { minInterval: 60000, delay: 3000 });
  for (const [id, file] of DATASETS) {
    try {
      const { header, rows } = M.parseCsv(readFile(path.join(cfg.datasetsDir, file)));
      if (!rows.length) throw new Error('CSV sin filas');
      register(id, 'dataset', M.createReplay(rows, header, (o) => o), 15000, { minInterval: 1000 });
      log.info('dataset cargado', { device: id, rows: rows.length });
    } catch (e) { log.error('no se pudo cargar el dataset', { device: id, file, err: e }); }
  }

  // ---------- Mensajes entrantes ----------
  function handleCmd(id, buf) {
    if (id === 'boss') { // reinicio del puntaje y contadores del jefe
      const o = parseJsonObject(buf);
      if (o && toBool(o.reset) === true) { boss.reset(); log.info('CMD jefe reiniciado'); }
      return;
    }
    const dev = devices.get(id);
    if (!dev || dev.kind === 'real') return; // la ESP32 real recibe sus comandos directo
    stats.cmds++;
    const o = parseJsonObject(buf);
    if (!o) { stats.cmds_invalid++; log.warn('CMD ignorado: no es un objeto JSON valido', { device: id }); return; }
    const { cmd, rejected, unknown } = sanitizeCmd(o, dev.spec);
    if (rejected.length || unknown.length) log.warn('CMD con campos ignorados', { device: id, invalid: rejected.join(',') || undefined, unknown: unknown.join(',') || undefined });
    if (!Object.keys(cmd).length) stats.cmds_invalid++;

    let resched = null;
    if ('enabled' in cmd) { const was = dev.enabled; dev.enabled = cmd.enabled; if (!was && dev.enabled) resched = 500; }
    if ('interval_s' in cmd) {
      const ms = Math.round(cmd.interval_s * 1000);
      if (ms !== dev.intervalMs) { dev.intervalMs = ms; resched ??= ms; }
    }
    try { dev.model.cmd(cmd); } catch (e) { log.warn('cmd() del modelo fallo', { device: id, err: e }); }
    if (resched !== null && !dev.busy) schedule(dev, resched); // el cambio aplica ya, no al final del intervalo viejo
    publishState(dev); // siempre se re-publica: el panel se resincroniza aunque el comando no fuera valido
    log.info('CMD', { device: id, cmd: JSON.stringify(cmd) });
  }

  function handleTelemetry(id, buf) {
    if (id === 'boss' || id === 'bridge') return; // las nuestras derivadas
    const o = parseJsonObject(buf, 16384);
    if (!o) { stats.msgs_invalid++; return; }
    const t = now();
    if (id === REAL_ID && !o.sim) source.markReal(t);
    rules.onTelemetry(id, o, t);
    if (id !== REAL_ID) return;
    if (o.sim && source.isReal(t)) return; // simulacion rezagada: no mezclarla con la real
    const b = boss.update(o.motion, t);
    if (!b) return;
    world.present = b.name !== 'absent';
    rules.onBoss(b, t);
    const { name, ...fields } = b;
    pub('jefe/boss/telemetry', { ...fields, sim: o.sim ? 1 : 0 });
  }

  function handleMessage(topic, buf) {
    try {
      stats.msgs_in++;
      const parts = String(topic).split('/');
      if (parts.length !== 3 || parts[0] !== 'jefe' || !parts[1]) return;
      const [, id, kind] = parts;
      if (kind === 'cmd') handleCmd(id, buf);
      else if (kind === 'telemetry') handleTelemetry(id, buf);
    } catch (e) { log.error('error procesando mensaje', { topic, err: e }); } // un mensaje malo nunca tumba el proceso
  }

  // ---------- Fuente de datos (real / simulada) ----------
  function checkSource() {
    const r = source.check(now());
    if (!r.changed) return r;
    pub('jefe/bridge/mode', r.mode, { retain: true, qos: 1 });
    if (rules.onSource(r.mode, r.first)) log.info('fuente de datos', { mode: r.mode });
    else log.info('Arranque en modo simulado (ESP32-CAM real sin datos)');
    return r;
  }

  // ---------- Ciclo de vida ----------
  function onConnect() {
    log.info('MQTT conectado', { url: cfg.mqttUrl, clientId: cfg.clientId });
    pub('jefe/bridge/status', 'online', { retain: true, qos: 1 });
    client.subscribe(['jefe/+/cmd', 'jefe/+/telemetry'], { qos: 0 }, (err) => { if (err) log.error('no se pudo suscribir', { err }); });
    // Re-publicar lo retenido: si el broker se reinicio sin persistencia, el panel lo necesita
    for (const dev of devices.values()) {
      if (!dev.noStatus) pub(`jefe/${dev.id}/status`, 'online', { retain: true, qos: 1 });
      publishState(dev);
    }
    if (source.mode) pub('jefe/bridge/mode', source.mode, { retain: true, qos: 1 });
  }

  function start() {
    stopped = false;
    for (const dev of devices.values()) schedule(dev, dev.delay + random() * 3000);
    modeTimer = timers.setInterval(checkSource, 5000);
  }

  function stop() {
    stopped = true;
    for (const dev of devices.values()) { if (dev.timer) timers.clearTimeout(dev.timer); dev.timer = null; }
    if (modeTimer) timers.clearInterval(modeTimer);
    modeTimer = null;
  }

  // Mensajes retenidos a publicar al apagar
  const offlineMessages = () => [['jefe/bridge/status', 'offline'], ...[...devices.values()].filter((d) => !d.noStatus).map((d) => [`jefe/${d.id}/status`, 'offline'])];

  function health() {
    const t = now();
    const devs = {};
    for (const d of devices.values()) {
      devs[d.id] = {
        kind: d.kind, enabled: d.enabled, interval_s: d.intervalMs / 1000, ticks: d.ticks, errors: d.errors,
        last_publish_s_ago: d.lastPublish ? Math.round((t - d.lastPublish) / 1000) : null, last_error: d.lastError,
        ...(d.kind === 'api' && d.model.status ? { api: d.model.status(t) } : {})
      };
    }
    const connected = !!client.connected;
    return {
      status: connected && !stopped ? 'ok' : 'degraded', mqtt: connected ? 'connected' : 'disconnected', mode: source.mode || 'starting',
      uptime_s: Math.round((t - startedAt) / 1000), last_real_s_ago: source.lastReal ? Math.round((t - source.lastReal) / 1000) : null,
      boss: boss.snapshot(t), events: { sent: limiter.sent, dropped: limiter.dropped }, stats, devices: devs
    };
  }

  return { devices, world, boss, rules, source, config: cfg, stats, handleMessage, handleCmd, handleTelemetry, tickDevice, runDevice, checkSource, onConnect, start, stop, health, offlineMessages, publishState };
}

// Servidor HTTP minimo: GET /health (200 si MQTT conectado, 503 si no)
function createHealthServer(bridge, log = silentLogger()) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
      let h; try { h = bridge.health(); } catch (e) { h = { status: 'error', error: e.message }; }
      res.writeHead(h.status === 'ok' ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(h));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
  });
  server.on('error', (e) => log.error('servidor de salud', { err: e }));
  return server;
}

module.exports = { createBridge, createHealthServer, loadConfig, REAL_ID };
