import { createScene } from './scene.js';
import { BleLink, errText, RESET_ES } from './ble.js';
import { createBossUI, fitCanvas } from './boss.js';

const $ = (id) => document.getElementById(id);
const DEVICE = 'esp32cam-01';
const store = {
  get: (k, d = '') => { try { return localStorage.getItem('jefe.' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('jefe.' + k, v); } catch { /* sin storage */ } }
};
function mk(tag, props = {}, ...kids) { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; }
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------- Contexto: local (dev) o VPS (https) ----------
const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const IS_HTTPS = location.protocol === 'https:';
let CFG = { mqttHost: '', mqttPort: 1883, tls: false };

// ---------- Estado ----------
const S = {
  ip: store.get('ip'), ipManual: false, dev: {}, tele: {}, ctrl: {}, motion: 0, brightness: 0, haveMotion: false,
  camLive: false, camVia: '', camFps: 6, httpOk: false, lastTele: 0, lastLive: 0, mqttUp: false, lastSnap: 0,
  boss: 'unknown', score: 0, lowSince: 0, bridgeMode: '', bridgeUp: null, srvBoss: null
};

// ---------- Log (sin repetir el mismo mensaje seguido) ----------
let lastLog = '', lastLogAt = 0;
function log(msg, cls = '') {
  const now = Date.now();
  if (msg === lastLog && now - lastLogAt < 5000) return;
  lastLog = msg; lastLogAt = now;
  const box = $('log');
  box.prepend(mk('div', { className: cls, textContent: `${new Date().toLocaleTimeString()}  ${msg}` }));
  while (box.children.length > 40) box.lastChild.remove();
}

// ---------- Toasts (alertas del servidor y avisos importantes) ----------
const RULE_ES = {
  distraido_prolongado: 'Distracción prolongada', ausente_largo: 'Ausencia larga', co2_alto: 'CO₂ alto', temperatura_alta: 'Temperatura alta',
  consumo_alto: 'Consumo alto', puerta_abierta_larga: 'Puerta abierta', movimiento_sospechoso: 'Movimiento sospechoso',
  aire_exterior_malo: 'Aire exterior malo', api_error: 'Error de API', fuente_datos: 'Fuente de datos'
};
const SEV_CLS = { critical: 'bad', warning: 'warn', info: 'info', ok: 'ok' };
function toast(title, body = '', { sev = 'info', meta = '', ttl } = {}) {
  const box = $('toasts');
  const cls = SEV_CLS[sev] || 'info';
  const close = mk('button', { type: 'button', textContent: '×', title: 'Cerrar' });
  close.setAttribute('aria-label', 'Cerrar aviso');
  const el = mk('div', { className: `toast ${cls}` }, mk('i', { ariaHidden: 'true' }), mk('b', { textContent: title }), close);
  if (sev === 'critical') el.setAttribute('role', 'alert');
  if (body) el.append(mk('p', { textContent: body }));
  if (meta) el.append(mk('small', { textContent: meta }));
  let timer = 0, gone = false;
  const remove = () => {
    if (gone) return; gone = true; clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 240);
  };
  const arm = () => { clearTimeout(timer); timer = setTimeout(remove, ttl ?? (sev === 'critical' ? 15000 : sev === 'warning' ? 9000 : 6000)); };
  close.onclick = remove;
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', arm);
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('focusout', arm);
  box.append(el); arm();
  while (box.children.length > 4) box.firstChild.remove();
}
const seenEvents = new Map(); // los eventos de esp32cam-01 llegan por dos suscripciones: deduplicar
function onEvent(j) {
  if (!j || typeof j !== 'object') return;
  const key = `${j.rule}|${j.device}|${j.msg}`, now = Date.now();
  if (now - (seenEvents.get(key) || 0) < 10000) return;
  seenEvents.set(key, now);
  if (seenEvents.size > 50) for (const [k, t] of seenEvents) if (now - t > 60000) seenEvents.delete(k);
  const sev = ['critical', 'warning', 'info'].includes(j.severity) ? j.severity : 'info';
  const title = RULE_ES[j.rule] || j.rule || 'Alerta';
  const dev = DEV_NAMES[j.device]?.[0] || (j.device === DEVICE ? 'ESP32-CAM' : j.device === 'boss' ? 'El jefe' : j.device || '');
  toast(title, j.msg || '', { sev, meta: [dev, new Date().toLocaleTimeString()].filter(Boolean).join(' · ') });
  log(`Alerta ${sev}: ${title}${j.msg ? ' · ' + j.msg : ''}`, sev === 'info' ? '' : sev === 'critical' ? 'e' : 'w');
  bossUI?.notify(sev);
  if (j.rule === 'fuente_datos') { S.bridgeMode = j.value ? 'real' : 'sim'; refreshChips(); }
}

