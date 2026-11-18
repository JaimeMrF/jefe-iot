'use strict';
// APIs reales (HTTP REST): fetch con timeout, reintentos con backoff exponencial, parsers puros y cache del ultimo valor.
const defaultSleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Nunca dejar la key de Azure en logs ni eventos
const redact = (s) => String(s).replace(/(subscription-key=)[^&\s"']+/gi, '$1***');

class ApiError extends Error {
  constructor(message, { status, retryable = true, permanent = false } = {}) {
    super(redact(message)); this.name = 'ApiError'; this.status = status; this.retryable = retryable; this.permanent = permanent;
  }
}

// GET JSON. Reintenta errores de red, timeouts, 429 y 5xx. Un 4xx o un JSON invalido fallan de inmediato.
async function fetchJson(url, { timeoutMs = 10000, retries = 2, backoffMs = 1000, fetchImpl = globalThis.fetch, sleep = defaultSleep } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(backoffMs * 2 ** (attempt - 1));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new ApiError(`HTTP ${res.status}`, { status: res.status, retryable, permanent: res.status === 401 || res.status === 403 });
      }
      try { return await res.json(); } catch { throw new ApiError('respuesta no es JSON valido', { retryable: false }); }
    } catch (e) {
      if (e instanceof ApiError) lastErr = e;
      else if (e && e.name === 'AbortError') lastErr = new ApiError(`timeout de ${timeoutMs} ms`);
      else lastErr = new ApiError(`red: ${(e && (e.cause?.code || e.message)) || e}`);
      if (!lastErr.retryable) break;
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// Azure Maps Weather - currentConditions
function parseAzure(j) {
  const c = j && Array.isArray(j.results) ? j.results[0] : undefined;
  if (!c) throw new ApiError('Azure: respuesta sin resultados', { retryable: false });
  const temperature = num(c.temperature?.value);
  if (temperature === undefined) throw new ApiError('Azure: respuesta sin temperatura', { retryable: false });
  return {
    temperature, real_feel: num(c.realFeelTemperature?.value), humidity: num(c.relativeHumidity), wind_kmh: num(c.wind?.speed?.value),
    gust_kmh: num(c.windGust?.speed?.value), uv_index: num(c.uvIndex), visibility_km: num(c.visibility?.value), cloud_cover: num(c.cloudCover),
    pressure_mb: num(c.pressure?.value), precip: c.hasPrecipitation ? 1 : 0, is_day: c.isDayTime ? 1 : 0
  };
}

// Open-Meteo Air Quality - current
function parseOpenMeteo(j) {
  const c = j && j.current;
  if (!c || typeof c !== 'object') throw new ApiError('Open-Meteo: respuesta sin "current"', { retryable: false });
  const f = { pm10: num(c.pm10), pm2_5: num(c.pm2_5), us_aqi: num(c.us_aqi), uv_index: num(c.uv_index), co_ugm3: num(c.carbon_monoxide), no2_ugm3: num(c.nitrogen_dioxide) };
  if (Object.values(f).every((v) => v === undefined)) throw new ApiError('Open-Meteo: respuesta sin variables', { retryable: false });
  return f;
}

const azureUrl = (lat, lon, key) =>
  `https://atlas.microsoft.com/weather/currentConditions/json?api-version=1.1&query=${encodeURIComponent(`${lat},${lon}`)}&subscription-key=${encodeURIComponent(key)}`;
const openMeteoUrl = (lat, lon) =>
  `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=pm10,pm2_5,us_aqi,uv_index,carbon_monoxide,nitrogen_dioxide`;

// Modelo de dispositivo API: cada tick consulta la API. Si falla, el error lleva el ultimo valor bueno
// (si no es demasiado viejo) como e.cached = { ...campos, stale: 1, age_s } para que el bridge lo publique.
function createApiModel(fetchValue, { cacheMaxMs = 30 * 60000, onValue } = {}) {
  let cache = null, cacheAt = 0, fails = 0, lastOk = 0, lastError = null;
  return {
    params: () => ({}),
    cmd() {},
    get fails() { return fails; },
    status: (now = Date.now()) => ({
      ok: lastOk > 0 && fails === 0, fails, last_ok: lastOk ? new Date(lastOk).toISOString() : null, last_error: lastError,
      cache_age_s: cache ? Math.round((now - cacheAt) / 1000) : null
    }),
    async tick(now = Date.now()) {
      try {
        const f = await fetchValue();
        cache = f; cacheAt = now; fails = 0; lastOk = now; lastError = null;
        if (onValue) onValue(f);
        return f;
      } catch (e) {
        fails++; lastError = e.message;
        const err = e instanceof Error ? e : new Error(String(e));
        err.cached = cache && now - cacheAt <= cacheMaxMs ? { ...cache, stale: 1, age_s: Math.round((now - cacheAt) / 1000) } : null;
        throw err;
      }
    }
  };
}

module.exports = { ApiError, redact, fetchJson, parseAzure, parseOpenMeteo, azureUrl, openMeteoUrl, createApiModel };
