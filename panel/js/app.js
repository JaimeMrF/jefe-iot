import { createScene } from './scene.js';
import { BleLink, errText, RESET_ES } from './ble.js';

const $ = (id) => document.getElementById(id);
const DEVICE = 'esp32cam-01';
const store = {
  get: (k, d = '') => { try { return localStorage.getItem('jefe.' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('jefe.' + k, v); } catch { /* sin storage */ } }
};

// ---------- Contexto: local (dev) o VPS (https) ----------
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const IS_HTTPS = location.protocol === 'https:';
let CFG = { mqttHost: '', mqttPort: 1883, tls: false };

// ---------- Estado ----------
const S = {
  ip: store.get('ip'), dev: {}, tele: {}, ctrl: {}, motion: 0, brightness: 0, haveMotion: false,
  camLive: false, camFps: 6, httpOk: false, lastTele: 0, mqttUp: false, lastSnap: 0,
  boss: 'unknown', score: 0, lowSince: 0, lastInfo: 0
};

// ---------- Log ----------
function log(msg, cls = '') {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  $('log').prepend(d);
  while ($('log').children.length > 30) $('log').lastChild.remove();
}

// ---------- Escena ----------
let scene = null;
try {
  scene = createScene($('gl'));
  scene.onStats(({ fps, level, auto }) => { $('fps').textContent = `${fps.toFixed(0)} fps · ${['Ultra', 'Alta', 'Media', 'Eco'][level]}${auto ? ' (auto)' : ''}`; });
} catch (e) {
  log('WebGL no disponible: ' + e.message, 'e');
  $('gl').style.background = '#04060c';
}
$('quality').onchange = (e) => scene?.setQuality(e.target.value === 'auto' ? 'auto' : +e.target.value);
$('views').onclick = (e) => {
  const v = e.target.dataset?.view; if (!v) return;
  scene?.setView(v);
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b === e.target));
};
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('left').classList.toggle('show', b.dataset.tab === 'left');
  $('right').classList.toggle('show', b.dataset.tab === 'right');
}));
$('left').classList.add('show');

// ---------- Chips ----------
const setChip = (id, cls, title = '') => { const c = $('chip-' + id); c.className = 'chip ' + cls; c.title = title; };
function refreshChips() {
  const bs = ble.state;
  setChip('ble', bs === 'connected' ? 'ok' : bs === 'off' ? '' : 'wait', bs);
  const w = S.dev.w;
  setChip('wifi', w === 'connected' ? 'ok' : w === 'connecting' ? 'wait' : w === 'failed' ? 'bad' : '', w || '');
  const fresh = Date.now() - S.lastTele < 35000;
  setChip('mqtt', S.mqttUp && (fresh || S.dev.m) ? 'ok' : S.mqttUp ? 'wait' : 'bad', S.mqttUp ? 'broker OK' : 'sin broker');
  setChip('cam', S.camLive ? 'ok' : S.ip ? 'wait' : '', S.camLive ? 'imagen en vivo' : 'sin imagen');
}
setInterval(refreshChips, 1500);

// ---------- Bluetooth ----------
const ble = new BleLink();
const msg = (id, text, cls) => { const el = $(id); el.hidden = !text; el.textContent = text || ''; el.className = 'msg ' + (cls || ''); };
const bad = BleLink.check();
if (bad) { msg('support', errText(bad), 'err'); $('btn-ble').disabled = true; }

$('btn-ble').onclick = () => ble.connect();
$('btn-ble-off').onclick = () => ble.disconnect();
ble.addEventListener('state', (e) => {
  const { state, info } = e.detail;
  $('btn-ble').disabled = state === 'connecting' || state === 'reconnecting' || !!BleLink.check();
  $('btn-ble').textContent = state === 'connecting' ? 'Conectando...' : state === 'reconnecting' ? 'Reconectando...' : 'Conectar por Bluetooth';
  $('btn-ble').hidden = state === 'connected';
  $('btn-ble-off').hidden = state !== 'connected';
  $('prov').hidden = state !== 'connected';
  $('ble-info').textContent = state === 'connected' ? `Conectado a ${info || 'JefeCAM'}.` : (info || 'Enciende la ESP32-CAM, acércala al PC y pulsa conectar. Aparecerá como JefeCAM.');
  log(`Bluetooth: ${state}${info ? ' · ' + info : ''}`);
  refreshChips();
});
ble.addEventListener('error', (e) => {
  const t = errText(e.detail.code);
  if (e.detail.code !== 'cancelled') { msg('prov-msg', t, 'err'); log(t, 'e'); }
  $('prov').hidden = ble.state !== 'connected';
  if (ble.state !== 'connected' && e.detail.code !== 'cancelled') $('ble-info').textContent = t;
});
ble.addEventListener('info', (e) => log(e.detail.msg));

