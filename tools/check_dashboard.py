"""Verifica el dashboard de Grafana (grafana/provisioning/dashboards/jefe.json).

Uso:
  python tools/check_dashboard.py                                   # solo estructura (sin Grafana): ids, gridPos, consultas
  python tools/check_dashboard.py http://localhost:3000 usuario clave [rango]
      ademas ejecuta cada consulta Flux (paneles y anotaciones) contra Grafana y reporta errores / paneles vacios.

Sale con codigo 1 si hay errores de estructura o consultas Flux con error (los paneles vacios solo se informan:
por ejemplo, la API de Azure sin clave o un rango sin alertas).
"""
import base64
import json
import os
import sys
import urllib.request

PATH = os.path.join(os.path.dirname(__file__), "..", "grafana", "provisioning", "dashboards", "jefe.json")
VARS = {"${ventana}": "1m", "${agg}": "mean", "${device:regex}": ".*"}


def load():
    with open(PATH, encoding="utf-8") as f:
        return json.load(f)


def static_check(dash):
    errs = []
    ids, cells = set(), {}
    for p in dash["panels"]:
        pid, title = p.get("id"), p.get("title", "?")
        if pid in ids:
            errs.append(f"id repetido {pid} ({title})")
        ids.add(pid)
        g = p.get("gridPos") or {}
        if not all(k in g for k in ("x", "y", "w", "h")) or g["x"] + g["w"] > 24:
            errs.append(f"gridPos invalido en '{title}': {g}")
            continue
        for x in range(g["x"], g["x"] + g["w"]):
            for y in range(g["y"], g["y"] + g["h"]):
                if (x, y) in cells:
                    errs.append(f"'{title}' se superpone con '{cells[(x, y)]}'")
                    break
                cells[(x, y)] = title
            else:
                continue
            break
        if p["type"] == "row":
            continue
        t = p.get("targets") or []
        if not t or not t[0].get("query", "").strip():
            errs.append(f"'{title}' no tiene consulta")
        if (p.get("datasource") or {}).get("uid") != "influx":
            errs.append(f"'{title}' no usa el datasource influx")
        if not p.get("description"):
            errs.append(f"'{title}' no tiene descripcion")
    names = {v["name"] for v in dash.get("templating", {}).get("list", [])}
    for p in dash["panels"]:
        for t in p.get("targets", []):
            for var in ("ventana", "agg", "device"):
                if "${" + var in t.get("query", "") and var not in names:
                    errs.append(f"'{p['title']}' usa ${var} pero la variable no existe")
    return errs


def queries(dash):
    for p in dash["panels"]:
        if p["type"] != "row":
            yield p["title"], p["targets"][0]["query"]
    for a in dash.get("annotations", {}).get("list", []):
        q = (a.get("target") or {}).get("query")
        if q:
            yield "anotacion: " + a.get("name", "?"), q


def live_check(dash, base, user, pwd, rng):
    auth = base64.b64encode(f"{user}:{pwd}".encode()).decode()
    bad = empty = ok = 0
    for title, flux in queries(dash):
        for k, v in VARS.items():
            flux = flux.replace(k, v)
        body = {"from": rng, "to": "now", "queries": [{"refId": "A", "datasource": {"type": "influxdb", "uid": "influx"}, "query": flux,
                                                       "maxDataPoints": 500, "intervalMs": 60000}]}
        req = urllib.request.Request(f"{base.rstrip('/')}/api/ds/query", json.dumps(body).encode(),
                                     {"Content-Type": "application/json", "Authorization": f"Basic {auth}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                res = json.load(r)["results"]["A"]
        except Exception as e:  # noqa: BLE001
            print("ERROR HTTP", title, str(e)[:200])
            bad += 1
            continue
        if res.get("error"):
            print("ERROR FLUX", title, res["error"][:200])
            bad += 1
        elif not res.get("frames") or not any(f["data"]["values"] and f["data"]["values"][0] for f in res["frames"]):
            print("vacio   ", title)
            empty += 1
        else:
            ok += 1
    print(f"\n{ok} consultas con datos, {empty} vacias, {bad} con error")
    return bad


def main():
    dash = load()
    n = len([p for p in dash["panels"] if p["type"] != "row"])
    errs = static_check(dash)
    for e in errs:
        print("ESTRUCTURA", e)
    print(f"Estructura: {n} paneles, {len(errs)} problemas")
    bad = 0
    if len(sys.argv) >= 4:
        bad = live_check(dash, sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "now-1h")
    elif len(sys.argv) > 1:
        print(__doc__)
        return 2
    return 1 if errs or bad else 0


if __name__ == "__main__":
    sys.exit(main())
