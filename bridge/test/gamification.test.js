'use strict';
// Gamificacion: xp, niveles, rachas de foco y de dias (cruzando medianoche), logros sin duplicar y persistencia
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/gamification');
const { localParts, validTimeZone, addDays, dayName } = require('../src/tz');

const MIN = 60000;
const at = (iso) => Date.parse(iso);
// Alimenta `minutes` minutos de un estado con muestras cada `step` ms. Devuelve el instante final y los logros nuevos.
function feed(g, name, start, minutes, { step = 10000, score = 80 } = {}) {
  let t = start; const unlocked = []; let last = null;
  const end = start + minutes * MIN;
  for (; t <= end; t += step) { last = g.update(name, score, t); if (last) unlocked.push(...last.unlocked); }
  return { t: t - step, unlocked, last };
}
const ids = (list) => list.map((a) => a.id);

// ---------- tz ----------
test('tz: fecha/hora local con Intl y aritmetica de dias', () => {
  const ms = at('2026-01-01T03:30:00Z');
  assert.deepEqual(localParts(ms, 'UTC'), { date: '2026-01-01', hour: 3, minute: 30, weekday: 4 });
  assert.equal(localParts(ms, 'America/Bogota').date, '2025-12-31');
  assert.equal(localParts(ms, 'America/Bogota').hour, 22);
  assert.equal(validTimeZone('America/Bogota'), 'America/Bogota');
  for (const bad of ['', '  ', 'Marte/Olimpo', undefined, ':/etc/localtime', 5]) assert.equal(validTimeZone(bad), undefined);
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2024-12-31', 1), '2025-01-01');
  assert.equal(dayName('2026-11-20'), 'vie');
});

// ---------- xp y niveles ----------
test('niveles: nivel n con 100*n*(n+1)/2 de xp', () => {
  assert.equal(G.xpForLevel(1), 100); assert.equal(G.xpForLevel(2), 300); assert.equal(G.xpForLevel(5), 1500); assert.equal(G.xpForLevel(10), 5500);
  const cases = [[0, 0], [99, 0], [100, 1], [299, 1], [300, 2], [599, 2], [600, 3], [1499, 4], [1500, 5], [5499, 9], [5500, 10], [-5, 0], [NaN, 0]];
  for (const [xp, lvl] of cases) assert.equal(G.levelFor(xp), lvl, `xp ${xp}`);
  for (let xp = 0; xp < 20000; xp += 37) {
    const n = G.levelFor(xp);
    assert.ok(G.xpForLevel(n) <= xp && xp < G.xpForLevel(n + 1), `xp ${xp}`);
  }
});

test('xp: +1 por minuto enfocado (los minutos parciales se acumulan)', () => {
  const g = G.createGamification({ tz: 'UTC' });
  feed(g, 'focused', at('2026-11-18T10:00:00Z'), 10);
  assert.equal(g.xp, 10);
  const s = g.stats(at('2026-11-18T10:10:00Z'));
  assert.equal(s.level, 0); assert.equal(s.xp_next, 100); assert.equal(s.current_focus_streak_min, 10);
});

test('xp: +5 extra por cada bloque de 25 min seguidos; distraido no suma y corta el bloque', () => {
  const g = G.createGamification({ tz: 'UTC' });
  let r = feed(g, 'focused', at('2026-11-18T10:00:00Z'), 50);
  assert.equal(g.xp, 50 + 2 * 5);
  r = feed(g, 'distracted', r.t + 10000, 5);
  assert.equal(g.xp, 60, 'distraido no da xp');
  r = feed(g, 'focused', r.t + 10000, 24);
  assert.equal(g.stats(r.t).current_focus_streak_min < 25, true);
  assert.equal(g.xp, 60 + 24, 'sin bonus: el bloque se reinicio al distraerse');
  r = feed(g, 'focused', r.t + 10000, 2);
  assert.equal(g.xp, 60 + 26 + 5);
});

