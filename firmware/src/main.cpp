// ESP32-CAM "ojo del jefe" v2
//  - Provision WiFi/MQTT por Bluetooth LE (Web Bluetooth desde el panel)
//  - Recuperacion de errores: backoff WiFi/MQTT, reinicio de pila, watchdog, anti bucle de reinicios
//  - Camara JPEG: /snapshot por HTTP (LAN) + deteccion de movimiento por frames reducidos
//  - Telemetria y comandos por MQTT (retroceso)
#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <NimBLEDevice.h>
#include <esp_task_wdt.h>
#include <esp_system.h>
#include "esp_camera.h"
#include "img_converters.h"
#include "esp_http_server.h"
#include "config.h"
#include "ca_certs.h"

// ---------- Pines AI-Thinker ----------
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22
#define FLASH_GPIO_NUM 4

// ---------- UUIDs BLE ----------
#define SVC_UUID "8f3c0001-5a4b-4e6d-9d1a-2b7c1e5f0a01"
#define CFG_UUID "8f3c0002-5a4b-4e6d-9d1a-2b7c1e5f0a01"     // write: JSON de configuracion
#define CMD_UUID "8f3c0003-5a4b-4e6d-9d1a-2b7c1e5f0a01"     // write: comando de texto
#define STATUS_UUID "8f3c0004-5a4b-4e6d-9d1a-2b7c1e5f0a01"  // read+notify: estado
#define SCAN_UUID "8f3c0005-5a4b-4e6d-9d1a-2b7c1e5f0a01"    // notify: redes WiFi

static const char *T_TELE = "jefe/" DEVICE_ID "/telemetry";
static const char *T_CMD = "jefe/" DEVICE_ID "/cmd";
static const char *T_STATE = "jefe/" DEVICE_ID "/state";
static const char *T_STATUS = "jefe/" DEVICE_ID "/status";
static const char *T_INFO = "jefe/" DEVICE_ID "/info";
static const char *T_SNAP = "jefe/" DEVICE_ID "/snap";
static const char *T_LIVE = "jefe/" DEVICE_ID "/live";

// ---------- Estado global ----------
Config cfg;
WiFiClient wifiClient;
WiFiClientSecure tlsClient;
PubSubClient mqtt(wifiClient);
String mqErr = "";
uint32_t streamUntil = 0;     // el panel renueva este plazo mientras alguien mira
uint32_t snapIntervalMs = 1000;
uint32_t lastSnap = 0;
SemaphoreHandle_t camMutex;

bool safeMode = false;  // demasiados reinicios seguidos: solo BLE + WiFi, sin camara
bool camOk = false;
String camErr = "";
uint8_t camFail = 0;

// Parametros ajustables (retroceso)
bool enabled = true;
bool flashOn = false;
uint32_t intervalMs = 10000;
float gain = 4.0f;
int jpegQuality = 12;

float motionEma = 0;
float brightness = 0;
uint32_t lastSample = 0, lastPublish = 0, lastBleStatus = 0, lastInfo = 0;

// ---------- WiFi ----------
enum WState { W_IDLE, W_CONNECTING, W_CONNECTED, W_FAILED };
volatile WState wstate = W_IDLE;
volatile uint8_t lastDiscReason = 0;
String wReason = "";
uint32_t wStart = 0, wNextRetry = 0, wOfflineSince = 0;
uint8_t wFails = 0;
uint16_t wReconnects = 0;
bool stackReset = false;
bool webStarted = false;
httpd_handle_t httpd = nullptr;

// ---------- BLE ----------
NimBLECharacteristic *chStatus = nullptr, *chScan = nullptr;
volatile bool bleConnected = false;
portMUX_TYPE bleMux = portMUX_INITIALIZER_UNLOCKED;
std::string pendingCfg, pendingCmd;
volatile bool hasCfg = false, hasCmd = false;
String bleErr = "";

