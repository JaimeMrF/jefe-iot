'use strict';
// Logica pura del bridge: jefe (estado y puntaje), motor de reglas/alertas, fuente de datos real/simulada,
// limitador de eventos y saneo de telemetria. Sin red ni timers: todo recibe `now` para poder probarlo.
const STATE_CODE = { focused: 1, distracted: 2, absent: 3 };
const SEVERITY = { info: 1, warning: 2, critical: 3 };
const MIN = 60000;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const r1 = (x) => Math.round(x * 10) / 10;

// ---------- Jefe ----------
// Media movil del movimiento => focused (quieto pero presente), distracted (mucho movimiento), absent (sin movimiento > 20 s)
const BOSS_DEFAULTS = { alpha: 0.3, absentBelow: 1.2, distractedAbove: 12, absentAfterMs: 20000, maxDtMin: 2, initialScore: 50 };

function createBoss(opts = {}) {
  const o = { ...BOSS_DEFAULTS, ...opts };
  let mAvg, lowSince, state, stateSince, score, last, mins;
  const reset = () => {
    mAvg = 0; lowSince = 0; state = 'focused'; stateSince = 0; score = o.initialScore; last = 0;
    mins = { focused: 0, distracted: 0, absent: 0 };
  };
  reset();
  const snapshot = (now = last) => {
    const total = mins.focused + mins.distracted + mins.absent || 1;
    return {
      state: STATE_CODE[state], name: state, score: r1(score), motion_avg: r1(mAvg),
      focused_min: r1(mins.focused), distracted_min: r1(mins.distracted), absent_min: r1(mins.absent),
      focus_pct: Math.round((mins.focused / total) * 1000) / 10,
      state_s: stateSince ? Math.max(0, Math.round((now - stateSince) / 1000)) : 0
    };
  };
  return {
    // Devuelve null (sin tocar el estado) si motion/now no son numeros validos
    update(motion, now) {
      const m = typeof motion === 'string' && motion.trim() !== '' ? Number(motion) : motion;
      if (num(m) === undefined || num(now) === undefined) return null;
      const mv = clamp(m, 0, 100);
      // dt nunca negativo (reloj hacia atras o mensajes desordenados) y acotado (huecos largos no cuentan como minutos)
      const dtMin = last ? clamp((now - last) / MIN, 0, o.maxDtMin) : 0;
      last = Math.max(last, now);
      mAvg = (1 - o.alpha) * mAvg + o.alpha * mv;
      let next = state;
      if (mAvg < o.absentBelow) { lowSince ||= now; if (now - lowSince > o.absentAfterMs) next = 'absent'; }
      else { lowSince = 0; next = mAvg > o.distractedAbove ? 'distracted' : 'focused'; }
      if (next !== state || !stateSince) { state = next; stateSince = now; }
      mins[state] += dtMin;
      const target = { focused: 100, distracted: 0, absent: 50 }[state];
      score += (target - score) * (1 - Math.pow(0.97, dtMin * 60)); // ~3% por segundo
      score = clamp(score, 0, 100);
      return snapshot(now);
    },
    snapshot,
    reset
  };
}

// ---------- Reglas / alertas ----------
// Umbrales (documentados en docs/ARQUITECTURA.md)
const THRESHOLDS = {
  co2Warn: 1000, co2Crit: 1500, tempSala: 28, powerW: 300, aqi: 100,
  doorOpenMs: 10 * MIN, distractedMs: 60000, absentMs: 30 * MIN, workStart: 9, workEnd: 18
};
const COOLDOWNS = {
  co2: 10 * MIN, tempalta: 15 * MIN, consumo: 15 * MIN, aqi: 60 * MIN, puerta: 30 * MIN, intruso: 10 * MIN,
  distraido: 5 * MIN, ausente: 60 * MIN, api: 30 * MIN
};

