"""Genera grafana/provisioning/dashboards/jefe.json  (python tools/gen_dashboard.py)."""
import json, os

DS = {"type": "influxdb", "uid": "influx"}
BUCKET = "iot"
panels, state = [], {"y": 0, "x": 0, "row_h": 0, "id": 0}


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


def ts(title, device, fields, unit="", w=8, h=7, desc="", agg=True, minv=None, maxv=None, steps=False):
    last = '|> aggregateWindow(every: ${ventana}, fn: ${agg}, createEmpty: false)' if agg else ""
    flux = f'from(bucket: "{BUCKET}")\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  {flt(device, fields)}\n  {last}'
    custom = {"lineWidth": 1, "fillOpacity": 12, "spanNulls": True, "showPoints": "never"}
    if steps:
        custom["lineInterpolation"] = "stepAfter"
    d = {"unit": unit, "custom": custom}
    if minv is not None: d["min"] = minv
    if maxv is not None: d["max"] = maxv
    panels.append({"type": "timeseries", "title": title, "description": desc, "id": nid(), "datasource": DS, "gridPos": place(w, h),
                   "targets": [target(flux)], "fieldConfig": {"defaults": d, "overrides": []},
                   "options": {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}}})


def stat(title, device, field, unit="", w=4, h=4, mappings=None, thresholds=None, gauge=False, minv=0, maxv=100, calc="lastNotNull"):
    flux = f'from(bucket: "{BUCKET}")\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  {flt(device, [field])}\n  |> last()'
    d = {"unit": unit, "mappings": mappings or [], "thresholds": {"mode": "absolute", "steps": thresholds or [{"color": "green", "value": None}]}}
    if gauge: d.update(min=minv, max=maxv)
    panels.append({"type": "gauge" if gauge else "stat", "title": title, "id": nid(), "datasource": DS, "gridPos": place(w, h),
                   "targets": [target(flux)], "fieldConfig": {"defaults": d, "overrides": []},
                   "options": {"reduceOptions": {"calcs": [calc], "fields": "", "values": False}, "colorMode": "value", "graphMode": "area", "textMode": "auto"}})


def table(title, flux, w=12, h=9, desc=""):
    panels.append({"type": "table", "title": title, "description": desc, "id": nid(), "datasource": DS, "gridPos": place(w, h),
                   "targets": [target(flux)], "fieldConfig": {"defaults": {}, "overrides": []}, "options": {"showHeader": True}})


STATE_MAP = [{"type": "value", "options": {"1": {"text": "ENFOCADO", "color": "green"}, "2": {"text": "DISTRAIDO", "color": "red"}, "3": {"text": "AUSENTE", "color": "blue"}}}]
SRC_MAP = [{"type": "value", "options": {"0": {"text": "REAL", "color": "green"}, "1": {"text": "SIMULADA", "color": "orange"}}}]
ONOFF = [{"type": "value", "options": {"0": {"text": "NO", "color": "red"}, "1": {"text": "SI", "color": "green"}}}]

# ===================== EL JEFE =====================
row("El Jefe: puntaje de productividad (calculado en el servidor)")
stat("Puntaje", "boss", "score", "percent", w=5, h=6, gauge=True, thresholds=[{"color": "red", "value": None}, {"color": "orange", "value": 40}, {"color": "green", "value": 70}])
stat("Estado", "boss", "state", w=4, h=6, mappings=STATE_MAP)
stat("Fuente de datos", "boss", "sim", w=3, h=6, mappings=SRC_MAP)
ts("Puntaje y movimiento (promedio movil)", "boss", ["score", "motion_avg"], w=12, h=6)
ts("Minutos acumulados por estado", "boss", ["focused_min", "distracted_min", "absent_min"], "m", w=12, h=7, agg=True)
ts("% de enfoque acumulado", "boss", ["focus_pct"], "percent", w=12, h=7, minv=0, maxv=100)