// ---------- Utilidades ----------
const char *resetReasonStr() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "poweron";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT: return "watchdog";
    case ESP_RST_BROWNOUT: return "brownout";
    default: return "other";
  }
}

String reasonToErr(uint8_t r) {
  switch (r) {
    case 201: return "ssid_not_found";
    case 2: case 15: case 202: case 204: return "bad_password";
    case 0: return "timeout";
    default: return "wifi_err_" + String(r);
  }
}

const char *wstateStr() {
  switch (wstate) {
    case W_CONNECTED: return "connected";
    case W_CONNECTING: return "connecting";
    case W_FAILED: return "failed";
    default: return "idle";
  }
}

String currentErr() {
  if (bleErr.length()) return bleErr;
  if (safeMode) return "safe_mode";
  if (camErr.length()) return camErr;
  if (wstate != W_CONNECTED && wReason.length()) return wReason;
  if (wstate == W_CONNECTED && !mqtt.connected() && mqErr.length()) return mqErr;
  return "";
}

void buildStatus(JsonDocument &d) {
  d["id"] = DEVICE_ID;
  d["fw"] = FW_VERSION;
  d["w"] = wstateStr();
  d["ip"] = wstate == W_CONNECTED ? WiFi.localIP().toString() : "";
  d["rssi"] = wstate == W_CONNECTED ? WiFi.RSSI() : 0;
  d["m"] = mqtt.connected() ? 1 : 0;
  d["tls"] = cfg.mqttTls ? 1 : 0;
  d["c"] = camOk ? 1 : 0;
  d["up"] = millis() / 1000;
  d["hp"] = ESP.getFreeHeap();
  d["rs"] = resetReasonStr();
  d["err"] = currentErr();
}

// ---------- Camara ----------
static bool camRaw = false;  // true: el sensor no hace JPEG, se captura RGB565 y se comprime por software

bool initCamera() {
  for (int i = 0; i < 4; i++) {
    camera_config_t c = {};
    c.ledc_channel = LEDC_CHANNEL_0;
    c.ledc_timer = LEDC_TIMER_0;
    c.pin_d0 = Y2_GPIO_NUM; c.pin_d1 = Y3_GPIO_NUM; c.pin_d2 = Y4_GPIO_NUM;
    c.pin_d3 = Y5_GPIO_NUM; c.pin_d4 = Y6_GPIO_NUM; c.pin_d5 = Y7_GPIO_NUM;
    c.pin_d6 = Y8_GPIO_NUM; c.pin_d7 = Y9_GPIO_NUM;
    c.pin_xclk = XCLK_GPIO_NUM; c.pin_pclk = PCLK_GPIO_NUM;
    c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href = HREF_GPIO_NUM;
    c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
    c.pin_pwdn = PWDN_GPIO_NUM; c.pin_reset = RESET_GPIO_NUM;
    c.xclk_freq_hz = 20000000;
    camRaw = (i >= 1);  // intento 0: JPEG nativo; despues RGB565
    c.pixel_format = camRaw ? PIXFORMAT_RGB565 : PIXFORMAT_JPEG;
    c.frame_size = FRAMESIZE_QVGA;  // 320x240: liviano para WiFi + textura 3D
    c.jpeg_quality = jpegQuality;
    c.fb_count = (psramFound() && !camRaw) ? 2 : 1;
    c.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
    c.grab_mode = CAMERA_GRAB_LATEST;
    esp_err_t er = esp_camera_init(&c);
    if (er == ESP_OK) {
      sensor_t *sn = esp_camera_sensor_get();
      Serial.printf("[cam] OK modo=%s sensor PID=0x%04x\n", camRaw ? "RGB565->JPEG sw" : "JPEG", sn ? sn->id.PID : 0);
      camErr = "";
      return true;
    }
    Serial.printf("[cam] init intento %d fallo: 0x%x\n", i, er);
    esp_camera_deinit();
    delay(300);
  }
  camErr = "camera_init";
  return false;
}

