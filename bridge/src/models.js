'use strict';
// Modelos de los dispositivos simulados (gemelos digitales). Funciones puras + estado interno, sin red.
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const rnd = (a, b) => a + Math.random() * (b - a);
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const r = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Hora local de Bogota (UTC-5, sin horario de verano)
function hourBogota(ms = Date.now()) { const d = new Date(ms - 5 * 3600e3); return d.getUTCHours() + d.getUTCMinutes() / 60; }
// Luz natural 0..1
function daylight(h) { return h < 6 || h > 18 ? 0 : Math.sin(Math.PI * (h - 6) / 12) ** 1.2; }

function pick(w) {
  const t = Object.values(w).reduce((a, b) => a + b, 0); let x = Math.random() * t;
  for (const [k, v] of Object.entries(w)) { if ((x -= v) <= 0) return k; }
  return Object.keys(w)[0];
}

// Maquina de estados de presencia: focused | distracted | absent, con duraciones realistas
function createPresence(profile) {
  let state = 'absent', until = 0;
  const dur = (s, h) => (s === 'focused' ? rnd(10, 40) : s === 'distracted' ? rnd(1, 6) : (h < 7 || h >= 23 ? rnd(60, 240) : rnd(5, 45))) * 60000;
  return {
    get state() { return state; },
    step(now) { if (now >= until) { const h = hourBogota(now); state = pick(profile(h)); until = now + dur(state, h); } return state; },
    force(s, mins, now) { state = s; until = now + mins * 60000; }
  };
}
const workHours = (h) => (h >= 9 && h < 12) || (h >= 14 && h < 18) || (h >= 19 && h < 23);
const deskProfile = (h) => (h < 7 || h >= 23.5 ? { focused: 0, distracted: 0, absent: 1 } : workHours(h) ? { focused: 0.6, distracted: 0.25, absent: 0.15 } : { focused: 0.35, distracted: 0.2, absent: 0.45 });
const salaProfile = (h) => (h < 7 || h >= 23.5 ? { focused: 0, distracted: 0, absent: 1 } : h >= 17 ? { focused: 0.3, distracted: 0.35, absent: 0.35 } : { focused: 0.1, distracted: 0.1, absent: 0.8 });

// ---------- ESP32-CAM simulada (solo se usa mientras la real no envia datos) ----------
function createEsp32Sim() {
  const pres = createPresence(deskProfile); const t0 = Date.now();
  let motion = 0;
  return {
    params: () => ({}), cmd() {},
    presence: () => pres.state,
    tick(now) {
      const s = pres.step(now); const h = hourBogota(now);
      const tgt = s === 'focused' ? rnd(2, 7) : s === 'distracted' ? rnd(15, 32) : rnd(0.1, 0.6);
      motion = 0.5 * motion + 0.5 * tgt;
      const lamp = s !== 'absent' && daylight(h) < 0.3 ? 45 : 0;
      return {
        rssi: Math.round(-55 + gauss() * 3), heap: Math.round(140000 + gauss() * 4000), uptime_s: Math.round((now - t0) / 1000),
        chip_temp: r(46 + 2 * Math.sin(now / 6e5) + gauss() * 0.4), brightness: r(clamp(35 + daylight(h) * 90 + lamp + gauss() * 3, 0, 255)),
        motion: r(motion), flash: 0, enabled: 1, cam_ok: 1, reconnects: 0, sim: 1
      };
    }
  };
}

// ---------- Camara virtual de la sala ----------
function createCamSala() {
  const pres = createPresence(salaProfile); const t0 = Date.now(); let motion = 0, gain = 4;
  return {
    params: () => ({ gain }),
    cmd(o) { if (isNum(o.gain)) gain = clamp(o.gain, 0.5, 12); },
    tick(now) {
      const s = pres.step(now); const h = hourBogota(now);
      const tgt = s === 'focused' ? rnd(1.5, 5) : s === 'distracted' ? rnd(10, 26) : rnd(0.05, 0.4);
      motion = clamp(0.5 * motion + 0.5 * tgt * (gain / 4), 0, 100);
      return {
        motion: r(motion), brightness: r(clamp(30 + daylight(h) * 100 + (s !== 'absent' ? 25 : 0) + gauss() * 3, 0, 255)),
        rssi: Math.round(-63 + gauss() * 4), heap: Math.round(120000 + gauss() * 5000), uptime_s: Math.round((now - t0) / 1000),
        chip_temp: r(44 + 2 * Math.sin(now / 7e5) + gauss() * 0.4), fps: r(clamp(5 + gauss() * 0.5, 1, 15)), sim: 1
      };
    }
  };
}