test('xp: huecos sin datos cuentan como maximo 2 min y cortan la racha de foco si pasan de 5 min', () => {
  const g = G.createGamification({ tz: 'UTC' });
  const t0 = at('2026-11-18T10:00:00Z');
  const r = feed(g, 'focused', t0, 20);
  g.update('focused', 80, r.t + 60 * MIN); // 1 h sin datos
  assert.equal(g.xp, 22);
  assert.equal(g.stats(r.t + 60 * MIN).current_focus_streak_min, 2);
  assert.equal(g.stats(r.t + 90 * MIN).current_focus_streak_min, 0, 'sin datos la racha actual se muestra en 0');
});

test('datos invalidos se ignoran sin tocar el estado', () => {
  const g = G.createGamification({ tz: 'UTC' });
  for (const [n, t] of [['dormido', 1e12], ['focused', NaN], ['focused', -1], [null, 1e12]]) assert.equal(g.update(n, 50, t), null);
  assert.equal(g.xp, 0);
});

// ---------- dias y rachas ----------
test('dia: minutos por estado, distracciones, focus_pct sobre tiempo presente y puntaje medio', () => {
  const g = G.createGamification({ tz: 'UTC' });
  let r = feed(g, 'focused', at('2026-11-18T09:00:00Z'), 30, { score: 90 });
  r = feed(g, 'distracted', r.t + 10000, 10, { score: 30 });
  r = feed(g, 'focused', r.t + 10000, 10, { score: 90 });
  r = feed(g, 'distracted', r.t + 10000, 5, { score: 30 });
  feed(g, 'absent', r.t + 10000, 20, { score: 50 });
  const d = g.day('2026-11-18');
  assert.equal(d.date, '2026-11-18');
  assert.ok(Math.abs(d.focused_min - 40) <= 0.5, `focused ${d.focused_min}`);
  assert.ok(Math.abs(d.distracted_min - 15) <= 0.5);
  assert.ok(Math.abs(d.absent_min - 20) <= 0.5);
  assert.equal(d.distractions, 2);
  assert.ok(Math.abs(d.focus_pct - 72.7) < 1, `pct ${d.focus_pct}`);
  assert.ok(Math.abs(d.best_focus_streak_min - 30) <= 0.5);
  assert.ok(d.score_avg > 30 && d.score_avg < 90);
  assert.equal(d.xp, g.xp);
  for (const k of ['focused_min', 'distracted_min', 'absent_min', 'focus_pct', 'distractions', 'best_focus_streak_min', 'score_avg', 'xp']) assert.equal(typeof d[k], 'number', k);
  assert.deepEqual(g.day('2020-01-01'), { date: '2020-01-01', focused_min: 0, distracted_min: 0, absent_min: 0, focus_pct: 0, distractions: 0, best_focus_streak_min: 0, score_avg: 0, xp: 0 });
});

test('racha de foco que cruza la medianoche: continua, desbloquea primer_foco y el nuevo dia cuenta desde 00:00', () => {
  const g = G.createGamification({ tz: 'UTC' });
  const r = feed(g, 'focused', at('2026-11-18T23:50:00Z'), 30);
  assert.equal(r.last.dayChanged, false, 'la ultima muestra ya es del dia nuevo');
  assert.ok(ids(r.unlocked).includes('primer_foco'));
  const s = g.stats(r.t);
  assert.equal(s.current_focus_streak_min, 30);
  assert.ok(Math.abs(g.day('2026-11-18').best_focus_streak_min - 10) <= 0.5);
  assert.ok(Math.abs(g.day('2026-11-19').best_focus_streak_min - 20) <= 0.5);
  assert.equal(s.best_focus_streak_min, 30);
});

test('dayChanged se avisa una vez al pasar la medianoche local (zona TZ)', () => {
  const g = G.createGamification({ tz: 'America/Bogota' });
  const t = at('2026-11-19T04:59:00Z'); // 23:59 en Bogota
  assert.equal(g.update('focused', 50, t).dayChanged, false);
  assert.equal(g.update('focused', 50, t + 30000).dayChanged, false);
  assert.equal(g.update('focused', 50, t + 70000).dayChanged, true); // 00:00:10 en Bogota
  assert.equal(g.update('focused', 50, t + 80000).dayChanged, false);
  assert.ok(g.rawDay('2026-11-18') && g.rawDay('2026-11-19'));
});

