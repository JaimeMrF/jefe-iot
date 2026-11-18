# Contrato v2: reportes, gamificación, personalidades y Telegram

Todo es aditivo: los tópicos y campos de v1 no cambian.

## Eventos (`jefe/<id>/event`)
Se añaden dos campos a cada evento: `ts` (epoch en ms) e `id` (string único, por ejemplo `"<ts>-<rule>-<device>"`).

## Personalidad del jefe
- Comando: `jefe/boss/cmd {"personality": "estricto" | "motivador" | "sarcastico"}`. Por defecto es `motivador`.
- Estado: `jefe/boss/state` (retenido, QoS 1) `{"personality": "...", "updated": <ts>}`. Fusiona con lo que ya publique ese tópico, si publica algo.
- Efecto en el servidor: la regla `distraido_prolongado` salta a los 30 s con `estricto`, a los 90 s con `motivador` y a los 60 s con `sarcastico`. El texto `msg` de las alertas del jefe sale de un banco de frases de cada personalidad.
- Efecto en el panel: selector de personalidad. Frases, tono y voz (pitch/rate de speechSynthesis) según la personalidad.
- La personalidad se guarda en disco.

## Gamificación
- `jefe/boss/telemetry` añade dos campos numéricos: `xp` y `level`.
- `jefe/boss/stats` (retenido, QoS 1):
  `{"ts", "xp", "level", "xp_next", "streak_days", "best_streak_days", "current_focus_streak_min", "best_focus_streak_min", "achievements": [{"id", "name", "desc", "ts"}]}`
- Puntos de experiencia:
  - +1 por cada minuto enfocado.
  - +5 extra por cada bloque de 25 min enfocado seguido.
  - Nivel n cuando la xp acumulada llega a 100·n·(n+1)/2.
- Racha de días: días seguidos con `focus_pct` ≥ 60 % y ≥ 60 min enfocado.
- Logros (como mínimo):
  - `primer_foco`: 25 min seguidos.
  - `maraton`: 2 h enfocado en un día.
  - `racha_3`, `racha_7`: rachas de 3 y 7 días.
  - `madrugador`: enfocado antes de las 8 h.
  - `sin_distracciones`: 1 h sin ninguna distracción.
  - `nivel_5`, `nivel_10`.
- Al desbloquear un logro: evento `{rule: "logro", severity: "info", device: "boss", value: <nivel>, msg: "Logro: <name>"}`.

## Reportes
- `jefe/boss/report` (retenido, QoS 1):
  `{"ts", "today": Day, "week": [Day x7, del más antiguo al más reciente], "week_totals": {...}}`
- `Day` = `{"date": "YYYY-MM-DD", "focused_min", "distracted_min", "absent_min", "focus_pct", "distractions", "best_focus_streak_min", "score_avg", "xp"}`
- Se publica cada 60 s y al cambiar de día.
- `GET /report` en el servidor de health (puerto 8081) devuelve el mismo JSON.
- Los días se calculan en la zona horaria `TZ` (variable de entorno; si no existe, la del proceso).

## Telegram (opcional)
- Variables de entorno:
  - `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`. Si falta alguna, Telegram queda desactivado sin errores.
  - `TELEGRAM_MIN_SEVERITY` (por defecto `warning`).
  - `REPORT_HOUR` (por defecto `18`).
  - `REPORT_WEEKDAY` (por defecto `5`, viernes; es la hora y el día del reporte semanal).
- Qué envía:
  - Las alertas con severidad ≥ la mínima, con antispam de 1 mensaje por regla y dispositivo cada 10 min.
  - Los logros.
  - El reporte diario a `REPORT_HOUR` y el semanal el día `REPORT_WEEKDAY`.
- El token nunca aparece en logs ni en eventos.

## Persistencia
- `DATA_DIR`: `/data` en Docker (volumen `bridge-data`); en local, `../data`.
- Archivo `jefe-state.json` con escritura atómica (tmp + rename), guardado cada 60 s y al apagar.
- Si el disco no es escribible: aviso en el log y se sigue en memoria.
