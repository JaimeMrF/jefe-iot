"""Genera grafana/provisioning/dashboards/jefe.json  (python tools/gen_dashboard.py).

No edites el JSON a mano: cambia este script y vuelve a generarlo (el CI comprueba que esten sincronizados).
Cada serie se describe como F(campo, etiqueta, color, unidad); las etiquetas, colores, unidades y umbrales
se aplican con overrides de Grafana para que las leyendas queden legibles y los colores sean estables.
"""
import json
import os
from collections import namedtuple

DS = {"type": "influxdb", "uid": "influx"}
BUCKET = "iot"
panels, state = [], {"y": 0, "x": 0, "row_h": 0, "id": 0}

F = namedtuple("F", "field label color unit", defaults=(None, None, None))

# Paleta comun (nombres de color de Grafana)
VERDE, ROJO, AZUL, NARANJA, AMARILLO, MORADO, CIAN, GRIS = "green", "red", "blue", "orange", "yellow", "purple", "#5ad1e6", "#8e8e8e"


def nid():
    state["id"] += 1
    return state["id"]


def row(title):
    state["y"] += state["row_h"]
    state.update(x=0, row_h=0)
    panels.append({"type": "row", "title": title, "id": nid(), "collapsed": False, "gridPos": {"h": 1, "w": 24, "x": 0, "y": state["y"]}, "panels": []})
    state["y"] += 1


def place(w, h):
    if state["x"] + w > 24:
        state["y"] += state["row_h"]
        state.update(x=0, row_h=0)
    pos = {"h": h, "w": w, "x": state["x"], "y": state["y"]}
    state["x"] += w
    state["row_h"] = max(state["row_h"], h)
    return pos


def flt(device, fields):
    f = " or ".join(f'r._field == "{x}"' for x in fields)
    return f'|> filter(fn: (r) => r._measurement == "iot" and r.device == "{device}" and ({f}))'


def target(flux):
    return {"datasource": DS, "refId": "A", "query": flux}


def norm(fields):
    return [x if isinstance(x, F) else F(x) for x in fields]


def overrides(fields):
    """Nombre legible, color fijo y unidad por serie (el nombre del campo de Influx es el nombre de la serie)."""
    out = []
    for f in fields:
        props = []
        if f.label:
            props.append({"id": "displayName", "value": f.label})
        if f.color:
            props.append({"id": "color", "value": {"mode": "fixed", "fixedColor": f.color}})
        if f.unit:
            props.append({"id": "unit", "value": f.unit})
        if props:
            out.append({"matcher": {"id": "byName", "options": f.field}, "properties": props})
    return out


def steps(*pairs):
    """steps(("green", None), ("orange", 1000), ("red", 1500)) -> umbrales absolutos de Grafana."""
    return {"mode": "absolute", "steps": [{"color": c, "value": v} for c, v in pairs]}


def ts(title, device, fields, unit="", w=8, h=7, desc="", agg=True, minv=None, maxv=None, stepped=False, thresholds=None, decimals=None):
    fields = norm(fields)
    names = [f.field for f in fields]
    last = '|> aggregateWindow(every: ${ventana}, fn: ${agg}, createEmpty: false)\n  ' if agg else ""
    # keep(): deja solo el nombre del campo como etiqueta de la serie (sin device/topic en la leyenda)
    flux = (f'from(bucket: "{BUCKET}")\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  {flt(device, names)}\n  '
            f'{last}|> keep(columns: ["_time", "_value", "_field"])')
    custom = {"lineWidth": 2, "fillOpacity": 10, "gradientMode": "opacity", "spanNulls": True, "showPoints": "never",
              "thresholdsStyle": {"mode": "dashed" if thresholds else "off"}}
    if stepped:
        custom["lineInterpolation"] = "stepAfter"
    d = {"unit": unit, "custom": custom, "color": {"mode": "palette-classic"}}
    if thresholds:
        d["thresholds"] = thresholds
    if minv is not None:
        d["min"] = minv
    if maxv is not None:
        d["max"] = maxv
    if decimals is not None:
        d["decimals"] = decimals
    panels.append({"type": "timeseries", "title": title, "description": desc, "id": nid(), "datasource": DS, "gridPos": place(w, h),
                   "targets": [target(flux)], "fieldConfig": {"defaults": d, "overrides": overrides(fields)},
                   "options": {"legend": {"displayMode": "list", "placement": "bottom", "calcs": ["lastNotNull"] if len(fields) <= 3 else []},
                               "tooltip": {"mode": "multi", "sort": "none"}}})


