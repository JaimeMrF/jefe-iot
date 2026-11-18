'use strict';
// Integracion del bridge con un cliente MQTT falso, timers manuales y fetch simulado
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');
const { createBridge, createHealthServer, loadConfig } = require('../src/bridge');
const { createLogger } = require('../src/log');

class FakeClient extends EventEmitter {
  constructor() { super(); this.connected = true; this.published = []; this.subs = []; this.options = {}; }
  publish(topic, payload, opts, cb) { this.published.push({ topic, payload, ...opts }); if (cb) cb(); }
  subscribe(t, o, cb) { this.subs.push(...[].concat(t)); if (cb) cb(null); }
  on$(topic) { return this.published.filter((p) => p.topic === topic); }
  json(topic) { return this.on$(topic).map((p) => JSON.parse(p.payload)); }
  clear() { this.published = []; }
}
const fakeTimers = () => {
  const list = new Map(); let id = 0;
  return {
    list,
    setTimeout: (fn, ms) => { const h = { id: ++id, fn, ms }; list.set(h.id, h); return h; },
    clearTimeout: (h) => { if (h) list.delete(h.id); },
    setInterval: (fn, ms) => ({ id: ++id, fn, ms, interval: true }),
    clearInterval: () => {},
    pending: (pred = () => true) => [...list.values()].filter(pred)
  };
};

const DATASETS = path.join(__dirname, '..', '..', 'datasets');
function setup({ env = {}, fetchImpl, clock = { t: 1.7e12 } } = {}) {
  const client = new FakeClient(); const timers = fakeTimers();
  const config = loadConfig({ DATASETS_DIR: DATASETS, ...env });
  const lines = [];
  const log = createLogger({ level: 'debug', out: (l) => lines.push(l), err: (l) => lines.push(l) });
  const b = createBridge({ client, config, log, timers, now: () => clock.t, sleep: () => Promise.resolve(), fetchImpl: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({ current: { us_aqi: 40, pm10: 10 } }) })) });
  const send = (topic, obj) => b.handleMessage(topic, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)));
  return { client, timers, b, clock, send, lines };
}

test('registra los 11 dispositivos (10 del bridge + datasets) con sus IDs del contrato', () => {
  const { b } = setup();
  assert.deepEqual([...b.devices.keys()].sort(), ['api-azure-weather', 'api-openmeteo-aq', 'cam-sala-twin', 'ds-co2', 'ds-energia', 'ds-ocupacion', 'enchufe-twin', 'esp32cam-01', 'luz-twin', 'puerta-twin', 'termostato-twin']);
});
test('dataset que falta no tumba el arranque', () => {
  const client = new FakeClient();
  const b = createBridge({ client, config: loadConfig({ DATASETS_DIR: path.join(__dirname, 'no-existe') }), timers: fakeTimers() });
  assert.equal(b.devices.has('ds-co2'), false); assert.equal(b.devices.has('luz-twin'), true);
});

test('onConnect: status online, suscripciones y estados retenidos', () => {
  const { b, client } = setup();
  b.onConnect();
  assert.deepEqual(client.on$('jefe/bridge/status').map((p) => [p.payload, p.retain]), [['online', true]]);
  assert.deepEqual(client.subs, ['jefe/+/cmd', 'jefe/+/telemetry']);
  assert.equal(client.on$('jefe/luz-twin/status')[0].payload, 'online');
  assert.equal(client.on$('jefe/esp32cam-01/status').length, 0, 'la real maneja su propio status');
  assert.equal(client.on$('jefe/esp32cam-01/state').length, 0);
  const st = client.json('jefe/termostato-twin/state')[0];
  assert.deepEqual(st, { enabled: 1, interval_s: 15, kind: 'twin', setpoint: 20 });
  assert.ok(client.on$('jefe/termostato-twin/state')[0].retain);
});

test('start programa todos los dispositivos y stop los cancela', () => {
  const { b, timers } = setup();
  b.start(); assert.equal(timers.pending().length, 11);
  b.stop(); assert.equal(timers.pending().length, 0);
});

test('tick de un gemelo publica telemetria numerica', async () => {
  const { b, client } = setup();
  await b.tickDevice(b.devices.get('enchufe-twin'));
  const f = client.json('jefe/enchufe-twin/telemetry')[0];
  for (const k of ['power_w', 'voltage_v', 'current_a', 'energy_kwh', 'relay', 'sim']) assert.equal(typeof f[k], 'number', k);
});