// ---------- Escena ----------
let scene = null;
const QNAMES = ['Ultra', 'Alta', 'Media', 'Eco'];
try {
  scene = createScene($('gl'));
  scene.onStats(({ fps, level, auto }) => {
    $('fps').textContent = `${fps.toFixed(0)} fps`;
    $('fps').title = `Calidad ${QNAMES[level]}${auto ? ' (automática)' : ''}`;
    const autoOpt = $('quality').options[0];
    autoOpt.textContent = auto ? `Auto · ${QNAMES[level]}` : 'Auto';
  });
  scene.onView((v) => document.querySelectorAll('#views button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v))));
} catch (e) {
  scene = null;
  log('WebGL no disponible: ' + e.message, 'e');
  $('gl').hidden = true; $('nogl').hidden = false;
  $('views').hidden = true; $('quality').closest('label').hidden = true; $('fps').hidden = true;
}
$('quality').onchange = (e) => scene?.setQuality(e.target.value === 'auto' ? 'auto' : +e.target.value);
$('views').onclick = (e) => {
  const b = e.target.closest('button[data-view]'); if (!b) return;
  scene?.setView(b.dataset.view);
};

// ---------- Pestanas (movil) ----------
const TABS = [...document.querySelectorAll('#tabs [role=tab]')];
function selectTab(name, focus = false) {
  TABS.forEach((b) => { const on = b.dataset.tab === name; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
  document.body.classList.remove('tab-left', 'tab-right', 'tab-scene');
  document.body.classList.add('tab-' + name);
  store.set('tab', name);
}
TABS.forEach((b, i) => {
  b.onclick = () => selectTab(b.dataset.tab);
  b.onkeydown = (e) => { // flechas entre pestanas (patron WAI-ARIA)
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!d) return;
    e.preventDefault(); selectTab(TABS[(i + d + TABS.length) % TABS.length].dataset.tab, true);
  };
});
selectTab(['left', 'right', 'scene'].includes(store.get('tab')) ? store.get('tab') : 'left');

// ---------- Estado de conexiones: chips + lista detallada ----------
const ble = new BleLink();
const bleUnsupported = BleLink.check();
const fresh = () => Date.now() - S.lastTele < 35000;
let mq = { state: 'idle', retry: 0, timer: 0, nextAt: 0, authFail: false };
function connState() {
  const r = {};
  // Bluetooth
  const bs = ble.state;
  r.ble = bleUnsupported ? ['', 'no disponible en este navegador']
    : bs === 'connected' ? ['ok', `conectado a ${ble.info || 'JefeCAM'}`]
    : bs === 'connecting' ? ['wait', 'conectando...']
    : bs === 'reconnecting' ? ['wait', 'reconectando...']
    : ['', 'sin conectar'];
  // WiFi de la placa (por BLE o por el tópico info)
  const w = S.dev.w, extra = [S.dev.ip, S.dev.rssi ? `${S.dev.rssi} dBm` : ''].filter(Boolean).join(' · ');
  const realTele = fresh() && !S.tele.sim;
  r.wifi = w === 'connected' ? ['ok', `conectada${extra ? ' · ' + extra : ''}`]
    : w === 'connecting' ? ['wait', 'conectando...']
    : w === 'failed' ? ['bad', S.dev.err ? errText(S.dev.err).split('.')[0] : 'falló']
    : realTele ? ['ok', 'conectada (la placa envía datos)']
    : ['', w === 'idle' ? 'sin configurar' : 'sin datos'];
  // Servidor MQTT
  const secs = Math.max(0, Math.ceil((mq.nextAt - Date.now()) / 1000));
  if (S.mqttUp) {
    r.mqtt = realTele ? ['ok', 'conectado · placa transmitiendo']
      : S.tele.sim && fresh() ? ['wait', 'conectado · placa sin datos (simulación)']
      : S.dev.online === false ? ['wait', 'conectado · placa desconectada']
      : ['wait', 'conectado · esperando a la placa'];
    if (S.bridgeUp === false) r.mqtt = ['wait', 'conectado · bridge caído'];
  } else {
    r.mqtt = mq.state === 'login' ? ['', 'falta iniciar sesión']
      : mq.state === 'auth' ? ['bad', 'usuario o clave incorrectos']
      : mq.state === 'connecting' ? ['wait', 'conectando...']
      : mq.state === 'retry' ? ['bad', `sin conexión · reintento en ${secs} s`]
      : mq.state === 'nolib' ? ['bad', 'no cargó la librería MQTT']
      : ['', 'sin conectar'];
  }
  // Camara
  const camBad = S.dev.c === 0 || S.tele.cam_ok === 0;
  r.cam = S.camLive ? ['ok', `en vivo${S.camVia ? ' · vía ' + S.camVia : ''}`]
    : camBad ? ['bad', 'la cámara reporta fallo']
    : S.mqttUp || S.ip ? ['wait', 'esperando imagen...']
    : ['', 'sin imagen'];
  return r;
}
const CHIP_LBL = { ble: 'Bluetooth', wifi: 'WiFi', mqtt: 'Servidor', cam: 'Cámara' };
let lastConn = '';
function refreshChips() {
  const r = connState();
  const sig = JSON.stringify(r);
  if (sig === lastConn) return;
  lastConn = sig;
  for (const k of Object.keys(r)) {
    const [cls, text] = r[k];
    const c = $('chip-' + k);
    c.className = 'chip ' + cls; c.title = `${CHIP_LBL[k]}: ${text}`; c.setAttribute('aria-label', `${CHIP_LBL[k]}: ${text}`);
    const row = document.querySelector(`#conn [data-k=${k}]`);
    row.className = cls; row.querySelector('dd').textContent = text;
  }
}
setInterval(refreshChips, 1000);

// ---------- Bluetooth ----------
const msg = (id, text, cls) => { const el = $(id); el.hidden = !text; el.textContent = text || ''; el.className = 'msg ' + (cls || ''); };
const BLE_HINT = 'Enciende la ESP32-CAM, acércala al PC y pulsa conectar. Aparecerá como JefeCAM.';
if (bleUnsupported) { msg('support', errText(bleUnsupported), 'err'); $('btn-ble').disabled = true; }

$('btn-ble').onclick = () => ble.connect();
$('btn-ble-off').onclick = () => ble.disconnect();
let lastBleState = '';
ble.addEventListener('state', (e) => {
  const { state, info } = e.detail;
  const busy = state === 'connecting' || state === 'reconnecting';
  $('btn-ble').disabled = busy || !!bleUnsupported;
  $('btn-ble').classList.toggle('busy', busy);
  $('btn-ble').textContent = state === 'connecting' ? 'Conectando...' : state === 'reconnecting' ? 'Reconectando...' : 'Conectar por Bluetooth';
  $('btn-ble').hidden = state === 'connected';
  // durante la reconexion tambien se puede cancelar
  $('btn-ble-off').hidden = !(state === 'connected' || state === 'reconnecting');
  $('btn-ble-off').textContent = state === 'reconnecting' ? 'Cancelar' : 'Desconectar';
  $('prov').hidden = state !== 'connected';
  $('ble-info').textContent = state === 'connected' ? `Conectado a ${info || 'JefeCAM'}. Elige la red y envía la configuración.` : (info || BLE_HINT);
  if (state !== lastBleState) {
    lastBleState = state;
    log(`Bluetooth: ${{ off: 'desconectado', connecting: 'conectando', connected: 'conectado', reconnecting: 'reconectando' }[state] || state}${state === 'connected' && info ? ' · ' + info : ''}`);
    if (state === 'connected') $('ssid').focus({ preventScroll: true });
  }
  refreshChips();
});
ble.addEventListener('error', (e) => {
  const code = e.detail.code;
  if (code === 'cancelled') return;
  const t = errText(code);
  log(t, 'e');
  if (ble.state === 'connected') msg('prov-msg', t, 'err');
  else $('ble-info').textContent = t;
  $('prov').hidden = ble.state !== 'connected';
});
ble.addEventListener('info', (e) => { log(e.detail.msg); toast(e.detail.msg, '', { sev: 'ok', ttl: 3500 }); });

let awaiting = null; // { ssid, timer } mientras esperamos el resultado del WiFi
function endAwait() { if (awaiting) clearTimeout(awaiting.timer); awaiting = null; }
ble.addEventListener('status', (e) => {
  const s = e.detail;
  if (!s || typeof s !== 'object') return;
  mergeDev(s);
  if (!awaiting) return;
  if (s.w === 'connected') {
    msg('prov-msg', `Conectada a "${awaiting.ssid}". IP de la placa: ${s.ip || '?'}`, 'ok');
    toast('WiFi configurado', `La placa se conectó a "${awaiting.ssid}".`, { sev: 'ok' });
    endAwait();
  } else if (s.w === 'failed' && s.err) {
    msg('prov-msg', errText(s.err), 'err');
    endAwait();
  } else if (s.err && /^invalid|bad_json/.test(s.err)) {
    msg('prov-msg', errText(s.err), 'err');
    endAwait();
  } else if (s.w === 'connecting') msg('prov-msg', `Conectando a "${awaiting.ssid}"...`, 'info');
});

function mergeDev(s) {
  if (!s || typeof s !== 'object') return;
  Object.assign(S.dev, s);
  if (s.ip) setIp(s.ip, true);
  if (s.rssi) $('m-rssi').textContent = `${s.rssi} dBm`;
  if (s.hp) $('m-heap').textContent = `${Math.round(s.hp / 1024)} KB`;
  if (s.up != null) $('m-up').textContent = fmtUp(s.up);
  const d = [];
  if (RESET_ES[s.rs]) d.push(RESET_ES[s.rs]);
  if (s.err && !['ssid_not_found', 'bad_password', 'timeout', 'link_lost'].includes(s.err)) d.push(errText(s.err));
  msg('diag', d.join(' '), 'warn');
  refreshChips();
}
const fmtUp = (s) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

$('ssid').value = store.get('ssid');
$('muser').value = store.get('muser_dev');
fetch('config.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : {}))
  .then((c) => { if (c && typeof c === 'object') CFG = { ...CFG, ...c }; })
  .catch(() => { /* sin config: valores por defecto */ })
  .finally(applyDefaults);
function applyDefaults() {
  $('mqtt').value = store.get('mqtt') || CFG.mqttHost || '';
  $('port').value = store.get('mport') || CFG.mqttPort || 1883;
  $('mtls').checked = store.get('mtls') ? store.get('mtls') === '1' : !!CFG.tls;
}
$('mtls').onchange = () => { if ($('mtls').checked && +$('port').value === 1883) $('port').value = 443; if (!$('mtls').checked && +$('port').value === 443) $('port').value = 1883; };
$('btn-eye').onclick = () => {
  const p = $('pass'), show = p.type === 'password';
  p.type = show ? 'text' : 'password';
  $('btn-eye').textContent = show ? 'Ocultar' : 'Ver';
  $('btn-eye').setAttribute('aria-pressed', String(show));
  $('btn-eye').setAttribute('aria-label', show ? 'Ocultar clave' : 'Mostrar clave');
};

// Lista de redes: se va llenando mientras la placa escanea
function renderNets(list) {
  const ul = $('nets');
  const best = new Map();
  for (const n of list) if (n?.s && (!best.has(n.s) || best.get(n.s).r < n.r)) best.set(n.s, n);
  const nets = [...best.values()].sort((a, b) => b.r - a.r);
  ul.replaceChildren(...nets.map((n) => {
    const bars = n.r >= -55 ? '▂▄▆█' : n.r >= -67 ? '▂▄▆' : n.r >= -78 ? '▂▄' : '▂';
    const b = mk('button', { type: 'button', title: `${n.s} · ${n.r} dBm${n.e ? ' · protegida' : ' · abierta'}` },
      mk('span', { className: 'nm', textContent: n.s }), mk('small', { textContent: `${n.e ? '🔒 ' : ''}${bars} ${n.r} dBm` }));
    b.setAttribute('aria-pressed', String($('ssid').value === n.s));
    b.onclick = () => {
      $('ssid').value = n.s;
      ul.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      (n.e ? $('pass') : $('mqtt')).focus();
    };
    return mk('li', {}, b);
  }));
  ul.hidden = !nets.length;
  return nets.length;
}
ble.addEventListener('scanpartial', (e) => renderNets(e.detail.list));
$('btn-scan').onclick = async () => {
  const btn = $('btn-scan');
  btn.disabled = true; btn.textContent = 'Buscando...'; btn.classList.add('busy');
  msg('prov-msg', 'Buscando redes (unos segundos)...', 'info');
  try {
    const list = await ble.scan();
    if (!renderNets(list)) msg('prov-msg', 'No se encontraron redes 2.4 GHz. Acerca la placa al router y reintenta.', 'warn');
    else msg('prov-msg', '', '');
  } finally {
    btn.disabled = false; btn.textContent = 'Buscar redes'; btn.classList.remove('busy');
  }
};

$('btn-send').onclick = async () => {
  const ssid = $('ssid').value.trim(), pass = $('pass').value, host = $('mqtt').value.trim(), port = Math.round(+$('port').value) || 1883;
  const bad = (id, text) => { msg('prov-msg', text, 'err'); const el = $(id); el.setAttribute('aria-invalid', 'true'); el.focus(); el.addEventListener('input', () => el.removeAttribute('aria-invalid'), { once: true }); };
  if (!ssid || ssid.length > 32) return bad('ssid', errText('invalid_ssid'));
  if (pass && (pass.length < 8 || pass.length > 63)) return bad('pass', errText('invalid_pass'));
  if (!host) return bad('mqtt', 'Falta el servidor MQTT (dominio del VPS o IP del PC).');
  if (!/^[\w.-]+$/.test(host)) return bad('mqtt', errText('invalid_mqtt'));
  if (port < 1 || port > 65535) return bad('port', errText('invalid_port'));
  const user = $('muser').value.trim(), mpass = $('mpass').value, tls = $('mtls').checked;
  if (tls && !user) return bad('muser', 'Con TLS necesitas usuario y clave MQTT de la placa.');
  store.set('ssid', ssid); store.set('mqtt', host); store.set('mport', port); store.set('mtls', tls ? '1' : '0'); store.set('muser_dev', user);
  const btn = $('btn-send');
  btn.disabled = true; btn.classList.add('busy');
  msg('prov-msg', 'Enviando configuración...', 'info');
  endAwait();
  awaiting = { ssid, timer: 0 };
  const ok = await ble.sendConfig({ ssid, pass, mqtt: host, port, user, mpass, tls });
  btn.disabled = false; btn.classList.remove('busy');
  if (!ok) { endAwait(); return; }
  $('pass').value = ''; $('mpass').value = '';
  if (!awaiting) return; // el resultado ya llego por notificacion
  msg('prov-msg', `Configuración enviada. Conectando a "${ssid}"...`, 'info');
  awaiting.timer = setTimeout(() => {
    if (awaiting) { msg('prov-msg', 'La placa tarda en responder. Si no conecta, revisa la clave y que la red sea de 2.4 GHz.', 'warn'); awaiting = null; }
  }, 35000);
};

// Botones peligrosos: piden confirmacion con un segundo clic
function confirmClick(b, run) {
  if (b.dataset.armed === '1') { clearTimeout(+b.dataset.t); b.dataset.armed = ''; b.textContent = b.dataset.label; b.classList.remove('armed'); return run(); }
  b.dataset.armed = '1'; b.dataset.label = b.textContent; b.textContent = '¿Seguro? Pulsa otra vez'; b.classList.add('armed');
  b.dataset.t = setTimeout(() => { b.dataset.armed = ''; b.textContent = b.dataset.label; b.classList.remove('armed'); }, 4000);
}
document.querySelectorAll('[data-cmd]').forEach((b) => (b.onclick = () => {
  const run = async () => { b.disabled = true; try { if (await ble.command(b.dataset.cmd)) log(`Comando enviado: ${b.dataset.cmd}`); } finally { b.disabled = false; } };
  if (b.dataset.confirm) confirmClick(b, run); else run();
}));

// ---------- IP de la camara ----------
let camFails = 0, camTimer = 0; // declarados aqui: setIp() los usa al arrancar con ?ip=
function setIp(ip, auto = false) {
  if (!/^[\w.-]+(:\d+)?$/.test(ip)) return false;
  if (auto && S.ipManual) return false;
  if (S.ip !== ip) { S.ip = ip; store.set('ip', ip); $('ip').value = ip; log(`Cámara en ${ip}`); camFails = 0; camNext(0); }
  return true;
}
$('ip').value = S.ip;
const qip = new URLSearchParams(location.search).get('ip');
if (qip) { S.ipManual = true; S.ip = ''; setIp(qip); }
$('btn-ip').onclick = () => {
  const v = $('ip').value.trim(); if (!v) return;
  S.ipManual = true; S.ip = '';
  if (!setIp(v)) { $('ip').setAttribute('aria-invalid', 'true'); log('IP no válida', 'e'); } else $('ip').removeAttribute('aria-invalid');
};
$('ip').onkeydown = (e) => { if (e.key === 'Enter') $('btn-ip').click(); };

// ---------- MQTT (reconexion propia con backoff exponencial y jitter) ----------
let client = null;
const mqttUrl = () => (IS_LOCAL ? `ws://${location.hostname}:9001` : `${IS_HTTPS ? 'wss' : 'ws'}://${location.host}/mqtt`);
const setMq = (state) => { mq.state = state; refreshChips(); updateRemote(); };
function showLogin(text) {
  $('mq-login').hidden = false;
  $('mq-user').value = store.get('muser');
  const m = $('mq-msg'); m.textContent = text || 'Entra con el usuario del panel para ver los datos y la cámara.'; m.className = 'msg ' + (text ? 'err' : 'info');
  selectTab('left');
  ($('mq-user').value ? $('mq-pass') : $('mq-user')).focus({ preventScroll: true });
}
$('mq-login').onsubmit = (e) => {
  e.preventDefault();
  const user = $('mq-user').value.trim(); if (!user) { $('mq-user').focus(); return; }
  store.set('muser', user); store.set('mpass', $('mq-pass').value);
  $('mq-pass').value = ''; $('mq-login').hidden = true; startMqtt();
};
function stopMqtt() {
  clearTimeout(mq.timer);
  const c = client; client = null;
  if (c) { c.removeAllListeners?.(); c.on?.('error', () => {}); c.end(true); }
  S.mqttUp = false;
}
function startMqtt() {
  if (typeof mqtt === 'undefined') { log('mqtt.js no cargó', 'e'); setMq('nolib'); return; }
  stopMqtt();
  const user = store.get('muser'), pass = store.get('mpass');
  if (!IS_LOCAL && !user) { setMq('login'); showLogin(); return; }
  mq.authFail = false; mq.retry = 0;
  setMq('connecting');
  let c;
  try {
    c = client = mqtt.connect(mqttUrl(), {
      username: user || undefined, password: pass || undefined,
      clientId: 'panel-' + Math.random().toString(16).slice(2, 10),
      reconnectPeriod: 0, // la reconexion la maneja scheduleReconnect() con backoff
      connectTimeout: 8000, keepalive: 30, clean: true
    });
  } catch (e) { log('MQTT: ' + e.message, 'e'); scheduleReconnect(); return; }
  c.on('connect', () => {
    if (c !== client) return;
    mq.retry = 0; S.mqttUp = true; setMq('up');
    log('Servidor MQTT conectado');
    c.subscribe([`jefe/${DEVICE}/#`, 'jefe/+/state', 'jefe/+/event', 'jefe/boss/telemetry', 'jefe/bridge/mode', 'jefe/bridge/status'], (err) => { if (err) log('MQTT: suscripción rechazada', 'e'); });
    requestStream(true);
    renderDevs();
  });
  c.on('close', () => {
    if (c !== client) return;
    const was = S.mqttUp; S.mqttUp = false;
    if (was) { log('Servidor MQTT desconectado, reintentando...', 'w'); toast('Sin conexión al servidor', 'Reintentando automáticamente.', { sev: 'warning', ttl: 5000 }); }
    if (mq.authFail) return;
    scheduleReconnect();
    renderDevs();
  });
  c.on('error', (err) => {
    if (c !== client) return;
    if (err?.code === 4 || err?.code === 5 || /Bad user|Not authorized|identifier/i.test(err?.message || '')) {
      mq.authFail = true; clearTimeout(mq.timer);
      c.end(true); S.mqttUp = false; store.set('mpass', '');
      setMq('auth'); showLogin('Usuario o clave incorrectos.'); log('MQTT: credenciales rechazadas', 'e');
    }
  });
  c.on('message', onMessage);
}
function scheduleReconnect() {
  clearTimeout(mq.timer);
  const base = Math.min(30000, 1000 * 2 ** mq.retry);
  const d = Math.round(base * (0.8 + Math.random() * 0.4));
  mq.retry = Math.min(mq.retry + 1, 6);
  mq.nextAt = Date.now() + d;
  setMq('retry');
  mq.timer = setTimeout(reconnectNow, d);
}
function reconnectNow() {
  if (!client || client.connected || mq.authFail) return;
  clearTimeout(mq.timer);
  setMq('connecting');
  try { client.reconnect(); } catch { scheduleReconnect(); }
}
// al volver la red o la pestana, reintentar ya en vez de esperar al backoff
window.addEventListener('online', () => { mq.retry = 0; reconnectNow(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (client && !client.connected && mq.state === 'retry') reconnectNow();
  requestStream(true);
});

function onMessage(topic, buf) {
  const [, id, t] = topic.split('/');
  if (t === 'snap') { if (id === DEVICE) onSnap(buf); return; }
  const raw = buf.toString();
  let j; try { j = JSON.parse(raw); } catch { j = raw; }
  if (id === 'bridge') {
    if (t === 'mode') S.bridgeMode = raw;
    else if (t === 'status') { const up = raw === 'online'; if (S.bridgeUp === true && !up) toast('Bridge desconectado', 'El servidor de lógica no responde: sin alertas ni gemelos.', { sev: 'warning' }); S.bridgeUp = up; }
    refreshChips(); return;
  }
  if (t === 'event') return onEvent(j);
  if (id === 'boss' && t === 'telemetry') return onServerBoss(j);
  if (t === 'state' && id !== DEVICE) { if (j && typeof j === 'object') onDevState(id, j); return; }
  if (id !== DEVICE) return;
  if (t === 'telemetry') { if (j && typeof j === 'object') onTelemetry(j); }
  else if (t === 'live') { if (j && typeof j === 'object') onLive(j); }
  else if (t === 'info') mergeDev(j);
  else if (t === 'state') { if (j && typeof j === 'object') onState(j); }
  else if (t === 'status') {
    const online = j === 'online';
    if (S.dev.online !== online) log(`Placa ${online ? 'en línea' : 'fuera de línea'}`, online ? '' : 'w');
    S.dev.online = online; refreshChips();
  }
}

// La imagen viaja por MQTT en https (el navegador bloquea pedirla a la IP local), sin IP conocida
// o si la IP local no responde.
const camViaMqtt = () => IS_HTTPS || !S.ip || camFails >= 3;
const sendStreamReq = () => {
  if (!client?.connected || document.hidden || !camViaMqtt()) return;
  client.publish(`jefe/${DEVICE}/cmd`, JSON.stringify({ stream: 30, snap_ms: Math.max(250, Math.round(1000 / S.camFps)) }));
};
const sendStreamSoon = debounce(sendStreamReq, 400);
function requestStream(now = false) { if (now) sendStreamReq(); else sendStreamSoon(); }
setInterval(sendStreamReq, 15000);
let snapBusy = false;
async function onSnap(buf) {
  if (snapBusy || document.hidden) return; // descartar cuadros si el navegador va atrasado
  snapBusy = true;
  try {
    const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
    try { scene?.setCameraImage(bmp); } finally { bmp.close(); }
    S.lastSnap = Date.now(); S.camVia = 'MQTT'; setCamLive(true);
  } catch { /* cuadro corrupto */ } finally { snapBusy = false; }
}
function onLive(j) { S.haveMotion = true; S.motion = +j.motion || 0; S.brightness = +j.brightness || 0; S.httpOk = true; S.lastLive = Date.now(); }
function onTelemetry(j) {
  S.lastTele = Date.now(); S.tele = j;
  if (!S.httpOk && typeof j.motion === 'number') { S.motion = j.motion; S.brightness = +j.brightness || S.brightness; S.haveMotion = true; }
  if (typeof j.chip_temp === 'number') $('m-temp').textContent = `${j.chip_temp.toFixed(0)} °C`;
  if (j.rssi) $('m-rssi').textContent = `${j.rssi} dBm`;
  if (j.heap) $('m-heap').textContent = `${Math.round(j.heap / 1024)} KB`;
  if (j.uptime_s != null) $('m-up').textContent = fmtUp(j.uptime_s);
  $('sim-badge').hidden = !j.sim;
  refreshChips();
}
function onState(j) {
  S.ctrl = j;
  const active = document.activeElement;
  $('c-flash').checked = !!j.flash; $('c-enabled').checked = !!j.enabled;
  // no mover un deslizador que el usuario esta arrastrando
  if (j.gain != null && active !== $('c-gain')) { $('c-gain').value = j.gain; $('o-gain').textContent = (+j.gain).toFixed(1); }
  if (j.interval_ms && active !== $('c-int')) { $('c-int').value = j.interval_ms / 1000; $('o-int').textContent = `${Math.round(j.interval_ms / 1000)} s`; }
  if (j.quality && active !== $('c-q')) { $('c-q').value = j.quality; $('o-q').textContent = j.quality; }
  scene?.update({ flash: !!j.flash });
}
function onServerBoss(j) {
  if (!j || typeof j !== 'object' || typeof j.score !== 'number') return;
  // al abrir el panel, partir del puntaje oficial en vez de 0 (antes ambos numeros no coincidian durante minutos)
  if (!S.srvBoss) S.score = Math.max(0, Math.min(100, j.score));
  S.srvBoss = j;
  const name = { 1: 'enfocado', 2: 'distraído', 3: 'ausente' }[j.state] || '—';
  const el = $('srv-boss'); el.hidden = false;
  el.textContent = `Servidor: ${name} · puntaje ${Math.round(j.score)}${j.focus_pct != null ? ` · ${Math.round(j.focus_pct)}% enfoque` : ''}${j.sim ? ' (simulado)' : ''}`;
}
function pub(obj) {
  if (client?.connected) { client.publish(`jefe/${DEVICE}/cmd`, JSON.stringify(obj)); return true; }
  log('Sin conexión al servidor: no se pudo enviar el comando', 'e'); return false;
}
function updateRemote() {
  const up = S.mqttUp;
  $('remote').disabled = !up;
  $('remote-hint').hidden = up;
}
$('c-flash').onchange = (e) => pub({ flash: e.target.checked });
$('c-enabled').onchange = (e) => pub({ enabled: e.target.checked });
const bindRange = (id, out, fmt, key, conv = (v) => v) => {
  const send = debounce((v) => pub({ [key]: conv(v) }));
  $(id).oninput = (e) => { $(out).textContent = fmt(+e.target.value); send(+e.target.value); };
};
bindRange('c-gain', 'o-gain', (v) => v.toFixed(1), 'gain');
bindRange('c-int', 'o-int', (v) => `${v} s`, 'interval_ms', (v) => v * 1000);
bindRange('c-q', 'o-q', (v) => v, 'quality');
$('c-fps').value = S.camFps = Math.min(15, Math.max(1, +store.get('camfps', '6') || 6));
$('o-fps').textContent = S.camFps;
$('c-fps').oninput = (e) => { S.camFps = +e.target.value; $('o-fps').textContent = e.target.value; store.set('camfps', S.camFps); requestStream(); };
$('btn-reboot').onclick = () => confirmClick($('btn-reboot'), () => { if (pub({ reboot: true })) log('Reinicio de la placa solicitado', 'w'); });

// ---------- Dispositivos del servidor (gemelos, APIs, datasets): retroceso ----------
const DEV_NAMES = {
  'cam-sala-twin': ['Cámara virtual de la sala', 'Digital Twin'], 'termostato-twin': ['Termostato', 'Digital Twin'], 'enchufe-twin': ['Enchufe inteligente', 'Digital Twin'],
  'puerta-twin': ['Puerta, ventana y PIR', 'Digital Twin'], 'luz-twin': ['Luz inteligente', 'Digital Twin'],
  'api-azure-weather': ['Azure Maps Weather', 'API'], 'api-openmeteo-aq': ['Calidad del aire (Open-Meteo)', 'API'],
  'ds-energia': ['Consumo del hogar', 'Dataset'], 'ds-co2': ['CO₂ interior', 'Dataset'], 'ds-ocupacion': ['Ocupación', 'Dataset']
};
const DEVS = {};
const sendDev = (id, obj) => {
  if (client?.connected) { client.publish(`jefe/${id}/cmd`, JSON.stringify(obj)); log(`Comando a ${id}: ${JSON.stringify(obj)}`); return true; }
  log('Sin conexión al servidor: comando no enviado', 'e'); return false;
};
function onDevState(id, st) { if (!DEV_NAMES[id]) return; DEVS[id] = st; renderDevs(); }
let devsPending = false;
function renderDevs() {
  const box = $('devs');
  // no redibujar mientras el usuario edita un campo de la lista (perdia el foco y lo escrito)
  if (box.contains(document.activeElement) && document.activeElement.matches('input[type=number]')) {
    if (!devsPending) { devsPending = true; document.activeElement.addEventListener('blur', () => { devsPending = false; setTimeout(renderDevs, 0); }, { once: true }); }
    return;
  }
  const rows = [];
  for (const id of Object.keys(DEV_NAMES)) {
    const st = DEVS[id]; if (!st) continue;
    const [name, kind] = DEV_NAMES[id];
    const tg = mk('input', { type: 'checkbox', checked: !!st.enabled, title: 'Encender / apagar', disabled: !S.mqttUp });
    tg.setAttribute('aria-label', `${name}: encender o apagar`);
    tg.onchange = () => { if (!sendDev(id, { enabled: tg.checked })) tg.checked = !tg.checked; };
    const ex = mk('div', { className: 'ex' });
    const num = (label, key, min, max, step, send) => {
      const i = mk('input', { type: 'number', value: st[key] ?? '', min, max, step, disabled: !S.mqttUp });
      i.onchange = () => {
        const v = +i.value;
        if (i.value === '' || !Number.isFinite(v)) { i.value = st[key] ?? ''; return; }
        const c = Math.min(max, Math.max(min, v)); i.value = c;
        sendDev(id, send(c));
      };
      ex.append(mk('label', {}, label, i));
    };
    const btn = (label, obj) => { const b = mk('button', { type: 'button', textContent: label, disabled: !S.mqttUp }); b.onclick = () => sendDev(id, obj); ex.append(b); };
    num('cada (s)', 'interval_s', kind === 'API' ? 60 : 1, 3600, 1, (v) => ({ interval_s: v }));
    if (id === 'termostato-twin') num('setpoint °C', 'setpoint', 10, 30, 0.5, (v) => ({ setpoint: v }));
    if (id === 'enchufe-twin') btn(st.relay ? 'Apagar relé' : 'Encender relé', { relay: !st.relay });
    if (id === 'luz-twin') { btn('Encender', { on: true }); btn('Apagar', { on: false }); btn('Auto', { mode: 'auto' }); }
    if (id === 'puerta-twin') { btn('Abrir puerta', { door: true }); btn('Cerrar', { door: false }); }
    if (id === 'cam-sala-twin') num('ganancia', 'gain', 0.5, 12, 0.5, (v) => ({ gain: v }));
    if (kind === 'Dataset') btn('Reiniciar', { rewind: true });
    rows.push(mk('div', { className: 'dev' + (st.enabled ? '' : ' off') }, mk('div', { className: 'nm' }, name, mk('small', { textContent: `${kind} · ${id}` })), tg, ex));
  }
  if (!rows.length) rows.push(mk('p', { className: 'empty', textContent: S.mqttUp ? 'Esperando el estado de los dispositivos del servidor...' : mq.state === 'login' || mq.state === 'auth' ? 'Inicia sesión para ver los dispositivos.' : 'Sin conexión al servidor. Reintentando...' }));
  box.replaceChildren(...rows);
}

// ---------- Imagen de la camara por HTTP (solo LAN, nunca sale a internet) ----------
const img = new Image(); img.crossOrigin = 'anonymous';
function setCamLive(v) {
  if (S.camLive !== v) { S.camLive = v; log(v ? `Imagen de la cámara en vivo (${S.camVia})` : 'Sin imagen de la cámara', v ? '' : 'w'); }
  scene?.update({ camLive: v }); refreshChips();
}
function camNext(ms) { clearTimeout(camTimer); camTimer = setTimeout(camTick, ms); }
function camTick() {
  if (document.hidden) return camNext(1000);
  const snapFresh = Date.now() - S.lastSnap < 6000;
  if (IS_HTTPS || !S.ip) { setCamLive(snapFresh); return camNext(1500); }
  const t0 = performance.now(); let settled = false;
  const fail = () => {
    camFails++;
    if (camFails === 3) { log('La cámara no responde en la red local: pido la imagen por MQTT', 'w'); requestStream(true); }
    if (camFails >= 3) setCamLive(Date.now() - S.lastSnap < 6000);
    camNext(Math.min(8000, 400 * 2 ** Math.min(camFails, 5)));
  };
  const guard = setTimeout(() => { if (!settled) { settled = true; img.onload = img.onerror = null; img.src = ''; fail(); } }, 4000);
  img.onload = () => { if (settled) return; settled = true; clearTimeout(guard); camFails = 0; S.camVia = 'red local'; scene?.setCameraImage(img); setCamLive(true); camNext(Math.max(0, 1000 / S.camFps - (performance.now() - t0))); };
  img.onerror = () => { if (settled) return; settled = true; clearTimeout(guard); fail(); };
  img.src = `http://${S.ip}/snapshot?t=${Date.now()}`;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) camNext(0); });

// ---------- Info HTTP (movimiento a 1 Hz, solo en la LAN) ----------
let infoBusy = false;
setInterval(async () => {
  if (IS_HTTPS || !S.ip || document.hidden || infoBusy) return;
  infoBusy = true;
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 2000);
  try {
    const r = await fetch(`http://${S.ip}/info`, { signal: ctl.signal, cache: 'no-store' });
    const j = await r.json();
    S.httpOk = true; S.haveMotion = true; S.motion = +j.motion || 0; S.brightness = +j.brightness || 0; S.lastLive = Date.now(); mergeDev(j);
  } catch { S.httpOk = false; } finally { clearTimeout(to); infoBusy = false; }
}, 1000);

// ---------- Logica del jefe (local, para reaccionar al instante; el calculo oficial esta en el bridge) ----------
const LABEL = { focused: 'ENFOCADO', distracted: 'DISTRAÍDO', absent: 'AUSENTE', unknown: 'SIN DATOS' };
const COLOR = { focused: '#19ffa0', distracted: '#ff3355', absent: '#4a7dff', unknown: '#8892a8' };
let mAvg = 0;
const bossUI = createBossUI($, scene, log);
const ago = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h`; };
setInterval(() => {
  const now = Date.now();
  if (now - S.lastLive > 10000) S.httpOk = false; // sin 'live' ni /info, el movimiento viene de la telemetria
  let st = S.boss;
  if (!S.haveMotion || (!S.httpOk && now - S.lastTele > 40000)) st = 'unknown';
  else {
    mAvg = mAvg * 0.7 + S.motion * 0.3;
    if (mAvg < 1.2) { S.lowSince ||= now; if (now - S.lowSince > 20000) st = 'absent'; else if (st === 'unknown') st = 'focused'; }
    else { S.lowSince = 0; st = mAvg > 12 ? 'distracted' : 'focused'; }
  }
  if (st !== S.boss) { S.boss = st; log(`El jefe: ${LABEL[st]}`); }
  const target = { focused: 100, distracted: 0, absent: 50, unknown: S.score }[st];
  S.score += (target - S.score) * 0.03;
  const score = Math.round(S.score);
  const bs = $('boss-state'); bs.textContent = LABEL[st]; bs.dataset.st = st;
  $('score-num').textContent = score; $('score-bar').style.width = `${S.score}%`; $('score-bar').style.background = COLOR[st];
  $('score-pb').setAttribute('aria-valuenow', score);
  $('m-motion').textContent = S.haveMotion ? S.motion.toFixed(1) : '--';
  $('m-bright').textContent = S.haveMotion ? S.brightness.toFixed(0) : '--';
  $('tele-age').textContent = S.lastTele ? `Última telemetría hace ${ago(now - S.lastTele)}${S.tele.sim ? ' (simulada por el servidor)' : ''}.` : S.mqttUp ? 'Esperando telemetría de la placa...' : 'Sin telemetría: conecta con el servidor.';
  document.title = st === 'unknown' ? 'Jefe IoT' : `${LABEL[st]} ${score} · Jefe IoT`;
  scene?.update({ motion: S.haveMotion ? S.motion : 0, mood: st, score: S.score });
  pushSpark(S.haveMotion ? S.motion : 0);
  bossUI.tick(st);
}, 1000);

// ---------- Sparkline de movimiento ----------
const hist = [];
function pushSpark(v) {
  hist.push(v); if (hist.length > 150) hist.shift();
  const c = fitCanvas($('spark')); if (!c) return;
  const { ctx, w, h } = c;
  ctx.strokeStyle = 'rgba(134,150,187,.18)'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
  const yT = h - 4 - (12 / 40) * (h - 8); // umbral de distraccion
  ctx.beginPath(); ctx.moveTo(0, yT); ctx.lineTo(w, yT); ctx.stroke(); ctx.setLineDash([]);
  if (hist.length < 2) return;
  ctx.strokeStyle = COLOR[S.boss]; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.beginPath();
  hist.forEach((y, i) => { const px = (i / 149) * w, py = h - 4 - (Math.min(y, 40) / 40) * (h - 8); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.stroke();
}

// ---------- Enlace a Grafana (dashboard con todas las graficas) ----------
$('lnk-graf').href = IS_LOCAL ? `http://${location.hostname}:3000/d/jefe-iot` : `${location.protocol}//grafana.${location.host}/d/jefe-iot`;

// ---------- Arranque ----------
updateRemote();
renderDevs();
startMqtt();
camTick();
refreshChips();
log('Panel listo');
