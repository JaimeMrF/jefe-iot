// Modo demostracion: pantalla de entrada (landing) y recorrido guiado tipo presentacion sobre el panel real.
// Todo es local: este modulo NUNCA publica en MQTT. Las acciones usan la API que le pasa app.js
// (vista 3D, pestanas, simulacion local del bucle del jefe, onEvent para avisos, datos de ejemplo del progreso).
import { STEPS, CHAPTERS, SPEAKERS, sampleProgress } from './tour-steps.js';

const rmq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const reduced = () => !!rmq?.matches;
const mobileQ = window.matchMedia?.('(max-width: 980px)');
const isMobile = () => !!mobileQ?.matches;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

export function initTour(api) {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const modo = (params.get('modo') || '').toLowerCase();
  const N = STEPS.length;

  // ---------- DOM del recorrido ----------
  const root = document.createElement('div');
  root.id = 'tour'; root.className = 'tour'; root.hidden = true; root.tabIndex = -1;
  root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'Demostración guiada');
  root.innerHTML = `
    <div class="tour-progress" aria-hidden="true"><i></i></div>
    <div class="tour-spot" aria-hidden="true"></div>
    <section class="tour-ch" aria-live="polite"></section>
    <div class="tour-tip" aria-live="polite"><span class="tour-arrow" aria-hidden="true"></span><div class="tour-tip-in"></div></div>
    <aside class="tour-notes" hidden aria-label="Guion del paso"><div class="tour-notes-h"></div><p></p></aside>
    <nav class="tour-bar" aria-label="Controles de la demostración">
      <button type="button" class="tour-b" data-act="prev" aria-label="Paso anterior" title="Anterior (← / RePág)">‹</button>
      <div class="tour-meta"><span class="tour-chap"></span><span class="tour-count mono"></span></div>
      <span class="tour-speaker" title="Quién expone este paso"><i aria-hidden="true"></i><span></span></span>
      <span class="tour-sim" hidden title="Datos de ejemplo solo en este panel: no se publican">SIMULACIÓN</span>
      <span class="tour-gap"></span>
      <button type="button" class="tour-b sm" data-act="notes" aria-pressed="false" title="Guion del expositor (N)">Guion <kbd>N</kbd></button>
      <button type="button" class="tour-b sm" data-act="fs" title="Pantalla completa (F)">Pantalla <kbd>F</kbd></button>
      <button type="button" class="tour-b sm" data-act="exit" title="Salir de la demostración (Esc)">Salir</button>
      <button type="button" class="tour-b next" data-act="next" aria-label="Paso siguiente" title="Siguiente (→ / Espacio / AvPág)">Siguiente ›</button>
    </nav>`;
  document.body.append(root);
  const q = (s) => root.querySelector(s);
  const el = {
    prog: q('.tour-progress i'), spot: q('.tour-spot'), ch: q('.tour-ch'), tip: q('.tour-tip'), tipIn: q('.tour-tip-in'), arrow: q('.tour-arrow'),
    notes: q('.tour-notes'), notesH: q('.tour-notes-h'), notesP: q('.tour-notes p'), bar: q('.tour-bar'), chap: q('.tour-chap'), count: q('.tour-count'),
    speaker: q('.tour-speaker'), speakerName: q('.tour-speaker span'), sim: q('.tour-sim'), exit: q('[data-act=exit]'), prev: q('[data-act=prev]'), next: q('[data-act=next]'),
    notesBtn: q('[data-act=notes]')
  };

  // ---------- Estado ----------
  let active = false, idx = -1, saved = null, raf = 0, escTimer = 0, notesOn = false, forceSim = false;
  let target = null, missSince = 0; // elemento real resaltado en el paso actual
  const spotCur = { x: 0, y: 0, w: 0, h: 0, init: false };

  // ---------- Director de escenarios simulados (solo local) ----------
  const director = {
    timers: [], jitter: 0, base: 4, running: false, phase: '', achN: 0, persTimer: 0,
    later(ms, fn) { this.timers.push(setTimeout(fn, ms)); },
    clear() { this.timers.forEach(clearTimeout); this.timers = []; },
    // enfocado -> distraido -> reclamo + alerta -> ausente, en bucle
    SEQ: [['focused', 7000], ['distracted', 4500], ['alarm', 8500], ['absent', 13000]],
    held: false,
    // jefe enfocado y quieto (para ver gestos y celebraciones sin el bucle de estados)
    hold() {
      this.startStates(0);
      clearTimeout(this.stTimer);
      this.held = true;
    },
    startStates(from = 0) {
      api.simStart();
      this.held = false;
      if (!this.running) {
        this.running = true;
        clearInterval(this.jitter);
        this.jitter = setInterval(() => { const b = this.base; api.simSet({ motion: b ? b + Math.random() * 2.4 - 1.2 : Math.random() * 0.3 }); }, 1000);
      }
      this.runPhase(from);
    },
    stTimer: 0,
    runPhase(i) {
      clearTimeout(this.stTimer);
      const [name, ms] = this.SEQ[i % this.SEQ.length];
      this.phase = name;
      this.base = { focused: 5, distracted: 24, alarm: 27, absent: 0 }[name];
      api.simSet({ motion: this.base, snap: true });
      if (name === 'alarm') this.alarm();
      this.stTimer = setTimeout(() => this.runPhase(i + 1), ms);
      paintTip();
    },
    alarm() {
      const p = api.getPersonality(), info = api.persInfo[p];
      api.alarm();
      api.event({ rule: 'distraido_prolongado', severity: 'warning', value: info.limit, msg: `Llevas ${info.limit} s distraído (modo ${info.name}).` });
      const card = document.querySelector('.boss-card');
      if (card) { card.classList.remove('tour-shake'); void card.offsetWidth; card.classList.add('tour-shake'); setTimeout(() => card.classList.remove('tour-shake'), 900); }
    },
    stopStates() {
      if (!this.running) return;
      clearTimeout(this.stTimer); clearInterval(this.jitter); this.running = false; this.held = false; this.phase = '';
      api.simStop();
    },
    alerts() {
      if (!this.running) { const info = api.persInfo[api.getPersonality()]; api.event({ rule: 'distraido_prolongado', severity: 'warning', value: info.limit, msg: `Llevas ${info.limit} s distraído (modo ${info.name}).` }); }
      else this.alarm();
      this.later(1600, () => api.event({ rule: 'co2_alto', severity: 'warning', device: 'ds-co2', value: 1240, msg: 'CO₂ interior en 1240 ppm (umbral 1000 ppm): abre una ventana.' }));
    },
    achievement() {
      const names = ['Modo zen', 'Semana redonda', 'Nivel 5'];
      const name = names[this.achN++ % names.length];
      api.event({ rule: 'logro', severity: 'info', value: name === 'Nivel 5' ? 5 : 4, msg: `Logro: ${name}` });
    },
    personality() {
      const order = ['estricto', 'motivador', 'sarcastico'];
      let i = order.indexOf(api.getPersonality());
      const step = () => { i = (i + 1) % order.length; api.setPersonalityLocal(order[i]); paintPers(); };
      clearInterval(this.persTimer);
      this.later(700, step);
      this.persTimer = setInterval(step, 4800);
      paintPers();
    },
    stopPersonality() {
      if (!this.persTimer) return;
      clearInterval(this.persTimer); this.persTimer = 0;
      api.restorePersonality();
    }
  };

  // ---------- Pasos ----------
  const cur = () => STEPS[idx];
  const liveBlocked = (s) => s.live && !forceSim && api.isLive();
  function enterRuns(s) {
    const run = s.run || '';
    // simulacion de estados: sigue viva entre pasos consecutivos que la usan (no se reinicia)
    if (run === 'states' && !liveBlocked(s)) { if (!director.running || director.held) director.startStates(0); }
    else if (s.sim === 'focused' && !api.isLive()) { if (!director.held) director.hold(); }
    else if (run !== 'alerts') director.stopStates();
    if (run === 'alerts') {
      if (liveBlocked(s)) director.stopStates();
      else director.later(500, () => director.alerts());
    }
    // datos de ejemplo del progreso/reporte (solo si el servidor no ha mandado los suyos)
    if (run === 'achievement' || run === 'report') api.progress.beginDemo(sampleProgress()); else api.progress.endDemo();
    if (run === 'achievement') director.later(1100, () => director.achievement());
    if (run === 'report') api.openReport(); else if (!saved.reportOpen) api.closeReport();
    if (run === 'personality') director.personality(); else director.stopPersonality();
  }

  function go(i, { focus = false } = {}) {
    i = clamp(i, 0, N - 1);
    if (!active) return;
    clearTimeout(seqTimer);
    director.clear(); // timers de un solo uso del paso anterior (el bucle de estados tiene el suyo)
    idx = i;
    const s = cur();
    if (s.view && api.hasScene) api.setView(s.view);
    if (s.tab && isMobile()) api.selectTab(s.tab);
    enterRuns(s);
    renderBar(s);
    if (s.type === 'chapter') renderChapter(s); else renderFocus(s);
    // el foco vuelve al recorrido (dialog.show() lo mueve al reporte y Espacio/Enter lo cerrarian)
    if (focus || !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  }
  const next = () => { if (idx < N - 1) go(idx + 1); };
  const prev = () => { if (idx > 0) go(idx - 1); };

  function renderBar(s) {
    el.prog.style.width = `${((idx + 1) / N) * 100}%`;
    el.chap.textContent = `Cap. ${s.ch} · ${CHAPTERS[s.ch]}`;
    el.count.textContent = `Paso ${idx + 1} de ${N}`;
    el.speaker.className = 'tour-speaker ' + (SPEAKERS[s.speaker]?.cls || '');
    el.speakerName.textContent = s.speaker;
    el.prev.disabled = idx === 0;
    el.next.disabled = idx === N - 1;
    el.notesH.textContent = `Guion · ${s.speaker} · ${s.title}`;
    el.notesP.textContent = s.notes || '';
    root.dataset.type = s.type;
    document.body.dataset.tour = s.type;
  }

  // ---------- Capitulos a pantalla completa ----------
  function renderChapter(s) {
    target = null;
    el.tip.classList.remove('on');
    el.spot.classList.remove('on');
    const inner = document.createElement('div');
    inner.className = 'tour-ch-in' + (s.bare ? ' bare' : '');
    inner.innerHTML = (s.bare ? '' : `<header class="tour-ch-h"><p class="tour-kicker">Capítulo ${s.ch} · ${esc(CHAPTERS[s.ch])}</p><h2>${esc(s.title)}</h2></header>`) + `<div class="tour-ch-body">${s.html}</div>`;
    el.ch.replaceChildren(inner);
    el.ch.classList.add('on');
    if (reduced()) inner.querySelectorAll('svg').forEach((svg) => svg.pauseAnimations?.());
    countUp(inner);
    inner.querySelectorAll('[data-seq]').forEach((box) => pipeline(box, inner.querySelector('[data-seq-status]')));
  }
  // Pipeline animado: las etapas pasan una a una; en vueltas alternas falla una etapa y el despliegue se bloquea
  let seqTimer = 0;
  function pipeline(box, status) {
    clearTimeout(seqTimer);
    const items = [...box.children], ms = +box.dataset.seq || 1000, failAt = +box.dataset.fail;
    const say = (t, cls = '') => { if (status) { status.textContent = t; status.className = 't-pipe-st mono ' + cls; } };
    if (reduced()) { items.forEach((li) => li.classList.add('ok')); say('✓ Todo verde: desplegado en el VPS.', 'ok'); return; }
    let round = 0, i = 0;
    const tick = () => {
      if (!box.isConnected) return;
      const fail = round % 2 === 1;
      if (i === 0) { items.forEach((li) => li.classList.remove('ok', 'run', 'fail', 'skip')); say(fail ? 'Nuevo push: probando de nuevo…' : 'Nuevo push en main…'); }
      if (i > 0) {
        const prevLi = items[i - 1];
        prevLi.classList.remove('run');
        if (fail && i - 1 === failAt) {
          prevLi.classList.add('fail');
          items.slice(i).forEach((li) => li.classList.add('skip'));
          say(`✗ Falló «${prevLi.querySelector('b').textContent}»: no se despliega.`, 'bad');
          round++; i = 0; seqTimer = setTimeout(tick, ms * 3); return;
        }
        prevLi.classList.add('ok');
      }
      if (i === items.length) { say('✓ Todo verde: desplegado en el VPS.', 'ok'); round++; i = 0; seqTimer = setTimeout(tick, ms * 3); return; }
      items[i].classList.add('run');
      if (i > 0) say(`Ejecutando «${items[i].querySelector('b').textContent}»…`);
      i++;
      seqTimer = setTimeout(tick, ms);
    };
    seqTimer = setTimeout(tick, 900);
  }
  function countUp(box) {
    box.querySelectorAll('[data-count]').forEach((b) => {
      const to = +b.dataset.count;
      if (reduced() || !to) { b.textContent = String(to); return; }
      const li = b.closest('.tz'), delay = 250 + (parseFloat(li?.style.getPropertyValue('--i')) || 0) * 90, dur = 1300;
      const t0 = performance.now() + delay;
      b.textContent = '0';
      const tick = (t) => {
        if (!b.isConnected) return;
        const k = clamp((t - t0) / dur, 0, 1), e = 1 - (1 - k) ** 3;
        b.textContent = String(Math.round(to * e));
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // ---------- Pasos de foco: spotlight + globo ----------
  function findTarget(s) {
    if (!s.selector) return null;
    let t = document.querySelector(s.selector);
    if (t && s.card) t = t.closest('.card') || t;
    if (t && s.closest) t = t.closest(s.closest) || t;
    return t;
  }
  function renderFocus(s) {
    el.ch.classList.remove('on');
    target = findTarget(s);
    if (target) {
      const col = target.closest('.panel-col');
      const big = col && target.offsetHeight > col.clientHeight * 0.8;
      try { target.scrollIntoView({ block: big ? 'start' : 'center', inline: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); } catch { /* nada */ }
    }
    root.dataset.dim = s.dim || 'full';
    missSince = 0;
    paintTip();
    el.tip.classList.remove('on'); void el.tip.offsetWidth; el.tip.classList.add('on');
    spotCur.init = false;
  }
  function paintTip() {
    const s = cur();
    if (!s || s.type !== 'focus') return;
    const blocked = liveBlocked(s);
    let extra = '';
    if (s.run === 'states') {
      extra += `<div class="t-live" aria-live="off"><span class="t-st" data-live-st>—</span><span>puntaje <b class="mono" data-live-score>0</b>/100</span></div>`;
      if (director.running) {
        extra += `<div class="t-actions">${[['focused', 'Enfocado'], ['distracted', 'Distraído'], ['absent', 'Ausente']].map(([p, l]) => `<button type="button" class="t-btn sm${director.phase === p || (p === 'distracted' && director.phase === 'alarm') ? ' on' : ''}" data-act="phase" data-phase="${p}">${l}</button>`).join('')}</div>`;
      }
    }
    if (blocked) {
      extra += `<div class="t-livebox"><b><i aria-hidden="true"></i>La placa está transmitiendo</b><p>${s.run === 'alerts' ? 'En vivo, las alertas llegan solas tras una distracción sostenida.' : 'Háganlo en vivo: muévanse frente a la cámara para distraer al jefe o salgan del cuadro para dejarlo ausente.'}</p><button type="button" class="t-btn" data-act="force-sim">Simular en su lugar</button></div>`;
    }
    el.tipIn.innerHTML = `<p class="tour-kicker">Cap. ${s.ch} · ${esc(CHAPTERS[s.ch])}</p><h3>${esc(s.title)}</h3><div class="tour-tip-body">${s.body || ''}</div>${extra}` +
      (s.selector ? '<p class="t-small t-miss" hidden>Este elemento no está visible ahora mismo en el panel.</p>' : '');
    if (blocked && s.run === 'alerts') el.tipIn.querySelector('[data-act=alerts]')?.parentElement.remove();
    if (s.run === 'personality') paintPers();
  }
  function paintPers() {
    const p = api.getPersonality();
    el.tipIn.querySelectorAll('.t-pers li').forEach((li) => li.classList.toggle('on', li.dataset.p === p));
  }

  // rectangulo visible de un elemento (recortado por su columna con scroll y la ventana); null si no se ve
  function visRect(t) {
    if (!t || !t.isConnected || t.closest('[hidden]') || !t.getClientRects().length) return null;
    const cs = getComputedStyle(t);
    if (cs.visibility === 'hidden' || +cs.opacity === 0) return null;
    const r = t.getBoundingClientRect();
    let top = r.top, bottom = r.bottom, left = r.left, right = r.right;
    const col = t.closest('.panel-col');
    if (col) { const c = col.getBoundingClientRect(); top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); }
    top = Math.max(top, 0); left = Math.max(left, 0); right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight);
    if (bottom - top < 8 || right - left < 8) return null;
    return { top, left, right, bottom, width: right - left, height: bottom - top };
  }

  function layout() {
    const s = cur();
    if (!s) return;
    const sim = api.simActive() || api.progress.demoSample() || s.run === 'personality' || (s.run === 'alerts' && !liveBlocked(s));
    if (el.sim.hidden === sim) el.sim.hidden = !sim;
    if (s.type !== 'focus') return;
    const W = innerWidth, H = innerHeight, M = 16;
    const barTop = el.bar.getBoundingClientRect().top;
    const notesTop = notesOn ? el.notes.getBoundingClientRect().top : barTop;
    const floor = Math.min(barTop, notesTop) - 12;
    const r = visRect(target);
    // spotlight (seguimiento suave; instantaneo con movimiento reducido)
    const pad = 8;
    const want = r ? { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 } : { x: W / 2, y: H / 2, w: 0, h: 0 };
    const k = reduced() || !spotCur.init ? 1 : 0.22;
    for (const key of ['x', 'y', 'w', 'h']) spotCur[key] += (want[key] - spotCur[key]) * k;
    spotCur.init = true;
    const sp = el.spot.style;
    sp.transform = `translate(${spotCur.x.toFixed(1)}px, ${spotCur.y.toFixed(1)}px)`;
    sp.width = `${Math.max(0, spotCur.w).toFixed(1)}px`; sp.height = `${Math.max(0, spotCur.h).toFixed(1)}px`;
    el.spot.classList.toggle('on', (s.dim || 'full') !== 'none');
    el.spot.classList.toggle('ring', !!r);
    // sin objetivo visible durante un rato (no mientras se desplaza): el globo queda centrado y lo avisa
    const now = performance.now();
    if (r) missSince = 0; else if (s.selector && !missSince) missSince = now;
    const miss = el.tipIn.querySelector('.t-miss');
    if (miss) { const show = !!missSince && now - missSince > 900; if (miss.hidden === show) miss.hidden = !show; }
    // lectura en vivo del estado del jefe
    const ls = el.tipIn.querySelector('[data-live-st]');
    if (ls) {
      const bs = $('boss-state');
      if (ls.textContent !== bs.textContent) { ls.textContent = bs.textContent; ls.dataset.st = bs.dataset.st; }
      const sc = el.tipIn.querySelector('[data-live-score]'); if (sc.textContent !== $('score-num').textContent) sc.textContent = $('score-num').textContent;
    }
    placeTip(s, r, W, H, M, floor);
  }

  function placeTip(s, r, W, H, M, floor) {
    const tip = el.tip, st = tip.style;
    const sheet = W <= 700;
    const maxW = sheet ? W - 2 * 10 : Math.min(560, Math.max(320, W * 0.34));
    st.width = `${maxW}px`;
    st.maxHeight = `${Math.max(160, floor - M)}px`;
    const tw = tip.offsetWidth, th = tip.offsetHeight, gap = 18;
    let x, y, side = 'none';
    if (sheet) {
      x = 10;
      const lower = r && (r.top + r.bottom) / 2 > H * 0.5;
      y = lower ? M : floor - th;
    } else if (!r) {
      const pl = s.place;
      if (pl === 'scene') { x = (W - tw) / 2; y = floor - th - 8; }
      else if (pl === 'scene-side') { x = M + 8; y = (floor + 60 - th) / 2; }
      else if (pl === 'top') { x = (W - tw) / 2; y = 76; }
      else { x = (W - tw) / 2; y = (floor - th) / 2; }
    } else {
      const space = { right: W - r.right - M, left: r.left - M, bottom: floor - r.bottom, top: r.top - M };
      const fits = { right: space.right >= tw + gap, left: space.left >= tw + gap, bottom: space.bottom >= th + gap, top: space.top >= th + gap };
      const order = [s.place, 'right', 'left', 'bottom', 'top'].filter((v, i, a) => v && a.indexOf(v) === i && v in space);
      side = order.find((o) => fits[o]) || 'over';
      if (side === 'right') { x = r.right + gap; y = (r.top + r.bottom) / 2 - th / 2; }
      else if (side === 'left') { x = r.left - gap - tw; y = (r.top + r.bottom) / 2 - th / 2; }
      else if (side === 'bottom') { x = (r.left + r.right) / 2 - tw / 2; y = r.bottom + gap; }
      else if (side === 'top') { x = (r.left + r.right) / 2 - tw / 2; y = r.top - gap - th; }
      else { x = (W - tw) / 2; y = floor - th; } // no cabe a ningun lado: abajo, encima
    }
    x = clamp(x, M, Math.max(M, W - tw - M));
    y = clamp(y, M, Math.max(M, floor - th));
    st.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    // flecha hacia el centro del objetivo
    const a = el.arrow.style;
    tip.dataset.side = side;
    if (r && ['right', 'left', 'top', 'bottom'].includes(side)) {
      if (side === 'right' || side === 'left') a.top = `${clamp((r.top + r.bottom) / 2 - y, 22, th - 22)}px`, a.left = '';
      else a.left = `${clamp((r.left + r.right) / 2 - x, 22, tw - 22)}px`, a.top = '';
    }
  }

  function loop() { raf = active ? requestAnimationFrame(loop) : 0; if (active) layout(); }

  // ---------- Entrar / salir ----------
  function start(at = 0) {
    if (active) return;
    active = true;
    saved = { view: api.getView(), tab: api.getTab(), reportOpen: !!$('report')?.open, scroll: ['left', 'right'].map((id) => $(id)?.scrollTop || 0) };
    forceSim = false; notesOn = false; el.notes.hidden = true; el.notesBtn.setAttribute('aria-pressed', 'false');
    root.hidden = false;
    document.body.classList.add('tour-on');
    document.addEventListener('keydown', onKey, true);
    api.log('Demostración iniciada (simulaciones solo locales)');
    go(at, { focus: true });
    raf = requestAnimationFrame(loop);
  }
  function stop() {
    if (!active) return;
    director.clear();
    director.stopStates();
    director.stopPersonality();
    api.progress.endDemo();
    if (saved.reportOpen) api.openReport(); else api.closeReport();
    if (api.hasScene) api.setView(saved.view);
    api.selectTab(saved.tab);
    ['left', 'right'].forEach((id, i) => { const c = $(id); if (c) c.scrollTop = saved.scroll[i]; });
    active = false; idx = -1; target = null;
    cancelAnimationFrame(raf); raf = 0;
    clearTimeout(escTimer); disarmExit();
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('tour-on');
    delete document.body.dataset.tour;
    clearTimeout(seqTimer);
    el.ch.classList.remove('on'); el.tip.classList.remove('on'); el.spot.classList.remove('on');
    el.ch.replaceChildren();
    root.hidden = true;
    api.log('Demostración terminada: el panel vuelve a los datos reales');
    api.focusPanel();
  }
  function armExit() {
    if (el.exit.classList.contains('armed')) { stop(); return; }
    el.exit.classList.add('armed'); el.exit.textContent = '¿Salir? Esc otra vez';
    clearTimeout(escTimer); escTimer = setTimeout(disarmExit, 3000);
  }
  function disarmExit() { el.exit.classList.remove('armed'); el.exit.textContent = 'Salir'; }

  function toggleNotes() {
    notesOn = !notesOn; el.notes.hidden = !notesOn;
    el.notesBtn.setAttribute('aria-pressed', String(notesOn));
  }
  function fullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.()?.catch?.(() => {});
    } catch { /* sin pantalla completa */ }
  }

  function onKey(e) {
    if (!active || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target instanceof Element ? e.target : null;
    const typing = !!t?.closest('input, textarea, select, [contenteditable]');
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); armExit(); return; }
    if (typing) return;
    const onCtl = !!t?.closest('button, a[href], summary, [role=radio], [role=tab]');
    let used = true;
    switch (e.key) {
      case 'ArrowRight': case 'PageDown': next(); break;
      case ' ': case 'Enter': if (onCtl) used = false; else next(); break;
      case 'ArrowLeft': case 'PageUp': case 'Backspace': prev(); break;
      case 'Home': go(0); break;
      case 'End': go(N - 1); break;
      case 'f': case 'F': fullscreen(); break;
      case 'n': case 'N': toggleNotes(); break;
      default: used = false;
    }
    if (used) { e.preventDefault(); e.stopPropagation(); }
  }

  // botones de la barra, del globo y de los capitulos
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'next') next();
    else if (act === 'prev') prev();
    else if (act === 'exit' || act === 'finish') stop();
    else if (act === 'notes') toggleNotes();
    else if (act === 'fs') fullscreen();
    else if (act === 'alerts') director.alerts();
    else if (act === 'achievement') director.achievement();
    else if (act === 'phase') { const i = ['focused', 'distracted', 'alarm', 'absent'].indexOf(b.dataset.phase); if (director.running && i >= 0) director.runPhase(i); }
    else if (act === 'force-sim') { forceSim = true; const s = cur(); enterRuns(s); paintTip(); }
  });

  // ---------- Pantalla de entrada ----------
  const landing = $('landing');
  const panel = $('hud');
  $('btn-tour').addEventListener('click', () => start());
  function closeLanding(next) {
    if (!landing || landing.dataset.closing) return;
    landing.dataset.closing = '1';
    landing.classList.add('out');
    document.body.classList.remove('landing-on');
    landing.inert = true; panel.inert = false;
    landing.removeEventListener('keydown', onLandingKey);
    setTimeout(() => landing.remove(), reduced() ? 0 : 520);
    if (next === 'demo') start(0); else api.focusPanel();
  }
  function onLandingKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeLanding('try'); return; }
    if (e.key === 'Tab') { // foco atrapado entre los dos botones
      const bs = [...landing.querySelectorAll('button')];
      const i = bs.indexOf(document.activeElement);
      e.preventDefault();
      bs[(i + (e.shiftKey ? -1 : 1) + bs.length) % bs.length].focus();
    }
  }
  if (landing) {
    if (modo === 'probar' || modo === 'demo') { landing.remove(); document.body.classList.remove('landing-on'); }
    else {
      document.body.classList.add('landing-on');
      panel.inert = true;
      landing.hidden = false;
      landing.addEventListener('keydown', onLandingKey);
      landing.querySelector('[data-land=try]').onclick = () => closeLanding('try');
      landing.querySelector('[data-land=demo]').onclick = () => closeLanding('demo');
      requestAnimationFrame(() => { if (!landing.inert) landing.querySelector('[data-land=demo]').focus({ preventScroll: true }); });
    }
  }
  if (modo === 'demo') start(0);

  return { start, stop, isActive: () => active };
}
