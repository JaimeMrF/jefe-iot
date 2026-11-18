'use strict';
// Credenciales de la placa publicadas para el panel (aprovisionamiento BLE solo con WiFi)
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createBridge, loadConfig } = require('../src/bridge');

class FakeClient extends EventEmitter {
  constructor() { super(); this.connected = true; this.published = []; }
  publish(topic, payload, opts, cb) { this.published.push({ topic, payload, ...opts }); if (cb) cb(); }
  subscribe(t, o, cb) { if (cb) cb(null); }
}
const timers = { setTimeout: () => ({}), clearTimeout: () => {}, setInterval: () => ({}), clearInterval: () => {} };
const TOPIC = 'jefe/provision/esp32cam-01';

test('publica las credenciales de la placa retenidas con QoS 1 al conectar', () => {
  const client = new FakeClient();
  const config = loadConfig({ PROVISION_ESP_USER: 'esp32', PROVISION_ESP_PASS: 's3cr3t', DATASETS_DIR: '/nonexistent' });
  const b = createBridge({ client, config, timers });
  b.onConnect();
  const msgs = client.published.filter((p) => p.topic === TOPIC);
  assert.equal(msgs.length, 1);
  assert.deepEqual(JSON.parse(msgs[0].payload), { user: 'esp32', pass: 's3cr3t' });
  assert.equal(msgs[0].retain, true);
  assert.equal(msgs[0].qos, 1);
});

test('sin clave de la placa no publica nada', () => {
  const client = new FakeClient();
  const b = createBridge({ client, config: loadConfig({ PROVISION_ESP_USER: 'esp32', DATASETS_DIR: '/nonexistent' }), timers });
  b.onConnect();
  assert.equal(client.published.filter((p) => p.topic === TOPIC).length, 0);
});

test('la clave no aparece en /health', () => {
  const b = createBridge({ client: new FakeClient(), config: loadConfig({ PROVISION_ESP_USER: 'esp32', PROVISION_ESP_PASS: 's3cr3t', DATASETS_DIR: '/nonexistent' }), timers });
  assert.ok(!JSON.stringify(b.health()).includes('s3cr3t'));
});
