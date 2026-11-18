'use strict';
// Persistencia del estado del bridge en DATA_DIR/jefe-state.json.
// Escritura atomica (archivo temporal + rename). JSON corrupto => se aparta como .corrupt y se empieza de cero.
// Si el disco no es escribible: aviso en el log (una vez por error distinto) y se sigue en memoria.
const fs = require('fs');
const path = require('path');
const { silentLogger } = require('./log');

const FILE = 'jefe-state.json';

function createStore({ dir, file = FILE, fsImpl = fs, log = silentLogger(), pid = process.pid } = {}) {
  const target = path.join(dir, file);
  const st = { saves: 0, failures: 0, last_error: null, failing: false };

  function load() {
    let txt;
    try { txt = fsImpl.readFileSync(target, 'utf8'); } catch (e) {
      if (e && e.code !== 'ENOENT') log.warn('no se pudo leer el estado guardado; se empieza de cero', { file: target, err: e.message });
      return null;
    }
    try {
      const o = JSON.parse(txt);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('no es un objeto JSON');
      return o;
    } catch (e) {
      log.warn('estado guardado corrupto: se ignora y se empieza de cero', { file: target, err: e.message });
      try { fsImpl.renameSync(target, `${target}.corrupt`); } catch { /* si no se puede apartar, se sobrescribira al guardar */ }
      return null;
    }
  }

  function save(obj) {
    const tmp = `${target}.${pid}.tmp`;
    try {
      const data = JSON.stringify(obj);
      fsImpl.mkdirSync(dir, { recursive: true });
      fsImpl.writeFileSync(tmp, data, { encoding: 'utf8', flush: true });
      fsImpl.renameSync(tmp, target);
      if (st.failing) log.info('persistencia en disco recuperada', { file: target });
      st.failing = false; st.last_error = null; st.saves++;
      return true;
    } catch (e) {
      try { fsImpl.unlinkSync(tmp); } catch { /* no habia temporal */ }
      const msg = e && e.message ? e.message : String(e);
      if (!st.failing || st.last_error !== msg) log.warn('no se pudo guardar el estado en disco; se sigue en memoria', { file: target, err: msg });
      st.failing = true; st.last_error = msg; st.failures++;
      return false;
    }
  }

  return { load, save, file: target, status: () => ({ file: target, ok: !st.failing, saves: st.saves, failures: st.failures, last_error: st.last_error }) };
}

module.exports = { createStore, FILE };
