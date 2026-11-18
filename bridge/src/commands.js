'use strict';
// Validacion y saneo de comandos jefe/<id>/cmd. Funciones puras: lo que no cumple tipo/rango se ignora.
const MAX_PAYLOAD = 4096;

// Devuelve el objeto JSON del mensaje, o null si no es un objeto plano (null, numeros, arrays, basura, demasiado grande)
function parseJsonObject(buf, max = MAX_PAYLOAD) {
  if (buf == null) return null;
  const len = typeof buf === 'string' ? Buffer.byteLength(buf) : buf.length;
  if (!len || len > max) return null;
  let o;
  try { o = JSON.parse(buf.toString()); } catch { return null; }
  return o !== null && typeof o === 'object' && !Array.isArray(o) ? o : null;
}

// Booleano tolerante: true/false, 1/0 y sus versiones en texto ("on"/"off", "si"/"no")
function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 0 || v === 1) return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'on', 'si', 'sí', 'yes'].includes(s)) return true;
    if (['false', '0', 'off', 'no'].includes(s)) return false;
  }
  return undefined;
}

// Numero finito (o texto numerico) recortado al rango. NaN, Infinity, objetos, etc. => undefined
function toNum(v, min = -Infinity, max = Infinity, { integer = false } = {}) {
  let n = v;
  if (typeof n === 'string' && n.trim() !== '') n = Number(n);
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  if (integer) n = Math.floor(n);
  return Math.min(max, Math.max(min, n));
}

const F = {
  bool: () => (v) => toBool(v),
  num: (min, max, opt) => (v) => toNum(v, min, max, opt),
  oneOf: (...vals) => (v) => (typeof v === 'string' && vals.includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : undefined),
  trueOnly: () => (v) => (toBool(v) === true ? true : undefined)
};

// Comandos que acepta cada dispositivo manejado por el bridge (ademas de enabled e interval_s)
const DEVICE_FIELDS = {
  'cam-sala-twin': { gain: F.num(0.5, 12) },
  'termostato-twin': { setpoint: F.num(10, 30) },
  'enchufe-twin': { relay: F.bool() },
  'puerta-twin': { door: F.bool() },
  'luz-twin': { mode: F.oneOf('auto', 'manual'), on: F.bool(), brightness: F.num(5, 100) }
};
const KIND_FIELDS = {
  dataset: { rewind: F.trueOnly(), row: F.num(0, 1e9, { integer: true }) }
};

// Especificacion de comandos para un dispositivo: { campo: validador }
function cmdSpec(id, kind, { minIntervalS = 1, maxIntervalS = 3600 } = {}) {
  return {
    enabled: F.bool(),
    interval_s: F.num(minIntervalS, maxIntervalS),
    ...(KIND_FIELDS[kind] || {}),
    ...(DEVICE_FIELDS[id] || {})
  };
}

// Aplica la especificacion: devuelve los campos validos ya convertidos, los invalidos y los desconocidos
function sanitizeCmd(payload, spec) {
  const cmd = {}; const rejected = []; const unknown = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { cmd, rejected, unknown };
  for (const [k, v] of Object.entries(payload)) {
    const check = Object.prototype.hasOwnProperty.call(spec, k) ? spec[k] : null;
    if (!check) { unknown.push(k); continue; }
    const val = check(v);
    if (val === undefined) rejected.push(k); else cmd[k] = val;
  }
  return { cmd, rejected, unknown };
}

module.exports = { MAX_PAYLOAD, parseJsonObject, toBool, toNum, cmdSpec, sanitizeCmd, DEVICE_FIELDS, KIND_FIELDS };
