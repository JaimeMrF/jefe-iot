// Gamificacion y reportes del contrato v2 (jefe/boss/stats, jefe/boss/report y eventos rule "logro").
// Todo funciona aunque el servidor aun no publique esos topicos: estados vacios y reporte local de respaldo.
import { fitCanvas } from './boss.js';

// Logros minimos del contrato. El servidor puede mandar mas, o cambiar nombre y descripcion.
export const ACHIEVEMENTS = [
  { id: 'primer_foco', name: 'Primer foco', desc: '25 min seguidos enfocado.', icon: '◎' },
  { id: 'maraton', name: 'Maratón', desc: '2 h enfocado en un mismo día.', icon: '⏱' },
  { id: 'racha_3', name: 'Racha de 3', desc: '3 días seguidos cumpliendo la meta.', icon: '3' },
  { id: 'racha_7', name: 'Semana redonda', desc: '7 días seguidos cumpliendo la meta.', icon: '7' },
  { id: 'madrugador', name: 'Madrugador', desc: 'Enfocado antes de las 8:00.', icon: '☀' },
  { id: 'sin_distracciones', name: 'Modo zen', desc: '1 h sin ninguna distracción.', icon: '◇' },
  { id: 'nivel_5', name: 'Nivel 5', desc: 'Llega al nivel 5.', icon: 'V' },
  { id: 'nivel_10', name: 'Nivel 10', desc: 'Llega al nivel 10.', icon: 'X' }
];
const COLORS = { f: '#19ffa0', d: '#ff3355', a: '#4a7dff', dim: '#8696bb', grid: 'rgba(134,150,187,.14)' };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// epoch en ms (acepta segundos por si acaso); null si no sirve
export function toDate(ts) {
  let n = num(+ts);
  if (n == null || n <= 0) return null;
  if (n < 1e12) n *= 1000;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d;
}
const xpFor = (n) => (100 * n * (n + 1)) / 2; // xp acumulada para llegar al nivel n
const fmtMin = (m) => { m = Math.round(m || 0); return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`; };
const fmtDateShort = (d) => d.toLocaleDateString('es', { day: 'numeric', month: 'short' });
const dayDate = (s) => { const d = new Date(`${s}T12:00:00`); return Number.isNaN(d.getTime()) ? null : d; };
const dayLabel = (s) => { const d = dayDate(s); return d ? `${d.toLocaleDateString('es', { weekday: 'short' }).replace('.', '')} ${d.getDate()}` : s || '?'; };
const dayLong = (s) => { const d = dayDate(s); return d ? d.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' }) : s || ''; };

export function createProgress({ $, mk, bossUI, log }) {
  let stats = null, statsAt = 0, xpLive = null, xpLiveAt = 0, report = null, reportAt = 0;
  let prevUnlocked = null;
  const localUnlocked = new Map(); // id -> Date (por evento, antes de que llegue el stats)
  const fresh = new Set(); // ids recien desbloqueados (resaltados unos segundos)

  // ---------- Nivel y experiencia ----------
  function renderLevel() {
    // la telemetria trae xp/level con mas frecuencia; se usa lo mas reciente
    const src = xpLive && xpLiveAt >= statsAt ? xpLive : stats;
    const xp = num(src?.xp), level = num(src?.level);
    const has = xp != null && level != null;
    $('lvl-num').textContent = has ? level : '–';
    $('lvl-title').textContent = has ? `Nivel ${level}` : 'Nivel –';
    const pb = $('xp-pb');
    if (!has) {
      $('xp-txt').textContent = '– xp'; $('xp-bar').style.width = '0%';
      pb.setAttribute('aria-valuenow', '0'); pb.setAttribute('aria-valuetext', 'Sin datos de experiencia');
      $('xp-next').textContent = 'Gana 1 xp por minuto enfocado y 5 extra por cada bloque de 25 min.';
      return;
    }
    // xp_next: xp total para el siguiente nivel (si parece ser lo que falta, se suma)
    let target = num(stats?.xp_next);
    const expected = xpFor(level + 1);
    if (target == null) target = expected;
    else if (target <= xp && target !== expected) target = xp + target;
    const base = xpFor(level) <= xp ? xpFor(level) : 0;
    const span = Math.max(1, target - base);
    const pct = Math.max(0, Math.min(100, ((xp - base) / span) * 100));
    const left = Math.max(0, Math.round(target - xp));
    $('xp-txt').textContent = `${Math.round(xp)} / ${Math.round(target)} xp`;
    $('xp-bar').style.width = `${pct}%`;
    pb.setAttribute('aria-valuenow', String(Math.round(pct)));
    pb.setAttribute('aria-valuetext', `Nivel ${level}: ${Math.round(xp)} de ${Math.round(target)} xp, faltan ${left}`);
    $('xp-next').textContent = left ? `Faltan ${left} xp para el nivel ${level + 1}.` : `¡Listo para el nivel ${level + 1}!`;
  }

  // ---------- Rachas ----------
  function renderStreaks() {
    const s = stats || {};
    const d = num(s.streak_days), bd = num(s.best_streak_days), f = num(s.current_focus_streak_min), bf = num(s.best_focus_streak_min);
    $('st-days').textContent = d == null ? '–' : `${d} ${d === 1 ? 'día' : 'días'}`;
    $('st-days-best').textContent = bd == null ? 'mejor: –' : `mejor: ${bd} ${bd === 1 ? 'día' : 'días'}`;
    $('st-focus').textContent = f == null ? '–' : fmtMin(f);
    $('st-focus-best').textContent = bf == null ? 'mejor: –' : `mejor: ${fmtMin(bf)}`;
    $('prog-empty').hidden = !!stats;
  }

  // ---------- Logros ----------
  function mergedAchievements() {
    const byId = new Map(ACHIEVEMENTS.map((a) => [a.id, { ...a, at: null }]));
    for (const a of Array.isArray(stats?.achievements) ? stats.achievements : []) {
      if (!a || typeof a !== 'object' || !a.id) continue;
      const prev = byId.get(a.id) || { id: a.id, name: a.id, desc: '', icon: '★', at: null };
      byId.set(a.id, { ...prev, name: a.name || prev.name, desc: a.desc || prev.desc, at: toDate(a.ts) });
    }
    for (const [id, at] of localUnlocked) { const a = byId.get(id); if (a && !a.at) a.at = at; }
    return [...byId.values()];
  }
  function renderAchievements() {
    const list = mergedAchievements();
    const done = list.filter((a) => a.at).length;
    $('ach-count').textContent = `${done}/${list.length}`;
    $('ach').replaceChildren(...list.map((a) => {
      const li = mk('li', { className: 'ach' + (a.at ? ' on' : '') + (fresh.has(a.id) ? ' new' : '') });
      li.append(
        mk('span', { className: 'ach-ico', textContent: a.at ? a.icon || '★' : '🔒', ariaHidden: 'true' }),
        mk('b', { textContent: a.name }),
        mk('small', { textContent: a.desc }),
        mk('small', { className: 'ach-when', textContent: a.at ? `Desbloqueado el ${fmtDateShort(a.at)}` : 'Bloqueado' })
      );
      if (a.at) li.title = `Desbloqueado: ${a.at.toLocaleString('es')}`;
      return li;
    }));
  }

  function onStats(j) {
    if (!j || typeof j !== 'object' || Array.isArray(j)) return;
    if (demo) { demo.pending.stats = j; return; } // se aplica al salir de la demostracion
    stats = j; statsAt = Date.now();
    const unlocked = new Set((Array.isArray(j.achievements) ? j.achievements : []).filter((a) => a?.id && toDate(a.ts)).map((a) => a.id));
    if (prevUnlocked) for (const id of unlocked) if (!prevUnlocked.has(id) && !localUnlocked.has(id)) flash(id);
    prevUnlocked = unlocked;
    for (const id of unlocked) localUnlocked.delete(id);
    renderLevel(); renderStreaks(); renderAchievements();
  }
  function onTelemetry(j) {
    if (!j || typeof j !== 'object' || num(j.xp) == null || num(j.level) == null) return;
    if (demo) { demo.pending.tele = j; return; }
    xpLive = { xp: j.xp, level: j.level }; xpLiveAt = Date.now();
    renderLevel();
  }
  function flash(id) {
    fresh.add(id);
    setTimeout(() => { fresh.delete(id); renderAchievements(); }, 12000);
  }
  // Evento "Logro: <nombre>": marcarlo ya (el stats retenido llega despues) y resaltar la tarjeta
  function onAchievementEvent(name, at, { simulated = false } = {}) {
    if (demo && !simulated) { demo.pending.achievements.push([name, at]); return; }
    const n = (name || '').trim().toLowerCase();
    const a = mergedAchievements().find((x) => x.name.toLowerCase() === n || x.id === n);
    if (a && !a.at) { localUnlocked.set(a.id, at || new Date()); flash(a.id); }
    else if (a) flash(a.id);
    renderAchievements();
    const card = $('prog');
    card.classList.remove('celebrate'); void card.offsetWidth; card.classList.add('celebrate');
    setTimeout(() => card.classList.remove('celebrate'), 2600);
  }

  // ---------- Reporte ----------
  const isDay = (d) => d && typeof d === 'object' && typeof d.date === 'string';
  function onReport(j) {
    if (!j || typeof j !== 'object' || (!isDay(j.today) && !Array.isArray(j.week))) return;
    if (demo) { demo.pending.report = j; return; }
    report = j; reportAt = Date.now();
    renderSummary();
    if ($('report').open) renderReport();
  }
  const simReport = () => !!(demo && demo.sample.report);
  const current = () => (report ? { src: simReport() ? 'sim' : 'server', r: report } : { src: 'local', r: bossUI.localReport() });

  // ---------- Modo demostracion: datos de ejemplo SOLO si el servidor no ha mandado los suyos ----------
  // Se guarda todo el estado real y se restaura tal cual al salir; lo que llegue mientras tanto se aplica despues.
  let demo = null;
  function beginDemo(sample = {}) {
    if (demo) return;
    demo = {
      real: { stats, statsAt, xpLive, xpLiveAt, report, reportAt, prevUnlocked, localUnlocked: new Map(localUnlocked) },
      sample: { stats: !stats && !!sample.stats, report: !report && !!sample.report }, pending: { achievements: [] }
    };
    if (demo.sample.stats) { stats = sample.stats; statsAt = Date.now(); xpLive = null; prevUnlocked = null; }
    if (demo.sample.report) { report = sample.report; reportAt = Date.now(); }
    renderAll();
  }
  function endDemo() {
    if (!demo) return;
    const { real, pending } = demo;
    demo = null;
    ({ stats, statsAt, xpLive, xpLiveAt, report, reportAt, prevUnlocked } = real);
    localUnlocked.clear(); for (const [k, v] of real.localUnlocked) localUnlocked.set(k, v);
    fresh.clear();
    renderAll();
    for (const [name, at] of pending.achievements) onAchievementEvent(name, at);
    if (pending.stats) onStats(pending.stats);
    if (pending.tele) onTelemetry(pending.tele);
    if (pending.report) onReport(pending.report);
  }
  const demoSample = () => !!(demo && (demo.sample.stats || demo.sample.report));
  function renderAll() { renderLevel(); renderStreaks(); renderAchievements(); renderSummary(); if ($('report').open) renderReport(); }

  function renderSummary() {
    const t = report?.today;
    $('rep-sum').textContent = simReport() && isDay(t) ? `Simulación · hoy: ${fmtMin(t.focused_min)} enfocado · ${Math.round(t.focus_pct)} % de enfoque.` : isDay(t)
      ? `Hoy: ${fmtMin(t.focused_min)} enfocado · ${num(t.focus_pct) != null ? Math.round(t.focus_pct) + ' %' : '–'} de enfoque.`
      : 'El reporte del servidor aún no llega; se muestra el de este navegador.';
  }

  function weekOf(r) {
    const w = (Array.isArray(r.week) ? r.week : []).filter(isDay).slice(-7);
    if (!w.length && isDay(r.today)) w.push(r.today);
    return w;
  }
  function totalsOf(r, week) {
    const wt = r.week_totals && typeof r.week_totals === 'object' ? r.week_totals : {};
    const sum = (k) => week.reduce((s, d) => s + (num(d[k]) || 0), 0);
    const f = num(wt.focused_min) ?? sum('focused_min'), d = num(wt.distracted_min) ?? sum('distracted_min'), a = num(wt.absent_min) ?? sum('absent_min');
    const tot = f + d + a;
    return {
      f, d, a, pct: num(wt.focus_pct) ?? (tot ? Math.round((f / tot) * 100) : 0),
      dists: num(wt.distractions) ?? sum('distractions'), xp: num(wt.xp) ?? (week.some((x) => num(x.xp) != null) ? sum('xp') : null)
    };
  }

  function renderReport() {
    const { src, r } = current();
    const today = isDay(r.today) ? r.today : null;
    const week = weekOf(r);
    const when = toDate(r.ts);
    $('rep-src').textContent = src === 'sim' ? 'SIMULACIÓN' : src === 'server' ? 'Servidor' : 'Este navegador';
    $('rep-src').className = 'badge ' + (src === 'server' ? 'ok' : 'warn');
    $('rep-meta').textContent = src === 'sim'
      ? 'Datos de ejemplo de la demostración: el servidor aún no ha publicado un reporte. No se guardan en ningún lado.'
      : src === 'server'
      ? `Actualizado ${when ? when.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : 'hace poco'}. El servidor lo recalcula cada minuto.`
      : 'El servidor todavía no publica reportes: estos datos salen de lo que este navegador registró (sin puntaje medio ni xp).';
    // Hoy
    const v = (k, fmt) => (today && num(today[k]) != null ? fmt(today[k]) : '–');
    $('rep-day-title').textContent = today ? `Hoy · ${dayLong(today.date)}` : 'Hoy';
    $('rep-f').textContent = v('focused_min', fmtMin);
    $('rep-d').textContent = v('distracted_min', fmtMin);
    $('rep-a').textContent = v('absent_min', fmtMin);
    $('rep-pct').textContent = v('focus_pct', (x) => `${Math.round(x)} %`);
    $('rep-dists').textContent = v('distractions', (x) => String(Math.round(x)));
    $('rep-best').textContent = v('best_focus_streak_min', fmtMin);
    $('rep-score').textContent = v('score_avg', (x) => `${Math.round(x)}/100`);
    $('rep-xp').textContent = v('xp', (x) => `+${Math.round(x)}`);
    // Semana: totales, grafico y tabla
    const t = totalsOf(r, week);
    $('rep-week-tot').textContent = week.length
      ? `Total: ${fmtMin(t.f)} enfocado · ${t.pct} % de enfoque · ${t.dists} distracciones${t.xp != null ? ` · +${Math.round(t.xp)} xp` : ''}.`
      : 'Sin datos de la semana todavía.';
    const tb = $('rep-tbody');
    tb.replaceChildren(...week.map((d) => mk('tr', {},
      mk('th', { scope: 'row', textContent: dayLabel(d.date) }),
      ...[d.focused_min, d.distracted_min, d.absent_min].map((x) => mk('td', { textContent: num(x) != null ? Math.round(x) : '–' })),
      mk('td', { textContent: num(d.focus_pct) != null ? `${Math.round(d.focus_pct)} %` : '–' }),
      mk('td', { textContent: num(d.distractions) != null ? Math.round(d.distractions) : '–' }),
      mk('td', { textContent: num(d.score_avg) != null ? Math.round(d.score_avg) : '–' })
    )));
    $('rep-week').setAttribute('aria-label', week.length
      ? 'Minutos por día de la última semana. ' + week.map((d) => `${dayLabel(d.date)}: ${Math.round(d.focused_min || 0)} enfocado, ${Math.round(d.distracted_min || 0)} distraído, ${Math.round(d.absent_min || 0)} ausente`).join('; ') + '.'
      : 'Sin datos de la semana.');
    drawWeek(week, today?.date);
  }

  function drawWeek(week, todayDate) {
    const c = fitCanvas($('rep-week')); if (!c) return;
    const { ctx, w: W, h: H } = c;
    const L = 34, R = 8, T = 16, B = 20, pw = W - L - R, ph = H - T - B;
    const tot = (d) => (num(d.focused_min) || 0) + (num(d.distracted_min) || 0) + (num(d.absent_min) || 0);
    const max = Math.max(0, ...week.map(tot));
    ctx.font = '10px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    if (!week.length || max <= 0) {
      ctx.fillStyle = COLORS.dim; ctx.textAlign = 'center';
      ctx.fillText('Sin datos esta semana', W / 2, H / 2);
      ctx.textAlign = 'left';
      return;
    }
    // escala con pasos "redondos" (30 min, 1 h, 2 h...)
    const step = [15, 30, 60, 120, 180, 240, 360, 480].find((s) => max / s <= 4) || 720;
    const top = Math.ceil(max / step) * step, sc = ph / top;
    ctx.textAlign = 'right';
    for (let v = 0; v <= top; v += step) {
      const y = Math.round(T + ph - v * sc) + 0.5;
      ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
      ctx.fillStyle = COLORS.dim; ctx.fillText(v === 0 ? '0' : v < 60 ? `${v}m` : `${+(v / 60).toFixed(1)}h`, L - 5, y);
    }
    const slot = pw / 7, bw = Math.min(34, slot * 0.62);
    ctx.textAlign = 'center';
    week.forEach((d, i) => {
      const x = L + slot * (i + 7 - week.length) + (slot - bw) / 2; // si faltan dias, alinear a la derecha (hoy al final)
      let y = T + ph;
      for (const [k, col] of [['focused_min', COLORS.f], ['distracted_min', COLORS.d], ['absent_min', COLORS.a]]) {
        const h = (num(d[k]) || 0) * sc; if (h <= 0) continue;
        ctx.fillStyle = col; ctx.fillRect(x, y - h, bw, Math.max(1, h - 1)); y -= h;
      }
      const isToday = d.date === todayDate;
      ctx.fillStyle = isToday ? '#dbe6ff' : COLORS.dim;
      ctx.font = `${isToday ? '700 ' : ''}10px system-ui, sans-serif`;
      ctx.fillText(dayLabel(d.date), x + bw / 2, H - B / 2 + 1);
      if (num(d.focus_pct) != null && tot(d) > 0) { ctx.fillStyle = COLORS.dim; ctx.font = '9px system-ui, sans-serif'; ctx.fillText(`${Math.round(d.focus_pct)}%`, x + bw / 2, y - 7); }
    });
    ctx.textAlign = 'left';
  }

  // ---------- Descargas ----------
  const COLS = ['date', 'focused_min', 'distracted_min', 'absent_min', 'focus_pct', 'distractions', 'best_focus_streak_min', 'score_avg', 'xp'];
  function download(name, type, text) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = mk('a', { href: url, download: name }); a.hidden = true;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function exportReport(kind) {
    const { src, r } = current();
    const date = (isDay(r.today) && r.today.date) || new Date().toISOString().slice(0, 10);
    const name = `jefe-reporte${src === 'sim' ? '-simulacion' : ''}-${date}.${kind}`;
    if (kind === 'json') download(name, 'application/json', JSON.stringify({ source: src === 'sim' ? 'simulacion' : src === 'server' ? 'servidor' : 'navegador', ...r }, null, 2));
    else {
      const rows = weekOf(r);
      if (isDay(r.today) && !rows.some((d) => d.date === r.today.date)) rows.push(r.today);
      const cell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      download(name, 'text/csv;charset=utf-8', '﻿' + [COLS.join(','), ...rows.map((d) => COLS.map((k) => cell(d[k])).join(','))].join('\r\n') + '\r\n');
    }
    log(`Reporte descargado (${kind.toUpperCase()})`);
  }

  // ---------- Dialogo ----------
  const dlg = $('report');
  $('btn-report').onclick = () => { renderReport(); dlg.showModal(); requestAnimationFrame(renderReport); };
  $('rep-close').onclick = $('rep-done').onclick = () => dlg.close();
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // clic en el fondo
  $('rep-json').onclick = () => exportReport('json');
  $('rep-csv').onclick = () => exportReport('csv');
  new ResizeObserver(() => { if (!dlg.open) return; const { r } = current(); drawWeek(weekOf(r), r.today?.date); }).observe($('rep-week'));

  renderLevel(); renderStreaks(); renderAchievements(); renderSummary();
  return { onStats, onTelemetry, onReport, onAchievementEvent, renderReport, beginDemo, endDemo, demoSample };
}