def stat(title, device, field, unit="", w=4, h=4, desc="", mappings=None, thresholds=None, gauge=False, minv=0, maxv=100, calc="lastNotNull", decimals=None):
    flux = (f'from(bucket: "{BUCKET}")\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  {flt(device, [field])}\n  '
            f'|> last()\n  |> keep(columns: ["_time", "_value", "_field"])')
    d = {"unit": unit, "mappings": mappings or [], "thresholds": thresholds or steps((VERDE, None)), "color": {"mode": "thresholds"}}
    if gauge:
        d.update(min=minv, max=maxv)
    if decimals is not None:
        d["decimals"] = decimals
    opts = {"reduceOptions": {"calcs": [calc], "fields": "", "values": False}}
    if gauge:
        opts.update(showThresholdMarkers=True, showThresholdLabels=False)
    else:
        # Un solo valor (last): la mini grafica no aporta nada
        opts.update(colorMode="background", graphMode="none", textMode="value", justifyMode="center")
    panels.append({"type": "gauge" if gauge else "stat", "title": title, "description": desc, "id": nid(), "datasource": DS, "gridPos": place(w, h),
                   "targets": [target(flux)], "fieldConfig": {"defaults": d, "overrides": []}, "options": opts})


def table(title, flux, w=12, h=9, desc="", overrides_=None, order=None):
    opts = {"showHeader": True, "cellHeight": "sm"}
    # Flux no garantiza el orden de las columnas: se fija con la transformacion "organize"
    tr = [{"id": "organize", "options": {"indexByName": {c: i for i, c in enumerate(order)}}}] if order else []
    panels.append({"transformations": tr, "type": "table", "title": title, "description": desc, "id": nid(), "datasource": DS, "gridPos": place(w, h),
                   "targets": [target(flux)], "fieldConfig": {"defaults": {"custom": {"filterable": True}}, "overrides": overrides_ or []}, "options": opts})


STATE_MAP = [{"type": "value", "options": {"1": {"text": "ENFOCADO", "color": VERDE, "index": 0}, "2": {"text": "DISTRAIDO", "color": ROJO, "index": 1},
                                           "3": {"text": "AUSENTE", "color": AZUL, "index": 2}}}]
SRC_MAP = [{"type": "value", "options": {"0": {"text": "REAL", "color": VERDE, "index": 0}, "1": {"text": "SIMULADA", "color": NARANJA, "index": 1}}}]
OK_MAP = [{"type": "value", "options": {"0": {"text": "FALLA", "color": ROJO, "index": 0}, "1": {"text": "OK", "color": VERDE, "index": 1}}}]
SCORE_TH = steps((ROJO, None), (NARANJA, 40), (VERDE, 70))

# ===================== EL JEFE =====================
row("El Jefe: puntaje de productividad (calculado en el servidor)")
stat("Puntaje", "boss", "score", "percent", w=5, h=6, gauge=True, thresholds=SCORE_TH, decimals=0,
     desc="Puntaje de productividad 0-100 que calcula el bridge a partir del movimiento de la ESP32-CAM. Rojo < 40, naranja < 70, verde >= 70.")
stat("Estado", "boss", "state", w=4, h=6, mappings=STATE_MAP, thresholds=steps((GRIS, None)),
     desc="Estado actual segun el jefe: ENFOCADO (poco movimiento con presencia), DISTRAIDO (mucho movimiento) o AUSENTE (sin movimiento).")
