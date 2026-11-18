'use strict';
// Integracion del contrato v2 en el bridge: ts/id en eventos, personalidad, gamificacion, reportes, Telegram y persistencia
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');
const { createBridge, createHealthServer, loadConfig } = require('../src/bridge');
const { createLogger } = require('../src/log');
const P = require('../src/personality');

const TOKEN = '555000111:AAE-token_muy_secreto';
const MIN = 60000;
const at = (iso) => Date.parse(iso);
const flush = () => new Promise((r) => setImmediate(r));

class FakeClient extends EventEmitter {
  constructor() { super(); this.connected = true; this.published = []; this.subs = []; this.options = {}; }
  publish(topic, payload, opts, cb) { this.published.push({ topic, payload, ...opts }); if (cb) cb(); }
  subscribe(t, o, cb) { this.subs.push(...[].concat(t)); if (cb) cb(null); }
  on$(topic) { return this.published.filter((p) => p.topic === topic); }
  json(topic) { return this.on$(topic).map((p) => JSON.parse(p.payload)); }
}
const fakeTimers = () => {
  const intervals = [];
  return {
    intervals,
    setTimeout: (fn, ms) => ({ fn, ms }), clearTimeout: () => {},
    setInterval: (fn, ms) => { const h = { fn, ms, active: true }; intervals.push(h); return h; },
    clearInterval: (h) => { if (h) h.active = false; }
  };
};
const memStore = (initial = null) => {
  const s = { data: initial ? JSON.parse(JSON.stringify(initial)) : null, saves: 0 };
  s.load = () => (s.data ? JSON.parse(JSON.stringify(s.data)) : null);
  s.save = (o) => { s.data = JSON.parse(JSON.stringify(o)); s.saves++; return true; };
  s.status = () => ({ ok: true, saves: s.saves });
  return s;
};
function telegramFetch() {
  const calls = [];
  const f = async (url, opts) => {
    if (String(url).includes('api.telegram.org')) { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    return { ok: true, status: 200, json: async () => ({ current: { us_aqi: 40, pm10: 10 } }) };
  };
  f.calls = calls;
  return f;
}

const DATASETS = path.join(__dirname, '..', '..', 'datasets');
function setup({ env = {}, fetchImpl, clock = { t: at('2026-11-18T10:00:00Z') }, store = null, random } = {}) {
  const client = new FakeClient(); const timers = fakeTimers();
  const config = loadConfig({ DATASETS_DIR: DATASETS, TZ: 'UTC', ...env });
  const lines = [];
  const log = createLogger({ level: 'debug', out: (l) => lines.push(l), err: (l) => lines.push(l) });
  const b = createBridge({ client, config, log, timers, store, now: () => clock.t, sleep: () => Promise.resolve(), fetchImpl: fetchImpl || telegramFetch(), ...(random ? { random } : {}) });
  const send = (topic, obj) => b.handleMessage(topic, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)));
  // n muestras de la ESP32 cada 10 s
  const motion = (m, n) => { for (let i = 0; i < n; i++) { clock.t += 10000; send('jefe/esp32cam-01/telemetry', { motion: m, sim: 1 }); } };
  return { client, timers, b, clock, send, lines, motion };
}

