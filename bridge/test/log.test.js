'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../src/log');

const capture = (opts) => { const out = []; const log = createLogger({ ...opts, out: (l) => out.push(l), err: (l) => out.push('ERR ' + l) }); return { out, log }; };

test('respeta el nivel minimo', () => {
  const { out, log } = capture({ level: 'warn' });
  log.debug('a'); log.info('b'); log.warn('c'); log.error('d');
  assert.equal(out.length, 2); assert.ok(out.every((l) => l.startsWith('ERR ')));
});
test('formato texto con clave=valor y errores como mensaje', () => {
  const { out, log } = capture({ level: 'info' });
  log.info('hola', { device: 'luz-twin', n: 3, err: new Error('fallo x'), skip: undefined });
  assert.match(out[0], /INFO  hola device=luz-twin n=3 err="fallo x"$/);
});
test('formato json', () => {
  const { out, log } = capture({ format: 'json' });
  log.child({ svc: 'bridge' }).info('evento', { rule: 'co2_alto' });
  const o = JSON.parse(out[0]);
  assert.equal(o.level, 'info'); assert.equal(o.msg, 'evento'); assert.equal(o.svc, 'bridge'); assert.equal(o.rule, 'co2_alto'); assert.ok(o.ts);
});
test('nivel desconocido cae en info', () => {
  assert.equal(createLogger({ level: 'loquesea' }).level, 'info');
});
