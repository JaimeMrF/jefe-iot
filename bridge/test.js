'use strict';
// Pruebas de humo: modelos, datasets, jefe y reglas. Ejecutar: node test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('./src/models');
const { createBoss, createRules } = require('./src/logic');

let ok = 0;
const t = (name, fn) => { try { fn(); ok++; console.log('ok  ', name); } catch (e) { console.error('FALLO', name, '->', e.message); process.exitCode = 1; } };
const numeric = (o) => Object.values(o).every((v) => typeof v === 'number' && Number.isFinite(v));

t('hora de Bogota en rango', () => { const h = M.hourBogota(); assert(h >= 0 && h < 24); });
t('luz natural 0..1', () => { for (let h = 0; h < 24; h += 0.5) { const d = M.daylight(h); assert(d >= 0 && d <= 1); } });

const world = { present: true, tempOut: 14, tempSala: 19 };
const sims = { esp32: M.createEsp32Sim(), cam: M.createCamSala(), term: M.createTermostato(world), plug: M.createEnchufe(world), door: M.createPuerta(world), luz: M.createLuz(world) };
for (const [k, m] of Object.entries(sims)) {
  t(`modelo ${k}: 500 ticks numericos y en rango`, () => {
    let now = Date.now();
    for (let i = 0; i < 500; i++) {
      now += 10000; const f = m.tick(now);
      assert(numeric(f), JSON.stringify(f));
      if ('motion' in f) assert(f.motion >= 0 && f.motion <= 100);
      if ('brightness' in f) assert(f.brightness >= 0 && f.brightness <= 255);
      if ('temp_sala' in f) assert(f.temp_sala > 0 && f.temp_sala < 45);
      if ('power_w' in f) assert(f.power_w >= 0 && f.power_w < 400);
    }
  });
}
t('enchufe apagado consume 0 W', () => { const p = M.createEnchufe({ present: true }); p.cmd({ relay: 0 }); assert.strictEqual(p.tick(Date.now()).power_w, 0); });
t('termostato respeta setpoint', () => { const m = M.createTermostato({ tempOut: 10, present: false }); m.cmd({ setpoint: 25 }); assert.strictEqual(m.params().setpoint, 25); m.cmd({ setpoint: 99 }); assert.strictEqual(m.params().setpoint, 30); });
t('luz manual obedece comando', () => { const l = M.createLuz({ present: false }); l.cmd({ on: true, brightness: 50 }); const f = l.tick(Date.now()); assert.strictEqual(f.on, 1); assert.strictEqual(f.brightness_pct, 50); });

for (const f of ['energia.csv', 'co2.csv', 'ocupacion.csv']) {
  t(`dataset ${f}`, () => {
    const p = [path.join(__dirname, '..', 'datasets', f), path.join('/datasets', f)].find(fs.existsSync);
    assert(p, 'archivo no encontrado');
    const { header, rows } = M.parseCsv(fs.readFileSync(p, 'utf8'));
    assert(rows.length > 1000);
    const rep = M.createReplay(rows, header, (o) => o);
    for (let i = 0; i < rows.length + 5; i++) assert(numeric(rep.tick()));
  });
}

t('jefe: movimiento alto => distraido, bajo => ausente', () => {
  const b = createBoss(); let now = 1e9; let s;
  for (let i = 0; i < 6; i++) { now += 10000; s = b.update(25, now); }
  assert.strictEqual(s.name, 'distracted');
  for (let i = 0; i < 12; i++) { now += 10000; s = b.update(0.1, now); }
  assert.strictEqual(s.name, 'absent');
  for (let i = 0; i < 6; i++) { now += 10000; s = b.update(4, now); }
  assert.strictEqual(s.name, 'focused');
  assert(s.score >= 0 && s.score <= 100);
});

t('reglas: co2 alto genera alerta con cooldown', () => {
  const ev = []; const r = createRules((...a) => ev.push(a), () => 12);
  r.onTelemetry('ds-co2', { co2: 1200 }, 1e9); r.onTelemetry('ds-co2', { co2: 1300 }, 1e9 + 1000);
  assert.strictEqual(ev.length, 1); assert.strictEqual(ev[0][0], 'co2_alto');
  r.onTelemetry('ds-co2', { co2: 1600 }, 1e9 + 20 * 60000);
  assert.strictEqual(ev.length, 2); assert.strictEqual(ev[1][1], 'critical');
});
t('reglas: distraido prolongado y puerta sin presencia', () => {
  const ev = []; const r = createRules((...a) => ev.push(a[0]), () => 12);
  r.onBoss({ name: 'distracted' }, 1e9); r.onBoss({ name: 'distracted' }, 1e9 + 61000);
  assert(ev.includes('distraido_prolongado'));
  r.onTelemetry('puerta-twin', { door_open: 1, pir: 0 }, 2e9);
  assert(ev.includes('movimiento_sospechoso'));
});

console.log(`\n${ok} pruebas correctas`);