// ---------- Eventos ----------
test('eventos con ts (ms) e id unico, aunque coincidan en el mismo milisegundo', () => {
  const { b, client, clock } = setup();
  for (const id of ['api-a', 'api-b']) b.rules.onApi(id, false, 'x', clock.t);
  b.rules.onApi('api-a', true, '', clock.t); // api_recuperada
  const evs = client.published.filter((p) => p.topic.endsWith('/event')).map((p) => JSON.parse(p.payload));
  assert.equal(evs.length, 3);
  for (const e of evs) { assert.equal(e.ts, clock.t); assert.equal(typeof e.id, 'string'); assert.ok(e.id.startsWith(`${clock.t}-${e.rule}-${e.device}`)); }
  assert.equal(new Set(evs.map((e) => e.id)).size, 3);
  // mismo rule+device+ms => sufijo
  b.rules.onApi('api-a', false, 'x', clock.t);
  const ids = client.json('jefe/api-a/event').map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---------- Personalidad ----------
test('personalidad por defecto motivador: jefe/boss/state retenido QoS 1 al conectar; distraido salta a los 90 s', () => {
  const { b, client, motion } = setup();
  b.onConnect();
  const st = client.on$('jefe/boss/state');
  assert.equal(st.length, 1); assert.equal(st[0].retain, true); assert.equal(st[0].qos, 1);
  const s = JSON.parse(st[0].payload);
  assert.equal(s.personality, 'motivador'); assert.equal(typeof s.updated, 'number');
  motion(40, 12); // 120 s con mucho movimiento
  const ev = client.json('jefe/boss/event').filter((e) => e.rule === 'distraido_prolongado');
  assert.equal(ev.length, 1);
  assert.ok(ev[0].value >= 90 && ev[0].value < 100, `value ${ev[0].value}`);
  assert.ok(P.PHRASES.motivador.distraido_prolongado.map((f) => f(ev[0].value)).includes(ev[0].msg), ev[0].msg);
});

test('cmd personality: cambia umbral (estricto 30 s), frases del banco, publica estado y valida el valor', () => {
  const { b, client, send, motion, clock } = setup({ random: () => 0 });
  send('jefe/boss/cmd', { personality: 'Estricto' });
  let st = client.json('jefe/boss/state').at(-1);
  assert.deepEqual(st, { personality: 'estricto', updated: clock.t });
  assert.equal(client.on$('jefe/boss/state').at(-1).retain, true);
  assert.equal(b.rules.thresholds.distractedMs, 30000);
  motion(40, 6);
  const ev = client.json('jefe/boss/event').filter((e) => e.rule === 'distraido_prolongado');
  assert.equal(ev.length, 1);
  assert.ok(ev[0].value >= 30 && ev[0].value < 60);
  assert.equal(ev[0].msg, P.PHRASES.estricto.distraido_prolongado[0](ev[0].value));
  // invalido: no cambia pero re-publica el estado
  const n = client.on$('jefe/boss/state').length;
  send('jefe/boss/cmd', { personality: 'malvado' });
  assert.equal(client.on$('jefe/boss/state').length, n + 1);
  assert.equal(client.json('jefe/boss/state').at(-1).personality, 'estricto');
  send('jefe/boss/cmd', { personality: 'sarcástico' });
  assert.equal(b.personality, 'sarcastico'); assert.equal(b.rules.thresholds.distractedMs, 60000);
  // basura no revienta
  for (const p of ['null', '[]', '{bad', '{"personality":null}', '{"personality":{"x":1}}']) assert.doesNotThrow(() => send('jefe/boss/cmd', p));
  assert.equal(b.personality, 'sarcastico');
  // reset sigue funcionando junto a personality
  send('jefe/boss/cmd', { reset: true, personality: 'motivador' });
  assert.equal(b.personality, 'motivador'); assert.equal(b.boss.snapshot().score, 50);
});

test('ausente_largo usa el banco de frases; las alertas de otros dispositivos conservan su msg', () => {
  const { b, client, clock } = setup({ random: () => 0 });
  b.setPersonality('sarcastico');
  for (let i = 0; i <= 32; i++) { clock.t += MIN; b.rules.onBoss({ name: 'absent' }, at('2026-11-18T15:00:00Z') + i * MIN); }
  const ev = client.json('jefe/boss/event').find((e) => e.rule === 'ausente_largo');
  assert.ok(ev);
  assert.equal(ev.msg, P.PHRASES.sarcastico.ausente_largo[0](ev.value));
  b.handleMessage('jefe/ds-co2/telemetry', Buffer.from('{"co2":1700}'));
  assert.match(client.json('jefe/ds-co2/event')[0].msg, /CO2 en 1700 ppm/);
});

// ---------- Gamificacion ----------
test('jefe/boss/telemetry agrega xp y level numericos (v1 intacto)', () => {
  const { client, motion } = setup();
  motion(5, 30);
  const t = client.json('jefe/boss/telemetry').at(-1);
  for (const k of ['state', 'score', 'motion_avg', 'focused_min', 'distracted_min', 'absent_min', 'focus_pct', 'state_s', 'sim', 'xp', 'level']) assert.equal(typeof t[k], 'number', k);
  assert.ok(t.xp >= 4);
  assert.equal(t.level, 0);
});

test('logro primer_foco: evento info del jefe con el nivel y stats retenido actualizado', () => {
  const { client, motion } = setup();
  motion(5, 6 * 26); // 26 min enfocado
  const logros = client.json('jefe/boss/event').filter((e) => e.rule === 'logro');
  assert.equal(logros.length, 1);
  const l = logros[0];
  assert.equal(l.severity, 'info'); assert.equal(l.device, 'boss'); assert.equal(l.msg, 'Logro: Primer foco');
  assert.equal(typeof l.value, 'number'); assert.equal(typeof l.ts, 'number'); assert.ok(l.id.includes('-logro-boss'));
  const stats = client.on$('jefe/boss/stats');
  assert.ok(stats.length >= 1); assert.ok(stats.every((p) => p.retain && p.qos === 1));
  const s = JSON.parse(stats.at(-1).payload);
  assert.deepEqual(s.achievements.map((a) => a.id), ['primer_foco']);
  assert.ok(s.current_focus_streak_min >= 25);
  motion(5, 6 * 10);
  assert.equal(client.json('jefe/boss/event').filter((e) => e.rule === 'logro').length, 1, 'no se repite');
});

test('stats no se publica en cada muestra: solo cuando cambia algo', () => {
  const { client, motion } = setup();
  motion(5, 60); // 10 min => ~10 cambios de xp
  const n = client.on$('jefe/boss/stats').length;
  assert.ok(n >= 8 && n <= 15, `publicaciones ${n}`);
});

// ---------- Reportes ----------
test('onConnect y el ciclo de 60 s publican stats y report retenidos; GET /report devuelve lo mismo', async () => {
  const { b, client, timers, motion } = setup();
  motion(5, 30);
  b.onConnect();
  const rep = client.on$('jefe/boss/report');
  assert.equal(rep.length, 1); assert.equal(rep[0].retain, true); assert.equal(rep[0].qos, 1);
  const r = JSON.parse(rep[0].payload);
  assert.equal(r.week.length, 7); assert.equal(r.today.date, '2026-11-18'); assert.ok(r.today.focused_min > 0);
  b.start();
  const periodic = timers.intervals.find((h) => h.ms === 60000);
  assert.ok(periodic, 'intervalo de 60 s');
  const before = client.on$('jefe/boss/report').length;
  periodic.fn();
  assert.equal(client.on$('jefe/boss/report').length, before + 1);
  assert.ok(client.on$('jefe/boss/stats').length >= 2);
  b.stop();
  assert.equal(periodic.active, false);
  periodic.fn(); // tras stop no publica
  assert.equal(client.on$('jefe/boss/report').length, before + 1);

  const server = createHealthServer(b);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/report`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /json/);
    assert.deepEqual(await res.json(), b.report());
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/report/x`)).status, 404);
  } finally { server.close(); }
});