let awaiting = null; // { ssid } mientras esperamos el resultado del WiFi
ble.addEventListener('status', (e) => {
  const s = e.detail;
  mergeDev(s);
  if (!awaiting) return;
  if (s.w === 'connected') {
    msg('prov-msg', `Conectada a "${awaiting.ssid}". IP de la placa: ${s.ip}`, 'ok');
    awaiting = null;
  } else if (s.w === 'failed' && s.err) {
    msg('prov-msg', errText(s.err), 'err');
    awaiting = null;
  } else if (s.err && /^invalid|bad_json/.test(s.err)) {
    msg('prov-msg', errText(s.err), 'err');
    awaiting = null;
  } else if (s.w === 'connecting') msg('prov-msg', `Conectando a "${awaiting.ssid}"...`, 'info');
});

function mergeDev(s) {
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
const fmtUp = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

$('ssid').value = store.get('ssid');
$('muser').value = store.get('muser_dev');
fetch('config.json', { cache: 'no-store' }).then((r) => r.json()).then((c) => { CFG = { ...CFG, ...c }; applyDefaults(); }).catch(applyDefaults);
function applyDefaults() {
  $('mqtt').value = store.get('mqtt') || CFG.mqttHost || '';
  $('port').value = store.get('mport') || CFG.mqttPort || 1883;
  $('mtls').checked = store.get('mtls') ? store.get('mtls') === '1' : !!CFG.tls;
}
$('mtls').onchange = () => { if ($('mtls').checked && +$('port').value === 1883) $('port').value = 443; if (!$('mtls').checked && +$('port').value === 443) $('port').value = 1883; };
$('btn-eye').onclick = () => { const p = $('pass'); const show = p.type === 'password'; p.type = show ? 'text' : 'password'; $('btn-eye').textContent = show ? 'Ocultar' : 'Ver'; };

$('btn-scan').onclick = async () => {
  $('btn-scan').disabled = true; $('btn-scan').textContent = 'Buscando...';
  msg('prov-msg', 'Buscando redes (unos segundos)...', 'info');
  const list = await ble.scan();
  $('btn-scan').disabled = false; $('btn-scan').textContent = 'Buscar redes';
  const ul = $('nets'); ul.replaceChildren();
  if (!list.length) { msg('prov-msg', 'No se encontraron redes 2.4 GHz. Acerca la placa al router y reintenta.', 'warn'); ul.hidden = true; return; }
  msg('prov-msg', '', '');
  for (const n of list) {
    const li = document.createElement('li');
    const a = document.createElement('span'); a.textContent = n.s;
    const b = document.createElement('small'); b.textContent = `${n.e ? '🔒 ' : ''}${n.r} dBm`;
    li.append(a, b);
    li.onclick = () => { $('ssid').value = n.s; $('pass').focus(); };
    ul.append(li);
  }
  ul.hidden = false;
};

$('btn-send').onclick = async () => {
  const ssid = $('ssid').value.trim(), pass = $('pass').value, host = $('mqtt').value.trim(), port = +$('port').value || 1883;
  if (!ssid) return msg('prov-msg', errText('invalid_ssid'), 'err');
  if (pass && (pass.length < 8 || pass.length > 63)) return msg('prov-msg', errText('invalid_pass'), 'err');
  if (!host) return msg('prov-msg', 'Falta el servidor MQTT (dominio del VPS o IP del PC).', 'err');
  const user = $('muser').value.trim(), mpass = $('mpass').value, tls = $('mtls').checked;
  if (tls && !user) return msg('prov-msg', 'Con TLS necesitas usuario y clave MQTT de la placa.', 'err');
  store.set('ssid', ssid); store.set('mqtt', host); store.set('mport', port); store.set('mtls', tls ? '1' : '0'); store.set('muser_dev', user);
  $('btn-send').disabled = true;
  msg('prov-msg', 'Enviando configuración...', 'info');
  awaiting = { ssid };
  const ok = await ble.sendConfig({ ssid, pass, mqtt: host, port, user, mpass, tls });
  $('btn-send').disabled = false;
  if (!ok) { awaiting = null; return; }
  $('pass').value = ''; $('mpass').value = '';
  msg('prov-msg', `Configuración enviada. Conectando a "${ssid}"...`, 'info');
  setTimeout(() => { if (awaiting) { msg('prov-msg', 'La placa tarda en responder. Si no conecta, revisa clave y que la red sea 2.4 GHz.', 'warn'); awaiting = null; } }, 35000);
};

document.querySelectorAll('[data-cmd]').forEach((b) => (b.onclick = async () => {
  const c = b.dataset.cmd;
  if (c === 'factory' && b.dataset.armed !== '1') {
    b.dataset.armed = '1'; const t = b.textContent; b.textContent = '¿Seguro? Pulsa otra vez';
    setTimeout(() => { b.dataset.armed = ''; b.textContent = t; }, 4000); return;
  }
  b.dataset.armed = '';
  if (await ble.command(c)) log(`Comando enviado: ${c}`);
}));

// ---------- IP de la camara ----------
function setIp(ip, auto = false) {
  if (!/^[\w.-]+(:\d+)?$/.test(ip)) return;
  if (auto && S.ipManual) return;
  if (S.ip !== ip) { S.ip = ip; store.set('ip', ip); $('ip').value = ip; log(`Cámara en ${ip}`); }
}
$('ip').value = S.ip;
const qip = new URLSearchParams(location.search).get('ip');
if (qip) { S.ipManual = true; S.ip = ''; setIp(qip); }
$('btn-ip').onclick = () => { const v = $('ip').value.trim(); if (v) { S.ipManual = true; S.ip = ''; setIp(v); } };

// ---------- MQTT ----------
let client = null;
const mqttUrl = () => (IS_LOCAL ? `ws://${location.hostname}:9001` : `${IS_HTTPS ? 'wss' : 'ws'}://${location.host}/mqtt`);
function showLogin(text) {
  $('mq-login').hidden = false;
  $('mq-user').value = store.get('muser');
  const m = $('mq-msg'); m.textContent = text || 'Entra con el usuario del panel para ver los datos y la cámara.'; m.className = 'msg ' + (text ? 'err' : 'info');
}
$('mq-go').onclick = () => {
  store.set('muser', $('mq-user').value.trim()); store.set('mpass', $('mq-pass').value);
  $('mq-pass').value = ''; $('mq-login').hidden = true; startMqtt();
};
function startMqtt() {
  if (typeof mqtt === 'undefined') { log('mqtt.js no cargó', 'e'); return; }
  client?.end(true);
  const user = store.get('muser'), pass = store.get('mpass');
  if (!IS_LOCAL && !user) { showLogin(); return; }
  client = mqtt.connect(mqttUrl(), { username: user || undefined, password: pass || undefined, clientId: 'panel-' + Math.random().toString(16).slice(2, 8), reconnectPeriod: 2000, connectTimeout: 5000 });
  client.on('connect', () => { S.mqttUp = true; log('Servidor MQTT conectado'); client.subscribe([`jefe/${DEVICE}/#`, 'jefe/+/state', 'jefe/bridge/mode']); requestStream(); refreshChips(); });
  client.on('close', () => { if (S.mqttUp) log('Servidor MQTT desconectado, reintentando...', 'w'); S.mqttUp = false; refreshChips(); });
  client.on('error', (err) => {
    if (/Bad user|Not authorized|identifier/i.test(err.message)) { client.end(true); S.mqttUp = false; store.set('mpass', ''); showLogin('Usuario o clave incorrectos.'); log('MQTT: credenciales rechazadas', 'e'); }
  });
  client.on('message', (topic, buf) => {
    const [, id, t] = topic.split('/');
    if (id === 'bridge' && t === 'mode') { S.bridgeMode = buf.toString(); return; }
    if (t === 'state' && id !== DEVICE) { try { onDevState(id, JSON.parse(buf.toString())); } catch { /* estado invalido */ } return; }
    if (id !== DEVICE) return;
    if (t === 'snap') return onSnap(buf);
    let j; try { j = JSON.parse(buf.toString()); } catch { j = buf.toString(); }
    if (t === 'telemetry') onTelemetry(j);
    else if (t === 'live') onLive(j);
    else if (t === 'info') mergeDev(j);
    else if (t === 'state') onState(j);
    else if (t === 'status') { S.dev.online = j === 'online'; log(`Placa ${j}`, j === 'online' ? '' : 'w'); }
  });
}
// La imagen viaja por MQTT cuando el panel esta en https (el navegador bloquea pedirla a la IP local)
const camViaMqtt = () => IS_HTTPS || camFails >= 3;
function requestStream() {
  if (!client?.connected || document.hidden || !camViaMqtt()) return;
  client.publish(`jefe/${DEVICE}/cmd`, JSON.stringify({ stream: 30, snap_ms: Math.max(250, Math.round(1000 / S.camFps)) }));
}
setInterval(requestStream, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) requestStream(); });
let snapBusy = false;
async function onSnap(buf) {
  S.lastSnap = Date.now();
  if (snapBusy) return; // descartar cuadros si el navegador va atrasado
  snapBusy = true;
  try { const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' })); scene?.setCameraImage(bmp); bmp.close(); setCamLive(true); } catch { /* cuadro corrupto */ }
  snapBusy = false;
}
function onLive(j) { S.haveMotion = true; S.motion = j.motion; S.brightness = j.brightness; S.httpOk = true; S.lastLive = Date.now(); }
function onTelemetry(j) {
  S.lastTele = Date.now(); S.tele = j;
  if (!S.httpOk) { S.motion = j.motion ?? S.motion; S.brightness = j.brightness ?? S.brightness; S.haveMotion = true; }
  if (j.chip_temp != null) $('m-temp').textContent = `${j.chip_temp.toFixed(0)} °C`;
  if (j.rssi) $('m-rssi').textContent = `${j.rssi} dBm`;
  if (j.heap) $('m-heap').textContent = `${Math.round(j.heap / 1024)} KB`;
  if (j.uptime_s != null) $('m-up').textContent = fmtUp(j.uptime_s);
}
function onState(j) {
  S.ctrl = j;
  $('c-flash').checked = !!j.flash; $('c-enabled').checked = !!j.enabled;
  if (j.gain) { $('c-gain').value = j.gain; $('o-gain').textContent = (+j.gain).toFixed(1); }
  if (j.interval_ms) { $('c-int').value = j.interval_ms / 1000; $('o-int').textContent = `${j.interval_ms / 1000} s`; }
  if (j.quality) { $('c-q').value = j.quality; $('o-q').textContent = j.quality; }
  scene?.update({ flash: !!j.flash });
}
function pub(obj) {
  if (client?.connected) { client.publish(`jefe/${DEVICE}/cmd`, JSON.stringify(obj)); return true; }
  log('Sin conexión al broker: no se pudo enviar el comando', 'e'); return false;
}
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
$('c-flash').onchange = (e) => pub({ flash: e.target.checked });
$('c-enabled').onchange = (e) => pub({ enabled: e.target.checked });
const bindRange = (id, out, fmt, key, conv = (v) => v) => {
  const send = debounce((v) => pub({ [key]: conv(v) }));
  $(id).oninput = (e) => { $(out).textContent = fmt(+e.target.value); send(+e.target.value); };
};
bindRange('c-gain', 'o-gain', (v) => v.toFixed(1), 'gain');
bindRange('c-int', 'o-int', (v) => `${v} s`, 'interval_ms', (v) => v * 1000);
bindRange('c-q', 'o-q', (v) => v, 'quality');
$('c-fps').oninput = (e) => { S.camFps = +e.target.value; $('o-fps').textContent = e.target.value; };
$('btn-reboot').onclick = async () => { if (client?.connected) pub({ reboot: true }); else if (ble.state === 'connected') await ble.command('reboot'); else log('Sin MQTT ni Bluetooth para reiniciar', 'e'); };

// ---------- Dispositivos del servidor (gemelos, APIs, datasets): retroceso ----------
const DEV_NAMES = {
  'cam-sala-twin': ['Camara virtual de la sala', 'Digital Twin'], 'termostato-twin': ['Termostato', 'Digital Twin'], 'enchufe-twin': ['Enchufe inteligente', 'Digital Twin'],
  'puerta-twin': ['Puerta, ventana y PIR', 'Digital Twin'], 'luz-twin': ['Luz inteligente', 'Digital Twin'],
  'api-azure-weather': ['Azure Maps Weather', 'API'], 'api-openmeteo-aq': ['Calidad del aire (Open-Meteo)', 'API'],
  'ds-energia': ['Consumo del hogar', 'Dataset'], 'ds-co2': ['CO2 interior', 'Dataset'], 'ds-ocupacion': ['Ocupacion', 'Dataset']
};
const DEVS = {};
const sendDev = (id, obj) => { if (client?.connected) { client.publish(`jefe/${id}/cmd`, JSON.stringify(obj)); log(`Comando a ${id}: ${JSON.stringify(obj)}`); } else log('Sin conexion al servidor: comando no enviado', 'e'); };
function mk(tag, props = {}, ...kids) { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; }
function onDevState(id, st) { if (!DEV_NAMES[id]) return; DEVS[id] = st; renderDevs(); }
function renderDevs() {
  const box = $('devs'); box.replaceChildren();
  for (const id of Object.keys(DEV_NAMES)) {
    const st = DEVS[id]; if (!st) continue;
    const [name, kind] = DEV_NAMES[id];
    const tg = mk('input', { type: 'checkbox', checked: !!st.enabled, title: 'Encender / apagar' }); tg.onchange = () => sendDev(id, { enabled: tg.checked });
    const ex = mk('div', { className: 'ex' });
    const num = (label, key, min, max, step, send) => { const i = mk('input', { type: 'number', value: st[key], min, max, step }); i.onchange = () => sendDev(id, send(+i.value)); ex.append(label, i); };
    const btn = (label, obj) => { const b = mk('button', { textContent: label }); b.onclick = () => sendDev(id, obj); ex.append(b); };
    num('cada (s)', 'interval_s', kind === 'API' ? 60 : 1, 3600, 1, (v) => ({ interval_s: v }));
    if (id === 'termostato-twin') num('setpoint C', 'setpoint', 10, 30, 0.5, (v) => ({ setpoint: v }));
    if (id === 'enchufe-twin') { btn(st.relay ? 'Apagar rele' : 'Encender rele', { relay: !st.relay }); }
    if (id === 'luz-twin') { btn('Encender', { on: true }); btn('Apagar', { on: false }); btn('Auto', { mode: 'auto' }); }
    if (id === 'puerta-twin') { btn('Abrir puerta', { door: true }); btn('Cerrar', { door: false }); }
    if (id === 'cam-sala-twin') num('ganancia', 'gain', 0.5, 12, 0.5, (v) => ({ gain: v }));
    if (kind === 'Dataset') btn('Reiniciar', { rewind: true });
    box.append(mk('div', { className: 'dev' }, mk('div', { className: 'nm' }, name, mk('small', { textContent: `${kind} · ${id}` })), tg, ex));
  }
  if (!box.children.length) box.append(mk('span', { className: 'hint', textContent: 'Esperando al servidor...' }));
}

// ---------- Imagen de la camara (solo LAN, nunca sale a internet) ----------
const img = new Image(); img.crossOrigin = 'anonymous';
let camFails = 0, camTimer = 0;
function setCamLive(v) { if (S.camLive !== v) { S.camLive = v; log(v ? 'Imagen de la cámara en vivo' : 'Sin imagen de la cámara', v ? '' : 'w'); } scene?.update({ camLive: v }); refreshChips(); }
function camNext(ms) { clearTimeout(camTimer); camTimer = setTimeout(camTick, ms); }
function camTick() {
  if (IS_HTTPS) { if (Date.now() - S.lastSnap > 6000) setCamLive(false); return camNext(1500); }
  if (document.hidden || !S.ip) { setCamLive(false); return camNext(1000); }
  const t0 = performance.now(); let settled = false;
  const guard = setTimeout(() => { if (!settled) { settled = true; img.onload = img.onerror = null; fail(); } }, 4000);
  const fail = () => { camFails++; if (camFails >= 3) setCamLive(false); camNext(Math.min(8000, 400 * 2 ** camFails)); };
  img.onload = () => { if (settled) return; settled = true; clearTimeout(guard); camFails = 0; scene?.setCameraImage(img); setCamLive(true); camNext(Math.max(0, 1000 / S.camFps - (performance.now() - t0))); };
  img.onerror = () => { if (settled) return; settled = true; clearTimeout(guard); fail(); };
  img.src = `http://${S.ip}/snapshot?t=${Date.now()}`;
}
camTick();

// ---------- Info HTTP (movimiento a 1 Hz) ----------
let infoBusy = false;
setInterval(async () => {
  if (IS_HTTPS || !S.ip || document.hidden || infoBusy) return;
  infoBusy = true;
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 2000);
  try {
    const r = await fetch(`http://${S.ip}/info`, { signal: ac.signal, cache: 'no-store' });
    const j = await r.json();
    S.httpOk = true; S.haveMotion = true; S.motion = j.motion; S.brightness = j.brightness; mergeDev(j);
  } catch { S.httpOk = false; } finally { clearTimeout(to); infoBusy = false; }
}, 1000);