stat("Fuente de datos", "boss", "sim", w=3, h=6, mappings=SRC_MAP, thresholds=steps((GRIS, None)),
     desc="REAL si la ESP32-CAM esta enviando telemetria; SIMULADA si no llega nada en 90 s y el bridge simula la camara (campo sim=1).")
ts("Puntaje y movimiento (promedio movil)", "boss", [F("score", "Puntaje", VERDE), F("motion_avg", "Movimiento promedio", NARANJA)], "percent",
   w=12, h=6, minv=0, maxv=100, thresholds=SCORE_TH,
   desc="Puntaje del jefe y promedio movil del movimiento detectado (0-100). Las lineas punteadas marcan los umbrales 40 y 70.")
ts("Minutos acumulados por estado", "boss", [F("focused_min", "Enfocado", VERDE), F("distracted_min", "Distraido", ROJO), F("absent_min", "Ausente", AZUL)],
   "m", w=8, h=7, decimals=1, desc="Minutos acumulados en cada estado durante el dia (zona horaria TZ del bridge).")
ts("% de enfoque acumulado", "boss", [F("focus_pct", "Enfoque", VERDE)], "percent", w=8, h=7, minv=0, maxv=100, thresholds=SCORE_TH,
   desc="Porcentaje del tiempo con presencia que se paso ENFOCADO.")
ts("Experiencia y nivel", "boss", [F("xp", "XP", MORADO), F("level", "Nivel (eje derecho)", AMARILLO, "none")], w=8, h=7, agg=True,
   desc="Gamificacion: +1 XP por minuto enfocado y +5 por cada bloque de 25 min seguidos. Nivel n al llegar a 100*n*(n+1)/2 XP. "
        "Los logros aparecen como alertas 'logro' y como anotaciones.")

# ===================== ESP32-CAM REAL =====================
row("Dispositivo REAL: ESP32-CAM (MQTT/TLS + BLE + HTTP). Si la placa no esta conectada se muestra la simulacion")
ts("Movimiento y brillo de la imagen", "esp32cam-01", [F("motion", "Movimiento (0-100)", NARANJA), F("brightness", "Brillo (0-255)", AMARILLO)], w=12, h=7,
   desc="motion 0-100: diferencia entre frames consecutivos. brightness 0-255: brillo medio de la imagen. Fuente: jefe/esp32cam-01/telemetry.")
ts("Senal WiFi", "esp32cam-01", [F("rssi", "RSSI", AZUL)], "dBm", w=6, h=7, thresholds=steps((ROJO, None), (NARANJA, -80), (VERDE, -67)),
   desc="Intensidad de la senal WiFi. Mejor que -67 dBm: buena; entre -80 y -67: aceptable; peor que -80: reconexiones probables.")
ts("Temperatura del chip", "esp32cam-01", [F("chip_temp", "Chip", ROJO)], "celsius", w=6, h=7, thresholds=steps((VERDE, None), (NARANJA, 65), (ROJO, 80)),
   desc="Sensor interno del ESP32 (aproximado, +/- 5 C). Por encima de 80 C conviene ventilar la placa.")
ts("Memoria libre (heap)", "esp32cam-01", [F("heap", "Heap libre", MORADO)], "bytes", w=8, h=6, thresholds=steps((ROJO, None), (VERDE, 30000)),
   desc="Memoria RAM interna libre. Si baja sostenidamente hay una fuga; por debajo de ~30 KB la camara o el TLS pueden fallar.")
ts("Tiempo encendida", "esp32cam-01", [F("uptime_s", "Uptime", CIAN)], "s", w=8, h=6,
   desc="Segundos desde el ultimo arranque de la placa. Una caida a 0 indica un reinicio (revisa el motivo en jefe/esp32cam-01/info).")