// emit(rule, severity, device, value, msg)
// Antirrebote: cada regla tiene cooldown; solo una severidad MAYOR puede saltarse el cooldown (escalada warning -> critical).
// Las condiciones sostenidas ("abierta > 10 min") se reinician si se pierde el rastro mas de maxGapMs (dispositivo apagado, etc.).
function createRules(emit, hourFn, opts = {}) {
  const T = { ...THRESHOLDS, ...(opts.thresholds || {}) };
  const C = { ...COOLDOWNS, ...(opts.cooldowns || {}) };
  const maxGapMs = opts.maxGapMs ?? 20 * MIN;
  const last = {};    // clave -> { at, sev }
  const timers = {};  // clave -> { since, seen }
  const apiFailing = {};

  const cool = (key, ms, now, sev = 'info') => {
    const prev = last[key];
    if (prev && now >= prev.at && now - prev.at < ms && SEVERITY[sev] <= SEVERITY[prev.sev]) return false;
    last[key] = { at: now, sev }; return true;
  };
  // Duracion (ms) que lleva activa una condicion; -1 si no esta activa
  const track = (key, active, now) => {
    if (!active) { delete timers[key]; return -1; }
    const t = timers[key];
    if (!t || now < t.seen || now - t.seen > maxGapMs) { timers[key] = { since: now, seen: now }; return 0; }
    t.seen = now; return now - t.since;
  };
  const fire = (rule, sev, device, value, msg) => { try { emit(rule, sev, device, value, msg); } catch { /* el emisor no debe tumbar las reglas */ } };

  return {
    onTelemetry(device, f, now) {
      if (!f || typeof f !== 'object' || f.stale) return; // datos de cache: ya se evaluaron cuando eran frescos
      if (device === 'ds-co2') {
        const co2 = num(f.co2);
        if (co2 !== undefined && co2 > T.co2Warn) {
          const sev = co2 > T.co2Crit ? 'critical' : 'warning';
          if (cool('co2', C.co2, now, sev)) fire('co2_alto', sev, device, co2, `CO2 en ${Math.round(co2)} ppm: ventila el espacio`);
        }
      }
      if (device === 'termostato-twin') {
        const t = num(f.temp_sala);
        if (t !== undefined && t > T.tempSala && cool('tempalta', C.tempalta, now, 'warning')) fire('temperatura_alta', 'warning', device, t, `Sala a ${t} C`);
      }
      if (device === 'enchufe-twin') {
        const p = num(f.power_w);
        if (p !== undefined && p > T.powerW && cool('consumo', C.consumo, now)) fire('consumo_alto', 'info', device, p, `El enchufe consume ${p} W`);
      }
      if (device === 'api-openmeteo-aq') {
        const aqi = num(f.us_aqi);
        if (aqi !== undefined && aqi > T.aqi && cool('aqi', C.aqi, now, 'warning')) fire('aire_exterior_malo', 'warning', device, aqi, `AQI exterior ${aqi}`);
      }
      if (device === 'puerta-twin' && 'door_open' in f) {
        const open = !!f.door_open;
        const dur = track('door', open, now);
        if (dur > T.doorOpenMs && cool('puerta', C.puerta, now, 'warning'))
          fire('puerta_abierta_larga', 'warning', device, Math.round(dur / MIN), `Puerta abierta mas de ${Math.round(T.doorOpenMs / MIN)} minutos`);
        // Solo con PIR explicito en 0: si el campo falta no sabemos si hay presencia
        if (open && num(f.pir) === 0 && cool('intruso', C.intruso, now, 'critical'))
          fire('movimiento_sospechoso', 'critical', device, 1, 'Puerta abierta sin presencia detectada');
      }
    },
    onBoss(b, now) {
      if (!b) return;
      const dist = track('dist', b.name === 'distracted', now);
      if (dist >= T.distractedMs && cool('distraido', C.distraido, now, 'warning'))
        fire('distraido_prolongado', 'warning', 'boss', Math.round(dist / 1000), 'El jefe te ve distraido hace mas de 1 minuto');
      const abs = track('abs', b.name === 'absent', now);
      if (abs > T.absentMs) {
        const h = hourFn(now);
        if (h >= T.workStart && h < T.workEnd && cool('ausente', C.ausente, now))
          fire('ausente_largo', 'info', 'boss', Math.round(abs / MIN), 'Escritorio vacio mas de 30 minutos en horario laboral');
      }
    },
    // Resultado de una consulta a una API: api_error (con cooldown) y api_recuperada al volver a funcionar
    onApi(device, ok, msg, now) {
      if (ok) {
        if (apiFailing[device]) { apiFailing[device] = false; delete last[`api:${device}`]; fire('api_recuperada', 'info', device, 0, `${device}: la API responde de nuevo`); }
        return;
      }
      apiFailing[device] = true;
      if (cool(`api:${device}`, C.api, now, 'warning')) fire('api_error', 'warning', device, 1, `${device}: ${msg}`);
    },
    // Cambio de fuente de datos de la ESP32-CAM. Al arrancar en simulado no se avisa (no es un cambio).
    onSource(mode, first) {
      if (first && mode !== 'real') return false;
      const real = mode === 'real';
      fire('fuente_datos', 'info', 'esp32cam-01', real ? 1 : 0, real ? 'ESP32-CAM real conectada: se detiene la simulacion' : 'ESP32-CAM real sin datos: simulacion activada');
      return true;
    }
  };
}

// ---------- Fuente de datos de la ESP32-CAM: real o simulada ----------
function createSourceTracker(timeoutMs = 90000) {
  let lastReal = 0, mode = null;
  const isReal = (now) => lastReal > 0 && now - lastReal < timeoutMs;
  return {
    markReal(now) { if (num(now) !== undefined) lastReal = Math.max(lastReal, now); },
    isReal,
    get lastReal() { return lastReal; },
    get mode() { return mode; },
    // { mode, changed, first }
    check(now) {
      const m = isReal(now) ? 'real' : 'sim';
      if (m === mode) return { mode: m, changed: false, first: false };
      const first = mode === null; mode = m;
      return { mode: m, changed: true, first };
    }
  };
}

// ---------- Limitador global de eventos (red de seguridad contra spam) ----------
function createEventLimiter(maxPerMin = 30) {
  const times = []; let dropped = 0, sent = 0;
  return {
    allow(now) {
      if (!(maxPerMin > 0)) { sent++; return true; }
      while (times.length && (now - times[0] >= MIN || now < times[0])) times.shift();
      if (times.length >= maxPerMin) { dropped++; return false; }
      times.push(now); sent++; return true;
    },
    get dropped() { return dropped; },
    get sent() { return sent; }
  };
}

// ---------- Telemetria: solo numeros finitos (Telegraf/Influx esperan campos numericos) ----------
function cleanTelemetry(f) {
  const out = {};
  if (!f || typeof f !== 'object') return out;
  for (const [k, v] of Object.entries(f)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
  }
  return out;
}

module.exports = {
  createBoss, createRules, createSourceTracker, createEventLimiter, cleanTelemetry,
  STATE_CODE, SEVERITY, THRESHOLDS, COOLDOWNS, BOSS_DEFAULTS
};
