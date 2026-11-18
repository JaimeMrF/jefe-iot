'use strict';
// Motor de reglas / alertas: umbrales, severidad, cooldown, escalada y condiciones sostenidas
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRules } = require('../src/logic');

const MIN = 60000;
const mk = (hour = 12) => { const ev = []; const r = createRules((rule, severity, device, value, msg) => ev.push({ rule, severity, device, value, msg }), () => hour); return { ev, r }; };

test('co2 alto genera alerta con cooldown y escala a critica', () => {
  const { ev, r } = mk();
  r.onTelemetry('ds-co2', { co2: 1200 }, 1e9); r.onTelemetry('ds-co2', { co2: 1300 }, 1e9 + 1000);
  assert.equal(ev.length, 1); assert.equal(ev[0].rule, 'co2_alto'); assert.equal(ev[0].severity, 'warning');
  r.onTelemetry('ds-co2', { co2: 1600 }, 1e9 + 20 * MIN);
  assert.equal(ev.length, 2); assert.equal(ev[1].severity, 'critical');
});
test('co2: la escalada warning -> critical se salta el cooldown, pero no al reves', () => {
  const { ev, r } = mk();
  r.onTelemetry('ds-co2', { co2: 1100 }, 1e9);
  r.onTelemetry('ds-co2', { co2: 1700 }, 1e9 + MIN);
  assert.deepEqual(ev.map((e) => e.severity), ['warning', 'critical']);
  r.onTelemetry('ds-co2', { co2: 1800 }, 1e9 + 2 * MIN);
  r.onTelemetry('ds-co2', { co2: 1100 }, 1e9 + 3 * MIN);
  assert.equal(ev.length, 2);
});
test('co2 en el umbral exacto o normal no alerta; otros dispositivos con co2 tampoco', () => {
  const { ev, r } = mk();
  r.onTelemetry('ds-co2', { co2: 1000 }, 1e9); r.onTelemetry('ds-co2', { co2: 500 }, 1e9);
  r.onTelemetry('ds-ocupacion', { co2: 5000 }, 1e9);
  assert.equal(ev.length, 0);
});
test('temperatura alta en la sala', () => {
  const { ev, r } = mk();
  r.onTelemetry('termostato-twin', { temp_sala: 27.9 }, 1e9); assert.equal(ev.length, 0);
  r.onTelemetry('termostato-twin', { temp_sala: 28.5 }, 1e9); assert.equal(ev[0].rule, 'temperatura_alta'); assert.equal(ev[0].value, 28.5);
  r.onTelemetry('termostato-twin', { temp_sala: 29 }, 1e9 + 14 * MIN); assert.equal(ev.length, 1);
  r.onTelemetry('termostato-twin', { temp_sala: 29 }, 1e9 + 15 * MIN); assert.equal(ev.length, 2);
});
test('consumo alto del enchufe (info)', () => {
  const { ev, r } = mk();
  r.onTelemetry('enchufe-twin', { power_w: 300 }, 1e9); assert.equal(ev.length, 0);
  r.onTelemetry('enchufe-twin', { power_w: 350 }, 1e9); assert.equal(ev[0].rule, 'consumo_alto'); assert.equal(ev[0].severity, 'info');
});
test('aire exterior malo con cooldown de 1 h', () => {
  const { ev, r } = mk();
  r.onTelemetry('api-openmeteo-aq', { us_aqi: 150 }, 1e9);
  r.onTelemetry('api-openmeteo-aq', { us_aqi: 160 }, 1e9 + 59 * MIN);
  r.onTelemetry('api-openmeteo-aq', { us_aqi: 160 }, 1e9 + 60 * MIN);
  assert.equal(ev.filter((e) => e.rule === 'aire_exterior_malo').length, 2);
});
test('datos de cache (stale=1) no disparan reglas', () => {
  const { ev, r } = mk();
  r.onTelemetry('api-openmeteo-aq', { us_aqi: 300, stale: 1 }, 1e9);
  assert.equal(ev.length, 0);
});
test('valores no numericos o telemetria basura no disparan ni revientan', () => {
  const { ev, r } = mk();
  for (const f of [null, undefined, 5, 'x', [], { co2: '2000' }, { co2: NaN }, { co2: Infinity }]) r.onTelemetry('ds-co2', f, 1e9);
  r.onTelemetry('termostato-twin', { temp_sala: 'caliente' }, 1e9);
  assert.equal(ev.length, 0);
});
test('puerta abierta > 10 min', () => {
  const { ev, r } = mk(); let t = 1e9;
  for (let i = 0; i <= 61; i++, t += 10000) r.onTelemetry('puerta-twin', { door_open: 1, pir: 1 }, t); // > 10 min estrictamente
  const e = ev.filter((x) => x.rule === 'puerta_abierta_larga');
  assert.equal(e.length, 1); assert.equal(e[0].severity, 'warning'); assert.equal(e[0].value, 10);
});
test('puerta: cerrar reinicia el conteo', () => {
  const { ev, r } = mk(); let t = 1e9;
  for (let i = 0; i < 50; i++, t += 10000) r.onTelemetry('puerta-twin', { door_open: 1, pir: 1 }, t);
  r.onTelemetry('puerta-twin', { door_open: 0, pir: 1 }, t);
  for (let i = 0; i < 50; i++, t += 10000) r.onTelemetry('puerta-twin', { door_open: 1, pir: 1 }, t);
  assert.equal(ev.filter((x) => x.rule === 'puerta_abierta_larga').length, 0);
});
test('puerta: un hueco largo sin datos reinicia el conteo (no cuenta tiempo no observado)', () => {
  const { ev, r } = mk();
  r.onTelemetry('puerta-twin', { door_open: 1, pir: 1 }, 1e9);
  r.onTelemetry('puerta-twin', { door_open: 1, pir: 1 }, 1e9 + 60 * MIN);
  assert.equal(ev.length, 0);
});
test('movimiento sospechoso: puerta abierta con PIR en 0 (critica)', () => {
  const { ev, r } = mk();
  r.onTelemetry('puerta-twin', { door_open: 1, pir: 0 }, 2e9);
  assert.equal(ev[0].rule, 'movimiento_sospechoso'); assert.equal(ev[0].severity, 'critical');
  r.onTelemetry('puerta-twin', { door_open: 1, pir: 0 }, 2e9 + 5 * MIN);
  assert.equal(ev.length, 1);
});
test('movimiento sospechoso: sin campo pir, con presencia o puerta cerrada no alerta', () => {
  const { ev, r } = mk();
  r.onTelemetry('puerta-twin', { door_open: 1 }, 2e9);
  r.onTelemetry('puerta-twin', { door_open: 1, pir: 1 }, 2e9);
  r.onTelemetry('puerta-twin', { door_open: 0, pir: 0 }, 2e9);
  assert.equal(ev.length, 0);
});
test('distraido prolongado a los 60 s y luego cada 5 min', () => {
  const { ev, r } = mk(); let t = 1e9;
  for (let i = 0; i <= 6; i++, t += 10000) r.onBoss({ name: 'distracted' }, t);
  assert.equal(ev.length, 1); assert.equal(ev[0].rule, 'distraido_prolongado'); assert.equal(ev[0].device, 'boss'); assert.equal(ev[0].value, 60);
  for (let i = 0; i < 30; i++, t += 10000) r.onBoss({ name: 'distracted' }, t);
  assert.equal(ev.length, 2);
});
test('distraido: volver a enfocado reinicia', () => {
  const { ev, r } = mk(); let t = 1e9;
  for (let i = 0; i < 5; i++, t += 10000) r.onBoss({ name: 'distracted' }, t);
  r.onBoss({ name: 'focused' }, t);
  for (let i = 0; i < 5; i++, t += 10000) r.onBoss({ name: 'distracted' }, t);
  assert.equal(ev.length, 0);
});
test('ausente largo solo en horario laboral (9-18 h)', () => {
  for (const [hour, expected] of [[12, 1], [8, 0], [18, 0], [9, 1]]) {
    const { ev, r } = mk(hour); let t = 1e9;
    for (let i = 0; i <= 31; i++, t += MIN) r.onBoss({ name: 'absent' }, t);
    assert.equal(ev.filter((e) => e.rule === 'ausente_largo').length, expected, `hora ${hour}`);
  }
});
test('ausente largo: valor en minutos y severidad info', () => {
  const { ev, r } = mk(); let t = 1e9;
  for (let i = 0; i <= 31; i++, t += MIN) r.onBoss({ name: 'absent' }, t);
  assert.equal(ev[0].severity, 'info'); assert.equal(ev[0].value, 31);
});
test('onBoss ignora null', () => { const { ev, r } = mk(); r.onBoss(null, 1e9); assert.equal(ev.length, 0); });

