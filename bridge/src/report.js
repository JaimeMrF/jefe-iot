'use strict';
// Reporte diario/semanal (jefe/boss/report y GET /report). Puro: se construye desde la gamificacion y el instante.
const { addDays } = require('./tz');
const { focusPct } = require('./gamification');

const MIN = 60000;
const r1 = (x) => Math.round(x * 10) / 10;

// { ts, today: Day, week: [Day x7, del mas antiguo al mas reciente], week_totals }
function buildReport(game, now) {
  const today = game.today(now);
  const dates = [];
  for (let i = 6; i >= 0; i--) dates.push(addDays(today, -i));
  const week = dates.map((d) => game.day(d));
  const acc = { focused_ms: 0, distracted_ms: 0, absent_ms: 0, distractions: 0, best_streak_ms: 0, score_sum: 0, score_n: 0, xp: 0 };
  let active = 0, goal = 0;
  for (const d of dates) {
    const rec = game.rawDay(d);
    if (!rec) continue;
    if (rec.focused_ms + rec.distracted_ms + rec.absent_ms > 0) active++;
    if (game.goalMet(d)) goal++;
    for (const k of ['focused_ms', 'distracted_ms', 'absent_ms', 'distractions', 'score_sum', 'score_n', 'xp']) acc[k] += rec[k];
    acc.best_streak_ms = Math.max(acc.best_streak_ms, rec.best_streak_ms);
  }
  const week_totals = {
    from: dates[0], to: today,
    focused_min: r1(acc.focused_ms / MIN), distracted_min: r1(acc.distracted_ms / MIN), absent_min: r1(acc.absent_ms / MIN),
    focus_pct: focusPct(acc), distractions: acc.distractions, best_focus_streak_min: r1(acc.best_streak_ms / MIN),
    score_avg: acc.score_n ? r1(acc.score_sum / acc.score_n) : 0, xp: acc.xp, active_days: active, goal_days: goal
  };
  return { ts: now, today: week[6], week, week_totals };
}

module.exports = { buildReport };
