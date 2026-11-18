// ESP32-CAM "ojo del jefe" v2
//  - Provision WiFi/MQTT por Bluetooth LE (Web Bluetooth desde el panel)
//  - Recuperacion de errores: backoff WiFi/MQTT, reinicio de pila, watchdog, anti bucle de reinicios
//  - Camara JPEG: /snapshot por HTTP (LAN) + deteccion de movimiento por frames reducidos
//  - Telemetria y comandos por MQTT (retroceso)
//
// Notas de concurrencia: loop() es el unico que toca WiFi/MQTT/NVS. El servidor HTTP corre en su propia
// tarea y solo lee estado "atomico" (bools, floats, punteros a literales); la camara se protege con camMutex.
// Los callbacks BLE corren en la tarea de NimBLE: solo copian el dato a un buffer fijo y loop() lo procesa.
// Con BLE y WiFi a la vez el modem sleep del WiFi DEBE quedar activo (es el valor por defecto): no llamar
// a WiFi.setSleep(false).
#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <NimBLEDevice.h>
#include <esp_task_wdt.h>
#include <esp_system.h>
#include <esp_timer.h>
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

// Tamano de la imagen de trabajo (QVGA) y de la reducida para movimiento (8x)
static const int CAM_W = 320, CAM_H = 240;
static const int SM_W = CAM_W / 8, SM_H = CAM_H / 8, SM_N = SM_W * SM_H;

// Plazo seguro frente al desborde de millis() (cada ~49 dias): se compara el tiempo transcurrido
// (now - from), nunca "now >= deadline", que falla al dar la vuelta o con plazos viejos.
struct Deadline {
  uint32_t from = 0, wait = 0;
  bool armed = false;
  void set(uint32_t ms) { from = millis(); wait = ms; armed = true; }
  void clear() { armed = false; }
  bool due(uint32_t now) const { return armed && now - from >= wait; }
  bool pending(uint32_t now) const { return armed && now - from < wait; }
};
// Segundos desde el arranque sin desborde a los 49 dias
static inline uint32_t uptimeS() { return (uint32_t)(esp_timer_get_time() / 1000000ULL); }

// ---------- Estado global ----------
Config cfg;
WiFiClient wifiClient;
WiFiClientSecure tlsClient;
PubSubClient mqtt(wifiClient);
// Los codigos de error son punteros a literales (asignacion atomica): se pueden leer desde la tarea HTTP
// sin riesgo, a diferencia de un String que se realoca.
const char *mqErr = "";
volatile bool mqttUp = false;  // copia de mqtt.connected() hecha en loop(); otras tareas leen esta
Deadline streamWin;            // el panel renueva este plazo mientras alguien mira
uint32_t snapIntervalMs = 1000;
uint32_t lastSnap = 0;
SemaphoreHandle_t camMutex;

bool safeMode = false;  // demasiados reinicios seguidos: solo BLE + WiFi, sin camara
volatile bool camOk = false;
const char *camErr = "";
uint8_t camFail = 0;
Deadline camRetry;  // reintento automatico si la camara quedo caida
uint8_t camRetries = 0;

// Parametros ajustables (retroceso), persistidos en NVS
bool enabled = true;
bool flashOn = false;
uint32_t intervalMs = 10000;
float gain = 4.0f;
int jpegQuality = 12;
uint8_t noiseFloor = 0;
bool paramsDirty = false;
uint32_t paramsDirtyAt = 0;

volatile float motionEma = 0;
volatile float brightness = 0;
volatile bool motionResync = true;  // descartar la proxima comparacion (flash, pausa, camara reiniciada)
uint32_t lastSample = 0, lastPublish = 0, lastBleStatus = 0, lastInfo = 0;

Deadline rebootT;

// ---------- WiFi ----------
enum WState { W_IDLE, W_CONNECTING, W_CONNECTED, W_FAILED };
volatile WState wstate = W_IDLE;
volatile uint8_t lastDiscReason = 0;
const char *wReason = "";
uint32_t wStart = 0, wOfflineSince = 0;
Deadline wRetry;
uint8_t wFails = 0;
uint16_t wReconnects = 0;
bool stackReset = false;
bool webStarted = false;
bool mdnsStarted = false;
httpd_handle_t httpd = nullptr;