test('racha de dias: dias seguidos con >=60 % y >=60 min; hoy sin cumplir no la rompe; un hueco si', () => {
  const g = G.createGamification({ tz: 'UTC' });
  // primero lo distraido: asi el dia nunca cumple la meta a medias
  const day = (d, focusMin, distMin) => { let t = at(`${d}T09:00:00Z`); if (distMin) t = feed(g, 'distracted', t, distMin, { step: 60000 }).t + 60000; feed(g, 'focused', t, focusMin, { step: 60000 }); };
  day('2026-11-10', 70, 10);
  day('2026-11-11', 61, 0);
  let s = g.stats(at('2026-11-11T20:00:00Z'));
  assert.equal(s.streak_days, 2);
  s = g.stats(at('2026-11-12T08:00:00Z'));
  assert.equal(s.streak_days, 2, 'hoy aun no cumple: la racha sigue viva');
  day('2026-11-12', 70, 60); // 54 %: no cumple
  s = g.stats(at('2026-11-13T08:00:00Z'));
  assert.equal(s.streak_days, 0, 'ayer no cumplio: racha rota');
  assert.equal(s.best_streak_days, 2);
  day('2026-11-13', 30, 0); // solo 30 min
  assert.equal(g.stats(at('2026-11-13T20:00:00Z')).streak_days, 0);
});

test('logros de racha_3 y racha_7 con dias consecutivos (sin duplicar)', () => {
  const g = G.createGamification({ tz: 'UTC' });
  const all = [];
  for (let i = 0; i < 8; i++) {
    const d = addDays('2026-11-01', i);
    all.push(...feed(g, 'focused', at(`${d}T10:00:00Z`), 65, { step: 60000 }).unlocked);
  }
  const got = ids(all);
  assert.equal(got.filter((x) => x === 'racha_3').length, 1);
  assert.equal(got.filter((x) => x === 'racha_7').length, 1);
  assert.equal(g.stats(at('2026-11-08T12:00:00Z')).streak_days, 8);
  const st = g.stats(at('2026-11-08T12:00:00Z'));
  assert.equal(new Set(st.achievements.map((a) => a.id)).size, st.achievements.length, 'sin duplicados');
});

// ---------- logros ----------
test('logros: primer_foco, maraton y sin_distracciones; cada uno una sola vez con ts', () => {
  const g = G.createGamification({ tz: 'UTC' });
  const t0 = at('2026-11-18T10:00:00Z');
  let r = feed(g, 'focused', t0, 24);
  assert.equal(r.unlocked.length, 0);
  r = feed(g, 'focused', r.t + 10000, 2);
  assert.deepEqual(ids(r.unlocked), ['primer_foco']);
  assert.equal(r.unlocked[0].name, 'Primer foco'); assert.ok(r.unlocked[0].ts > t0);
  // ausente no rompe "sin distracciones" pero si la racha de foco
  r = feed(g, 'absent', r.t + 10000, 10);
  r = feed(g, 'focused', r.t + 10000, 40);
  assert.ok(ids(r.unlocked).includes('sin_distracciones'));
  r = feed(g, 'focused', r.t + 10000, 60);
  assert.ok(ids(r.unlocked).includes('maraton'));
  r = feed(g, 'focused', r.t + 10000, 60);
  assert.deepEqual(ids(r.unlocked).filter((x) => ['primer_foco', 'maraton', 'sin_distracciones'].includes(x)), [], 'no se repiten');
  const st = g.stats(r.t);
  for (const a of st.achievements) for (const k of ['id', 'name', 'desc', 'ts']) assert.ok(k in a, k);
});

