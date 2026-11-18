'use strict';
// Telegram: desactivado sin token/chat, envio con fetch falso, timeout, redaccion del token, antispam y programacion de reportes
const test = require('node:test');
const assert = require('node:assert/strict');
const TG = require('../src/telegram');
const { createGamification } = require('../src/gamification');
const { buildReport } = require('../src/report');
const { createLogger } = require('../src/log');

const TOKEN = '123456789:AAH-secreto_SuperPrivado';
const MIN = 60000;
const at = (iso) => Date.parse(iso);
function fakeFetch(reply = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, opts, body: JSON.parse(opts.body) }); return reply(url, opts); };
  f.calls = calls;
  return f;
}
const logs = () => { const lines = []; return { lines, log: createLogger({ level: 'debug', out: (l) => lines.push(l), err: (l) => lines.push(l) }) }; };
const ev = (o) => ({ rule: 'co2_alto', severity: 'warning', device: 'ds-co2', value: 1200, msg: 'CO2 en 1200 ppm', ts: at('2026-11-18T15:04:00Z'), id: 'x', ...o });

test('sin token o sin chat queda desactivado y no llama a fetch', async () => {
  for (const [token, chatId] of [['', '1'], [TOKEN, ''], [undefined, undefined], ['  ', '  ']]) {
    const f = fakeFetch();
    const tg = TG.createTelegram({ token, chatId, fetchImpl: f });
    assert.equal(tg.enabled, false);
    assert.equal(await tg.send('hola'), false);
    assert.equal(await tg.notifyEvent(ev({ severity: 'critical' })), false);
    assert.equal(f.calls.length, 0);
    assert.equal(tg.status().enabled, false);
  }
});

test('envia sendMessage por POST JSON en texto plano (sin parse_mode)', async () => {
  const f = fakeFetch();
  const tg = TG.createTelegram({ token: TOKEN, chatId: '-1001', fetchImpl: f });
  assert.equal(await tg.send('Hola <b>&</b> _jefe_'), true);
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(c.opts.method, 'POST');
  assert.equal(c.opts.headers['content-type'], 'application/json');
  assert.deepEqual(c.body, { chat_id: '-1001', text: 'Hola <b>&</b> _jefe_', disable_web_page_preview: true });
  assert.equal('parse_mode' in c.body, false);
  assert.ok(c.opts.signal instanceof AbortSignal);
  assert.equal(tg.status().sent, 1);
});

