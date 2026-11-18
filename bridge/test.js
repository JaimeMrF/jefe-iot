'use strict';
// Pruebas de humo: modelos (gemelos digitales) y datasets. El resto de pruebas vive en test/*.test.js
// Ejecutar todas: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const M = require('./src/models');

const numeric = (o) => Object.values(o).every((v) => typeof v === 'number' && Number.isFinite(v));
const datasetPath = (f) => [path.join(__dirname, '..', 'datasets', f), path.join('/datasets', f)].find(fs.existsSync);

test('hora de Bogota en rango', () => { const h = M.hourBogota(); assert.ok(h >= 0 && h < 24); });
test('hora de Bogota es UTC-5', () => {
  assert.equal(M.hourBogota(Date.UTC(2026, 0, 1, 17, 0)), 12);
  assert.equal(M.hourBogota(Date.UTC(2026, 0, 1, 2, 30)), 21.5);
});
test('luz natural 0..1, de noche 0 y maxima a mediodia', () => {
  for (let h = 0; h < 24; h += 0.5) { const d = M.daylight(h); assert.ok(d >= 0 && d <= 1); }
  assert.equal(M.daylight(3), 0); assert.equal(M.daylight(21), 0);
  assert.ok(Math.abs(M.daylight(12) - 1) < 1e-9);
});

const world = { present: true, tempOut: 14, tempSala: 19 };
const sims = { esp32: M.createEsp32Sim(), cam: M.createCamSala(), term: M.createTermostato(world), plug: M.createEnchufe(world), door: M.createPuerta(world), luz: M.createLuz(world) };
for (const [k, m] of Object.entries(sims)) {
  test(`modelo ${k}: 500 ticks numericos y en rango`, () => {
    let now = Date.now();
    for (let i = 0; i < 500; i++) {
      now += 10000; const f = m.tick(now);
      assert.ok(numeric(f), JSON.stringify(f));
      if ('motion' in f) assert.ok(f.motion >= 0 && f.motion <= 100);
      if ('brightness' in f) assert.ok(f.brightness >= 0 && f.brightness <= 255);
      if ('temp_sala' in f) assert.ok(f.temp_sala > 0 && f.temp_sala < 45);
      if ('power_w' in f) assert.ok(f.power_w >= 0 && f.power_w < 400);
      if ('hum_sala' in f) assert.ok(f.hum_sala >= 35 && f.hum_sala <= 85);
      for (const b of ['door_open', 'window_open', 'pir', 'relay', 'heating', 'on', 'sim']) if (b in f) assert.ok(f[b] === 0 || f[b] === 1, `${b}=${f[b]}`);
    }
  });
}