test('sin_distracciones se reinicia con una distraccion', () => {
  const g = G.createGamification({ tz: 'UTC' });
  let r = feed(g, 'focused', at('2026-11-18T10:00:00Z'), 50);
  r = feed(g, 'distracted', r.t + 10000, 1);
  r = feed(g, 'focused', r.t + 10000, 50);
  assert.equal(ids(g.stats(r.t).achievements).includes('sin_distracciones'), false);
});

test('madrugador: 10 min enfocado antes de las 8:00 locales', () => {
  const g = G.createGamification({ tz: 'America/Bogota' });
  // 07:40 Bogota = 12:40 UTC
  const r = feed(g, 'focused', at('2026-11-18T12:40:00Z'), 12);
  assert.ok(ids(r.unlocked).includes('madrugador'));
  const g2 = G.createGamification({ tz: 'America/Bogota' });
  const r2 = feed(g2, 'focused', at('2026-11-18T13:00:00Z'), 30); // 08:00 Bogota
  assert.equal(ids(r2.unlocked).includes('madrugador'), false);
});

test('logros de nivel 5 y 10 y levelUp', () => {
  const g = G.createGamification({ tz: 'UTC', opts: { xpPerMin: 50 } });
  let r = g.update('focused', 80, at('2026-11-18T10:00:00Z'));
  r = g.update('focused', 80, at('2026-11-18T10:02:00Z')); // 2 min => 100 xp => nivel 1
  assert.equal(r.levelUp, true); assert.equal(r.level, 1);
  const res = feed(g, 'focused', at('2026-11-18T10:02:10Z'), 120);
  const got = ids(res.unlocked);
  assert.ok(got.includes('nivel_5') && got.includes('nivel_10'));
  assert.ok(g.level >= 10);
});

// ---------- persistencia ----------
test('exportState/importState conserva todo y es JSON puro; estados basura se sanean', () => {
  const g = G.createGamification({ tz: 'UTC' });
  const r = feed(g, 'focused', at('2026-11-18T10:00:00Z'), 30);
  const snap = JSON.parse(JSON.stringify(g.exportState()));
  const g2 = G.createGamification({ tz: 'UTC', state: snap });
  assert.deepEqual(g2.stats(r.t), g.stats(r.t));
  assert.deepEqual(g2.day('2026-11-18'), g.day('2026-11-18'));
  // tras restaurar no se repite primer_foco
  const more = feed(g2, 'focused', r.t + 10000, 30);
  assert.equal(ids(more.unlocked).includes('primer_foco'), false);
  for (const bad of [null, 'x', 42, [], { xp: 'mucho', achievements: [{ id: 'inventado' }, null, { id: 'maraton', ts: 5 }, { id: 'maraton', ts: 6 }], days: { 'no-fecha': {}, '2026-11-01': { focused_ms: -5, xp: 'x' } } }]) {
    const g3 = G.createGamification({ tz: 'UTC', state: bad });
    const s = g3.stats(at('2026-11-18T10:00:00Z'));
    assert.equal(typeof s.xp, 'number');
    assert.ok(s.achievements.every((a) => G.ACHIEVEMENTS.some((x) => x.id === a.id)));
  }
  const g4 = G.createGamification({ tz: 'UTC', state: { achievements: [{ id: 'maraton', ts: 5 }, { id: 'maraton', ts: 6 }] } });
  assert.equal(g4.stats(1e12).achievements.length, 1);
});

test('el historial guarda como maximo 60 dias', () => {
  const g = G.createGamification({ tz: 'UTC' });
  for (let i = 0; i < 70; i++) g.update('focused', 50, at(`${addDays('2026-01-01', i)}T10:00:00Z`));
  const days = Object.keys(g.exportState().days);
  assert.equal(days.length, 60);
  assert.equal(days.includes('2026-01-01'), false);
});

test('stats tiene la forma del contrato', () => {
  const g = G.createGamification({ tz: 'UTC' });
  const s = g.stats(at('2026-11-18T10:00:00Z'));
  assert.deepEqual(Object.keys(s).sort(), ['achievements', 'best_focus_streak_min', 'best_streak_days', 'current_focus_streak_min', 'level', 'streak_days', 'ts', 'xp', 'xp_next'].sort());
});
