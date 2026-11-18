'use strict';
// Validacion y saneo de comandos jefe/<id>/cmd
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonObject, toBool, toNum, cmdSpec, sanitizeCmd } = require('../src/commands');

test('parseJsonObject solo acepta objetos planos', () => {
  assert.deepEqual(parseJsonObject(Buffer.from('{"a":1}')), { a: 1 });
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  for (const bad of ['null', '5', '"x"', '[1,2]', 'true', '{nope', '', ' ']) assert.equal(parseJsonObject(Buffer.from(bad)), null, bad);
  assert.equal(parseJsonObject(null), null); assert.equal(parseJsonObject(undefined), null);
});
test('parseJsonObject rechaza mensajes demasiado grandes', () => {
  const big = JSON.stringify({ x: 'a'.repeat(5000) });
  assert.equal(parseJsonObject(Buffer.from(big)), null);
  assert.ok(parseJsonObject(Buffer.from(big), 10000));
});
test('toBool', () => {
  for (const v of [true, 1, '1', 'true', 'ON', ' si ', 'yes']) assert.equal(toBool(v), true, String(v));
  for (const v of [false, 0, '0', 'false', 'off', 'No']) assert.equal(toBool(v), false, String(v));
  for (const v of [2, -1, 'quizas', null, undefined, {}, [], NaN]) assert.equal(toBool(v), undefined, String(v));
});
test('toNum: finitos, texto numerico, recorte y enteros', () => {
  assert.equal(toNum(5, 0, 10), 5); assert.equal(toNum('7.5', 0, 10), 7.5); assert.equal(toNum(50, 0, 10), 10); assert.equal(toNum(-3, 0, 10), 0);
  assert.equal(toNum(3.9, 0, 10, { integer: true }), 3);
  for (const v of [NaN, Infinity, -Infinity, '', '  ', 'abc', null, undefined, {}, [], true]) assert.equal(toNum(v, 0, 10), undefined, String(v));
});
test('spec comun: enabled e interval_s con minimo por dispositivo', () => {
  const s = cmdSpec('api-azure-weather', 'api', { minIntervalS: 60 });
  assert.deepEqual(sanitizeCmd({ enabled: 'false', interval_s: 5 }, s).cmd, { enabled: false, interval_s: 60 });
  assert.deepEqual(sanitizeCmd({ interval_s: 99999 }, s).cmd, { interval_s: 3600 });
});
test('interval_s NaN / texto basura se rechaza (antes daba setTimeout(NaN) = bucle a 1 ms)', () => {
  const s = cmdSpec('luz-twin', 'twin');
  const r = sanitizeCmd({ interval_s: 'rapido' }, s);
  assert.deepEqual(r.cmd, {}); assert.deepEqual(r.rejected, ['interval_s']);
});
test('enabled "false" en texto ya no enciende el dispositivo', () => {
  assert.equal(sanitizeCmd({ enabled: 'false' }, cmdSpec('luz-twin', 'twin')).cmd.enabled, false);
});
test('campos por dispositivo', () => {
  assert.deepEqual(sanitizeCmd({ gain: 50 }, cmdSpec('cam-sala-twin', 'twin')).cmd, { gain: 12 });
  assert.deepEqual(sanitizeCmd({ setpoint: '22.5' }, cmdSpec('termostato-twin', 'twin')).cmd, { setpoint: 22.5 });
  assert.deepEqual(sanitizeCmd({ relay: 'off' }, cmdSpec('enchufe-twin', 'twin')).cmd, { relay: false });
  assert.deepEqual(sanitizeCmd({ door: 1 }, cmdSpec('puerta-twin', 'twin')).cmd, { door: true });
  assert.deepEqual(sanitizeCmd({ mode: 'AUTO', on: true, brightness: 1 }, cmdSpec('luz-twin', 'twin')).cmd, { mode: 'auto', on: true, brightness: 5 });
  assert.deepEqual(sanitizeCmd({ rewind: true, row: 12.7 }, cmdSpec('ds-co2', 'dataset')).cmd, { rewind: true, row: 12 });
});
test('valores invalidos van a rejected y campos ajenos a unknown', () => {
  const r = sanitizeCmd({ mode: 'turbo', relay: true, brightness: 'mucho', on: 'tal vez' }, cmdSpec('luz-twin', 'twin'));
  assert.deepEqual(r.cmd, {}); assert.deepEqual(r.rejected.sort(), ['brightness', 'mode', 'on']); assert.deepEqual(r.unknown, ['relay']);
});
test('rewind false no hace nada; setpoint no aplica a la luz', () => {
  assert.deepEqual(sanitizeCmd({ rewind: false }, cmdSpec('ds-co2', 'dataset')).cmd, {});
  assert.deepEqual(sanitizeCmd({ setpoint: 20 }, cmdSpec('luz-twin', 'twin')).unknown, ['setpoint']);
});
test('no se cuelan propiedades del prototipo', () => {
  const o = JSON.parse('{"__proto__": {"enabled": true}, "constructor": 1, "toString": 2}');
  const r = sanitizeCmd(o, cmdSpec('luz-twin', 'twin'));
  assert.deepEqual(r.cmd, {}); assert.equal(Object.getPrototypeOf(r.cmd), Object.prototype);
});
test('payload que no es objeto => vacio', () => {
  for (const p of [null, undefined, 5, 'x', [1]]) assert.deepEqual(sanitizeCmd(p, cmdSpec('luz-twin', 'twin')), { cmd: {}, rejected: [], unknown: [] });
});