stat("Camara OK", "esp32cam-01", "cam_ok", w=4, h=6, mappings=OK_MAP, thresholds=steps((ROJO, None), (VERDE, 1)),
     desc="1 si el sensor de la camara se inicializo y captura frames; 0 si fallo (la placa reintenta sola).")
stat("Reconexiones WiFi", "esp32cam-01", "reconnects", w=4, h=6, thresholds=steps((VERDE, None), (NARANJA, 3), (ROJO, 10)), decimals=0,
     desc="Reconexiones WiFi desde el arranque. Muchas reconexiones = mala senal o router saturado.")

# ===================== GEMELOS DIGITALES =====================
row("Gemelos digitales (MQTT) con retroceso: apagar, ajustar y calibrar desde el panel")
ts("Camara virtual de la sala", "cam-sala-twin", [F("motion", "Movimiento", NARANJA), F("brightness", "Brillo", AMARILLO), F("fps", "FPS", CIAN)], w=8, h=7,
   desc="Gemelo digital de una segunda camara: movimiento 0-100, brillo 0-255 y cuadros por segundo.")
ts("Termostato: temperatura por habitacion", "termostato-twin",
   [F("temp_sala", "Sala", NARANJA), F("temp_cuarto", "Cuarto", MORADO), F("temp_cocina", "Cocina", ROJO), F("setpoint", "Consigna", GRIS)], "celsius", w=8, h=7,
   thresholds=steps((AZUL, None), (VERDE, 18), (ROJO, 28)), desc="Temperatura de cada habitacion y consigna del termostato. Regla temperatura_alta: sala > 28 C.")
ts("Termostato: humedad por habitacion", "termostato-twin", [F("hum_sala", "Sala", NARANJA), F("hum_cuarto", "Cuarto", MORADO), F("hum_cocina", "Cocina", ROJO)],
   "humidity", w=8, h=7, minv=0, maxv=100, desc="Humedad relativa por habitacion (35-85 %).")
ts("Enchufe: potencia", "enchufe-twin", [F("power_w", "Potencia", AMARILLO)], "watt", w=8, h=7, thresholds=steps((VERDE, None), (ROJO, 300)),
   desc="Consumo instantaneo del enchufe inteligente. Sube cuando la camara detecta presencia. Regla consumo_alto: > 300 W.")
ts("Enchufe: energia acumulada", "enchufe-twin", [F("energy_kwh", "Energia", VERDE)], "kwatth", w=8, h=7, decimals=3,
   desc="Energia acumulada por el enchufe desde que arranco el gemelo.")
ts("Enchufe: voltaje y corriente", "enchufe-twin", [F("voltage_v", "Voltaje", AZUL, "volt"), F("current_a", "Corriente", NARANJA, "amp")], w=8, h=7,
   desc="Voltaje de la red (~120 V) y corriente consumida (eje derecho).")
ts("Puerta, ventana y PIR", "puerta-twin", [F("door_open", "Puerta abierta", ROJO), F("window_open", "Ventana abierta", AZUL), F("pir", "PIR (presencia)", VERDE)],
   w=12, h=7, stepped=True, minv=0, maxv=1, decimals=0,
   desc="Sensores binarios (1 = activo). Reglas: puerta_abierta_larga (> 10 min) y movimiento_sospechoso (puerta abierta sin presencia).")
ts("Luz inteligente", "luz-twin", [F("on", "Encendida", AMARILLO, "none"), F("brightness_pct", "Intensidad", NARANJA, "percent"),
                                    F("lux_ambient", "Luz ambiente", CIAN, "lux"), F("power_w", "Potencia", ROJO, "watt")], w=12, h=7,
   desc="Estado, intensidad, iluminacion ambiente y consumo de la luz. En modo auto se enciende cuando hay presencia.")