// ---------- BLE ----------
NimBLECharacteristic *chStatus = nullptr, *chScan = nullptr;
volatile bool bleConnected = false;
volatile bool bleKick = false;  // recien conectado: enviar estado ya
portMUX_TYPE bleMux = portMUX_INITIALIZER_UNLOCKED;
static const size_t CFG_MAX = 512, CMD_MAX = 32;
char pendingCfg[CFG_MAX + 1];
char pendingCmd[CMD_MAX + 1];
size_t pendingCfgLen = 0, pendingCmdLen = 0;
volatile bool hasCfg = false, hasCmd = false;
const char *bleErr = "";
uint32_t bleErrAt = 0;

void scheduleReboot(uint32_t ms) {
  rebootT.set(ms);
}

void setBleErr(const char *e) {
  bleErr = e;
  bleErrAt = millis();
}

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

const char *reasonToErr(uint8_t r) {
  static char other[20];
  switch (r) {
    case 201: return "ssid_not_found";
    case 2: case 15: case 202: case 204: return "bad_password";
    case 0: return "timeout";
    default:
      snprintf(other, sizeof(other), "wifi_err_%u", r);
      return other;
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

const char *currentErr() {
  if (bleErr[0]) return bleErr;
  if (safeMode) return "safe_mode";
  if (camErr[0]) return camErr;
  if (wstate != W_CONNECTED && wReason[0]) return wReason;
  if (wstate == W_CONNECTED && !mqttUp && mqErr[0]) return mqErr;
  return "";
}

void buildStatus(JsonDocument &d) {
  bool up = wstate == W_CONNECTED;
  d["id"] = DEVICE_ID;
  d["fw"] = FW_VERSION;
  d["w"] = wstateStr();
  d["ip"] = up ? WiFi.localIP().toString() : "";
  d["rssi"] = up ? WiFi.RSSI() : 0;
  d["m"] = mqttUp ? 1 : 0;
  d["tls"] = cfg.mqttTls ? 1 : 0;
  d["c"] = camOk ? 1 : 0;
  d["up"] = uptimeS();
  d["hp"] = ESP.getFreeHeap();
  d["rs"] = resetReasonStr();
  d["err"] = currentErr();
}

static inline double round1(float v) { return lroundf(v * 10.0f) / 10.0; }

// ---------- Camara ----------
static bool camRaw = false;  // true: el sensor no hace JPEG, se captura RGB565 y se comprime por software

bool initCamera() {
  for (int i = 0; i < 4; i++) {
    esp_task_wdt_reset();
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
      LOGI("cam", "OK modo=%s sensor PID=0x%04x psram=%d", camRaw ? "RGB565->JPEG sw" : "JPEG", sn ? sn->id.PID : 0, psramFound());
      camErr = "";
      motionResync = true;
      return true;
    }
    LOGW("cam", "init intento %d fallo: 0x%x", i, er);
    esp_camera_deinit();
    delay(300);
  }
  LOGE("cam", "no inicializa");
  camErr = "camera_init";
  return false;
}

void recoverCamera() {
  if (xSemaphoreTake(camMutex, pdMS_TO_TICKS(1000)) != pdTRUE) return;
  LOGW("cam", "reinicializando camara");
  camOk = false;  // la tarea HTTP no debe usarla mientras se reinicia
  esp_camera_deinit();
  delay(200);
  camOk = initCamera();
  camFail = 0;
  xSemaphoreGive(camMutex);
  if (camOk) {
    camRetries = 0;
  } else {
    // reintento automatico con backoff: 30 s, 60 s, 120 s ... hasta 5 min
    if (camRetries < 250) camRetries++;
    uint32_t wait = min(300000UL, 30000UL << min<uint8_t>(camRetries - 1, 4));
    camRetry.set(wait);
    LOGW("cam", "nuevo intento en %lu s", (unsigned long)(wait / 1000));
  }
}

void sampleFrame() {
  if (!camOk || !enabled) return;
  if (xSemaphoreTake(camMutex, pdMS_TO_TICKS(200)) != pdTRUE) return;
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    xSemaphoreGive(camMutex);
    // Cada fb_get fallido puede bloquear varios segundos: no esperar demasiados antes de reiniciarla
    if (++camFail >= 8) {
      LOGW("cam", "%u capturas fallidas seguidas", camFail);
      recoverCamera();  // la camara se colgo: reinicializar
      if (!camOk) camErr = "camera_stalled";
    }
    return;
  }
  camFail = 0;
  static uint8_t small[SM_N * 2];  // QVGA reducido 8x en RGB565
  static uint8_t prev[SM_N];
  static bool havePrev = false;
  static float prevMean = 0;
  bool ok = false;
  // Validar el tamano real del cuadro antes de leerlo: evita leer/escribir fuera de los buffers
  if (fb->width == CAM_W && fb->height == CAM_H) {
    if (camRaw) {  // RGB565 320x240: submuestreo 8x directo
      if (fb->len >= (size_t)CAM_W * CAM_H * 2) {
        for (int y = 0; y < SM_H; y++)
          for (int x = 0; x < SM_W; x++) {
            const uint8_t *px = fb->buf + ((y * 8) * CAM_W + (x * 8)) * 2;
            small[2 * (y * SM_W + x)] = px[0];
            small[2 * (y * SM_W + x) + 1] = px[1];
          }
        ok = true;
      }
    } else {
      ok = jpg2rgb565(fb->buf, fb->len, small, JPG_SCALE_8X);
    }
  }
  esp_camera_fb_return(fb);
  xSemaphoreGive(camMutex);
  if (!ok) {
    LOGD("cam", "cuadro descartado");
    return;
  }
  // Luminancia en el mismo buffer (in situ): small[i] se escribe despues de leer small[2i] y small[2i+1]
  uint8_t *cur = small;
  uint32_t sum = 0;
  for (int i = 0; i < SM_N; i++) {
    uint8_t g = (((small[2 * i] & 0x07) << 3) | (small[2 * i + 1] >> 5)) << 2;  // canal verde ~ luminancia
    cur[i] = g;
    sum += g;
  }
  float mean = sum / (float)SM_N;
  if (motionResync) {  // tras flash, pausa o reinicio de camara, la comparacion no tiene sentido
    havePrev = false;
    motionResync = false;
  }
  if (havePrev) {
    // Compensacion de iluminacion: se resta el cambio de brillo global (auto-exposicion, nubes, flash)
    // para que un cambio de luz uniforme no cuente como movimiento. Sin cambio global es identico al original.
    int off = (int)lroundf(mean - prevMean);
    uint32_t diff = 0;
    for (int i = 0; i < SM_N; i++) {
      int d = abs((int)cur[i] - (int)prev[i] - off);
      if (d > noiseFloor) diff += d - noiseFloor;  // umbral de ruido del sensor (0 = sin umbral)
    }
    float m = constrain((diff / (float)SM_N) * gain, 0.0f, 100.0f);
    motionEma = 0.6f * motionEma + 0.4f * m;
  }
  memcpy(prev, cur, sizeof(prev));
  prevMean = mean;
  havePrev = true;
  brightness = mean;
}

