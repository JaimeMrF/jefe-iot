'use strict';
// Bridge de Jefe IoT: gemelos digitales, APIs, datasets, logica del jefe y alertas, todo sobre MQTT.
//  - La ESP32-CAM real (esp32cam-01) manda su telemetria directo al broker.
//  - Mientras la real NO envie datos, este servicio simula esp32cam-01 (campo sim=1). Al llegar datos reales, la simulacion se apaga sola.
const fs = require('fs');
const mqtt = require('mqtt');
const M = require('./models');
const { createBoss, createRules } = require('./logic');

const env = process.env;
const LAT = env.LAT || '4.711';
const LON = env.LON || '-74.072';
const DATASETS = env.DATASETS_DIR || '/datasets';
const REAL_TIMEOUT_MS = 90000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

const client = mqtt.connect(env.MQTT_URL || 'mqtt://mosquitto:1883', {
  username: env.MQTT_USER || undefined, password: env.MQTT_PASS || undefined,
  clientId: 'jefe-bridge', reconnectPeriod: 2000,
  will: { topic: 'jefe/bridge/status', payload: 'offline', retain: true, qos: 1 }
});
const pub = (topic, obj, retain = false) => client.publish(topic, typeof obj === 'string' ? obj : JSON.stringify(obj), { retain });

const world = { present: false, tempOut: 14, tempSala: 19 };
const boss = createBoss();
let lastReal = 0;
let mode = null; // 'real' | 'sim'

// ---------- Eventos / reglas ----------
const emit = (rule, severity, device, value, msg) => {
  log('EVENTO', rule, severity, device, value);
  pub(`jefe/${device}/event`, { rule, severity, device, value, msg });
};
const rules = createRules(emit, M.hourBogota);

// ---------- Dispositivos ----------
const devices = {};
const lastErr = {};
function publishState(dev) {
  if (dev.noState) return;
  pub(`jefe/${dev.id}/state`, { enabled: dev.enabled ? 1 : 0, interval_s: dev.intervalMs / 1000, kind: dev.kind, ...dev.model.params() }, true);
}
function register(id, kind, model, intervalMs, opts = {}) {
  const dev = { id, kind, model, intervalMs, enabled: true, gate: opts.gate, noState: !!opts.noState, minInterval: opts.minInterval || 1000 };
  devices[id] = dev;
  if (!opts.noStatus) pub(`jefe/${id}/status`, 'online', true);
  publishState(dev);
  const loop = async () => {
    if (dev.enabled && (!dev.gate || dev.gate())) {
      try {
        const f = await dev.model.tick(Date.now());
        if (f) { for (const k of Object.keys(f)) if (f[k] === null || f[k] === undefined || Number.isNaN(f[k])) delete f[k]; pub(`jefe/${id}/telemetry`, f); }
      } catch (e) {
        log(id, 'ERROR', e.message);
        const now = Date.now();
        if (kind === 'api' && (!lastErr[id] || now - lastErr[id] > 30 * 60000)) { lastErr[id] = now; emit('api_error', 'warning', id, 1, `${id}: ${e.message}`); }
      }
    }
    setTimeout(loop, dev.intervalMs);
  };
  setTimeout(loop, (opts.delay ?? 1000) + Math.random() * 3000);
}

async function getJson(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try { const res = await fetch(url, { signal: ctl.signal }); if (!res.ok) throw new Error(`HTTP ${res.status}`); return await res.json(); } finally { clearTimeout(t); }
}