# ===================== APIs =====================
row("APIs (HTTP REST): Azure Maps Weather y Open-Meteo")
ts("Azure Maps: temperatura exterior", "api-azure-weather", [F("temperature", "Temperatura", NARANJA), F("real_feel", "Sensacion termica", ROJO)], "celsius",
   w=8, h=7, desc="Condiciones actuales de Azure Maps Weather (consulta cada 5 min). Si la API falla, el bridge reenvia el ultimo valor bueno con stale=1 y age_s; "
        "si falta AZURE_MAPS_KEY el panel queda vacio y se registra api_error (api_recuperada cuando vuelve).")
ts("Azure Maps: humedad y nubes", "api-azure-weather", [F("humidity", "Humedad", AZUL), F("cloud_cover", "Nubosidad", GRIS)], "percent", w=8, h=7,
   minv=0, maxv=100, desc="Humedad relativa y porcentaje de cielo cubierto.")
ts("Azure Maps: viento y UV", "api-azure-weather", [F("wind_kmh", "Viento", CIAN, "velocitykmh"), F("gust_kmh", "Rafagas", AZUL, "velocitykmh"),
                                                    F("uv_index", "Indice UV", MORADO, "none")], w=8, h=7,
   desc="Velocidad del viento y rafagas (km/h) e indice UV (eje derecho).")
ts("Calidad del aire: PM2.5 y PM10", "api-openmeteo-aq", [F("pm2_5", "PM2.5", NARANJA), F("pm10", "PM10", MORADO)], "conμgm3", w=8, h=7,
   thresholds=steps((VERDE, None), (NARANJA, 35), (ROJO, 55)), desc="Material particulado de Open-Meteo Air Quality (ug/m3). Referencia PM2.5: > 35 insalubre para grupos sensibles.")
ts("Calidad del aire: indice AQI (US)", "api-openmeteo-aq", [F("us_aqi", "AQI", NARANJA)], w=8, h=7, decimals=0,
   thresholds=steps((VERDE, None), (AMARILLO, 51), (NARANJA, 101), (ROJO, 151)),
   desc="Indice de calidad del aire de EE. UU.: 0-50 bueno, 51-100 moderado, 101-150 insalubre para sensibles, > 150 insalubre. Regla aire_exterior_malo: > 100.")
ts("Gases: CO y NO2", "api-openmeteo-aq", [F("co_ugm3", "CO", GRIS), F("no2_ugm3", "NO2", ROJO)], "conμgm3", w=8, h=7,
   desc="Monoxido de carbono y dioxido de nitrogeno a nivel del suelo (ug/m3).")

# ===================== DATASETS =====================
row("Datasets reales reproducidos (UCI): energia del hogar y deteccion de ocupacion")
ts("Energia: electrodomesticos y luces", "ds-energia", [F("appliances_wh", "Electrodomesticos", AMARILLO), F("lights_wh", "Luces", NARANJA)], "watth", w=8, h=7,
   desc="UCI Appliances Energy Prediction (Candanedo, 2017), reproducido fila a fila cada 15 s.")
ts("Energia: temperatura cocina, sala y exterior", "ds-energia", [F("t_cocina", "Cocina", ROJO), F("t_sala", "Sala", NARANJA), F("t_exterior", "Exterior", AZUL)],
   "celsius", w=8, h=7, desc="Temperaturas del mismo dataset de energia.")
ts("Energia: humedad y viento", "ds-energia", [F("rh_cocina", "Humedad cocina", ROJO, "humidity"), F("rh_sala", "Humedad sala", NARANJA, "humidity"),
                                                F("viento", "Viento", CIAN, "velocityms")], w=8, h=7,
   desc="Humedad relativa interior (%) y velocidad del viento exterior (m/s, eje derecho).")
ts("CO2 interior", "ds-co2", [F("co2", "CO2", MORADO)], "ppm", w=8, h=7, thresholds=steps((VERDE, None), (NARANJA, 1000), (ROJO, 1500)),
   desc="UCI Occupancy Detection (Candanedo y Feldheim, 2016). Regla co2_alto: > 1000 ppm warning, > 1500 ppm critica.")