// ---------- HTTP (solo LAN): snapshot e info ----------
static esp_err_t snapshotHandler(httpd_req_t *req) {
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  if (!camOk || xSemaphoreTake(camMutex, pdMS_TO_TICKS(1500)) != pdTRUE) {
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "camera busy");
    return ESP_FAIL;
  }
  if (!camOk) {  // se cayo mientras esperabamos el mutex
    xSemaphoreGive(camMutex);
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
    if (frame2jpg(fb, 20, &jb, &jl)) r = httpd_resp_send(req, (const char *)jb, jl);
    else r = httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "jpeg encode");
    if (jb) free(jb);
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
  d["motion"] = round1(motionEma);
  d["brightness"] = round1(brightness);
  char buf[384];
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
  if (httpd_start(&httpd, &config) != ESP_OK) {
    LOGE("http", "no arranca el servidor");
    return;
  }
  httpd_uri_t snap = {"/snapshot", HTTP_GET, snapshotHandler, nullptr};
  httpd_uri_t info = {"/info", HTTP_GET, infoHandler, nullptr};
  httpd_register_uri_handler(httpd, &snap);
  httpd_register_uri_handler(httpd, &info);
  webStarted = true;
  LOGI("http", "servidor en :80 (/snapshot, /info)");
}

// ---------- WiFi ----------
void onWiFiEvent(WiFiEvent_t ev, WiFiEventInfo_t info) {
  if (ev != ARDUINO_EVENT_WIFI_STA_DISCONNECTED) return;
  uint8_t r = info.wifi_sta_disconnected.reason;
  // 8 = ASSOC_LEAVE: lo genera nuestro propio WiFi.disconnect() al reintentar. Si llega tarde, durante
  // el nuevo intento, se tomaba como fallo inmediato ("wifi_err_8") y se perdia un ciclo de backoff.
  if (r == WIFI_REASON_ASSOC_LEAVE) return;
  lastDiscReason = r;
}