void recoverCamera() {
  if (xSemaphoreTake(camMutex, pdMS_TO_TICKS(1000)) != pdTRUE) return;
  esp_camera_deinit();
  delay(200);
  camOk = initCamera();
  camFail = 0;
  xSemaphoreGive(camMutex);
}

void sampleFrame() {
  if (!camOk || !enabled) return;
  if (xSemaphoreTake(camMutex, pdMS_TO_TICKS(200)) != pdTRUE) return;
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    xSemaphoreGive(camMutex);
    if (++camFail > 20) {
      recoverCamera();  // la camara se colgo: reinicializar
      if (!camOk) camErr = "camera_stalled";
    }
    return;
  }
  camFail = 0;
  static uint8_t small[40 * 30 * 2];  // QVGA reducido 8x en RGB565
  static uint8_t prev[40 * 30];
  static bool havePrev = false;
  bool ok = true;
  if (camRaw) {  // RGB565 320x240: submuestreo 8x directo
    for (int y = 0; y < 30; y++)
      for (int x = 0; x < 40; x++) {
        const uint8_t *px = fb->buf + ((y * 8) * 320 + (x * 8)) * 2;
        small[2 * (y * 40 + x)] = px[0];
        small[2 * (y * 40 + x) + 1] = px[1];
      }
  } else {
    ok = jpg2rgb565(fb->buf, fb->len, small, JPG_SCALE_8X);
  }
  esp_camera_fb_return(fb);
  xSemaphoreGive(camMutex);
  if (!ok) return;
  uint32_t sum = 0, diff = 0;
  const int N = 40 * 30;
  for (int i = 0; i < N; i++) {
    uint8_t g = (((small[2 * i] & 0x07) << 3) | (small[2 * i + 1] >> 5)) << 2;  // canal verde ~ luminancia
    sum += g;
    if (havePrev) diff += abs((int)g - (int)prev[i]);
    prev[i] = g;
  }
  havePrev = true;
  brightness = sum / (float)N;
  float m = constrain((diff / (float)N) * gain, 0.0f, 100.0f);
  motionEma = 0.6f * motionEma + 0.4f * m;
}

// ---------- HTTP (solo LAN): snapshot e info ----------
static esp_err_t snapshotHandler(httpd_req_t *req) {
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  if (!camOk || xSemaphoreTake(camMutex, pdMS_TO_TICKS(1500)) != pdTRUE) {
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "camera busy");
    return ESP_FAIL;
  }
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    xSemaphoreGive(camMutex);
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no frame");
    return ESP_FAIL;
  }
  httpd_resp_set_type(req, "image/jpeg");
  esp_err_t r;
  if (camRaw) {
    uint8_t *jb = nullptr; size_t jl = 0;
    if (frame2jpg(fb, 20, &jb, &jl)) { r = httpd_resp_send(req, (const char *)jb, jl); free(jb); }
    else r = httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "jpeg encode");
  } else {
    r = httpd_resp_send(req, (const char *)fb->buf, fb->len);
  }
  esp_camera_fb_return(fb);
  xSemaphoreGive(camMutex);
  return r;
}

static esp_err_t infoHandler(httpd_req_t *req) {
  JsonDocument d;
  buildStatus(d);
  d["motion"] = motionEma;
  d["brightness"] = brightness;
  char buf[320];
  size_t n = serializeJson(d, buf, sizeof(buf));
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, buf, n);
}

void startWeb() {
  if (webStarted) return;
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;
  config.stack_size = 8192;
  config.max_open_sockets = 4;
  config.lru_purge_enable = true;
  if (httpd_start(&httpd, &config) != ESP_OK) return;
  httpd_uri_t snap = {"/snapshot", HTTP_GET, snapshotHandler, nullptr};
  httpd_uri_t info = {"/info", HTTP_GET, infoHandler, nullptr};
  httpd_register_uri_handler(httpd, &snap);
  httpd_register_uri_handler(httpd, &info);
  webStarted = true;
}