test('errores de fetch y respuestas de error: el token nunca aparece en logs ni en el estado', async () => {
  const replies = [
    async () => { throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: ECONNRESET`); },
    async () => { throw new TypeError('fetch failed bot987:otroSecreto-xyz'); },
    () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: `Unauthorized ${TOKEN}` }) }),
    () => ({ ok: true, status: 200, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) }),
    () => ({ ok: false, status: 502, json: async () => { throw new Error('no json'); } })
  ];
  for (const reply of replies) {
    const { lines, log } = logs();
    const tg = TG.createTelegram({ token: TOKEN, chatId: '1', fetchImpl: fakeFetch(reply), log });
    assert.equal(await tg.send('x'), false);
    const all = lines.join('\n') + JSON.stringify(tg.status());
    assert.equal(all.includes(TOKEN), false, all);
    assert.equal(all.includes('AAH-secreto'), false);
    assert.equal(all.includes('otroSecreto'), false);
    assert.ok(lines.some((l) => /Telegram: no se pudo enviar/.test(l)));
    assert.equal(tg.status().failed, 1);
  }
});

test('redact quita el token y cualquier bot<id>:<secreto>', () => {
  assert.equal(TG.redact(`a ${TOKEN} b ${TOKEN}`, TOKEN), 'a <token> b <token>');
  assert.equal(TG.redact('url /bot42:abc-DEF_9/sendMessage', ''), 'url /bot<token>/sendMessage');
  assert.equal(TG.redact(undefined, TOKEN), '');
});

test('timeout: aborta la peticion colgada y lo informa sin token', async () => {
  const hang = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error(`aborted ${url}`), { name: 'AbortError' }))));
  const { lines, log } = logs();
  const tg = TG.createTelegram({ token: TOKEN, chatId: '1', fetchImpl: hang, timeoutMs: 30, log });
  const t0 = Date.now();
  assert.equal(await tg.send('x'), false);
  assert.ok(Date.now() - t0 < 2000);
  assert.match(tg.status().last_error, /timeout tras 30 ms/);
  assert.equal(lines.join('\n').includes(TOKEN), false);
});

test('alertas: severidad minima y antispam por regla+dispositivo de 10 min; logros siempre', async () => {
  const clock = { t: 1e12 };
  const f = fakeFetch();
  const tg = TG.createTelegram({ token: TOKEN, chatId: '1', fetchImpl: f, now: () => clock.t });
  assert.equal(await tg.notifyEvent(ev({ severity: 'info', rule: 'consumo_alto', device: 'enchufe-twin' })), false, 'info < warning');
  assert.equal(await tg.notifyEvent(ev()), true);
  clock.t += 5 * MIN;
  assert.equal(await tg.notifyEvent(ev({ severity: 'critical' })), false, 'misma regla+dispositivo dentro de 10 min');
  assert.equal(await tg.notifyEvent(ev({ device: 'otro' })), true, 'otro dispositivo si');
  assert.equal(await tg.notifyEvent(ev({ rule: 'temperatura_alta' })), true, 'otra regla si');
  clock.t += 5 * MIN;
  assert.equal(await tg.notifyEvent(ev()), true, 'pasados 10 min vuelve a avisar');
  for (let i = 0; i < 3; i++) assert.equal(await tg.notifyEvent({ rule: 'logro', severity: 'info', device: 'boss', value: 2, msg: `Logro: L${i}`, ts: clock.t }), true);
  assert.equal(f.calls.length, 7);
  assert.equal(tg.status().suppressed, 1);
  const crit = TG.createTelegram({ token: TOKEN, chatId: '1', fetchImpl: fakeFetch(), minSeverity: 'critical' });
  assert.equal(crit.shouldNotify(ev()), false);
  assert.equal(crit.shouldNotify(ev({ severity: 'critical' })), true);
  assert.equal(TG.createTelegram({ token: TOKEN, chatId: '1', fetchImpl: fakeFetch(), minSeverity: 'raro' }).minSeverity, 'warning');
});

test('formato legible en espanol de alertas y logros', () => {
  const s = TG.formatEvent(ev({ severity: 'critical' }), { tz: 'America/Bogota' });
  assert.match(s, /Crítico: co2_alto/); assert.match(s, /CO2 en 1200 ppm/); assert.match(s, /Dispositivo: ds-co2/); assert.match(s, /Hora: 10:04/);
  const l = TG.formatEvent({ rule: 'logro', severity: 'info', device: 'boss', value: 3, msg: 'Logro: Maratón' }, { personality: 'sarcastico', random: () => 0 });
  assert.match(l, /Logro: Maratón/); assert.match(l, /Nivel actual: 3/);
  assert.equal(TG.fmtMin(45), '45 min'); assert.equal(TG.fmtMin(120), '2 h'); assert.equal(TG.fmtMin(125.4), '2 h 5 min');
});

test('formato de reportes diario y semanal', () => {
  const g = createGamification({ tz: 'UTC' });
  let t = at('2026-11-18T09:00:00Z');
  for (; t <= at('2026-11-18T10:30:00Z'); t += 60000) g.update('focused', 80, t);
  const now = at('2026-11-18T18:00:00Z');
  const r = buildReport(g, now); const st = g.stats(now);
  const d = TG.formatDailyReport(r, st, { personality: 'estricto', random: () => 0 });
  assert.match(d, /Reporte diario del jefe \(2026-11-18\)/);
  assert.match(d, /Enfocado: 1 h 30 min \(100 %\)/);
  assert.match(d, /Nivel 1 \(105 XP, siguiente en 300\) · Racha: 1 día/); // 90 min + 3 bloques de 25 min
  const w = TG.formatWeeklyReport(r, st, { personality: 'motivador', random: () => 0 });
  assert.match(w, /Reporte semanal del jefe \(2026-11-12 a 2026-11-18\)/);
  assert.match(w, /mié 11-18: 1 h 30 min/);
  assert.equal(w.split('\n').filter((x) => /^\S{3} \d\d-\d\d:/.test(x)).length, 7);
});

test('dueReports: diario desde REPORT_HOUR una vez por fecha; semanal solo el dia indicado', () => {
  const tz = 'UTC';
  const fri = at('2026-11-20T18:00:00Z'); // viernes
  assert.deepEqual(TG.dueReports(at('2026-11-20T17:59:00Z'), { tz, hour: 18, weekday: 5, sched: {} }), { date: '2026-11-20', daily: false, weekly: false });
  assert.deepEqual(TG.dueReports(fri, { tz, hour: 18, weekday: 5, sched: {} }), { date: '2026-11-20', daily: true, weekly: true });
  assert.deepEqual(TG.dueReports(fri + 3600e3, { tz, hour: 18, weekday: 5, sched: { last_daily: '2026-11-20', last_weekly: '2026-11-20' } }), { date: '2026-11-20', daily: false, weekly: false });
  assert.equal(TG.dueReports(at('2026-11-19T19:00:00Z'), { tz, hour: 18, weekday: 5, sched: { last_daily: '2026-11-18' } }).weekly, false, 'jueves no hay semanal');
  assert.equal(TG.dueReports(at('2026-11-21T18:30:00Z'), { tz, hour: 18, weekday: 5, sched: { last_daily: '2026-11-20' } }).daily, true, 'otro dia, otro diario');
  // la hora es la local de TZ: 18:00 en Bogota = 23:00 UTC
  assert.equal(TG.dueReports(at('2026-11-20T22:00:00Z'), { tz: 'America/Bogota', hour: 18, weekday: 5 }).daily, false);
  assert.equal(TG.dueReports(at('2026-11-20T23:00:00Z'), { tz: 'America/Bogota', hour: 18, weekday: 5 }).daily, true);
});