void beginWifi() {
  if (!cfg.hasWifi()) {
    wstate = W_IDLE;
    return;
  }
  WiFi.disconnect(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);  // el reintento lo manejamos nosotros, con backoff
  lastDiscReason = 0;
  WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
  wstate = W_CONNECTING;
  wStart = millis();
  LOGI("wifi", "conectando a \"%s\" (fallos=%u)", cfg.ssid.c_str(), wFails);
}

void onWifiUp() {
  wReconnects++;
  LOGI("wifi", "conectado ip=%s rssi=%d", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  configTime(0, 0, "pool.ntp.org", "time.google.com");  // necesario para validar certificados TLS
  if (!mdnsStarted) {  // MDNS.begin repetido en cada reconexion fallaba y duplicaba el servicio
    mdnsStarted = MDNS.begin("jefecam");
    if (mdnsStarted) MDNS.addService("http", "tcp", 80);
  }
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
        backoff += esp_random() % 1000;  // jitter: evita que varias placas reintenten a la vez
        wRetry.set(backoff);
        wstate = W_FAILED;
        LOGW("wifi", "fallo: %s (razon %u), reintento en %lu ms", wReason, lastDiscReason, (unsigned long)backoff);
      }
      break;
    case W_CONNECTED:
      if (WiFi.status() != WL_CONNECTED) {
        LOGW("wifi", "enlace perdido");
        wReason = "link_lost";
        wOfflineSince = now;
        mqtt.disconnect();
        mqttUp = false;
        beginWifi();
      }
      break;
    case W_FAILED:
      if (!wRetry.pending(now)) beginWifi();
      break;
  }
  // Escalamiento: sin red durante mucho tiempo
  if (cfg.hasWifi() && wstate != W_CONNECTED) {
    if (!wOfflineSince) wOfflineSince = now;
    uint32_t off = now - wOfflineSince;
    if (off > 600000UL && !stackReset) {  // 10 min: reiniciar la pila WiFi
      LOGW("wifi", "10 min sin red: reinicio de la pila WiFi");
      stackReset = true;
      WiFi.mode(WIFI_OFF);
      delay(300);
      beginWifi();
    }
    // 30 min: reiniciar el equipo (salvo que alguien este configurandolo por Bluetooth)
    if (off > 1800000UL && !bleConnected) {
      LOGE("wifi", "30 min sin red: reinicio");
      ESP.restart();
    }
  }
}

// ---------- MQTT ----------
Deadline mqRetry;
uint8_t mqFails = 0;
uint32_t mqDownSince = 0;

void markParamsDirty() {
  paramsDirty = true;
  paramsDirtyAt = millis();
}

void saveParamsNow() {
  Params p;
  p.enabled = enabled;
  p.intervalMs = intervalMs;
  p.gain = gain;
  p.quality = jpegQuality;
  p.noise = noiseFloor;
  paramsSave(p);
  paramsDirty = false;
  LOGD("nvs", "parametros guardados");
}

void publishState() {
  JsonDocument d;
  d["enabled"] = enabled;
  d["flash"] = flashOn;
  d["interval_ms"] = intervalMs;
  d["gain"] = gain;
  d["quality"] = jpegQuality;
  d["noise"] = noiseFloor;
  char buf[200];
  size_t n = serializeJson(d, buf, sizeof(buf));
  mqtt.publish(T_STATE, (const uint8_t *)buf, n, true);
}

void publishInfo() {
  JsonDocument d;
  buildStatus(d);
  d["hm"] = ESP.getMinFreeHeap();  // minimo historico de heap: ayuda a detectar fugas
  char buf[384];
  size_t n = serializeJson(d, buf, sizeof(buf));
  mqtt.publish(T_INFO, (const uint8_t *)buf, n, true);
}

// Lee un numero aceptando int o float. Devuelve false si el campo no existe o no es numerico.
static bool numField(JsonVariantConst v, float &out) {
  if (v.is<int>() || v.is<float>()) { out = v.as<float>(); return !isnan(out); }
  return false;
}
// Lee un booleano aceptando true/false y 0/1 (el bridge y la documentacion usan 0/1)
static bool boolField(JsonVariantConst v, bool &out) {
  if (v.is<bool>()) { out = v.as<bool>(); return true; }
  if (v.is<int>()) { out = v.as<int>() != 0; return true; }
  return false;
}