// ---------- WiFi ----------
void onWiFiEvent(WiFiEvent_t ev, WiFiEventInfo_t info) {
  if (ev == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) lastDiscReason = info.wifi_sta_disconnected.reason;
}

void beginWifi() {
  if (!cfg.hasWifi()) {
    wstate = W_IDLE;
    return;
  }
  lastDiscReason = 0;
  WiFi.disconnect(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);  // el reintento lo manejamos nosotros, con backoff
  WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
  wstate = W_CONNECTING;
  wStart = millis();
}

void onWifiUp() {
  wReconnects++;
  configTime(0, 0, "pool.ntp.org", "time.google.com");  // necesario para validar certificados TLS
  MDNS.begin("jefecam");
  MDNS.addService("http", "tcp", 80);
  startWeb();
}

void wifiTick() {
  uint32_t now = millis();
  switch (wstate) {
    case W_IDLE: break;
    case W_CONNECTING:
      if (WiFi.status() == WL_CONNECTED) {
        wstate = W_CONNECTED;
        wFails = 0;
        wReason = "";
        wOfflineSince = 0;
        stackReset = false;
        onWifiUp();
      } else if (lastDiscReason != 0 || now - wStart > 20000) {
        wReason = reasonToErr(lastDiscReason);
        if (wFails < 250) wFails++;
        uint32_t backoff = min(60000UL, 3000UL * (1UL << min<uint8_t>(wFails - 1, 4)));
        wNextRetry = now + backoff;
        wstate = W_FAILED;
      }
      break;
    case W_CONNECTED:
      if (WiFi.status() != WL_CONNECTED) {
        wReason = "link_lost";
        wOfflineSince = now;
        mqtt.disconnect();
        beginWifi();
      }
      break;
    case W_FAILED:
      if (now >= wNextRetry) beginWifi();
      break;
  }
  // Escalamiento: sin red durante mucho tiempo
  if (cfg.hasWifi() && wstate != W_CONNECTED) {
    if (!wOfflineSince) wOfflineSince = now;
    uint32_t off = now - wOfflineSince;
    if (off > 600000UL && !stackReset) {  // 10 min: reiniciar la pila WiFi
      stackReset = true;
      WiFi.mode(WIFI_OFF);
      delay(300);
      beginWifi();
    }
    if (off > 1800000UL) ESP.restart();  // 30 min: reiniciar el equipo
  }
}

// ---------- MQTT ----------
uint32_t mqNext = 0;
uint8_t mqFails = 0;

void publishState() {
  JsonDocument d;
  d["enabled"] = enabled;
  d["flash"] = flashOn;
  d["interval_ms"] = intervalMs;
  d["gain"] = gain;
  d["quality"] = jpegQuality;
  char buf[200];
  size_t n = serializeJson(d, buf);
  mqtt.publish(T_STATE, (const uint8_t *)buf, n, true);
}

void publishInfo() {
  JsonDocument d;
  buildStatus(d);
  char buf[320];
  size_t n = serializeJson(d, buf);
  mqtt.publish(T_INFO, (const uint8_t *)buf, n, true);
}

void onMqttMessage(char *topic, byte *payload, unsigned int len) {
  JsonDocument d;
  if (deserializeJson(d, payload, len)) return;
  if (d["enabled"].is<bool>()) enabled = d["enabled"];
  if (d["flash"].is<bool>()) {
    flashOn = d["flash"];
    digitalWrite(FLASH_GPIO_NUM, flashOn ? HIGH : LOW);
  }
  if (d["interval_ms"].is<int>()) intervalMs = constrain((int)d["interval_ms"], 1000, 60000);
  if (d["gain"].is<float>() || d["gain"].is<int>()) gain = constrain((float)d["gain"], 0.5f, 20.0f);
  if (d["quality"].is<int>() && camOk) {
    jpegQuality = constrain((int)d["quality"], 10, 40);
    sensor_t *s = esp_camera_sensor_get();
    if (s) s->set_quality(s, jpegQuality);
  }
  if (d["stream"].is<int>()) streamUntil = (int)d["stream"] > 0 ? millis() + (uint32_t)constrain((int)d["stream"], 1, 120) * 1000UL : 0;
  if (d["snap_ms"].is<int>()) snapIntervalMs = constrain((int)d["snap_ms"], 250, 5000);
  publishState();
  if (d["reboot"] | false) {
    delay(300);
    ESP.restart();
  }
}

