'use strict';
// Gamificacion: experiencia (xp), niveles, rachas de dias y de foco, logros e historial por dia.
// Logica pura: se alimenta con el estado del jefe (focused/distracted/absent), su puntaje y el instante.
// Los dias se cuentan en la zona horaria `tz`. El estado se exporta/importa como JSON plano (persistencia).
const { localParts, addDays, isDateKey } = require('./tz');

const MIN = 60000;
const STATES = ['focused', 'distracted', 'absent'];
const DEFAULTS = {
  maxDtMs: 2 * MIN,          // igual que el jefe: huecos largos no cuentan como minutos
  gapBreakMs: 5 * MIN,       // sin datos mas de 5 min => se corta la racha de foco
  blockMs: 25 * MIN, blockBonus: 5, xpPerMin: 1,
  keepDays: 60,
  goalFocusMs: 60 * MIN, goalPct: 60, // dia que cuenta para la racha
  maratonMs: 120 * MIN, zenMs: 60 * MIN,
  earlyHour: 8, earlyMinMs: 10 * MIN // madrugador: 10 min enfocado antes de las 8:00
};

const ACHIEVEMENTS = [
  { id: 'primer_foco', name: 'Primer foco', desc: '25 minutos seguidos enfocado' },
  { id: 'maraton', name: 'Maratón', desc: '2 horas enfocado en un mismo día' },
  { id: 'racha_3', name: 'Racha de 3 días', desc: '3 días seguidos cumpliendo la meta (≥60 % y ≥60 min de foco)' },
  { id: 'racha_7', name: 'Semana imparable', desc: '7 días seguidos cumpliendo la meta (≥60 % y ≥60 min de foco)' },
  { id: 'madrugador', name: 'Madrugador', desc: 'Enfocado antes de las 8:00' },
  { id: 'sin_distracciones', name: 'Modo zen', desc: '1 hora de foco sin ninguna distracción' },
  { id: 'nivel_5', name: 'Nivel 5', desc: 'Alcanza el nivel 5' },
  { id: 'nivel_10', name: 'Nivel 10', desc: 'Alcanza el nivel 10' }
];
const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

const r1 = (x) => Math.round(x * 10) / 10;
const fin = (v, def = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : def);

// Nivel n cuando la xp acumulada llega a 100*n*(n+1)/2
const xpForLevel = (n) => (100 * n * (n + 1)) / 2;
function levelFor(xp) {
  const x = Math.max(0, fin(xp));
  let n = Math.max(0, Math.floor((Math.sqrt(1 + (8 * x) / 100) - 1) / 2));
  while (xpForLevel(n + 1) <= x) n++;
  while (n > 0 && xpForLevel(n) > x) n--;
  return n;
}

const emptyRec = () => ({ focused_ms: 0, distracted_ms: 0, absent_ms: 0, distractions: 0, best_streak_ms: 0, score_sum: 0, score_n: 0, xp: 0, early_ms: 0 });

// focus_pct del dia = enfocado / (enfocado + distraido): porcentaje del tiempo frente al escritorio
const focusPct = (rec) => { const t = rec.focused_ms + rec.distracted_ms; return t > 0 ? Math.round((rec.focused_ms / t) * 1000) / 10 : 0; };

function dayView(date, rec = emptyRec()) {
  return {
    date,
    focused_min: r1(rec.focused_ms / MIN), distracted_min: r1(rec.distracted_ms / MIN), absent_min: r1(rec.absent_ms / MIN),
    focus_pct: focusPct(rec), distractions: rec.distractions, best_focus_streak_min: r1(rec.best_streak_ms / MIN),
    score_avg: rec.score_n ? r1(rec.score_sum / rec.score_n) : 0, xp: rec.xp
  };
}

const goalMet = (rec, o = DEFAULTS) => !!rec && rec.focused_ms >= o.goalFocusMs && focusPct(rec) >= o.goalPct;

// Dias seguidos cumpliendo la meta. Si hoy aun no la cumple, la racha sigue viva hasta ayer.
function streakDays(days, today, o = DEFAULTS) {
  let d = goalMet(days[today], o) ? today : addDays(today, -1);
  let n = 0;
  while (goalMet(days[d], o) && n < 10000) { n++; d = addDays(d, -1); }
  return n;
}

function freshState() {
  return {
    xp: 0, last: 0, last_state: null, today: null,
    streak_ms: 0, day_streak_ms: 0, blocks: 0, zen_ms: 0, focus_rem_ms: 0,
    best_focus_streak_ms: 0, best_streak_days: 0, achievements: [], days: {}
  };
}

// Restaura tolerando estados viejos o a medias: lo que no sea valido vuelve al valor por defecto
function sanitizeState(raw) {
  const s = freshState();
  if (!raw || typeof raw !== 'object') return s;
  for (const k of ['xp', 'last', 'streak_ms', 'day_streak_ms', 'blocks', 'zen_ms', 'focus_rem_ms', 'best_focus_streak_ms', 'best_streak_days']) s[k] = Math.max(0, fin(raw[k]));
  s.xp = Math.floor(s.xp);
  if (STATES.includes(raw.last_state)) s.last_state = raw.last_state;
  if (isDateKey(raw.today)) s.today = raw.today;
  const seen = new Set();
  if (Array.isArray(raw.achievements)) {
    for (const a of raw.achievements) {
      if (!a || !ACH_BY_ID[a.id] || seen.has(a.id)) continue;
      seen.add(a.id);
      s.achievements.push({ ...ACH_BY_ID[a.id], ts: fin(a.ts) });
    }
  }
  if (raw.days && typeof raw.days === 'object') {
    for (const [date, rec] of Object.entries(raw.days)) {
      if (!isDateKey(date) || !rec || typeof rec !== 'object') continue;
      const r = emptyRec();
      for (const k of Object.keys(r)) r[k] = Math.max(0, fin(rec[k]));
      s.days[date] = r;
    }
  }
  return s;
}

