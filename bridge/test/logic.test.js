'use strict';
// Jefe, fuente real/simulada, limitador de eventos y saneo de telemetria
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBoss, createSourceTracker, createEventLimiter, cleanTelemetry, STATE_CODE } = require('../src/logic');

const feed = (b, motion, n, now, step = 10000) => { let s; for (let i = 0; i < n; i++) { now.t += step; s = b.update(motion, now.t); } return s; };

test('jefe: movimiento alto => distraido, bajo => ausente, moderado => enfocado', () => {
  const b = createBoss(); const now = { t: 1e9 };
  assert.equal(feed(b, 25, 6, now).name, 'distracted');
  assert.equal(feed(b, 0.1, 12, now).name, 'absent');
  const s = feed(b, 4, 6, now);
  assert.equal(s.name, 'focused');
  assert.ok(s.score >= 0 && s.score <= 100);
});
test('jefe: codigos de estado 1/2/3', () => {
  assert.deepEqual(STATE_CODE, { focused: 1, distracted: 2, absent: 3 });
  const b = createBoss(); const now = { t: 1e9 };
  assert.equal(feed(b, 30, 5, now).state, 2);
  assert.equal(feed(b, 0, 15, now).state, 3); // la media baja primero por 'enfocado'
});
test('jefe: ausente solo tras >20 s sin movimiento', () => {
  const b = createBoss(); const now = { t: 1e9 };
  feed(b, 4, 5, now);
  assert.notEqual(feed(b, 0, 1, now).name, 'absent'); // mAvg todavia > 1.2 o < 20 s
  assert.equal(feed(b, 0, 10, now).name, 'absent');
});
test('jefe: puntaje sube enfocado y baja distraido, siempre en 0..100', () => {
  const b = createBoss(); const now = { t: 1e9 };
  const up = feed(b, 4, 60, now); assert.ok(up.score > 90, String(up.score));
  const down = feed(b, 40, 60, now); assert.ok(down.score < 10, String(down.score));
  for (const m of [100, 0, 50, 1e6, -5]) { const s = b.update(m, (now.t += 10000)); assert.ok(s.score >= 0 && s.score <= 100); assert.ok(s.motion_avg >= 0 && s.motion_avg <= 100); }
});
test('jefe: minutos y focus_pct coherentes', () => {
  const b = createBoss(); const now = { t: 1e9 };
  feed(b, 4, 61, now); // 10 min enfocado
  const s = b.snapshot(now.t);
  assert.ok(Math.abs(s.focused_min - 10) < 0.5, String(s.focused_min));
  assert.equal(s.focus_pct, 100);
  feed(b, 40, 60, now); // 10 min distraido (los primeros ticks aun enfocado)
  const s2 = b.snapshot(now.t);
  assert.ok(s2.focus_pct > 40 && s2.focus_pct < 60, String(s2.focus_pct));
  assert.ok(Math.abs(s2.focused_min + s2.distracted_min + s2.absent_min - 20) < 0.5);
});
test('jefe: ignora motion invalido sin envenenar la media (NaN, texto, null)', () => {
  const b = createBoss(); const now = { t: 1e9 };
  feed(b, 4, 5, now);
  for (const bad of [NaN, undefined, null, 'abc', {}, Infinity]) assert.equal(b.update(bad, (now.t += 10000)), null);
  const s = feed(b, 4, 1, now);
  assert.ok(Number.isFinite(s.motion_avg) && Number.isFinite(s.score));
  assert.equal(b.update('5', (now.t += 10000)).name, 'focused'); // texto numerico si vale
});
test('jefe: reloj hacia atras no resta minutos', () => {
  const b = createBoss(); const now = { t: 1e9 };
  const a = feed(b, 4, 10, now);
  const s = b.update(4, now.t - 3600e3);
  assert.ok(s.focused_min >= a.focused_min);
});
test('jefe: huecos largos se acotan a 2 min', () => {
  const b = createBoss(); b.update(4, 1e9);
  const s = b.update(4, 1e9 + 3 * 3600e3);
  assert.ok(s.focused_min <= 2.01, String(s.focused_min));
});
test('jefe: state_s cuenta el tiempo en el estado actual', () => {
  const b = createBoss(); const now = { t: 1e9 };
  feed(b, 30, 10, now);
  const s = b.snapshot(now.t);
  assert.equal(s.name, 'distracted'); assert.ok(s.state_s > 0 && s.state_s <= 100);
});
test('jefe: reset vuelve al estado inicial', () => {
  const b = createBoss(); const now = { t: 1e9 }; feed(b, 40, 30, now);
  b.reset();
  const s = b.snapshot();
  assert.equal(s.score, 50); assert.equal(s.focused_min + s.distracted_min + s.absent_min, 0); assert.equal(s.name, 'focused');
});
test('jefe: campos publicados (contrato Grafana)', () => {
  const s = createBoss().update(3, 1e9);
  for (const k of ['state', 'score', 'motion_avg', 'focused_min', 'distracted_min', 'absent_min', 'focus_pct']) assert.equal(typeof s[k], 'number', k);
});

test('fuente: arranca en sim, pasa a real y vuelve a sim tras el timeout', () => {
  const src = createSourceTracker(90000);
  let r = src.check(0); assert.deepEqual(r, { mode: 'sim', changed: true, first: true });
  assert.equal(src.check(1000).changed, false);
  src.markReal(10000);
  r = src.check(15000); assert.deepEqual(r, { mode: 'real', changed: true, first: false });
  assert.equal(src.isReal(99999), true);
  r = src.check(100000); assert.deepEqual(r, { mode: 'sim', changed: true, first: false });
});
test('fuente: primer chequeo en real', () => {
  const src = createSourceTracker(90000); src.markReal(1000);
  assert.deepEqual(src.check(2000), { mode: 'real', changed: true, first: true });
});
test('fuente: markReal ignora tiempos invalidos y no retrocede', () => {
  const src = createSourceTracker(1000); src.markReal(5000); src.markReal(10); src.markReal(NaN);
  assert.equal(src.lastReal, 5000);
});

test('limitador: corta al superar el maximo por minuto y se recupera', () => {
  const lim = createEventLimiter(3);
  assert.deepEqual([1, 2, 3, 4].map((i) => lim.allow(i)), [true, true, true, false]);
  assert.equal(lim.dropped, 1); assert.equal(lim.sent, 3);
  assert.equal(lim.allow(60001 + 3), true);
});
test('limitador: 0 = sin limite', () => {
  const lim = createEventLimiter(0); for (let i = 0; i < 1000; i++) assert.equal(lim.allow(i), true);
});

test('cleanTelemetry deja solo numeros finitos y booleanos como 0/1', () => {
  assert.deepEqual(cleanTelemetry({ a: 1, b: NaN, c: Infinity, d: null, e: 'x', f: true, g: false, h: undefined, i: { x: 1 } }), { a: 1, f: 1, g: 0 });
  assert.deepEqual(cleanTelemetry(null), {});
});