// ---------- Comandos ----------
test('cmd valido: aplica, recorta y re-publica el estado', () => {
  const { b, client, send } = setup();
  send('jefe/termostato-twin/cmd', { setpoint: 99, interval_s: 30 });
  const st = client.json('jefe/termostato-twin/state').at(-1);
  assert.equal(st.setpoint, 30); assert.equal(st.interval_s, 30);
  assert.equal(b.devices.get('termostato-twin').intervalMs, 30000);
});
test('cmd basura (null, numero, array, texto, JSON roto) no revienta ni cambia nada', () => {
  const { b, client, send } = setup();
  for (const p of ['null', '5', '[1]', '"hola"', '{roto', '']) assert.doesNotThrow(() => send('jefe/luz-twin/cmd', p));
  assert.equal(client.on$('jefe/luz-twin/state').length, 0);
  assert.equal(b.devices.get('luz-twin').enabled, true);
  assert.equal(b.stats.cmds_invalid, 6);
});
test('cmd interval_s NaN/texto no rompe el bucle; enabled "false" apaga', () => {
  const { b, send } = setup();
  const dev = b.devices.get('luz-twin');
  send('jefe/luz-twin/cmd', '{"interval_s":"rapido"}');
  assert.equal(dev.intervalMs, 15000);
  send('jefe/luz-twin/cmd', { enabled: 'false' });
  assert.equal(dev.enabled, false);
});
test('cmd interval_s respeta el minimo por tipo (APIs >= 60 s)', () => {
  const { b, send } = setup();
  send('jefe/api-openmeteo-aq/cmd', { interval_s: 1 });
  assert.equal(b.devices.get('api-openmeteo-aq').intervalMs, 60000);
});
test('cmd interval_s reprograma el timer de inmediato', () => {
  const { b, timers, send } = setup();
  b.start();
  send('jefe/ds-co2/cmd', { interval_s: 3600 });
  send('jefe/ds-co2/cmd', { interval_s: 2 });
  const dev = b.devices.get('ds-co2');
  assert.equal(dev.timer.ms, 2000);
  assert.equal(timers.pending().length, 11);
});
test('cmd enabled true tras apagado reprograma en 0.5 s', () => {
  const { b, send } = setup(); b.start();
  send('jefe/luz-twin/cmd', { enabled: false }); send('jefe/luz-twin/cmd', { enabled: true });
  assert.equal(b.devices.get('luz-twin').timer.ms, 500);
});
test('dispositivo apagado no publica', async () => {
  const { b, client, send } = setup();
  send('jefe/luz-twin/cmd', { enabled: 0 });
  await b.runDevice(b.devices.get('luz-twin'));
  assert.equal(client.on$('jefe/luz-twin/telemetry').length, 0);
});
test('cmd a la ESP32 real o a dispositivos desconocidos se ignora', () => {
  const { client, send } = setup();
  send('jefe/esp32cam-01/cmd', { enabled: false }); send('jefe/no-existe/cmd', { enabled: false });
  assert.equal(client.published.length, 0);
});
test('cmd de luz, enchufe, puerta y dataset llegan al modelo', async () => {
  const { b, client, send } = setup();
  send('jefe/luz-twin/cmd', { on: 'on', brightness: 40 });
  assert.deepEqual(client.json('jefe/luz-twin/state').at(-1), { enabled: 1, interval_s: 15, kind: 'twin', mode: 'manual', on: 1, brightness: 40 });
  send('jefe/enchufe-twin/cmd', { relay: false });
  assert.equal(client.json('jefe/enchufe-twin/state').at(-1).relay, 0);
  send('jefe/ds-co2/cmd', { row: 10 });
  assert.equal(client.json('jefe/ds-co2/state').at(-1).row, 10);
  send('jefe/ds-co2/cmd', { rewind: true });
  assert.equal(client.json('jefe/ds-co2/state').at(-1).row, 0);
  send('jefe/puerta-twin/cmd', { door: true });
  await b.tickDevice(b.devices.get('puerta-twin'));
  assert.equal(client.json('jefe/puerta-twin/telemetry').at(-1).door_open, 1);
});
test('cmd jefe/boss/cmd reset reinicia el puntaje', () => {
  const { b, send, clock } = setup();
  for (let i = 0; i < 30; i++) { clock.t += 10000; send('jefe/esp32cam-01/telemetry', { motion: 40, sim: 1 }); }
  assert.ok(b.boss.snapshot().score < 50);
  send('jefe/boss/cmd', { reset: true });
  assert.equal(b.boss.snapshot().score, 50);
});

