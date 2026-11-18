'use strict';
// Fechas locales en una zona horaria IANA (Intl). tz undefined => la zona del proceso.
// Funciones puras: reciben el instante en ms, nunca leen el reloj.
const cache = new Map();
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

function formatter(tz) {
  const key = tz || '';
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
    });
    cache.set(key, f);
  }
  return f;
}

// { date: 'YYYY-MM-DD', hour: 0..23, minute, weekday: 0 (domingo)..6 (sabado) }
function localParts(ms, tz) {
  const p = {};
  for (const x of formatter(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: WEEKDAY[p.weekday] };
}

// Zona valida o undefined (TZ vacia o desconocida => la del proceso)
function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz.trim() || tz.startsWith(':')) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }); return tz.trim(); } catch { return undefined; }
}

const isDateKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
// Aritmetica de calendario sobre 'YYYY-MM-DD' (independiente de la zona)
function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const weekdayOf = (dateKey) => { const [y, m, d] = dateKey.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const dayName = (dateKey) => DIAS[weekdayOf(dateKey)];

module.exports = { localParts, validTimeZone, addDays, isDateKey, weekdayOf, dayName };
