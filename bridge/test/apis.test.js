'use strict';
// APIs: parsers, fetch con timeout/reintentos/backoff y cache del ultimo valor
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/apis');

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body instanceof Error) throw body; return body; } });
const seqFetch = (...responses) => { const calls = []; const f = async (url, opts) => { calls.push({ url, opts }); const r = responses[Math.min(calls.length - 1, responses.length - 1)]; if (r instanceof Error) throw r; if (typeof r === 'function') return r(opts); return r; }; f.calls = calls; return f; };
const opts = (fetchImpl, extra = {}) => { const s = { sleeps: [] }; return { fetchImpl, sleep: (ms) => { s.sleeps.push(ms); return Promise.resolve(); }, s, ...extra }; };

const AZURE = { results: [{ temperature: { value: 15.2 }, realFeelTemperature: { value: 14 }, relativeHumidity: 70, wind: { speed: { value: 9 } }, windGust: { speed: { value: 20 } }, uvIndex: 3, visibility: { value: 16 }, cloudCover: 40, pressure: { value: 1020 }, hasPrecipitation: false, isDayTime: true }] };
const OPENMETEO = { current: { pm10: 20, pm2_5: 12, us_aqi: 55, uv_index: 2, carbon_monoxide: 300, nitrogen_dioxide: 15 } };

test('parseAzure: campos y nombres del contrato', () => {
  assert.deepEqual(A.parseAzure(AZURE), { temperature: 15.2, real_feel: 14, humidity: 70, wind_kmh: 9, gust_kmh: 20, uv_index: 3, visibility_km: 16, cloud_cover: 40, pressure_mb: 1020, precip: 0, is_day: 1 });
});
test('parseAzure: respuesta vacia o sin temperatura => error claro', () => {
  assert.throws(() => A.parseAzure({}), /sin resultados/);
  assert.throws(() => A.parseAzure(null), /sin resultados/);
  assert.throws(() => A.parseAzure({ results: [{ temperature: { value: 'x' } }] }), /sin temperatura/);
});
test('parseAzure: campos opcionales ausentes quedan undefined (no NaN)', () => {
  const f = A.parseAzure({ results: [{ temperature: { value: 10 } }] });
  assert.equal(f.temperature, 10); assert.equal(f.wind_kmh, undefined); assert.equal(f.precip, 0);
});
test('parseOpenMeteo', () => {
  assert.deepEqual(A.parseOpenMeteo(OPENMETEO), { pm10: 20, pm2_5: 12, us_aqi: 55, uv_index: 2, co_ugm3: 300, no2_ugm3: 15 });
  assert.throws(() => A.parseOpenMeteo({}), /current/);
  assert.throws(() => A.parseOpenMeteo({ current: { pm10: null } }), /sin variables/);
});
test('URLs con coordenadas y key codificadas; redact oculta la key', () => {
  const u = A.azureUrl('4.711', '-74.072', 'k&y=1');
  assert.match(u, /query=4\.711%2C-74\.072/); assert.match(u, /subscription-key=k%26y%3D1/);
  assert.equal(A.redact(u).includes('k%26y'), false); assert.match(A.redact(u), /subscription-key=\*\*\*/);
  assert.match(A.openMeteoUrl('4.7', '-74'), /latitude=4\.7&longitude=-74&current=pm10/);
});

test('fetchJson: OK a la primera', async () => {
  const f = seqFetch(res(200, { a: 1 })); const o = opts(f);
  assert.deepEqual(await A.fetchJson('http://x', o), { a: 1 }); assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].opts.signal);
});
test('fetchJson: reintenta 5xx y errores de red con backoff exponencial', async () => {
  const f = seqFetch(res(503), new TypeError('fetch failed'), res(200, { ok: 1 })); const o = opts(f, { retries: 2, backoffMs: 100 });
  assert.deepEqual(await A.fetchJson('http://x', o), { ok: 1 });
  assert.equal(f.calls.length, 3); assert.deepEqual(o.s.sleeps, [100, 200]);
});
test('fetchJson: 4xx no se reintenta; 401/403 son permanentes', async () => {
  const f = seqFetch(res(401)); const o = opts(f, { retries: 3 });
  await assert.rejects(A.fetchJson('http://x', o), (e) => e.status === 401 && e.permanent === true && /HTTP 401/.test(e.message));
  assert.equal(f.calls.length, 1);
  const f2 = seqFetch(res(404));
  await assert.rejects(A.fetchJson('http://x', opts(f2, { retries: 3 })), (e) => e.status === 404 && !e.permanent);
  assert.equal(f2.calls.length, 1);
});
test('fetchJson: 429 si se reintenta', async () => {
  const f = seqFetch(res(429), res(200, {})); await A.fetchJson('http://x', opts(f)); assert.equal(f.calls.length, 2);
});
test('fetchJson: agota reintentos y lanza el ultimo error', async () => {
  const f = seqFetch(res(500)); await assert.rejects(A.fetchJson('http://x', opts(f, { retries: 2 })), /HTTP 500/); assert.equal(f.calls.length, 3);
});
test('fetchJson: JSON invalido falla sin reintentar', async () => {
  const f = seqFetch(res(200, new SyntaxError('bad'))); await assert.rejects(A.fetchJson('http://x', opts(f, { retries: 2 })), /JSON/); assert.equal(f.calls.length, 1);
});
test('fetchJson: timeout aborta la peticion', async () => {
  const hang = (o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
  const f = seqFetch(hang);
  await assert.rejects(A.fetchJson('http://x', opts(f, { timeoutMs: 20, retries: 1 })), /timeout de 20 ms/);
  assert.equal(f.calls.length, 2);
});
test('fetchJson: los errores nunca exponen la key', async () => {
  const f = seqFetch(new Error('fallo en https://h/?subscription-key=SECRETA&x=1'));
  await assert.rejects(A.fetchJson('http://x', opts(f, { retries: 0 })), (e) => !e.message.includes('SECRETA'));
});

test('createApiModel: guarda cache y la entrega marcada stale al fallar', async () => {
  let fail = false; const got = [];
  const m = A.createApiModel(async () => { if (fail) throw new Error('caida'); return { t: 1 }; }, { cacheMaxMs: 60000, onValue: (f) => got.push(f) });
  assert.deepEqual(await m.tick(1000), { t: 1 }); assert.deepEqual(got, [{ t: 1 }]);
  fail = true;
  await assert.rejects(m.tick(31000), (e) => { assert.deepEqual(e.cached, { t: 1, stale: 1, age_s: 30 }); return true; });
  assert.equal(m.fails, 1);
  await assert.rejects(m.tick(62000), (e) => e.cached === null); // cache demasiado vieja
  assert.equal(m.fails, 2); assert.equal(m.status(62000).ok, false); assert.equal(m.status(62000).last_error, 'caida');
  fail = false; await m.tick(70000); assert.equal(m.fails, 0); assert.equal(m.status(70000).ok, true);
});
test('createApiModel: sin cache previa el error no trae datos', async () => {
  const m = A.createApiModel(async () => { throw new A.ApiError('falta key', { permanent: true }); });
  await assert.rejects(m.tick(1), (e) => e.cached === null && e.permanent === true);
});