void onMqttMessage(char *topic, byte *payload, unsigned int len) {
  JsonDocument d;
  DeserializationError e = deserializeJson(d, payload, len);
  if (e || !d.is<JsonObject>()) {
    LOGW("mqtt", "cmd invalido (%s)", e ? e.c_str() : "no es objeto");
    return;
  }
  bool b;
  float f;
  bool persist = false;
  if (boolField(d["enabled"], b)) {
    if (b && !enabled) motionResync = true;  // al reanudar no comparar con un cuadro viejo
    if (b != enabled) persist = true;
    enabled = b;
  }
  if (boolField(d["flash"], b)) {
    if (b != flashOn) motionResync = true;  // el salto de luz del flash no es movimiento
    flashOn = b;
    digitalWrite(FLASH_GPIO_NUM, flashOn ? HIGH : LOW);
  }
  if (numField(d["interval_ms"], f)) { intervalMs = (uint32_t)constrain(f, 1000.0f, 60000.0f); persist = true; }
  else if (numField(d["interval_s"], f)) { intervalMs = (uint32_t)constrain(f * 1000.0f, 1000.0f, 60000.0f); persist = true; }
  if (numField(d["gain"], f)) { gain = constrain(f, 0.5f, 20.0f); persist = true; }
  if (numField(d["quality"], f)) {
    jpegQuality = constrain((int)f, 10, 40);
    persist = true;
    if (camOk && xSemaphoreTake(camMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
      sensor_t *s = esp_camera_sensor_get();
      if (s) s->set_quality(s, jpegQuality);
      xSemaphoreGive(camMutex);
    }
  }
  if (numField(d["noise"], f)) { noiseFloor = (uint8_t)constrain(f, 0.0f, 40.0f); persist = true; }
  if (numField(d["stream"], f)) {
    int s = (int)f;
    if (s > 0) streamWin.set((uint32_t)constrain(s, 1, 120) * 1000UL);
    else streamWin.clear();
  }
  if (numField(d["snap_ms"], f)) snapIntervalMs = (uint32_t)constrain(f, 250.0f, 5000.0f);
  if (persist) markParamsDirty();
  publishState();
  bool rb = false;
  if (boolField(d["reboot"], rb) && rb) {
    LOGW("mqtt", "reinicio pedido por MQTT");
    if (paramsDirty) saveParamsNow();
    scheduleReboot(500);  // deja salir el estado antes de reiniciar
  }
}

void mqttTick() {
  if (wstate != W_CONNECTED || cfg.mqttHost.isEmpty()) {
    mqttUp = false;
    mqDownSince = 0;
    return;
  }
  if (mqtt.connected()) {
    mqtt.loop();
    mqttUp = mqtt.connected();
    if (mqttUp) {
      mqDownSince = 0;
      return;
    }
    LOGW("mqtt", "conexion perdida (estado %d)", mqtt.state());
  }
  mqttUp = false;
  uint32_t now = millis();
  if (!mqDownSince) mqDownSince = now;
  // WiFi bien pero el broker no responde durante 30 min: reinicio limpio (p. ej. heap fragmentado para TLS)
  if (now - mqDownSince > 1800000UL && !bleConnected) {
    LOGE("mqtt", "30 min sin broker: reinicio");
    ESP.restart();
  }
  if (mqRetry.pending(now)) return;
  if (cfg.mqttTls) {
    if (time(nullptr) < 1700000000) {  // hora aun sin sincronizar: el certificado no se puede validar
      mqErr = "time_sync";
      mqRetry.set(3000);
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
  LOGI("mqtt", "conectando a %s:%u tls=%d heap=%u", cfg.mqttHost.c_str(), cfg.mqttPort, cfg.mqttTls, ESP.getFreeHeap());
  esp_task_wdt_reset();  // la conexion (DNS + TCP + TLS) puede tardar varios segundos
  bool ok = mqtt.connect(DEVICE_ID, u, p, T_STATUS, 1, true, "offline");
  esp_task_wdt_reset();
  if (ok) {
    mqFails = 0;
    mqErr = "";
    mqRetry.clear();  // si luego se cae, reintentar de inmediato
    mqttUp = true;
    mqDownSince = 0;
    mqtt.publish(T_STATUS, "online", true);
    mqtt.subscribe(T_CMD);
    publishState();
    publishInfo();
    LOGI("mqtt", "conectado");
  } else {
    int st = mqtt.state();
    mqErr = (st == 4 || st == 5) ? "mqtt_auth" : "mqtt_unreachable";
    if (mqFails < 250) mqFails++;
    uint32_t wait = min(30000UL, 2000UL * mqFails) + esp_random() % 1000;
    mqRetry.set(wait);
    LOGW("mqtt", "fallo %s (estado %d), reintento en %lu ms", mqErr, st, (unsigned long)wait);
  }
}

// Foto por MQTT (solo mientras el panel la pide): asi se ve desde internet sin abrir la placa a la red.
void publishSnapshot() {
  if (!camOk || xSemaphoreTake(camMutex, pdMS_TO_TICKS(300)) != pdTRUE) return;
  if (!camOk) {
    xSemaphoreGive(camMutex);
    return;
  }
  camera_fb_t *fb = esp_camera_fb_get();
  bool broken = false;
  if (fb) {
    uint8_t *jb = nullptr; size_t jl = 0;
    const uint8_t *pb = fb->buf; size_t pl = fb->len;
    if (camRaw) { if (frame2jpg(fb, 20, &jb, &jl)) { pb = jb; pl = jl; } else pl = 0; }
    if (pl && mqtt.beginPublish(T_SNAP, pl, false)) {
      size_t w = mqtt.write(pb, pl);
      mqtt.endPublish();
      // Un envio parcial deja el flujo MQTT desincronizado con el broker: hay que reconectar
      if (w != pl) broken = true;
    }
    if (jb) free(jb);
    esp_camera_fb_return(fb);
  }
  xSemaphoreGive(camMutex);
  if (broken) {
    LOGW("mqtt", "snapshot enviado a medias: reconectando");
    mqtt.disconnect();
    mqttUp = false;
    return;
  }
  if (fb) {
    char live[80];
    int n = snprintf(live, sizeof(live), "{\"motion\":%.1f,\"brightness\":%.0f}", (double)motionEma, (double)brightness);
    if (n > 0 && n < (int)sizeof(live)) mqtt.publish(T_LIVE, (const uint8_t *)live, n);
  }
}

void publishTelemetry() {
  JsonDocument d;
  d["rssi"] = WiFi.RSSI();
  d["heap"] = ESP.getFreeHeap();
  d["uptime_s"] = uptimeS();
  d["chip_temp"] = round1(temperatureRead());
  d["brightness"] = round1(brightness);
  d["motion"] = round1(motionEma);
  d["flash"] = flashOn ? 1 : 0;
  d["enabled"] = enabled ? 1 : 0;
  d["cam_ok"] = camOk ? 1 : 0;
  d["reconnects"] = wReconnects;
  char buf[256];
  size_t n = serializeJson(d, buf, sizeof(buf));
  mqtt.publish(T_TELE, (const uint8_t *)buf, n);
}

// ---------- BLE ----------
// Actualiza el valor de la caracteristica de estado (para lecturas) y, si hay alguien, notifica.
void bleNotifyStatus() {
  if (!chStatus) return;
  JsonDocument d;
  buildStatus(d);
  char buf[256];
  size_t n = serializeJson(d, buf, sizeof(buf));
  chStatus->setValue((uint8_t *)buf, n);
  if (bleConnected) chStatus->notify();
}

void bleScanAndNotify() {
  LOGI("ble", "escaneando redes WiFi");
  esp_task_wdt_reset();
  int found = WiFi.scanNetworks(false, false, false, 300);
  esp_task_wdt_reset();
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
    char buf[200];  // un SSID de 32 bytes con caracteres escapados puede ocupar mas de 120
    size_t n = serializeJson(d, buf, sizeof(buf));
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
  LOGI("ble", "escaneo: %d redes", found);
}

void applyConfigJson(const char *js, size_t len) {
  JsonDocument d;
  if (deserializeJson(d, js, len) || !d.is<JsonObject>()) {
    setBleErr("bad_json");
    return;
  }
  bool wifiChanged = false;
  // Validar todo antes de tocar la configuracion: un error no debe dejarla a medias
  String ssid, pass, host, user, mpass;
  int port = 1883;
  bool haveWifi = d["ssid"].is<const char *>();
  bool haveMqtt = d["mqtt"].is<const char *>();
  if (haveWifi) {
    ssid = d["ssid"].as<const char *>();
    pass = d["pass"] | "";
    if (ssid.length() < 1 || ssid.length() > 32) { setBleErr("invalid_ssid"); return; }
    if (pass.length() != 0 && (pass.length() < 8 || pass.length() > 63)) { setBleErr("invalid_pass"); return; }
  }
  if (haveMqtt) {
    host = d["mqtt"].as<const char *>();
    host.trim();
    port = d["port"] | 1883;
    user = d["user"] | "";
    mpass = d["mpass"] | "";
    if (host.length() < 1 || host.length() > 63 || host.indexOf(' ') >= 0) { setBleErr("invalid_mqtt"); return; }
    if (port < 1 || port > 65535) { setBleErr("invalid_port"); return; }
    if (user.length() > 64 || mpass.length() > 128) { setBleErr("invalid_mqtt"); return; }
  }
  if (haveWifi) {
    cfg.ssid = ssid;
    cfg.pass = pass;
    wifiChanged = true;
  }
  if (haveMqtt) {
    cfg.mqttHost = host;
    cfg.mqttPort = port;
    cfg.mqttUser = user;
    cfg.mqttPass = mpass;
    cfg.mqttTls = d["tls"] | false;
    mqtt.disconnect();
    mqttUp = false;
    mqRetry.clear();
    mqFails = 0;
    mqErr = "";
    mqDownSince = 0;
  }
  cfgSave(cfg);
  setBleErr("");
  LOGI("ble", "configuracion guardada (wifi=%d mqtt=%d)", haveWifi, haveMqtt);
  if (wifiChanged) {
    wFails = 0;
    wOfflineSince = 0;
    wReason = "";
    mqtt.disconnect();
    mqttUp = false;
    beginWifi();
  }
}

void handleCommand(char *cmd) {
  // Tolerar espacios o saltos de linea al final
  size_t n = strlen(cmd);
  while (n && isspace((unsigned char)cmd[n - 1])) cmd[--n] = 0;
  LOGI("ble", "comando: %s", cmd);
  bool known = true;
  if (!strcmp(cmd, "scan")) bleScanAndNotify();
  else if (!strcmp(cmd, "retry")) { wFails = 0; wReason = ""; beginWifi(); }
  else if (!strcmp(cmd, "forget")) {
    cfgClear(false);
    cfg.ssid = ""; cfg.pass = "";
    mqtt.disconnect(); mqttUp = false;
    WiFi.disconnect(true);
    wstate = W_IDLE; wReason = "";
  }
  else if (!strcmp(cmd, "factory")) { cfgClear(true); scheduleReboot(300); }
  else if (!strcmp(cmd, "reboot")) { if (paramsDirty) saveParamsNow(); scheduleReboot(300); }
  else if (!strcmp(cmd, "camera")) { if (!safeMode) recoverCamera(); }
  else if (!strcmp(cmd, "ping")) { /* solo fuerza una notificacion */ }
  else known = false;
  setBleErr(known ? "" : "unknown_cmd");
  bleNotifyStatus();
}

class ServerCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *s, ble_gap_conn_desc *desc) override {
    bleConnected = true;
    bleKick = true;
    // Pedir un intervalo de conexion corto mejora la respuesta de la interfaz
    s->updateConnParams(desc->conn_handle, 24, 48, 0, 400);
  }
  void onDisconnect(NimBLEServer *s) override {
    bleConnected = false;
    NimBLEDevice::startAdvertising();
  }
};

// Los callbacks corren en la tarea de NimBLE: copiar a un buffer fijo (sin malloc dentro de la seccion
// critica) y dejar el trabajo a loop().
class CfgCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c) override {
    NimBLEAttValue v = c->getValue();
    size_t n = min((size_t)v.length(), CFG_MAX);
    portENTER_CRITICAL(&bleMux);
    memcpy(pendingCfg, v.data(), n);
    pendingCfg[n] = 0;
    pendingCfgLen = n;
    hasCfg = true;
    portEXIT_CRITICAL(&bleMux);
  }
};

class CmdCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c) override {
    NimBLEAttValue v = c->getValue();
    // Un comando mas largo que CMD_MAX no existe: se trunca y terminara como unknown_cmd
    size_t n = min((size_t)v.length(), CMD_MAX);
    portENTER_CRITICAL(&bleMux);
    memcpy(pendingCmd, v.data(), n);
    pendingCmd[n] = 0;
    pendingCmdLen = n;
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
  bleNotifyStatus();  // valor inicial: una lectura antes de la primera notificacion ya no llega vacia
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(SVC_UUID);
  adv->setScanResponse(true);
  adv->start();
  LOGI("ble", "anunciando como JefeCAM");
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
  Params p;
  paramsLoad(p);
  enabled = p.enabled;
  intervalMs = p.intervalMs;
  gain = p.gain;
  jpegQuality = p.quality;
  noiseFloor = p.noise;
  camMutex = xSemaphoreCreateMutex();
  LOGI("boot", "%s fw %s, reinicio=%s, arranques=%u, psram=%d, heap=%u", DEVICE_ID, FW_VERSION, resetReasonStr(), boots,
       psramFound(), ESP.getFreeHeap());

  if (!safeMode) {
    camOk = initCamera();
    if (!camOk && boots < 3) {  // un reinicio suele arreglar fallos de camara
      delay(500);
      ESP.restart();
    }
    if (!camOk) camRetry.set(30000);
  } else {
    LOGW("boot", "MODO SEGURO: camara desactivada");
    camErr = "";
  }