test('api_error con cooldown de 30 min y api_recuperada al volver', () => {
  const { ev, r } = mk();
  r.onApi('api-x', false, 'HTTP 500', 1e9);
  r.onApi('api-x', false, 'HTTP 500', 1e9 + MIN);
  assert.equal(ev.length, 1); assert.equal(ev[0].rule, 'api_error'); assert.equal(ev[0].severity, 'warning'); assert.match(ev[0].msg, /HTTP 500/);
  r.onApi('api-x', true, '', 1e9 + 2 * MIN);
  assert.equal(ev[1].rule, 'api_recuperada'); assert.equal(ev[1].severity, 'info');
  r.onApi('api-x', true, '', 1e9 + 3 * MIN); assert.equal(ev.length, 2);
  r.onApi('api-x', false, 'timeout', 1e9 + 4 * MIN); assert.equal(ev.length, 3); // tras recuperarse, un fallo nuevo avisa ya
});
test('api: los cooldowns son por dispositivo', () => {
  const { ev, r } = mk();
  r.onApi('api-a', false, 'x', 1e9); r.onApi('api-b', false, 'x', 1e9);
  assert.equal(ev.length, 2);
});
test('fuente_datos: arranque simulado no avisa, los cambios si', () => {
  const { ev, r } = mk();
  assert.equal(r.onSource('sim', true), false);
  assert.equal(r.onSource('real', false), true);
  assert.equal(r.onSource('sim', false), true);
  assert.deepEqual(ev.map((e) => [e.rule, e.value, e.device]), [['fuente_datos', 1, 'esp32cam-01'], ['fuente_datos', 0, 'esp32cam-01']]);
  const b = mk(); assert.equal(b.r.onSource('real', true), true);
});
test('un emisor que lanza no rompe las reglas', () => {
  const r = createRules(() => { throw new Error('boom'); }, () => 12);
  assert.doesNotThrow(() => r.onTelemetry('ds-co2', { co2: 5000 }, 1e9));
});
test('umbrales configurables', () => {
  const ev = []; const r = createRules((rule) => ev.push(rule), () => 12, { thresholds: { co2Warn: 500 } });
  r.onTelemetry('ds-co2', { co2: 600 }, 1e9); assert.deepEqual(ev, ['co2_alto']);
});
