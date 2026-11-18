'use strict';
// Reporte diario/semanal: 7 dias del mas antiguo al mas reciente, totales y forma del contrato
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGamification } = require('../src/gamification');
const { buildReport } = require('../src/report');
const { addDays } = require('../src/tz');

const MIN = 60000;
const at = (iso) => Date.parse(iso);
const DAY_KEYS = ['absent_min', 'best_focus_streak_min', 'date', 'distracted_min', 'distractions', 'focus_pct', 'focused_min', 'score_avg', 'xp'];
function feed(g, name, start, minutes, score = 70) { let t = start; for (; t <= start + minutes * MIN; t += 60000) g.update(name, score, t); return t; }

test('reporte con 7 dias: orden, huecos en cero, today = ultimo dia y totales', () => {
  const g = createGamification({ tz: 'UTC' });
  // dias -6, -4, -1 y hoy con datos; el resto vacios
  const today = '2026-11-18';
  const plan = { [-6]: [30, 10], [-4]: [90, 0], [-1]: [65, 5], [0]: [20, 20] };
  for (const [off, [f, d]] of Object.entries(plan).sort((a, b) => a[0] - b[0])) { // en orden cronologico
    const date = addDays(today, Number(off));
    let t = at(`${date}T10:00:00Z`);
    t = feed(g, 'distracted', t, d);
    feed(g, 'focused', t, f);
  }
  const now = at(`${today}T20:00:00Z`);
  const r = buildReport(g, now);
  assert.equal(r.ts, now);
  assert.equal(r.week.length, 7);
  assert.deepEqual(r.week.map((d) => d.date), ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18']);
  assert.deepEqual(r.today, r.week[6]);
  for (const d of r.week) assert.deepEqual(Object.keys(d).sort(), DAY_KEYS);
  assert.equal(r.week[1].focused_min, 0); assert.equal(r.week[1].score_avg, 0);
  assert.ok(r.week[2].focused_min >= 90);
  const sum = r.week.reduce((a, d) => a + d.focused_min, 0);
  assert.ok(Math.abs(r.week_totals.focused_min - sum) < 1);
  assert.equal(r.week_totals.distractions, r.week.reduce((a, d) => a + d.distractions, 0));
  assert.equal(r.week_totals.xp, r.week.reduce((a, d) => a + d.xp, 0));
  assert.equal(r.week_totals.active_days, 4);
  assert.equal(r.week_totals.goal_days, 2, 'dia -4 (90 min, 100 %) y -1 (65 min, ~93 %)');
  assert.equal(r.week_totals.from, '2026-11-12'); assert.equal(r.week_totals.to, today);
  assert.ok(r.week_totals.best_focus_streak_min >= 90);
  assert.ok(r.week_totals.focus_pct > 0 && r.week_totals.focus_pct <= 100);
  assert.ok(r.week_totals.score_avg > 0);
  JSON.parse(JSON.stringify(r)); // serializable
});

test('reporte vacio: 7 dias en cero sin NaN', () => {
  const r = buildReport(createGamification({ tz: 'UTC' }), at('2026-11-18T10:00:00Z'));
  assert.equal(r.week.length, 7);
  const nums = [...r.week.flatMap((d) => Object.values(d).filter((v) => typeof v === 'number')), ...Object.values(r.week_totals).filter((v) => typeof v === 'number')];
  assert.ok(nums.every(Number.isFinite));
  assert.equal(r.week_totals.focus_pct, 0);
});

test('reporte usa la zona horaria: a las 23:00 de Bogota ya es otro dia en UTC', () => {
  const now = at('2026-11-19T04:00:00Z'); // 23:00 del 18 en Bogota
  assert.equal(buildReport(createGamification({ tz: 'America/Bogota' }), now).today.date, '2026-11-18');
  assert.equal(buildReport(createGamification({ tz: 'UTC' }), now).today.date, '2026-11-19');
});
