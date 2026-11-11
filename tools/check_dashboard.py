"""Ejecuta todas las consultas Flux del dashboard contra Grafana y reporta errores / paneles vacios.
Uso: python tools/check_dashboard.py http://localhost:3000 usuario clave [rango]"""
import base64, json, os, sys, urllib.request

base, user, pwd = sys.argv[1], sys.argv[2], sys.argv[3]
rng = sys.argv[4] if len(sys.argv) > 4 else "now-1h"
dash = json.load(open(os.path.join(os.path.dirname(__file__), "..", "grafana", "provisioning", "dashboards", "jefe.json"), encoding="utf-8"))
auth = base64.b64encode(f"{user}:{pwd}".encode()).decode()
bad = empty = ok = 0
for p in dash["panels"]:
    if p["type"] == "row":
        continue
    flux = p["targets"][0]["query"].replace("${ventana}", "1m").replace("${agg}", "mean").replace("${device:regex}", ".*")
    body = {"from": rng, "to": "now", "queries": [{"refId": "A", "datasource": {"type": "influxdb", "uid": "influx"}, "query": flux, "maxDataPoints": 500, "intervalMs": 60000}]}
    req = urllib.request.Request(f"{base}/api/ds/query", json.dumps(body).encode(), {"Content-Type": "application/json", "Authorization": f"Basic {auth}"})
    try:
        res = json.load(urllib.request.urlopen(req, timeout=60))["results"]["A"]
    except Exception as e:  # noqa: BLE001
        print("ERROR HTTP", p["title"], str(e)[:200]); bad += 1; continue
    if res.get("error"):
        print("ERROR FLUX", p["title"], res["error"][:200]); bad += 1
    elif not res.get("frames") or not any(f["data"]["values"] and f["data"]["values"][0] for f in res["frames"]):
        print("vacio   ", p["title"]); empty += 1
    else:
        ok += 1
print(f"\n{ok} paneles con datos, {empty} vacios, {bad} con error")
sys.exit(1 if bad else 0)
