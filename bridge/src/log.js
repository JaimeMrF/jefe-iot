'use strict';
// Logs estructurados con niveles. LOG_LEVEL = debug | info | warn | error | silent ; LOG_FORMAT = text | json
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const fmtVal = (v) => (typeof v === 'string' ? (/[\s="]/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v));
const normalize = (fields) => {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined) continue;
    out[k] = v instanceof Error ? v.message : v;
  }
  return out;
};

function createLogger({ level = 'info', format = 'text', out = console.log, err = console.error, base = {} } = {}) {
  const min = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  const json = String(format).toLowerCase() === 'json';
  const write = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    const ts = new Date().toISOString();
    const data = normalize({ ...base, ...fields });
    const sink = LEVELS[lvl] >= LEVELS.warn ? err : out;
    if (json) sink(JSON.stringify({ ts, level: lvl, msg, ...data }));
    else {
      const kv = Object.entries(data).map(([k, v]) => `${k}=${fmtVal(v)}`).join(' ');
      sink(`${ts} ${lvl.toUpperCase().padEnd(5)} ${msg}${kv ? ' ' + kv : ''}`);
    }
  };
  return {
    level: Object.keys(LEVELS).find((k) => LEVELS[k] === min),
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (extra) => createLogger({ level, format, out, err, base: { ...base, ...extra } })
  };
}

// Logger mudo para pruebas
const silentLogger = () => createLogger({ level: 'silent' });

module.exports = { createLogger, silentLogger, LEVELS };