ts("Luz y temperatura (CO2)", "ds-co2", [F("luz", "Luz", AMARILLO, "lux"), F("temperatura", "Temperatura", ROJO, "celsius")], w=8, h=7,
   desc="Iluminacion (lux) y temperatura del dataset de ocupacion/CO2.")
ts("Ocupacion detectada", "ds-ocupacion", [F("ocupado", "Ocupado", VERDE, "none"), F("luz", "Luz", AMARILLO, "lux")], w=8, h=7, stepped=True,
   desc="Ocupacion real etiquetada (1 = ocupado) y la luz medida en ese momento (eje derecho).")

# ===================== ESTADISTICAS Y ALERTAS =====================
row("Estadisticas (promedio, maximo y minimo en el rango elegido) y alertas")
stats_flux = f'''data = from(bucket: "{BUCKET}")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "iot" and r.device =~ /^${{device:regex}}$/)
  |> filter(fn: (r) => r._field != "sim" and r._field != "replay" and r._field != "row" and r._field != "stale" and r._field != "age_s")
  |> toFloat()
union(tables: [
  data |> mean() |> set(key: "stat", value: "promedio"),
  data |> max() |> set(key: "stat", value: "maximo"),
  data |> min() |> set(key: "stat", value: "minimo"),
  data |> count() |> toFloat() |> set(key: "stat", value: "muestras")
])
  |> group()
  |> pivot(rowKey: ["device", "_field"], columnKey: ["stat"], valueColumn: "_value")
  |> rename(columns: {{_field: "variable", device: "dispositivo"}})
  |> keep(columns: ["dispositivo", "variable", "promedio", "maximo", "minimo", "muestras"])
  |> sort(columns: ["dispositivo", "variable"])'''
table("Estadisticas por dispositivo y variable (usa el filtro Dispositivo y el selector de tiempo)", stats_flux, w=14, h=12,
      desc="Promedio, maximo, minimo y numero de muestras de cada variable en el rango de tiempo elegido. Filtra con la variable Dispositivo.",
      order=["dispositivo", "variable", "promedio", "maximo", "minimo", "muestras"],
      overrides_=[{"matcher": {"id": "byRegexp", "options": "promedio|maximo|minimo"}, "properties": [{"id": "decimals", "value": 2}]},
                  {"matcher": {"id": "byName", "options": "muestras"}, "properties": [{"id": "decimals", "value": 0}]}])
alerts_flux = f'''from(bucket: "{BUCKET}")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "alerts")
  |> pivot(rowKey: ["_time", "rule", "severity", "device"], columnKey: ["_field"], valueColumn: "_value")
  |> drop(fn: (column) => column == "_start" or column == "_stop" or column == "_measurement" or column == "topic" or column == "ts")
  |> group()
  |> sort(columns: ["_time"], desc: true)
  |> limit(n: 100)'''
SEV_MAP = [{"type": "value", "options": {"critical": {"text": "critica", "color": ROJO, "index": 0}, "warning": {"text": "warning", "color": NARANJA, "index": 1},
                                         "info": {"text": "info", "color": AZUL, "index": 2}}}]
table("Alertas y eventos (reglas del servidor)", alerts_flux, w=10, h=12,
      desc="Ultimas 100 alertas. Reglas: distraido_prolongado, ausente_largo, co2_alto, temperatura_alta, consumo_alto, puerta_abierta_larga, "
           "movimiento_sospechoso, aire_exterior_malo, api_error, api_recuperada, fuente_datos, logro",
      order=["_time", "severity", "rule", "device", "value", "msg"],
      overrides_=[{"matcher": {"id": "byName", "options": "severity"}, "properties": [{"id": "mappings", "value": SEV_MAP},
                                                                                     {"id": "custom.cellOptions", "value": {"type": "color-text"}}]},
                  {"matcher": {"id": "byName", "options": "_time"}, "properties": [{"id": "displayName", "value": "hora"}]}])