test('al cambiar de dia se publica el reporte al instante', () => {
  const clock = { t: at('2026-11-18T23:58:00Z') };
  const { client, motion } = setup({ clock });
  motion(5, 6);
  const before = client.json('jefe/boss/report').length;
  motion(5, 12);
  const reps = client.json('jefe/boss/report');
  assert.equal(reps.length, before + 1);
  assert.equal(reps.at(-1).today.date, '2026-11-19');
  assert.equal(reps.at(-1).week[5].date, '2026-11-18');
});

// ---------- Telegram ----------
test('Telegram desactivado por defecto: sin llamadas y health sin token', async () => {
  const f = telegramFetch();
  const { b, send } = setup({ fetchImpl: f });
  send('jefe/ds-co2/telemetry', { co2: 1700 });
  await flush();
  assert.equal(f.calls.length, 0);
  assert.equal(b.health().telegram.enabled, false);
});

test('Telegram activo: alertas >= warning con antispam, logros y nunca el token en logs/health/eventos', async () => {
  const f = telegramFetch();
  const { b, client, send, lines, motion } = setup({ fetchImpl: f, env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' } });
  assert.equal(b.telegram.enabled, true);
  send('jefe/ds-co2/telemetry', { co2: 1700 });
  send('jefe/enchufe-twin/telemetry', { power_w: 900 }); // info: no se manda
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.chat_id, '42');
  assert.match(f.calls[0].body.text, /co2_alto/);
  motion(5, 6 * 26);
  await flush();
  assert.ok(f.calls.some((c) => /Logro: Primer foco/.test(c.body.text)));
  const everything = lines.join('\n') + JSON.stringify(b.health()) + client.published.map((p) => p.payload).join('\n');
  assert.equal(everything.includes(TOKEN), false);
  assert.equal(everything.includes('token_muy_secreto'), false);
});

test('reporte diario a REPORT_HOUR y semanal en REPORT_WEEKDAY, una sola vez aunque se reinicie', async () => {
  const store = memStore();
  const f = telegramFetch();
  const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42', REPORT_HOUR: '18', REPORT_WEEKDAY: '5' };
  const clock = { t: at('2026-11-20T17:00:00Z') }; // viernes 17:00 UTC
  let s = setup({ fetchImpl: f, env, store, clock });
  await s.b.maybeSendReports();
  assert.equal(f.calls.length, 0, 'antes de la hora no se envia');
  clock.t = at('2026-11-20T18:01:00Z');
  await s.b.maybeSendReports();
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].body.text, /Reporte diario del jefe \(2026-11-20\)/);
  assert.match(f.calls[1].body.text, /Reporte semanal del jefe/);
  await s.b.maybeSendReports();
  assert.equal(f.calls.length, 2, 'no se repite el mismo dia');
  assert.deepEqual(store.data.telegram, { last_daily: '2026-11-20', last_weekly: '2026-11-20' });
  // reinicio con el mismo estado guardado
  clock.t = at('2026-11-20T20:00:00Z');
  s = setup({ fetchImpl: f, env, store, clock });
  await s.b.maybeSendReports();
  assert.equal(f.calls.length, 2, 'tras reiniciar tampoco');
  // sabado: solo diario
  clock.t = at('2026-11-21T18:30:00Z');
  await s.b.maybeSendReports();
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[2].body.text, /Reporte diario/);
});