// ---------- Telemetria, jefe y real/simulada ----------
test('telemetria de la ESP32 alimenta al jefe y publica jefe/boss/telemetry', () => {
  const { client, send, clock } = setup();
  for (let i = 0; i < 6; i++) { clock.t += 10000; send('jefe/esp32cam-01/telemetry', { motion: 30, sim: 1 }); }
  const last = client.json('jefe/boss/telemetry').at(-1);
  assert.equal(last.state, 2); assert.equal(last.sim, 1); assert.equal('name' in last, false);
  for (const k of ['score', 'motion_avg', 'focused_min', 'distracted_min', 'absent_min', 'focus_pct', 'state_s']) assert.equal(typeof last[k], 'number', k);
});
test('telemetria real sin campo sim o con sim=0 cuenta como real', () => {
  for (const extra of [{}, { sim: 0 }]) {
    const { b, send } = setup();
    send('jefe/esp32cam-01/telemetry', { motion: 3, ...extra });
    assert.equal(b.source.isReal(b.source.lastReal), true);
  }
});
test('cambio real <-> simulado: modo retenido, evento fuente_datos y la simulacion se detiene', async () => {
  const { b, client, send, clock } = setup();
  let r = b.checkSource(); assert.equal(r.mode, 'sim');
  assert.equal(client.on$('jefe/bridge/mode').at(-1).payload, 'sim');
  assert.equal(client.on$('jefe/esp32cam-01/event').length, 0, 'arrancar simulado no es un cambio');
  const sim = b.devices.get('esp32cam-01');
  assert.equal(sim.gate(), true);
  send('jefe/esp32cam-01/telemetry', { motion: 5, rssi: -60 });
  r = b.checkSource(); assert.equal(r.mode, 'real');
  assert.equal(sim.gate(), false, 'con la real activa no se simula');
  const ev = client.json('jefe/esp32cam-01/event');
  assert.deepEqual([ev[0].rule, ev[0].value], ['fuente_datos', 1]);
  // la simulacion rezagada no se mezcla con la real en el jefe
  const before = client.on$('jefe/boss/telemetry').length;
  send('jefe/esp32cam-01/telemetry', { motion: 90, sim: 1 });
  assert.equal(client.on$('jefe/boss/telemetry').length, before);
  clock.t += 91000;
  r = b.checkSource(); assert.equal(r.mode, 'sim');
  assert.equal(client.json('jefe/esp32cam-01/event').at(-1).value, 0);
  assert.equal(sim.gate(), true);
});
test('REAL_TIMEOUT_S configurable', () => {
  const { b, send, clock } = setup({ env: { REAL_TIMEOUT_S: '30' } });
  send('jefe/esp32cam-01/telemetry', { motion: 5 }); b.checkSource();
  clock.t += 31000; assert.equal(b.checkSource().mode, 'sim');
});
test('motion invalido de la placa no publica jefe ni revienta', () => {
  const { client, send } = setup();
  for (const m of [null, 'x', NaN]) send('jefe/esp32cam-01/telemetry', `{"motion":${JSON.stringify(m)}}`);
  send('jefe/esp32cam-01/telemetry', 'null');
  assert.equal(client.on$('jefe/boss/telemetry').length, 0);
});
test('telemetria basura en cualquier topico no revienta', () => {
  const { b } = setup();
  for (const t of ['jefe/ds-co2/telemetry', 'jefe/puerta-twin/telemetry', 'jefe/x/y/z', 'otro/topico', 'jefe//telemetry'])
    for (const p of ['null', '7', '[]', '{bad', '']) assert.doesNotThrow(() => b.handleMessage(t, Buffer.from(p)));
});
test('reglas sobre telemetria entrante publican en jefe/<id>/event', () => {
  const { client, send } = setup();
  send('jefe/ds-co2/telemetry', { co2: 1700 });
  const ev = client.json('jefe/ds-co2/event')[0];
  assert.deepEqual(Object.keys(ev).sort(), ['device', 'msg', 'rule', 'severity', 'value']);
  assert.equal(ev.rule, 'co2_alto'); assert.equal(ev.severity, 'critical');
});
test('limite global de eventos por minuto', () => {
  const { b, client, send } = setup({ env: { EVENTS_MAX_PER_MIN: '2' } });
  for (const id of ['api-a', 'api-b', 'api-c', 'api-d']) b.rules.onApi(id, false, 'x', 1);
  send('jefe/ds-co2/telemetry', { co2: 1700 });
  const events = client.published.filter((p) => p.topic.endsWith('/event'));
  assert.equal(events.length, 2);
  assert.equal(b.health().events.dropped, 3);
});