count_flux = f'''from(bucket: "{BUCKET}")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "alerts" and r._field == "value")
  |> group(columns: ["rule"])
  |> count()
  |> group()
  |> keep(columns: ["rule", "_value"])
  |> rename(columns: {{_value: "alertas"}})
  |> sort(columns: ["alertas"], desc: true)'''
panels.append({"type": "barchart", "title": "Alertas por regla", "description": "Cuantas veces se disparo cada regla en el rango elegido.", "id": nid(),
               "datasource": DS, "gridPos": place(24, 7), "targets": [target(count_flux)],
               "fieldConfig": {"defaults": {"color": {"mode": "fixed", "fixedColor": NARANJA}, "decimals": 0}, "overrides": []},
               "options": {"xField": "rule", "orientation": "horizontal", "showValue": "auto", "legend": {"showLegend": False}}})


def var_custom(name, label, options, default, desc=""):
    return {"name": name, "label": label, "description": desc, "type": "custom", "query": ",".join(options), "current": {"text": default, "value": default},
            "options": [{"text": o, "value": o, "selected": o == default} for o in options], "hide": 0}


# Anotaciones: cada alerta aparece como marca vertical en todas las graficas de tiempo
ANNOT_FLUX = f'''from(bucket: "{BUCKET}")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "alerts" and r._field == "msg")
  |> map(fn: (r) => ({{_time: r._time, text: r.severity + " | " + r.rule + ": " + r._value, tags: r.device}}))'''

dash = {
    "uid": "jefe-iot", "title": "Jefe IoT", "description": "El jefe virtual, la ESP32-CAM real, gemelos digitales, APIs, datasets UCI y alertas.",
    "tags": ["iot", "jefe"], "timezone": "browser", "schemaVersion": 39, "version": 1, "editable": True,
    "refresh": "10s", "time": {"from": "now-6h", "to": "now"}, "graphTooltip": 1, "panels": panels, "liveNow": False,
    "timepicker": {"refresh_intervals": ["10s", "30s", "1m", "5m", "15m"]},
    "templating": {"list": [
        var_custom("ventana", "Ventana de agregacion", ["10s", "30s", "1m", "5m", "15m", "1h"], "1m", "Tamano de la ventana con la que se agregan las series"),
        var_custom("agg", "Funcion", ["mean", "max", "min", "last"], "mean", "Funcion de agregacion de cada ventana"),
        {"name": "device", "label": "Dispositivo", "description": "Filtra la tabla de estadisticas", "type": "query", "datasource": DS, "multi": True,
         "includeAll": True, "allValue": ".*", "query": f'import "influxdata/influxdb/schema"\nschema.tagValues(bucket: "{BUCKET}", tag: "device")',
         "refresh": 2, "sort": 1, "current": {"text": "All", "value": "$__all"}, "hide": 0}
    ]},
    "annotations": {"list": [
        {"builtIn": 1, "datasource": {"type": "grafana", "uid": "-- Grafana --"}, "enable": True, "hide": True, "iconColor": "rgba(0, 211, 255, 1)",
         "name": "Annotations & Alerts", "type": "dashboard"},
        {"datasource": DS, "enable": True, "hide": False, "iconColor": "orange", "name": "Alertas del jefe", "target": {"refId": "Anno", "query": ANNOT_FLUX}}
    ]},
    "links": []
}

out = os.path.join(os.path.dirname(__file__), "..", "grafana", "provisioning", "dashboards")
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "jefe.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(dash, f, ensure_ascii=False, indent=1)
    f.write("\n")
with open(os.path.join(out, "provider.yml"), "w", encoding="utf-8", newline="\n") as f:
    f.write("apiVersion: 1\nproviders:\n  - name: jefe\n    folder: Jefe IoT\n    type: file\n    allowUiUpdates: true\n"
            "    updateIntervalSeconds: 30\n    options:\n      path: /etc/grafana/provisioning/dashboards\n")
print("paneles:", len([p for p in panels if p["type"] != "row"]))