// ---------- Logica del jefe (demo local; el calculo oficial va en Node-RED) ----------
const SAY = {
  focused: ['Mmm... buen ritmo. No te acostumbres.', 'Veo trabajo. Qué sospechoso.', 'Sigue así y quizá te deje respirar.'],
  distracted: ['¿Eso es un celular?', 'Movimiento excesivo. ¿Estás bailando?', 'Vuelve a la pantalla. YA.'],
  absent: ['¿Dónde estás? El jefe pregunta.', 'Escritorio vacío. Se descuenta ánimo.', 'Silencio sospechoso...'],
  unknown: ['Conecta mi ojo para vigilarte.']
};
const LABEL = { focused: 'ENFOCADO', distracted: 'DISTRAÍDO', absent: 'AUSENTE', unknown: 'SIN DATOS' };
const COLOR = { focused: '#19ffa0', distracted: '#ff3355', absent: '#4a7dff', unknown: '#8892a8' };
let sayIdx = 0, lastSay = 0, mAvg = 0;
setInterval(() => {
  const now = Date.now();
  if (IS_HTTPS && now - (S.lastLive || 0) > 10000) S.httpOk = false; // sin 'live' el movimiento viene de la telemetria
  let st = S.boss;
  if (!S.haveMotion || (!S.httpOk && now - S.lastTele > 40000)) st = 'unknown';
  else {
    mAvg = mAvg * 0.7 + S.motion * 0.3;
    if (mAvg < 1.2) { S.lowSince ||= now; if (now - S.lowSince > 20000) st = 'absent'; else if (st === 'unknown') st = 'focused'; }
    else { S.lowSince = 0; st = mAvg > 12 ? 'distracted' : 'focused'; }
  }
  if (st !== S.boss) { S.boss = st; lastSay = 0; log(`El jefe: ${LABEL[st]}`); }
  const target = { focused: 100, distracted: 0, absent: 50, unknown: S.score }[st];
  S.score += (target - S.score) * 0.03;
  if (now - lastSay > 20000) { const a = SAY[st]; $('boss-say').textContent = a[sayIdx++ % a.length]; lastSay = now; }
  $('boss-state').textContent = LABEL[st]; $('boss-state').style.color = COLOR[st];
  $('score-num').textContent = Math.round(S.score); $('score-bar').style.width = `${S.score}%`; $('score-bar').style.background = COLOR[st];
  $('m-motion').textContent = S.haveMotion ? S.motion.toFixed(1) : '--';
  $('m-bright').textContent = S.haveMotion ? S.brightness.toFixed(0) : '--';
  scene?.update({ motion: S.haveMotion ? S.motion : 0, mood: st, score: S.score });
  pushSpark(S.haveMotion ? S.motion : 0);
}, 1000);

// ---------- Sparkline de movimiento ----------
const hist = []; const sp = $('spark'); const sx = sp.getContext('2d');
function pushSpark(v) {
  hist.push(v); if (hist.length > 150) hist.shift();
  const w = sp.width, h = sp.height; sx.clearRect(0, 0, w, h);
  sx.strokeStyle = COLOR[S.boss]; sx.lineWidth = 1.6; sx.beginPath();
  hist.forEach((y, i) => { const px = (i / 149) * w, py = h - 4 - (Math.min(y, 40) / 40) * (h - 8); i ? sx.lineTo(px, py) : sx.moveTo(px, py); });
  sx.stroke();
}

// ---------- Enlace a Grafana (dashboard con todas las graficas) ----------
$('lnk-graf').href = IS_LOCAL ? `http://${location.hostname}:3000/d/jefe-iot` : `${location.protocol}//grafana.${location.host}/d/jefe-iot`;

// ---------- Arranque ----------
startMqtt();
refreshChips();
log('Panel listo');