// ---------- APIs ----------
test('API OK publica telemetria y actualiza la temperatura exterior del mundo', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ results: [{ temperature: { value: 9.5 }, relativeHumidity: 80 }] }) });
  const { b, client } = setup({ env: { AZURE_MAPS_KEY: 'k' }, fetchImpl });
  await b.tickDevice(b.devices.get('api-azure-weather'));
  assert.equal(client.json('jefe/api-azure-weather/telemetry')[0].temperature, 9.5);
  assert.equal(b.world.tempOut, 9.5);
});
test('sin AZURE_MAPS_KEY: api_error (una vez por cooldown), sin reintentos rapidos ni peticion HTTP', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; throw new Error('no deberia llamarse'); };
  const { b, client } = setup({ fetchImpl });
  const dev = b.devices.get('api-azure-weather');
  assert.equal(await b.tickDevice(dev), 300000);
  await b.tickDevice(dev);
  assert.equal(calls, 0);
  const ev = client.json('jefe/api-azure-weather/event');
  assert.equal(ev.length, 1); assert.equal(ev[0].rule, 'api_error'); assert.match(ev[0].msg, /AZURE_MAPS_KEY/);
});
test('API caida: backoff 60/120/240 s, cache stale y api_recuperada al volver', async () => {
  let mode = 'ok';
  const fetchImpl = async () => { if (mode === 'down') return { ok: false, status: 503, json: async () => ({}) }; return { ok: true, status: 200, json: async () => ({ current: { us_aqi: 42, pm10: 9 } }) }; };
  const { b, client, clock } = setup({ fetchImpl });
  const dev = b.devices.get('api-openmeteo-aq');
  assert.equal(await b.tickDevice(dev), 300000);
  mode = 'down';
  clock.t += 60000; assert.equal(await b.tickDevice(dev), 60000);
  clock.t += 60000; assert.equal(await b.tickDevice(dev), 120000);
  clock.t += 120000; assert.equal(await b.tickDevice(dev), 240000);
  clock.t += 240000; assert.equal(await b.tickDevice(dev), 300000);
  const tele = client.json('jefe/api-openmeteo-aq/telemetry');
  const stale = tele.filter((t) => t.stale === 1);
  assert.ok(stale.length >= 1, 'publica el ultimo valor como stale');
  assert.equal(stale[0].us_aqi, 42); assert.ok(stale[0].age_s > 0);
  assert.ok(stale.length <= 2, 'no duplica puntos en cada reintento');
  mode = 'ok';
  clock.t += 300000; await b.tickDevice(dev);
  const rules = client.json('jefe/api-openmeteo-aq/event').map((e) => e.rule);
  assert.deepEqual(rules, ['api_error', 'api_recuperada']);
  assert.equal(b.health().devices['api-openmeteo-aq'].api.ok, true);
});
test('error en un modelo no detiene su bucle', async () => {
  const { b } = setup();
  const dev = b.devices.get('luz-twin'); dev.model.tick = () => { throw new Error('boom'); };
  assert.equal(await b.tickDevice(dev), dev.intervalMs);
  assert.equal(dev.errors, 1); assert.equal(dev.lastError, 'boom');
});

// ---------- Salud y apagado ----------
test('health: ok con MQTT conectado, degraded si no', () => {
  const { b, client } = setup();
  const h = b.health();
  assert.equal(h.status, 'ok'); assert.equal(h.mqtt, 'connected'); assert.equal(Object.keys(h.devices).length, 11);
  client.connected = false; assert.equal(b.health().status, 'degraded');
});
test('servidor /health responde 200/503 y 404 en otras rutas', async () => {
  const { b, client } = setup();
  const server = createHealthServer(b);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(`${base}/health`); assert.equal(res.status, 200); assert.equal((await res.json()).status, 'ok');
    client.connected = false;
    res = await fetch(`${base}/health`); assert.equal(res.status, 503);
    res = await fetch(`${base}/otra`); assert.equal(res.status, 404);
  } finally { server.close(); }
});
test('offlineMessages cubre el bridge y todos los dispositivos con status', () => {
  const { b } = setup();
  const msgs = b.offlineMessages();
  assert.deepEqual(msgs[0], ['jefe/bridge/status', 'offline']);
  assert.equal(msgs.length, 11); // bridge + 10 (la real maneja su LWT)
  assert.ok(msgs.every(([, p]) => p === 'offline'));
});
test('tras stop no se publica telemetria', async () => {
  const { b, client } = setup(); b.stop();
  await b.tickDevice(b.devices.get('enchufe-twin'));
  assert.equal(client.on$('jefe/enchufe-twin/telemetry').length, 0);
});

test('loadConfig: defaults seguros y valores invalidos ignorados', () => {
  const c = loadConfig({});
  assert.equal(c.mqttUrl, 'mqtt://mosquitto:1883'); assert.equal(c.clientId, 'jefe-bridge'); assert.equal(c.realTimeoutMs, 90000);
  assert.equal(c.healthPort, 8081); assert.equal(c.lat, '4.711'); assert.equal(c.lon, '-74.072');
  const bad = loadConfig({ LAT: '999', LON: 'abc', REAL_TIMEOUT_S: 'x', HEALTH_PORT: '-1', API_RETRIES: '50' });
  assert.equal(bad.lat, '4.711'); assert.equal(bad.lon, '-74.072'); assert.equal(bad.realTimeoutMs, 90000); assert.equal(bad.healthPort, 0); assert.equal(bad.apiRetries, 5);
});