void mqttTick() {
  if (wstate != W_CONNECTED || cfg.mqttHost.isEmpty()) return;
  if (mqtt.connected()) {
    mqtt.loop();
    return;
  }
  uint32_t now = millis();
  if (now < mqNext) return;
  if (cfg.mqttTls) {
    if (time(nullptr) < 1700000000) {  // hora aun sin sincronizar: el certificado no se puede validar
      mqErr = "time_sync";
      mqNext = now + 3000;
      return;
    }
    tlsClient.setCACert(CA_CERTS);
    mqtt.setClient(tlsClient);
  } else {
    mqtt.setClient(wifiClient);
  }
  mqtt.setServer(cfg.mqttHost.c_str(), cfg.mqttPort);
  const char *u = cfg.mqttUser.length() ? cfg.mqttUser.c_str() : nullptr;
  const char *p = cfg.mqttPass.length() ? cfg.mqttPass.c_str() : nullptr;
  if (mqtt.connect(DEVICE_ID, u, p, T_STATUS, 1, true, "offline")) {
    mqFails = 0;
    mqErr = "";
    mqtt.publish(T_STATUS, "online", true);
    mqtt.subscribe(T_CMD);
    publishState();
    publishInfo();
  } else {
    int st = mqtt.state();
    mqErr = (st == 4 || st == 5) ? "mqtt_auth" : "mqtt_unreachable";
    if (mqFails < 250) mqFails++;
    mqNext = now + min(30000UL, 2000UL * mqFails);
  }
}

// Foto por MQTT (solo mientras el panel la pide): asi se ve desde internet sin abrir la placa a la red.
void publishSnapshot() {
  if (!camOk || xSemaphoreTake(camMutex, pdMS_TO_TICKS(300)) != pdTRUE) return;
  camera_fb_t *fb = esp_camera_fb_get();
  if (fb) {
    uint8_t *jb = nullptr; size_t jl = 0;
    const uint8_t *pb = fb->buf; size_t pl = fb->len;
    if (camRaw) { if (frame2jpg(fb, 20, &jb, &jl)) { pb = jb; pl = jl; } else pl = 0; }
    if (pl && mqtt.beginPublish(T_SNAP, pl, false)) {
      mqtt.write(pb, pl);
      mqtt.endPublish();
    }
    if (jb) free(jb);
    esp_camera_fb_return(fb);
    char live[80];
    int n = snprintf(live, sizeof(live), "{\"motion\":%.1f,\"brightness\":%.0f}", motionEma, brightness);
    mqtt.publish(T_LIVE, (const uint8_t *)live, n);
  }
  xSemaphoreGive(camMutex);
}

void publishTelemetry() {
  JsonDocument d;
  d["rssi"] = WiFi.RSSI();
  d["heap"] = ESP.getFreeHeap();
  d["uptime_s"] = millis() / 1000;
  d["chip_temp"] = temperatureRead();
  d["brightness"] = brightness;
  d["motion"] = motionEma;
  d["flash"] = flashOn ? 1 : 0;
  d["enabled"] = enabled ? 1 : 0;
  d["cam_ok"] = camOk ? 1 : 0;
  d["reconnects"] = wReconnects;
  char buf[256];
  size_t n = serializeJson(d, buf);
  mqtt.publish(T_TELE, (const uint8_t *)buf, n);
}

// ---------- BLE ----------
void bleNotifyStatus() {
  if (!bleConnected || !chStatus) return;
  JsonDocument d;
  buildStatus(d);
  char buf[200];
  size_t n = serializeJson(d, buf);
  chStatus->setValue((uint8_t *)buf, n);
  chStatus->notify();
}