test('si Telegram falla al mandar el reporte no se marca como enviado y se reintenta a los 10 min', async () => {
  let fail = true; const calls = [];
  const fetchImpl = async (url, opts) => { calls.push(JSON.parse(opts.body)); return fail ? { ok: false, status: 500, json: async () => ({ ok: false }) } : { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const clock = { t: at('2026-11-18T18:05:00Z') }; // miercoles
  const { b } = setup({ fetchImpl, clock, env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' } });
  await b.maybeSendReports(); assert.equal(calls.length, 1);
  clock.t += MIN; await b.maybeSendReports(); assert.equal(calls.length, 1, 'espera antes de reintentar');
  fail = false; clock.t += 10 * MIN; await b.maybeSendReports(); assert.equal(calls.length, 2);
  clock.t += 10 * MIN; await b.maybeSendReports(); assert.equal(calls.length, 2);
});

// ---------- Persistencia ----------
test('persistencia: personalidad, xp y logros sobreviven al reinicio', () => {
  const store = memStore();
  const clock = { t: at('2026-11-18T10:00:00Z') };
  let s = setup({ store, clock });
  s.send('jefe/boss/cmd', { personality: 'estricto' });
  assert.ok(store.saves >= 1, 'se guarda al cambiar la personalidad');
  s.motion(5, 6 * 26);
  const xp = s.b.game.xp;
  s.b.persist();
  assert.equal(store.data.version, 1);
  s = setup({ store, clock });
  assert.equal(s.b.personality, 'estricto');
  assert.equal(s.b.rules.thresholds.distractedMs, 30000);
  assert.equal(s.b.game.xp, xp);
  assert.deepEqual(s.b.bossStats().achievements.map((a) => a.id), ['primer_foco']);
  s.b.onConnect();
  assert.equal(s.client.json('jefe/boss/state')[0].personality, 'estricto');
  s.motion(5, 6 * 30);
  assert.equal(s.client.json('jefe/boss/event').filter((e) => e.rule === 'logro' && e.msg === 'Logro: Primer foco').length, 0);
});

test('el ciclo de 60 s guarda en disco; un store roto no tumba el bridge', () => {
  const store = memStore();
  const { b, timers } = setup({ store });
  b.start();
  const n = store.saves;
  timers.intervals.find((h) => h.ms === 60000).fn();
  assert.equal(store.saves, n + 1);
  b.stop();
  const broken = { load: () => { throw new Error('disco roto'); }, save: () => { throw new Error('disco roto'); } };
  const s2 = setup({ store: broken });
  assert.equal(s2.b.personality, 'motivador');
  assert.doesNotThrow(() => { s2.send('jefe/boss/cmd', { personality: 'estricto' }); s2.b.persist(); s2.b.periodic(); });
  assert.equal(s2.b.personality, 'estricto');
  // estado guardado basura
  const s3 = setup({ store: memStore({ personality: 'malvado', personality_updated: 'ayer', gamification: 'x', telegram: 5 }) });
  assert.equal(s3.b.personality, 'motivador'); assert.equal(s3.b.game.xp, 0);
});

test('loadConfig v2: defaults y validacion', () => {
  const c = loadConfig({});
  assert.equal(c.telegramToken, ''); assert.equal(c.telegramChatId, ''); assert.equal(c.telegramMinSeverity, 'warning');
  assert.equal(c.reportHour, 18); assert.equal(c.reportWeekday, 5); assert.equal(c.tz, undefined);
  assert.equal(typeof c.dataDir, 'string');
  const d = loadConfig({ TZ: 'America/Bogota', DATA_DIR: '/tmp/x', TELEGRAM_MIN_SEVERITY: 'CRITICAL', REPORT_HOUR: '25', REPORT_WEEKDAY: '7' });
  assert.equal(d.tz, 'America/Bogota'); assert.equal(d.dataDir, '/tmp/x'); assert.equal(d.telegramMinSeverity, 'critical');
  assert.equal(d.reportHour, 23); assert.equal(d.reportWeekday, 0);
  const e = loadConfig({ TZ: 'Nowhere/Land', TELEGRAM_MIN_SEVERITY: 'x', REPORT_HOUR: 'tarde', REPORT_WEEKDAY: '-3' });
  assert.equal(e.tz, undefined); assert.equal(e.telegramMinSeverity, 'warning'); assert.equal(e.reportHour, 18); assert.equal(e.reportWeekday, 0);
});

test('health incluye personalidad, gamificacion, telegram y persistencia', () => {
  const { b } = setup({ store: memStore() });
  const h = b.health();
  assert.equal(h.personality, 'motivador');
  assert.deepEqual(h.gamification, { xp: 0, level: 0 });
  assert.equal(h.telegram.enabled, false);
  assert.equal(h.persistence.ok, true);
});
