// Configuracion persistente (NVS). Las credenciales WiFi llegan por Bluetooth, no estan en el codigo.
#pragma once
#include <Arduino.h>
#include <Preferences.h>

#define DEVICE_ID "esp32cam-01"
#define FW_VERSION "2.0.0"

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

inline void cfgClear(bool all) {
  prefs.begin("jefe", false);
  prefs.remove("ssid");
  prefs.remove("pass");
  if (all) {
    prefs.remove("mqtt");
    prefs.remove("port");
    prefs.remove("muser");
    prefs.remove("mpass");
    prefs.remove("tls");
  }
  prefs.end();
}

// Proteccion contra bucles de reinicio: se incrementa al arrancar y se borra tras 60 s estable.
inline uint8_t bootCountInc() {
  prefs.begin("jefe", false);
  uint8_t n = prefs.getUChar("boots", 0) + 1;
  prefs.putUChar("boots", n);
  prefs.end();
  return n;
}

inline void bootCountClear() {
  prefs.begin("jefe", false);
  prefs.putUChar("boots", 0);
  prefs.end();
}
