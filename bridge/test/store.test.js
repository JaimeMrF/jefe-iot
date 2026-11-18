'use strict';
// Persistencia: escritura atomica, JSON corrupto tolerado y disco no escribible => sigue en memoria
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/store');
const { createLogger } = require('../src/log');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jefe-store-'));
const logs = () => { const lines = []; return { lines, log: createLogger({ level: 'debug', out: (l) => lines.push(l), err: (l) => lines.push(l) }) }; };

test('guarda y carga; crea el directorio si no existe; no deja temporales', (t) => {
  const base = tmpDir(); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'sub', 'data');
  const s = createStore({ dir });
  assert.equal(s.load(), null, 'sin archivo => null');
  assert.equal(s.save({ a: 1, txt: 'ñandú' }), true);
  assert.deepEqual(s.load(), { a: 1, txt: 'ñandú' });
  assert.equal(s.save({ a: 2 }), true);
  assert.deepEqual(s.load(), { a: 2 });
  assert.deepEqual(fs.readdirSync(dir), ['jefe-state.json']);
  assert.equal(s.status().saves, 2); assert.equal(s.status().ok, true);
});

test('escritura atomica: si falla el rename el archivo anterior queda intacto y se borra el temporal', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const good = createStore({ dir });
  good.save({ v: 'bueno' });
  const fsImpl = { ...fs, renameSync: () => { throw Object.assign(new Error('EIO simulado'), { code: 'EIO' }); } };
  const { lines, log } = logs();
  const bad = createStore({ dir, fsImpl, log });
  assert.equal(bad.save({ v: 'nuevo' }), false);
  assert.deepEqual(good.load(), { v: 'bueno' });
  assert.deepEqual(fs.readdirSync(dir), ['jefe-state.json']);
  assert.ok(lines.some((l) => /se sigue en memoria/.test(l)));
  assert.equal(bad.status().ok, false); assert.match(bad.status().last_error, /EIO/);
});

test('el temporal se escribe completo antes de reemplazar (nunca hay un archivo a medias)', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const fsImpl = { ...fs, renameSync: (a, b) => { seen.push(JSON.parse(fs.readFileSync(a, 'utf8'))); assert.notEqual(a, b); return fs.renameSync(a, b); } };
  const s = createStore({ dir, fsImpl });
  const big = { arr: Array.from({ length: 5000 }, (_, i) => ({ i, s: 'x'.repeat(20) })) };
  s.save(big);
  assert.deepEqual(seen[0], big);
});

test('JSON corrupto: aviso, se aparta como .corrupt y se empieza de cero', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const junk of ['{roto', '', '[1,2]', 'null', '"texto"']) {
    fs.writeFileSync(path.join(dir, 'jefe-state.json'), junk);
    const { lines, log } = logs();
    const s = createStore({ dir, log });
    assert.equal(s.load(), null, `contenido ${JSON.stringify(junk)}`);
    assert.ok(lines.some((l) => /corrupto/.test(l)));
    assert.ok(fs.existsSync(path.join(dir, 'jefe-state.json.corrupt')));
    assert.equal(s.save({ ok: 1 }), true);
    assert.deepEqual(s.load(), { ok: 1 });
    fs.rmSync(path.join(dir, 'jefe-state.json.corrupt'));
  }
});

test('disco no escribible: avisa una sola vez por error, sigue funcionando y avisa al recuperarse', (t) => {
  const base = tmpDir(); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const blocker = path.join(base, 'soy-un-archivo');
  fs.writeFileSync(blocker, 'x');
  const { lines, log } = logs();
  const s = createStore({ dir: path.join(blocker, 'data'), log }); // un archivo como directorio padre: mkdir falla
  assert.doesNotThrow(() => { s.save({ a: 1 }); s.save({ a: 2 }); s.save({ a: 3 }); });
  assert.equal(lines.filter((l) => /se sigue en memoria/.test(l)).length, 1);
  assert.equal(s.status().failures, 3);
  assert.equal(s.load(), null);
  // recuperacion
  let fail = true;
  const fsImpl = { ...fs, writeFileSync: (...a) => { if (fail) throw new Error('EROFS: solo lectura'); return fs.writeFileSync(...a); } };
  const l2 = logs();
  const s2 = createStore({ dir: base, fsImpl, log: l2.log });
  assert.equal(s2.save({ a: 1 }), false);
  fail = false;
  assert.equal(s2.save({ a: 1 }), true);
  assert.ok(l2.lines.some((l) => /recuperada/.test(l)));
});