// ---------- APIs reales ----------
const azureWeather = {
  params: () => ({}), cmd() {},
  async tick() {
    if (!env.AZURE_MAPS_KEY) throw new Error('falta AZURE_MAPS_KEY');
    const j = await getJson(`https://atlas.microsoft.com/weather/currentConditions/json?api-version=1.1&query=${LAT},${LON}&subscription-key=${env.AZURE_MAPS_KEY}`);
    const c = j.results[0];
    world.tempOut = c.temperature.value;
    return {
      temperature: c.temperature.value, real_feel: c.realFeelTemperature?.value, humidity: c.relativeHumidity, wind_kmh: c.wind?.speed?.value,
      gust_kmh: c.windGust?.speed?.value, uv_index: c.uvIndex, visibility_km: c.visibility?.value, cloud_cover: c.cloudCover,
      pressure_mb: c.pressure?.value, precip: c.hasPrecipitation ? 1 : 0, is_day: c.isDayTime ? 1 : 0
    };
  }
};
const openMeteoAq = {
  params: () => ({}), cmd() {},
  async tick() {
    const j = await getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LAT}&longitude=${LON}&current=pm10,pm2_5,us_aqi,uv_index,carbon_monoxide,nitrogen_dioxide`);
    const c = j.current;
    return { pm10: c.pm10, pm2_5: c.pm2_5, us_aqi: c.us_aqi, uv_index: c.uv_index, co_ugm3: c.carbon_monoxide, no2_ugm3: c.nitrogen_dioxide };
  }
};

// ---------- Registro ----------
register('esp32cam-01', 'real', M.createEsp32Sim(), 10000, {
  noStatus: true, noState: true, delay: 500,
  gate: () => Date.now() - lastReal > REAL_TIMEOUT_MS // solo simula si la real no esta enviando
});
register('cam-sala-twin', 'twin', M.createCamSala(), 10000);
register('termostato-twin', 'twin', M.createTermostato(world), 15000);
register('enchufe-twin', 'twin', M.createEnchufe(world), 10000);
register('puerta-twin', 'twin', M.createPuerta(world), 10000);
register('luz-twin', 'twin', M.createLuz(world), 15000);
register('api-azure-weather', 'api', azureWeather, 300000, { minInterval: 60000, delay: 2000 });
register('api-openmeteo-aq', 'api', openMeteoAq, 300000, { minInterval: 60000, delay: 3000 });
for (const [id, file, kind] of [['ds-energia', 'energia.csv'], ['ds-co2', 'co2.csv'], ['ds-ocupacion', 'ocupacion.csv']]) {
  try {
    const { header, rows } = M.parseCsv(fs.readFileSync(`${DATASETS}/${file}`, 'utf8'));
    register(id, 'dataset', M.createReplay(rows, header, (o) => o), 15000, { minInterval: 1000 });
    log(id, 'dataset cargado:', rows.length, 'filas');
  } catch (e) { log(id, 'no se pudo cargar', file, e.message); }
}

// ---------- Mensajes entrantes ----------
client.on('connect', () => {
  log('MQTT conectado');
  pub('jefe/bridge/status', 'online', true);
  client.subscribe(['jefe/+/cmd', 'jefe/+/telemetry']);
});
client.on('error', (e) => log('MQTT error', e.message));

client.on('message', (topic, buf) => {
  const [, id, kind] = topic.split('/');
  let o; try { o = JSON.parse(buf.toString()); } catch { return; }
  const now = Date.now();

  if (kind === 'cmd') { // retroceso: apagar, ajustar, calibrar los dispositivos que maneja el bridge
    const dev = devices[id];
    if (!dev || dev.kind === 'real') return; // la ESP32 real recibe sus comandos directo
    if ('enabled' in o) dev.enabled = !!o.enabled;
    if (typeof o.interval_s === 'number') dev.intervalMs = Math.max(dev.minInterval, Math.min(3600000, o.interval_s * 1000));
    dev.model.cmd(o);
    publishState(dev);
    log('CMD', id, JSON.stringify(o));
    return;
  }

  // telemetria (de cualquier dispositivo, incluidos los propios): reglas y logica del jefe
  rules.onTelemetry(id, o, now);
  if (id === 'esp32cam-01' && typeof o.motion === 'number') {
    if (!('sim' in o)) lastReal = now;
    const b = boss.update(o.motion, now);
    world.present = b.name !== 'absent';
    rules.onBoss(b, now);
    const { name, ...fields } = b;
    pub('jefe/boss/telemetry', { ...fields, sim: o.sim ? 1 : 0 });
  }
});

// Vigilante de la fuente de datos: real o simulada
setInterval(() => {
  const real = Date.now() - lastReal < REAL_TIMEOUT_MS;
  const m = real ? 'real' : 'sim';
  if (m !== mode) {
    const first = mode === null; mode = m;
    pub('jefe/bridge/mode', m, true);
    if (!first || m === 'real') emit('fuente_datos', 'info', 'esp32cam-01', real ? 1 : 0, real ? 'ESP32-CAM real conectada: se detiene la simulacion' : 'ESP32-CAM real sin datos: simulacion activada');
    else log('Arranque en modo simulado (ESP32-CAM real sin datos)');
  }
}, 5000);

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { pub('jefe/bridge/status', 'offline', true); setTimeout(() => process.exit(0), 300); });