  startBle();
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(1024);
  mqtt.setSocketTimeout(3);
  // Por defecto TLS espera 30 s al conectar y 120 s el handshake: mas que el watchdog (30 s).
  tlsClient.setTimeout(8);           // segundos
  tlsClient.setHandshakeTimeout(8);  // segundos
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
    static char js[CFG_MAX + 1];
    size_t n;
    portENTER_CRITICAL(&bleMux);
    n = pendingCfgLen;
    memcpy(js, pendingCfg, n + 1);
    hasCfg = false;
    portEXIT_CRITICAL(&bleMux);
    applyConfigJson(js, n);
    bleNotifyStatus();
  }
  if (hasCmd) {
    char c[CMD_MAX + 1];
    portENTER_CRITICAL(&bleMux);
    memcpy(c, pendingCmd, pendingCmdLen + 1);
    hasCmd = false;
    portEXIT_CRITICAL(&bleMux);
    handleCommand(c);
  }
  // Los errores de configuracion/comando BLE caducan para no tapar otros diagnosticos para siempre
  if (bleErr[0] && now - bleErrAt > 30000) bleErr = "";
  if (bleKick || (bleConnected && now - lastBleStatus >= 1500)) {
    bleKick = false;
    lastBleStatus = now;
    bleNotifyStatus();
  }

  if (enabled && now - lastSample >= 500) {
    // Una pausa larga (camara ocupada, comando bloqueante) hace que el cuadro previo sea viejo
    if (now - lastSample > 3000) motionResync = true;
    lastSample = now;
    sampleFrame();
  }
  // Reintento automatico de la camara si quedo caida (no en modo seguro)
  if (!safeMode && !camOk && camRetry.due(now)) {
    camRetry.clear();
    recoverCamera();
    if (camOk) LOGI("cam", "recuperada");
  }
  if (streamWin.pending(now)) {
    if (now - lastSnap >= snapIntervalMs && mqttUp) {
      lastSnap = now;
      publishSnapshot();
    }
  } else {
    streamWin.clear();
  }
  if (now - lastPublish >= intervalMs && mqttUp) {
    lastPublish = now;
    publishTelemetry();
  }
  if (now - lastInfo >= 30000 && mqttUp) {
    lastInfo = now;
    publishInfo();
  }
  // Guardado diferido en NVS: los deslizadores del panel mandan muchos cambios seguidos
  if (paramsDirty && now - paramsDirtyAt > 5000) saveParamsNow();

  if (rebootT.due(now)) {
    LOGW("boot", "reiniciando");
    Serial.flush();
    ESP.restart();
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
    if (!lowSince) {
      lowSince = now ? now : 1;
      LOGW("mem", "heap bajo: %u", ESP.getFreeHeap());
    }
    if (now - lowSince > 60000) {
      LOGE("mem", "heap bajo sostenido: reinicio");
      ESP.restart();
    }
  } else {
    lowSince = 0;
  }
  delay(5);
}
