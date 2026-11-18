'use strict';
// Notificaciones por Telegram (opcional): Bot API sendMessage con fetch nativo (inyectable) y timeout.
// Sin token o sin chat queda desactivado sin errores. El token nunca sale en logs ni en errores.
// Mensajes en texto plano (sin parse_mode) para no depender de escapes.
const { localParts, dayName } = require('./tz');
const { phrase } = require('./personality');
const { silentLogger } = require('./log');

const API = 'https://api.telegram.org';
const MIN = 60000;
const SEVERITY = { info: 1, warning: 2, critical: 3 };
const MAX_TEXT = 4000; // Telegram admite 4096

// Quita el token (y cualquier "bot<id>:<secreto>") de un texto
function redact(text, token) {
  let s = String(text ?? '');
  if (token) s = s.split(token).join('<token>');
  return s.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>');
}

const normSeverity = (v, def = 'warning') => {
  const k = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return SEVERITY[k] ? k : def;
};

// ---------- Formato de mensajes ----------
const ICON = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };
const SEV_ES = { info: 'Info', warning: 'Aviso', critical: 'Crítico' };

function fmtMin(m) {
  const t = Math.round(Number(m) || 0);
  if (t < 60) return `${t} min`;
  const h = Math.floor(t / 60), r = t % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
const fmtTime = (ts, tz) => { const p = localParts(ts, tz); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };

function formatEvent(ev, { tz, personality, random } = {}) {
  if (ev.rule === 'logro') {
    const extra = phrase(personality, 'logro', ev.value, random);
    return `🏆 ${ev.msg}\nNivel actual: ${ev.value}${extra ? `\n${extra}` : ''}`;
  }
  const sev = normSeverity(ev.severity, 'info');
  const lines = [`${ICON[sev]} ${SEV_ES[sev]}: ${ev.rule}`, ev.msg ? String(ev.msg) : null, `Dispositivo: ${ev.device}`];
  if (Number.isFinite(ev.ts)) lines.push(`Hora: ${fmtTime(ev.ts, tz)}`);
  return lines.filter(Boolean).join('\n');
}

function formatDailyReport(report, stats, { personality, random } = {}) {
  const d = report.today;
  const intro = phrase(personality, 'report', 0, random);
  return [
    `📊 Reporte diario del jefe (${d.date})`,
    intro,
    '',
    `Enfocado: ${fmtMin(d.focused_min)} (${d.focus_pct} %)`,
    `Distraído: ${fmtMin(d.distracted_min)} · Ausente: ${fmtMin(d.absent_min)}`,
    `Distracciones: ${d.distractions}`,
    `Mejor racha de foco: ${fmtMin(d.best_focus_streak_min)}`,
    `Puntaje medio: ${d.score_avg}`,
    `XP de hoy: ${d.xp}`,
    stats ? `Nivel ${stats.level} (${stats.xp} XP, siguiente en ${stats.xp_next}) · Racha: ${stats.streak_days} día${stats.streak_days === 1 ? '' : 's'}` : null
  ].filter((l) => l !== null).join('\n');
}

function formatWeeklyReport(report, stats, { personality, random } = {}) {
  const w = report.week_totals;
  const intro = phrase(personality, 'report', 0, random);
  const days = report.week.map((d) => `${dayName(d.date)} ${d.date.slice(5)}: ${fmtMin(d.focused_min)} (${d.focus_pct} %)`);
  return [
    `🗓️ Reporte semanal del jefe (${w.from} a ${w.to})`,
    intro,
    '',
    ...days,
    '',
    `Total enfocado: ${fmtMin(w.focused_min)} (${w.focus_pct} %)`,
    `Distraído: ${fmtMin(w.distracted_min)} · Ausente: ${fmtMin(w.absent_min)}`,
    `Distracciones: ${w.distractions} · Mejor racha: ${fmtMin(w.best_focus_streak_min)}`,
    `Días con meta cumplida: ${w.goal_days}/7 · XP de la semana: ${w.xp}`,
    stats ? `Nivel ${stats.level} (${stats.xp} XP) · Racha: ${stats.streak_days} día${stats.streak_days === 1 ? '' : 's'}` : null
  ].filter((l) => l !== null).join('\n');
}

// ---------- Programacion de reportes ----------
// Diario a partir de `hour` (una vez por fecha local) y semanal el dia `weekday` (0 domingo .. 6 sabado).
// sched = { last_daily: 'YYYY-MM-DD' | null, last_weekly: ... } (persistido para no repetir tras reiniciar)
function dueReports(now, { tz, hour = 18, weekday = 5, sched = {} } = {}) {
  const p = localParts(now, tz);
  const afterHour = p.hour >= hour;
  return {
    date: p.date,
    daily: afterHour && sched.last_daily !== p.date,
    weekly: afterHour && p.weekday === weekday && sched.last_weekly !== p.date
  };
}

// ---------- Cliente ----------
function createTelegram({
  token, chatId, minSeverity = 'warning', fetchImpl = globalThis.fetch, timeoutMs = 10000, now = Date.now,
  log = silentLogger(), cooldownMs = 10 * MIN, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout
} = {}) {
  const tok = typeof token === 'string' ? token.trim() : '';
  const chat = chatId === undefined || chatId === null ? '' : String(chatId).trim();
  const enabled = !!(tok && chat && typeof fetchImpl === 'function');
  const min = normSeverity(minSeverity);
  const last = new Map();
  const st = { sent: 0, failed: 0, suppressed: 0, last_error: null };

  async function send(text) {
    if (!enabled) return false;
    const ctrl = new AbortController();
    const timer = setTimeoutFn(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${API}/bot${tok}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, MAX_TEXT), disable_web_page_preview: true })
      });
      let body = null;
      try { body = await res.json(); } catch { /* respuesta sin JSON */ }
      if (!res.ok || (body && body.ok === false)) {
        throw new Error(`Telegram respondio HTTP ${res.status}${body && body.description ? `: ${body.description}` : ''}`);
      }
      st.sent++; st.last_error = null;
      return true;
    } catch (e) {
      st.failed++;
      const msg = ctrl.signal.aborted ? `timeout tras ${timeoutMs} ms` : redact(e && e.message ? e.message : e, tok);
      st.last_error = msg;
      log.warn('Telegram: no se pudo enviar el mensaje', { err: msg });
      return false;
    } finally { clearTimeoutFn(timer); }
  }

  // Alertas con severidad >= minima, 1 por regla+dispositivo cada 10 min; los logros siempre
  function shouldNotify(ev, t = now()) {
    if (!enabled || !ev || typeof ev !== 'object') return false;
    if (ev.rule === 'logro') return true;
    if ((SEVERITY[ev.severity] || 0) < SEVERITY[min]) return false;
    const key = `${ev.rule}|${ev.device}`;
    const prev = last.get(key);
    if (prev !== undefined && t >= prev && t - prev < cooldownMs) { st.suppressed++; return false; }
    last.set(key, t);
    return true;
  }

  function notifyEvent(ev, fmtOpts = {}) {
    if (!shouldNotify(ev)) return Promise.resolve(false);
    return send(formatEvent(ev, fmtOpts));
  }

  return { enabled, minSeverity: min, send, shouldNotify, notifyEvent, status: () => ({ enabled, min_severity: min, ...st }) };
}

module.exports = { createTelegram, redact, dueReports, formatEvent, formatDailyReport, formatWeeklyReport, fmtMin, SEVERITY };