# ===================== ESP32-CAM REAL =====================
row("Dispositivo REAL: ESP32-CAM (MQTT/TLS + BLE + HTTP). Si la placa no esta conectada se muestra la simulacion")
ts("Movimiento y brillo de la imagen", "esp32cam-01", ["motion", "brightness"], w=12, h=7, desc="motion 0-100 (diferencia entre frames), brightness 0-255")
ts("Senal WiFi", "esp32cam-01", ["rssi"], "dBm", w=6, h=7)
ts("Temperatura del chip", "esp32cam-01", ["chip_temp"], "celsius", w=6, h=7)
ts("Memoria libre (heap)", "esp32cam-01", ["heap"], "bytes", w=8, h=6)
ts("Tiempo encendida", "esp32cam-01", ["uptime_s"], "s", w=8, h=6)
stat("Camara OK", "esp32cam-01", "cam_ok", w=4, h=6, mappings=ONOFF, thresholds=[{"color": "red", "value": None}, {"color": "green", "value": 1}])
stat("Reconexiones WiFi", "esp32cam-01", "reconnects", w=4, h=6)

# ===================== GEMELOS DIGITALES =====================
row("Gemelos digitales (MQTT) con retroceso: apagar, ajustar y calibrar desde el panel")
ts("Camara virtual de la sala", "cam-sala-twin", ["motion", "brightness", "fps"], w=8, h=7)
ts("Termostato: temperatura por habitacion", "termostato-twin", ["temp_sala", "temp_cuarto", "temp_cocina", "setpoint"], "celsius", w=8, h=7)
ts("Termostato: humedad por habitacion", "termostato-twin", ["hum_sala", "hum_cuarto", "hum_cocina"], "percent", w=8, h=7)
ts("Enchufe: potencia", "enchufe-twin", ["power_w"], "watt", w=8, h=7)
ts("Enchufe: energia acumulada", "enchufe-twin", ["energy_kwh"], "kwatth", w=8, h=7)
ts("Enchufe: voltaje y corriente", "enchufe-twin", ["voltage_v", "current_a"], w=8, h=7)
ts("Puerta, ventana y PIR", "puerta-twin", ["door_open", "window_open", "pir"], w=12, h=7, steps=True, minv=0, maxv=1)
ts("Luz inteligente", "luz-twin", ["on", "brightness_pct", "lux_ambient", "power_w"], w=12, h=7)

# ===================== APIs =====================
row("APIs (HTTP REST): Azure Maps Weather y Open-Meteo")
ts("Azure Maps: temperatura exterior", "api-azure-weather", ["temperature", "real_feel"], "celsius", w=8, h=7)
ts("Azure Maps: humedad y nubes", "api-azure-weather", ["humidity", "cloud_cover"], "percent", w=8, h=7)
ts("Azure Maps: viento y UV", "api-azure-weather", ["wind_kmh", "gust_kmh", "uv_index"], w=8, h=7)
ts("Calidad del aire: PM2.5 y PM10", "api-openmeteo-aq", ["pm2_5", "pm10"], "conμgm3", w=8, h=7)
ts("Calidad del aire: indice AQI (US)", "api-openmeteo-aq", ["us_aqi"], w=8, h=7)
ts("Gases: CO y NO2", "api-openmeteo-aq", ["co_ugm3", "no2_ugm3"], w=8, h=7)

# ===================== DATASETS =====================
row("Datasets reales reproducidos (UCI): energia del hogar y deteccion de ocupacion")
ts("Energia: electrodomesticos y luces", "ds-energia", ["appliances_wh", "lights_wh"], "watth", w=8, h=7)
ts("Energia: temperatura cocina, sala y exterior", "ds-energia", ["t_cocina", "t_sala", "t_exterior"], "celsius", w=8, h=7)
ts("Energia: humedad y viento", "ds-energia", ["rh_cocina", "rh_sala", "viento"], w=8, h=7)
ts("CO2 interior", "ds-co2", ["co2"], "ppm", w=8, h=7)
ts("Luz y temperatura (CO2)", "ds-co2", ["luz", "temperatura"], w=8, h=7)
ts("Ocupacion detectada", "ds-ocupacion", ["ocupado", "luz"], w=8, h=7, steps=True)

