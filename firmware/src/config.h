// Configuracion persistente (NVS). Las credenciales WiFi llegan por Bluetooth, no estan en el codigo.
#pragma once
#include <Arduino.h>
#include <Preferences.h>

#define DEVICE_ID "esp32cam-01"
#define FW_VERSION "2.1.0"

// ---------- Logs por Serial con niveles ----------
// 0 = nada, 1 = errores, 2 = + avisos, 3 = + info, 4 = + depuracion. Se puede fijar con -DJEFE_LOG_LEVEL=n.
#ifndef JEFE_LOG_LEVEL
#define JEFE_LOG_LEVEL 3
#endif
#define JLOG_(lvl, ch, tag, fmt, ...) \
  do { if (JEFE_LOG_LEVEL >= (lvl)) Serial.printf("[%7lu][%c][%s] " fmt "\n", (unsigned long)millis(), ch, tag, ##__VA_ARGS__); } while (0)
#define LOGE(tag, fmt, ...) JLOG_(1, 'E', tag, fmt, ##__VA_ARGS__)
#define LOGW(tag, fmt, ...) JLOG_(2, 'W', tag, fmt, ##__VA_ARGS__)
#define LOGI(tag, fmt, ...) JLOG_(3, 'I', tag, fmt, ##__VA_ARGS__)
#define LOGD(tag, fmt, ...) JLOG_(4, 'D', tag, fmt, ##__VA_ARGS__)

struct Config {
  String ssid;
  String pass;
  String mqttHost;
  String mqttUser;
  String mqttPass;
  uint16_t mqttPort = 1883;
  bool mqttTls = false;
  bool hasWifi() const { return ssid.length() > 0; }
};

// Parametros ajustables por MQTT (retroceso). Se guardan en NVS para sobrevivir a reinicios.
// El flash NO se persiste a proposito: el LED se calienta y no debe quedar encendido tras un reinicio.
struct Params {
  bool enabled = true;
  uint32_t intervalMs = 10000;
  float gain = 4.0f;
  int quality = 12;
  uint8_t noise = 0;  // umbral de ruido por pixel (0 = comportamiento original)
};

static Preferences prefs;

inline void cfgLoad(Config &c) {
  prefs.begin("jefe", true);
  c.ssid = prefs.getString("ssid", "");
  c.pass = prefs.getString("pass", "");
  c.mqttHost = prefs.getString("mqtt", "");
  c.mqttPort = prefs.getUShort("port", 1883);
  c.mqttUser = prefs.getString("muser", "");
  c.mqttPass = prefs.getString("mpass", "");
  c.mqttTls = prefs.getBool("tls", false);
  prefs.end();
  if (c.mqttPort == 0) c.mqttPort = 1883;
}

inline void cfgSave(const Config &c) {
  prefs.begin("jefe", false);
  prefs.putString("ssid", c.ssid);
  prefs.putString("pass", c.pass);
  prefs.putString("mqtt", c.mqttHost);
  prefs.putUShort("port", c.mqttPort);
  prefs.putString("muser", c.mqttUser);
  prefs.putString("mpass", c.mqttPass);
  prefs.putBool("tls", c.mqttTls);
  prefs.end();
}

// all=false: olvida solo el WiFi. all=true: borra todo el espacio "jefe" (credenciales, MQTT y parametros).
inline void cfgClear(bool all) {
  prefs.begin("jefe", false);
  if (all) {
    prefs.clear();
  } else {
    prefs.remove("ssid");
    prefs.remove("pass");
  }
  prefs.end();
}

// Los valores leidos se validan: una NVS corrupta no debe dejar parametros fuera de rango.
inline void paramsLoad(Params &p) {
  prefs.begin("jefe", true);
  p.enabled = prefs.getBool("p_en", true);
  p.intervalMs = constrain(prefs.getUInt("p_int", 10000), 1000u, 60000u);
  p.gain = prefs.getFloat("p_gain", 4.0f);
  if (!(p.gain >= 0.5f && p.gain <= 20.0f)) p.gain = 4.0f;  // tambien descarta NaN
  p.quality = constrain((int)prefs.getUChar("p_q", 12), 10, 40);
  p.noise = min<uint8_t>(prefs.getUChar("p_noise", 0), 40);
  prefs.end();
}

inline void paramsSave(const Params &p) {
  prefs.begin("jefe", false);
  prefs.putBool("p_en", p.enabled);
  prefs.putUInt("p_int", p.intervalMs);
  prefs.putFloat("p_gain", p.gain);
  prefs.putUChar("p_q", (uint8_t)p.quality);
  prefs.putUChar("p_noise", p.noise);
  prefs.end();
}

// Proteccion contra bucles de reinicio: se incrementa al arrancar y se borra tras 60 s estable.
inline uint8_t bootCountInc() {
  prefs.begin("jefe", false);
  uint8_t n = prefs.getUChar("boots", 0);
  if (n < 250) n++;
  prefs.putUChar("boots", n);
  prefs.end();
  return n;
}

inline void bootCountClear() {
  prefs.begin("jefe", false);
  prefs.putUChar("boots", 0);
  prefs.end();
}
