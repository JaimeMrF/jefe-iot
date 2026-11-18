// Enlace Web Bluetooth con la ESP32-CAM: aprovisionamiento WiFi/MQTT y comandos.
// Maneja: cola serial de operaciones GATT, timeouts, reintentos y reconexion automatica con backoff.
export const SVC = '8f3c0001-5a4b-4e6d-9d1a-2b7c1e5f0a01';
const U = (n) => `8f3c000${n}-5a4b-4e6d-9d1a-2b7c1e5f0a01`;

// Mensajes en espanol para codigos de error del panel y del firmware
export const ERR_ES = {
  // panel / navegador
  unsupported: 'Este navegador no soporta Web Bluetooth. Usa Chrome o Edge en escritorio.',
  insecure: 'Web Bluetooth necesita https o http://localhost. Abre el panel desde http://localhost:8080.',
  cancelled: 'Seleccion cancelada.',
  ble_denied: 'Permiso de Bluetooth denegado. Revisa los permisos del sitio y que el Bluetooth de Windows este activo.',
  ble_out_of_range: 'No se pudo conectar. Acerca la ESP32 y verifica que este encendida (el LED/advertising no se ve, pero reinicia la placa).',
  ble_disconnected: 'Bluetooth desconectado.',
  ble_busy: 'El Bluetooth esta ocupado, reintentando.',
  gatt_timeout: 'La ESP32 no respondio a tiempo por Bluetooth.',
  svc_timeout: 'No encuentro el servicio del jefe en ese dispositivo. Reinicia la ESP32.',
  ble_unknown: 'Error de Bluetooth inesperado.',
  // firmware
  ssid_not_found: 'No encuentro esa red WiFi. La ESP32 solo usa 2.4 GHz (no 5 GHz) y debe estar al alcance.',
  bad_password: 'Clave WiFi incorrecta (o el router rechazo la conexion).',
  timeout: 'El router no respondio a tiempo. Reintentando.',
  link_lost: 'Se perdio el WiFi. Reconectando automaticamente.',
  invalid_ssid: 'El nombre de la red no es valido (1 a 32 caracteres).',
  invalid_pass: 'La clave debe tener entre 8 y 63 caracteres (o estar vacia si la red es abierta).',
  invalid_mqtt: 'La direccion del broker MQTT no es valida.',
  invalid_port: 'Puerto MQTT invalido.',
  bad_json: 'La ESP32 recibio una configuracion corrupta. Reenvia.',
  unknown_cmd: 'La ESP32 no conoce ese comando (firmware desactualizado).',
  mqtt_auth: 'El servidor MQTT rechazo el usuario o la clave de la placa.',
  mqtt_unreachable: 'La placa tiene WiFi pero no llega al servidor MQTT. Revisa el dominio, el puerto (443 con TLS) y el firewall del VPS.',
  time_sync: 'La placa aun no sincroniza la hora (necesaria para TLS). Espera unos segundos.',
  camera_init: 'La camara no inicializa. Revisa el cable plano y la alimentacion (5V, 1A o mas).',
  camera_stalled: 'La camara se colgo y no se pudo recuperar. Reiniciala desde el panel.',
  safe_mode: 'Modo seguro: la placa se reinicio muchas veces seguidas. Camara desactivada hasta estabilizar.'
};
export const RESET_ES = {
  brownout: 'Ultimo reinicio por BROWNOUT: la fuente es debil. Usa 5V con al menos 1A y cable corto.',
  watchdog: 'Ultimo reinicio por watchdog (se colgo). Si se repite, avisame.',
  panic: 'Ultimo reinicio por un fallo interno (panic).'
};
export const errText = (c) => ERR_ES[c] || (c ? `Error: ${c}` : '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, code) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(code), { code })), ms))]);

function mapErr(e) {
  if (!e) return 'ble_unknown';
  if (e.code && ERR_ES[e.code]) return e.code;
  const m = `${e.name || ''} ${e.message || ''}`;
  if (/NotAllowed|Security/i.test(m)) return 'ble_denied';
  if (/already in progress/i.test(m)) return 'ble_busy';
  if (/disconnected/i.test(m)) return 'ble_disconnected';
  if (/NetworkError|Connection attempt failed|out of range|Unsupported device/i.test(m)) return 'ble_out_of_range';
  return 'ble_unknown';
}

export class BleLink extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.ch = {};
    this.state = 'off'; // off | connecting | connected | reconnecting
    this.manual = false;
    this.queue = Promise.resolve();
    this.dec = new TextDecoder();
    this.enc = new TextEncoder();
    this.scanList = [];
    this.scanDone = null;
    this.gen = 0;          // generacion: invalida bucles de reconexion viejos
    this.opening = false;  // true mientras _open() intenta conectar (ignora desconexiones intermedias)
    this.looping = false;  // true mientras corre el bucle de reconexion
    this._onStatusEv = (e) => this._parseStatus(e.target.value);
    this._onScanEv = (e) => this._parseScan(e.target.value);
    this._onDiscEv = () => this._onDisc();
  }

  static check() {
    if (!navigator.bluetooth) return 'unsupported';
    if (!window.isSecureContext) return 'insecure';
    return null;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(state, info) {
    const changed = state !== this.state || info !== this.info;
    this.state = state; this.info = info;
    if (changed) this.emit('state', { state, info });
  }
  _enqueue(fn) {
    const run = this.queue.then(() => fn());
    this.queue = run.catch(() => {});
    return run;
  }

  async connect() {
    const bad = BleLink.check();
    if (bad) { this.emit('error', { code: bad }); return false; }
    if (this.state === 'connecting' || this.state === 'reconnecting') return false;
    this.manual = false;
    this.gen++;
    this.setState('connecting', 'Buscando dispositivo...');
    let dev;
    try {
      dev = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'JefeCAM' }],
        optionalServices: [SVC]
      });
    } catch (e) {
      this.setState('off');
      this.emit('error', { code: e.name === 'NotFoundError' ? 'cancelled' : mapErr(e) });
      return false;
    }
    // Un solo listener por dispositivo: si se reconecta al mismo, no se duplican los bucles de reconexion
    this.device?.removeEventListener('gattserverdisconnected', this._onDiscEv);
    this.device = dev;
    this.device.addEventListener('gattserverdisconnected', this._onDiscEv);
    return this._open(3, false);
  }

  async _open(tries, quiet) {
    let last = null;
    const gen = this.gen;
    this.opening = true;
    try {
      for (let i = 1; i <= tries; i++) {
        if (gen !== this.gen || this.manual) return false;
        try {
        this.setState(quiet ? 'reconnecting' : 'connecting', `Conectando (${i}/${tries})...`);
        this.server = await withTimeout(this.device.gatt.connect(), 10000, 'gatt_timeout');
        const svc = await withTimeout(this.server.getPrimaryService(SVC), 8000, 'svc_timeout');
        this.ch = {
          cfg: await svc.getCharacteristic(U(2)),
          cmd: await svc.getCharacteristic(U(3)),
          status: await svc.getCharacteristic(U(4)),
          scan: await svc.getCharacteristic(U(5))
        };
        this.ch.status.removeEventListener('characteristicvaluechanged', this._onStatusEv);
        this.ch.scan.removeEventListener('characteristicvaluechanged', this._onScanEv);
        this.ch.status.addEventListener('characteristicvaluechanged', this._onStatusEv);
        this.ch.scan.addEventListener('characteristicvaluechanged', this._onScanEv);
        await this.ch.status.startNotifications();
        await this.ch.scan.startNotifications();
          try { this._parseStatus(await this.ch.status.readValue(), true); } catch { /* llegara por notificacion */ }
          if (gen !== this.gen || this.manual) { try { this.device.gatt.disconnect(); } catch { /* nada */ } return false; }
          this.setState('connected', this.device.name);
          return true;
        } catch (e) {
          last = e;
          try { this.device.gatt.disconnect(); } catch { /* ya cerrado */ }
          if (i < tries) await sleep(700 * i);
        }
      }
    } finally {
      this.opening = false;
    }
    if (gen !== this.gen || this.manual) return false;
    if (!quiet) { this.setState('off'); this.emit('error', { code: mapErr(last) }); }
    return false;
  }

  _onDisc() {
    this.ch = {};
    if (this.opening) return; // _open() ya esta reintentando
    if (this.manual) { this.setState('off'); return; }
    this.setState('reconnecting', 'Bluetooth perdido, reconectando...');
    this._reconnectLoop();
  }

  async _reconnectLoop() {
    if (this.looping) return;
    this.looping = true;
    const gen = this.gen;
    const alive = () => gen === this.gen && !this.manual;
    try {
      for (let i = 1; i <= 10 && alive(); i++) {
        this.setState('reconnecting', `Bluetooth perdido, reconectando (${i}/10)...`);
        await sleep(Math.min(1000 * i, 6000));
        if (!alive()) return;
        if (await this._open(1, true)) { this.emit('info', { msg: 'Bluetooth recuperado' }); return; }
      }
      if (alive()) {
        this.setState('off');
        this.emit('error', { code: 'ble_out_of_range' });
      }
    } finally {
      this.looping = false;
    }
  }

  disconnect() {
    this.manual = true;
    this.gen++;
    try { this.device?.gatt?.disconnect(); } catch { /* nada */ }
    this.ch = {};
    this.scanDone?.(this.scanList);
    this.setState('off');
  }

  _parseStatus(dv, retried = false) {
    try { this.emit('status', JSON.parse(this.dec.decode(dv))); } catch {
      // notificacion truncada por MTU pequeno: leer la caracteristica completa (una sola vez, sin bucles)
      if (retried) return;
      this._enqueue(() => this.ch.status?.readValue()).then((v) => v && this._parseStatus(v, true)).catch(() => {});
    }
  }

  _parseScan(dv) {
    let o;
    try { o = JSON.parse(this.dec.decode(dv)); } catch { return; }
    if (o.done) { this.scanDone?.(this.scanList); return; }
    if (o.s) this.scanList.push(o);
    this.emit('scanpartial', { list: [...this.scanList] });
  }

  async _write(ch, text) {
    const data = this.enc.encode(text);
    return this._enqueue(async () => {
      for (let i = 0; i < 3; i++) {
        try {
          if (!ch) throw Object.assign(new Error('desconectado'), { code: 'ble_disconnected' });
          const w = ch.writeValueWithResponse ? ch.writeValueWithResponse(data) : ch.writeValue(data);
          return await withTimeout(w, 8000, 'gatt_timeout');
        } catch (e) {
          if (mapErr(e) !== 'ble_busy' || i === 2) throw e;
          await sleep(400);
        }
      }
    });
  }

  async sendConfig(obj) {
    try { await this._write(this.ch.cfg, JSON.stringify(obj)); return true; } catch (e) {
      this.emit('error', { code: mapErr(e) });
      return false;
    }
  }

  async command(name) {
    try { await this._write(this.ch.cmd, name); return true; } catch (e) {
      this.emit('error', { code: mapErr(e) });
      return false;
    }
  }

  async scan() {
    this.scanList = [];
    const done = new Promise((res) => { this.scanDone = res; });
    if (!(await this.command('scan'))) return [];
    const list = await withTimeout(done, 20000, 'gatt_timeout').catch(() => this.scanList);
    this.scanDone = null;
    const seen = new Map();
    for (const n of list) if (!seen.has(n.s) || seen.get(n.s).r < n.r) seen.set(n.s, n);
    return [...seen.values()].sort((a, b) => b.r - a.r);
  }
}