// ---------- Termostato de 3 habitaciones ----------
function createTermostato(world) {
  // Si la API del clima aun no responde (o mando basura) se usa 14 C como exterior
  const outT = () => (isNum(world.tempOut) ? world.tempOut : 14);
  const rooms = { sala: outT() + 5, cuarto: outT() + 4, cocina: outT() + 6 };
  let setpoint = 20, heating = 0, last = Date.now();
  return {
    params: () => ({ setpoint }),
    cmd(o) { if (isNum(o.setpoint)) setpoint = clamp(o.setpoint, 10, 30); },
    tick(now) {
      const dt = clamp((now - last) / 60000, 0, 5); last = now;
      for (const k of Object.keys(rooms)) {
        rooms[k] += (outT() + 4 - rooms[k]) * (dt / 360) * 1.5; // perdida hacia el exterior (tau ~ 4 h)
        if (world.present) rooms[k] += 0.004 * dt;
        if (k === 'sala' && heating) rooms[k] += 0.05 * dt;
      }
      if (rooms.sala < setpoint - 0.5) heating = 1; else if (rooms.sala > setpoint + 0.3) heating = 0;
      world.tempSala = rooms.sala;
      const hum = (T) => r(clamp(75 - (T - 14) * 2 + gauss() * 1.2, 35, 85));
      return {
        temp_sala: r(rooms.sala + gauss() * 0.05, 2), temp_cuarto: r(rooms.cuarto + gauss() * 0.05, 2), temp_cocina: r(rooms.cocina + gauss() * 0.05, 2),
        hum_sala: hum(rooms.sala), hum_cuarto: hum(rooms.cuarto), hum_cocina: hum(rooms.cocina), setpoint, heating, sim: 1
      };
    }
  };
}

// ---------- Enchufe inteligente (sigue la presencia del escritorio) ----------
function createEnchufe(world) {
  let relay = 1, kwh = 0, last = Date.now();
  return {
    params: () => ({ relay }),
    cmd(o) { if ('relay' in o) relay = o.relay ? 1 : 0; },
    tick(now) {
      const dt = clamp((now - last) / 3600e3, 0, 1); last = now;
      let p = world.present ? rnd(130, 260) : rnd(4, 9); if (!relay) p = 0;
      kwh += p * dt / 1000; const v = 120 + gauss() * 0.8;
      return { power_w: r(p), voltage_v: r(v), current_a: r(p / v, 2), energy_kwh: r(kwh, 4), relay, sim: 1 };
    }
  };
}

// ---------- Puerta, ventana y PIR ----------
function createPuerta(world) {
  let doorUntil = 0, winUntil = 0, nextDoor = Date.now() + rnd(1, 5) * 60000, nextWin = Date.now() + rnd(5, 30) * 60000, openings = 0;
  return {
    params: () => ({}),
    cmd(o) { if ('door' in o) { doorUntil = o.door ? Date.now() + 120000 : 0; if (o.door) openings++; } },
    tick(now) {
      const h = hourBogota(now);
      if (now >= nextDoor) { doorUntil = now + rnd(10, 90) * 1000; openings++; nextDoor = now + (h >= 7 && h < 23 ? rnd(20, 90) : rnd(120, 300)) * 60000; }
      if (now >= nextWin) { if ((world.tempSala || 0) > 22) winUntil = now + rnd(10, 40) * 60000; nextWin = now + rnd(20, 90) * 60000; }
      const pir = world.present ? (Math.random() < 0.85 ? 1 : 0) : (now < doorUntil ? 1 : 0);
      return { door_open: now < doorUntil ? 1 : 0, window_open: now < winUntil ? 1 : 0, pir, openings, sim: 1 };
    }
  };
}

// ---------- Luz inteligente ----------
function createLuz(world) {
  let mode = 'auto', manualOn = 0, bright = 80;
  return {
    params: () => ({ mode, on: manualOn, brightness: bright }),
    cmd(o) {
      if (o.mode === 'auto' || o.mode === 'manual') mode = o.mode;
      if ('on' in o) { manualOn = o.on ? 1 : 0; mode = 'manual'; }
      if (isNum(o.brightness)) bright = clamp(o.brightness, 5, 100);
    },
    tick(now) {
      const h = hourBogota(now); const ambient = daylight(h) * 650 + 20;
      const on = mode === 'auto' ? (world.present && ambient < 180 ? 1 : 0) : manualOn;
      return { on, brightness_pct: on ? bright : 0, lux_ambient: r(ambient + (on ? bright * 3 : 0) + gauss() * 6), power_w: on ? r(bright * 0.12) : 0, auto: mode === 'auto' ? 1 : 0, sim: 1 };
    }
  };
}

// ---------- Reproduccion de datasets reales (CSV) ----------
function createReplay(rows, header, mapFn) {
  let i = 0;
  return {
    params: () => ({ row: i, total: rows.length }),
    cmd(o) { if (o.rewind) i = 0; if (isNum(o.row) && rows.length) i = clamp(Math.floor(o.row), 0, rows.length - 1); },
    tick() {
      if (!rows.length) return null;
      const raw = rows[i]; i = (i + 1) % rows.length;
      // Celdas vacias o no numericas => campo omitido (nunca 0 inventado ni NaN)
      const obj = {};
      header.forEach((h, k) => { const c = raw[k]; const v = c === undefined || String(c).trim() === '' ? NaN : Number(c); if (Number.isFinite(v)) obj[h] = v; });
      return { ...mapFn(obj), replay: 1, row: i };
    }
  };
}

// CSV simple (sin comillas). Ignora BOM, lineas vacias y espacios alrededor de cada celda.
function parseCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { header: [], rows: [] };
  const split = (l) => l.split(',').map((c) => c.trim());
  return { header: split(lines[0]), rows: lines.slice(1).map(split) };
}

module.exports = { isNum, clamp, rnd, gauss, r, hourBogota, daylight, createPresence, createEsp32Sim, createCamSala, createTermostato, createEnchufe, createPuerta, createLuz, createReplay, parseCsv };