function createGamification({ tz, state, opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  let s = sanitizeState(state);

  const has = (id) => s.achievements.some((a) => a.id === id);
  const prune = (today) => {
    const min = addDays(today, -(o.keepDays - 1));
    for (const d of Object.keys(s.days)) if (d < min) delete s.days[d];
  };
  const curStreakMs = (now) => (s.last && now - s.last > o.gapBreakMs ? 0 : s.streak_ms);

  // Procesa una muestra del jefe. Devuelve null si los datos no son validos, o
  // { unlocked: [logros nuevos], levelUp, level, xp, dayChanged }
  function update(name, score, now) {
    if (!STATES.includes(name) || !Number.isFinite(now) || now <= 0) return null;
    const { date, hour } = localParts(now, tz);
    const levelBefore = levelFor(s.xp);
    let dayChanged = false;
    if (date !== s.today) {
      if (s.today !== null && date > s.today) dayChanged = true;
      if (s.today === null || date > s.today) { s.today = date; s.day_streak_ms = 0; prune(date); }
    }
    let dt = 0;
    if (s.last) {
      const gap = now - s.last;
      if (gap > o.gapBreakMs) { s.streak_ms = 0; s.day_streak_ms = 0; s.blocks = 0; }
      dt = Math.min(o.maxDtMs, Math.max(0, gap));
    }
    s.last = Math.max(s.last, now);
    const rec = (s.days[date] ||= emptyRec());
    if (name === 'distracted' && s.last_state !== 'distracted') rec.distractions++;
    rec[`${name}_ms`] += dt;

    if (name === 'focused') {
      s.streak_ms += dt; s.day_streak_ms += dt; s.zen_ms += dt; s.focus_rem_ms += dt;
      if (hour < o.earlyHour) rec.early_ms += dt;
      let gained = 0;
      while (s.focus_rem_ms >= MIN) { s.focus_rem_ms -= MIN; gained += o.xpPerMin; }
      const blocks = Math.floor(s.streak_ms / o.blockMs);
      if (blocks > s.blocks) { gained += (blocks - s.blocks) * o.blockBonus; s.blocks = blocks; }
      s.xp += gained; rec.xp += gained;
    } else {
      s.streak_ms = 0; s.day_streak_ms = 0; s.blocks = 0;
      if (name === 'distracted') s.zen_ms = 0; // ausente no rompe el "sin distracciones"
    }
    rec.best_streak_ms = Math.max(rec.best_streak_ms, s.day_streak_ms);
    s.best_focus_streak_ms = Math.max(s.best_focus_streak_ms, s.streak_ms);
    if (Number.isFinite(score)) { rec.score_sum += score; rec.score_n++; }
    s.last_state = name;

    const sd = streakDays(s.days, date, o);
    s.best_streak_days = Math.max(s.best_streak_days, sd);
    const level = levelFor(s.xp);
    const checks = {
      primer_foco: s.streak_ms >= o.blockMs,
      maraton: rec.focused_ms >= o.maratonMs,
      racha_3: sd >= 3,
      racha_7: sd >= 7,
      madrugador: rec.early_ms >= o.earlyMinMs,
      sin_distracciones: s.zen_ms >= o.zenMs,
      nivel_5: level >= 5,
      nivel_10: level >= 10
    };
    const unlocked = [];
    for (const a of ACHIEVEMENTS) {
      if (checks[a.id] && !has(a.id)) { const u = { ...a, ts: now }; s.achievements.push(u); unlocked.push(u); }
    }
    return { unlocked, levelUp: level > levelBefore, level, xp: s.xp, dayChanged };
  }

  function stats(now) {
    const level = levelFor(s.xp);
    const today = localParts(now, tz).date;
    const sd = streakDays(s.days, today, o);
    return {
      ts: now, xp: s.xp, level, xp_next: xpForLevel(level + 1),
      streak_days: sd, best_streak_days: Math.max(s.best_streak_days, sd),
      current_focus_streak_min: r1(curStreakMs(now) / MIN), best_focus_streak_min: r1(s.best_focus_streak_ms / MIN),
      achievements: s.achievements.map((a) => ({ id: a.id, name: a.name, desc: a.desc, ts: a.ts }))
    };
  }

  return {
    update,
    stats,
    day: (date) => dayView(date, s.days[date]),
    rawDay: (date) => s.days[date] || null,
    goalMet: (date) => goalMet(s.days[date], o),
    today: (now) => localParts(now, tz).date,
    get xp() { return s.xp; },
    get level() { return levelFor(s.xp); },
    exportState: () => JSON.parse(JSON.stringify(s)),
    importState: (raw) => { s = sanitizeState(raw); },
    tz
  };
}

module.exports = { createGamification, levelFor, xpForLevel, streakDays, dayView, goalMet, focusPct, emptyRec, ACHIEVEMENTS, DEFAULTS };