test('enchufe apagado consume 0 W', () => { const p = M.createEnchufe({ present: true }); p.cmd({ relay: 0 }); assert.equal(p.tick(Date.now()).power_w, 0); });
test('enchufe acumula energia con el tiempo', () => {
  const p = M.createEnchufe({ present: true }); let now = Date.now(), f;
  for (let i = 0; i < 60; i++) { now += 60000; f = p.tick(now); }
  assert.ok(f.energy_kwh > 0.1 && f.energy_kwh < 0.3, String(f.energy_kwh));
});
test('termostato respeta setpoint y lo recorta a 10..30', () => {
  const m = M.createTermostato({ tempOut: 10, present: false });
  m.cmd({ setpoint: 25 }); assert.equal(m.params().setpoint, 25);
  m.cmd({ setpoint: 99 }); assert.equal(m.params().setpoint, 30);
  m.cmd({ setpoint: -5 }); assert.equal(m.params().setpoint, 10);
});
test('termostato ignora setpoint NaN / texto', () => {
  const m = M.createTermostato({ tempOut: 10, present: false });
  m.cmd({ setpoint: NaN }); m.cmd({ setpoint: '22' }); m.cmd({ setpoint: Infinity });
  assert.equal(m.params().setpoint, 20);
});
test('termostato calienta la sala hacia el setpoint', () => {
  const w = { tempOut: 10, present: false }; const m = M.createTermostato(w); m.cmd({ setpoint: 24 });
  let now = Date.now(), f;
  for (let i = 0; i < 400; i++) { now += 60000; f = m.tick(now); }
  assert.ok(Math.abs(f.temp_sala - 24) < 1.5, String(f.temp_sala));
  assert.ok(Number.isFinite(w.tempSala));
});
test('termostato sobrevive a temperatura exterior invalida', () => {
  const w = { tempOut: NaN, present: false }; const m = M.createTermostato(w);
  const f = m.tick(Date.now() + 60000);
  assert.ok(numeric(f), JSON.stringify(f));
});
test('luz manual obedece comando', () => { const l = M.createLuz({ present: false }); l.cmd({ on: true, brightness: 50 }); const f = l.tick(Date.now()); assert.equal(f.on, 1); assert.equal(f.brightness_pct, 50); assert.equal(f.auto, 0); });
test('luz vuelve a auto y en auto sigue la presencia de noche', () => {
  const w = { present: true }; const l = M.createLuz(w); l.cmd({ on: false }); l.cmd({ mode: 'auto' });
  const night = Date.UTC(2026, 0, 1, 3, 0); // 22:00 Bogota
  assert.equal(l.tick(night).on, 1);
  w.present = false; assert.equal(l.tick(night).on, 0);
});
test('luz ignora brillo invalido y recorta a 5..100', () => {
  const l = M.createLuz({}); l.cmd({ brightness: NaN }); assert.equal(l.params().brightness, 80);
  l.cmd({ brightness: 500 }); assert.equal(l.params().brightness, 100);
});
test('camara de la sala: ganancia recortada e ignorada si es invalida', () => {
  const c = M.createCamSala(); c.cmd({ gain: 100 }); assert.equal(c.params().gain, 12);
  c.cmd({ gain: NaN }); assert.equal(c.params().gain, 12);
});
test('puerta: comando abrir y cerrar', () => {
  const p = M.createPuerta({ present: false }); const now = Date.now();
  p.cmd({ door: true }); const f = p.tick(now + 1000); assert.equal(f.door_open, 1); assert.equal(f.openings >= 1, true);
  p.cmd({ door: false }); assert.equal(p.tick(now + 2000).door_open, 0);
});
test('presencia: maquina de estados forzable', () => {
  const pres = M.createPresence(() => ({ focused: 1, distracted: 0, absent: 0 })); const now = Date.now();
  assert.equal(pres.step(now), 'focused');
  pres.force('absent', 10, now); assert.equal(pres.step(now + 1000), 'absent');
});

test('parseCsv tolera BOM, CRLF, espacios y lineas vacias', () => {
  const { header, rows } = M.parseCsv('﻿a, b\r\n1,2\r\n\r\n 3 ,4\r\n');
  assert.deepEqual(header, ['a', 'b']); assert.deepEqual(rows, [['1', '2'], ['3', '4']]);
  assert.deepEqual(M.parseCsv(''), { header: [], rows: [] });
});
test('replay omite celdas vacias o no numericas', () => {
  const rep = M.createReplay([['1', ''], ['x', '2']], ['a', 'b'], (o) => o);
  assert.deepEqual(rep.tick(), { a: 1, replay: 1, row: 1 });
  assert.deepEqual(rep.tick(), { b: 2, replay: 1, row: 0 });
});
test('replay: rewind, row recortado y row invalido ignorado', () => {
  const rows = [['1'], ['2'], ['3']]; const rep = M.createReplay(rows, ['v'], (o) => o);
  rep.cmd({ row: 99 }); assert.equal(rep.params().row, 2);
  rep.cmd({ row: NaN }); assert.equal(rep.params().row, 2);
  assert.equal(rep.tick().v, 3);
  rep.cmd({ rewind: true }); assert.equal(rep.tick().v, 1);
});
test('replay sin filas no revienta', () => {
  const rep = M.createReplay([], ['v'], (o) => o); assert.equal(rep.tick(), null); rep.cmd({ row: 3 }); assert.equal(rep.params().row, 0);
});

for (const f of ['energia.csv', 'co2.csv', 'ocupacion.csv']) {
  test(`dataset ${f}: >1000 filas, todas numericas y da la vuelta`, () => {
    const p = datasetPath(f);
    assert.ok(p, 'archivo no encontrado');
    const { header, rows } = M.parseCsv(fs.readFileSync(p, 'utf8'));
    assert.ok(rows.length > 1000);
    assert.ok(rows.every((r) => r.length === header.length), 'filas con columnas de mas o de menos');
    const rep = M.createReplay(rows, header, (o) => o);
    for (let i = 0; i < rows.length + 5; i++) { const t = rep.tick(); assert.ok(numeric(t)); assert.equal(Object.keys(t).length, header.length + 2); }
  });
}