# ===================== ESTADISTICAS Y ALERTAS =====================
row("Estadisticas (promedio, maximo y minimo en el rango elegido) y alertas")
stats_flux = f'''data = from(bucket: "{BUCKET}")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "iot" and r.device =~ /^${{device:regex}}$/)
  |> filter(fn: (r) => r._field != "sim" and r._field != "replay" and r._field != "row")
  |> toFloat()
union(tables: [
  data |> mean() |> set(key: "stat", value: "promedio"),
  data |> max() |> set(key: "stat", value: "maximo"),
  data |> min() |> set(key: "stat", value: "minimo"),
  data |> count() |> toFloat() |> set(key: "stat", value: "muestras")
])
  |> group()
  |> pivot(rowKey: ["device", "_field"], columnKey: ["stat"], valueColumn: "_value")
  |> sort(columns: ["device", "_field"])'''
table("Estadisticas por dispositivo y variable (usa el filtro Dispositivo y el selector de tiempo)", stats_flux, w=14, h=12)
alerts_flux = f'''from(bucket: "{BUCKET}")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "alerts")
  |> pivot(rowKey: ["_time", "rule", "severity", "device"], columnKey: ["_field"], valueColumn: "_value")
  |> group()
  |> sort(columns: ["_time"], desc: true)
  |> limit(n: 100)'''
table("Alertas y eventos (reglas del servidor)", alerts_flux, w=10, h=12, desc="Reglas: distraido_prolongado, ausente_largo, co2_alto, temperatura_alta, consumo_alto, puerta_abierta_larga, movimiento_sospechoso, aire_exterior_malo, api_error, fuente_datos")
count_flux = f'''from(bucket: "{BUCKET}")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "alerts" and r._field == "value")
  |> group(columns: ["rule"])
  |> count()
  |> group()'''
panels.append({"type": "barchart", "title": "Alertas por regla", "id": nid(), "datasource": DS, "gridPos": place(24, 7), "targets": [target(count_flux)],
               "fieldConfig": {"defaults": {}, "overrides": []}, "options": {"xField": "rule", "orientation": "horizontal", "legend": {"showLegend": False}}})


def var_custom(name, label, options, default):
    return {"name": name, "label": label, "type": "custom", "query": ",".join(options), "current": {"text": default, "value": default},
            "options": [{"text": o, "value": o, "selected": o == default} for o in options], "hide": 0}


dash = {
    "uid": "jefe-iot", "title": "Jefe IoT", "tags": ["iot", "jefe"], "timezone": "browser", "schemaVersion": 39, "version": 1, "editable": True,
    "refresh": "10s", "time": {"from": "now-6h", "to": "now"}, "graphTooltip": 1, "panels": panels,
    "templating": {"list": [
        var_custom("ventana", "Ventana de agregacion", ["10s", "30s", "1m", "5m", "15m", "1h"], "1m"),
        var_custom("agg", "Funcion", ["mean", "max", "min", "last"], "mean"),
        {"name": "device", "label": "Dispositivo", "type": "query", "datasource": DS, "multi": True, "includeAll": True, "allValue": ".*",
         "query": f'import "influxdata/influxdb/schema"\nschema.tagValues(bucket: "{BUCKET}", tag: "device")',
         "refresh": 2, "current": {"text": "All", "value": "$__all"}, "hide": 0}
    ]},
    "annotations": {"list": []}, "links": []
}

out = os.path.join(os.path.dirname(__file__), "..", "grafana", "provisioning", "dashboards")
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "jefe.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(dash, f, ensure_ascii=False, indent=1)
with open(os.path.join(out, "provider.yml"), "w", encoding="utf-8", newline="\n") as f:
    f.write("apiVersion: 1\nproviders:\n  - name: jefe\n    folder: Jefe IoT\n    type: file\n    allowUiUpdates: true\n    options:\n      path: /etc/grafana/provisioning/dashboards\n")
print("paneles:", len([p for p in panels if p["type"] != "row"]))