void bleScanAndNotify() {
  int found = WiFi.scanNetworks(false, false, false, 300);
  // ordenar por RSSI descendente (seleccion simple, hasta 12)
  bool used[40] = {false};
  int limit = min(found, 40);
  for (int k = 0; k < min(limit, 12); k++) {
    int best = -1;
    for (int i = 0; i < limit; i++)
      if (!used[i] && (best < 0 || WiFi.RSSI(i) > WiFi.RSSI(best))) best = i;
    if (best < 0) break;
    used[best] = true;
    String s = WiFi.SSID(best);
    if (s.isEmpty()) continue;
    JsonDocument d;
    d["s"] = s;
    d["r"] = WiFi.RSSI(best);
    d["e"] = WiFi.encryptionType(best) == WIFI_AUTH_OPEN ? 0 : 1;
    char buf[120];
    size_t n = serializeJson(d, buf);
    if (!bleConnected) break;
    chScan->setValue((uint8_t *)buf, n);
    chScan->notify();
    delay(40);
  }
  if (bleConnected) {
    const char *done = "{\"done\":1}";
    chScan->setValue((uint8_t *)done, strlen(done));
    chScan->notify();
  }
  WiFi.scanDelete();
}

void applyConfigJson(const std::string &js) {
  JsonDocument d;
  if (deserializeJson(d, js)) {
    bleErr = "bad_json";
    return;
  }
  bool wifiChanged = false;
  if (d["ssid"].is<const char *>()) {
    String ssid = d["ssid"].as<String>();
    String pass = d["pass"] | "";
    if (ssid.length() < 1 || ssid.length() > 32) { bleErr = "invalid_ssid"; return; }
    if (pass.length() != 0 && (pass.length() < 8 || pass.length() > 63)) { bleErr = "invalid_pass"; return; }
    cfg.ssid = ssid;
    cfg.pass = pass;
    wifiChanged = true;
  }
  if (d["mqtt"].is<const char *>()) {
    String host = d["mqtt"].as<String>();
    int port = d["port"] | 1883;
    if (host.length() < 1 || host.length() > 63) { bleErr = "invalid_mqtt"; return; }
    if (port < 1 || port > 65535) { bleErr = "invalid_port"; return; }
    cfg.mqttHost = host;
    cfg.mqttPort = port;
    cfg.mqttUser = d["user"] | "";
    cfg.mqttPass = d["mpass"] | "";
    cfg.mqttTls = d["tls"] | false;
    mqtt.disconnect();
    mqNext = 0;
  }
  cfgSave(cfg);
  bleErr = "";
  if (wifiChanged) {
    wFails = 0;
    wOfflineSince = 0;
    wReason = "";
    beginWifi();
  }
}

void handleCommand(const std::string &cmd) {
  if (cmd == "scan") bleScanAndNotify();
  else if (cmd == "retry") { wFails = 0; wReason = ""; beginWifi(); }
  else if (cmd == "forget") { cfgClear(false); cfg.ssid = ""; cfg.pass = ""; WiFi.disconnect(true); wstate = W_IDLE; wReason = ""; }
  else if (cmd == "factory") { cfgClear(true); delay(200); ESP.restart(); }
  else if (cmd == "reboot") { delay(300); ESP.restart(); }
  else if (cmd == "camera") { if (!safeMode) recoverCamera(); }
  else if (cmd == "ping") { /* solo fuerza una notificacion */ }
  else bleErr = "unknown_cmd";
  bleNotifyStatus();
}

class ServerCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *s, ble_gap_conn_desc *desc) override {
    bleConnected = true;
    // Pedir un intervalo de conexion corto mejora la respuesta de la interfaz
    s->updateConnParams(desc->conn_handle, 24, 48, 0, 400);
  }
  void onDisconnect(NimBLEServer *s) override {
    bleConnected = false;
    NimBLEDevice::startAdvertising();
  }
};

class CfgCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c) override {
    portENTER_CRITICAL(&bleMux);
    pendingCfg = c->getValue();
    hasCfg = true;
    portEXIT_CRITICAL(&bleMux);
  }
};

class CmdCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c) override {
    portENTER_CRITICAL(&bleMux);
    pendingCmd = c->getValue();
    hasCmd = true;
    portEXIT_CRITICAL(&bleMux);
  }
};

void startBle() {
  NimBLEDevice::init("JefeCAM");
  NimBLEDevice::setMTU(247);
  NimBLEServer *server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCb());
  NimBLEService *svc = server->createService(SVC_UUID);
  NimBLECharacteristic *chCfg = svc->createCharacteristic(CFG_UUID, NIMBLE_PROPERTY::WRITE);
  NimBLECharacteristic *chCmd = svc->createCharacteristic(CMD_UUID, NIMBLE_PROPERTY::WRITE);
  chStatus = svc->createCharacteristic(STATUS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  chScan = svc->createCharacteristic(SCAN_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  chCfg->setCallbacks(new CfgCb());
  chCmd->setCallbacks(new CmdCb());
  svc->start();
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(SVC_UUID);
  adv->setScanResponse(true);
  adv->start();
}

// ---------- Setup / loop ----------
void setup() {
  Serial.begin(115200);
  pinMode(FLASH_GPIO_NUM, OUTPUT);
  digitalWrite(FLASH_GPIO_NUM, LOW);
  esp_task_wdt_init(30, true);  // 30 s sin vida => reinicio
  esp_task_wdt_add(NULL);

  uint8_t boots = bootCountInc();
  safeMode = boots >= 5;
  cfgLoad(cfg);
  camMutex = xSemaphoreCreateMutex();

  if (!safeMode) {
    camOk = initCamera();
    if (!camOk && boots < 3) {  // un reinicio suele arreglar fallos de camara
      delay(500);
      ESP.restart();
    }
  } else {
    camErr = "";
  }

  startBle();
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(1024);
  mqtt.setSocketTimeout(3);
  WiFi.onEvent(onWiFiEvent);
  wOfflineSince = millis();
  beginWifi();
}

void loop() {
  esp_task_wdt_reset();
  uint32_t now = millis();

  wifiTick();
  mqttTick();

  // Comandos BLE (se procesan aqui, no dentro del callback)
  if (hasCfg) {
    portENTER_CRITICAL(&bleMux);
    std::string js = pendingCfg;
    hasCfg = false;
    portEXIT_CRITICAL(&bleMux);
    applyConfigJson(js);
    bleNotifyStatus();
  }
  if (hasCmd) {
    portENTER_CRITICAL(&bleMux);
    std::string c = pendingCmd;
    hasCmd = false;
    portEXIT_CRITICAL(&bleMux);
    handleCommand(c);
  }
  if (bleConnected && now - lastBleStatus >= 1500) {
    lastBleStatus = now;
    bleNotifyStatus();
  }

  if (enabled && now - lastSample >= 500) {
    lastSample = now;
    sampleFrame();
  }
  if (streamUntil && now < streamUntil && now - lastSnap >= snapIntervalMs && mqtt.connected()) {
    lastSnap = now;
    publishSnapshot();
  }
  if (now - lastPublish >= intervalMs && mqtt.connected()) {
    lastPublish = now;
    publishTelemetry();
  }
  if (now - lastInfo >= 30000 && mqtt.connected()) {
    lastInfo = now;
    publishInfo();
  }

  // Estable 60 s => limpiar contador anti bucle
  static bool cleared = false;
  if (!cleared && now > 60000) {
    bootCountClear();
    cleared = true;
  }
  // Guardia de memoria: heap bajo sostenido => reinicio limpio
  static uint32_t lowSince = 0;
  if (ESP.getFreeHeap() < 20000) {
    if (!lowSince) lowSince = now;
    if (now - lowSince > 60000) ESP.restart();
  } else {
    lowSince = 0;
  }
  delay(5);
}
