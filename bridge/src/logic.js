'use strict';
// Logica del jefe (estado y puntaje) y motor de reglas/alertas.
const STATE_CODE = { focused: 1, distracted: 2, absent: 3 };

function createBoss() {
  let mAvg = 0, lowSince = 0, state = 'focused', score = 50, last = 0;
  const mins = { focused: 0, distracted: 0, absent: 0 };
  return {
    update(motion, now) {
      const dtMin = last ? Math.min((now - last) / 60000, 2) : 0; last = now;
      mAvg = 0.7 * mAvg + 0.3 * motion;
      if (mAvg < 1.2) { lowSince ||= now; if (now - lowSince > 20000) state = 'absent'; }
      else { lowSince = 0; state = mAvg > 12 ? 'distracted' : 'focused'; }
      mins[state] += dtMin;
      const target = { focused: 100, distracted: 0, absent: 50 }[state];
      score += (target - score) * (1 - Math.pow(0.97, dtMin * 60)); // ~3% por segundo
      const total = mins.focused + mins.distracted + mins.absent || 1;
      return {
        state: STATE_CODE[state], name: state, score: Math.round(score * 10) / 10, motion_avg: Math.round(mAvg * 10) / 10,
        focused_min: Math.round(mins.focused * 10) / 10, distracted_min: Math.round(mins.distracted * 10) / 10, absent_min: Math.round(mins.absent * 10) / 10,
        focus_pct: Math.round((mins.focused / total) * 1000) / 10
      };
    }
  };
}

// emit(rule, severity, device, value, msg)
function createRules(emit, hourFn) {
  const last = {}; const since = {};
  const cool = (k, ms, now) => { if (last[k] && now - last[k] < ms) return false; last[k] = now; return true; };
  const MIN = 60000;
  return {
    onTelemetry(device, f, now) {
      if (device === 'ds-co2' && f.co2 > 1000 && cool('co2', 10 * MIN, now))
        emit('co2_alto', f.co2 > 1500 ? 'critical' : 'warning', device, f.co2, `CO2 en ${Math.round(f.co2)} ppm: ventila el espacio`);
      if (device === 'termostato-twin' && f.temp_sala > 28 && cool('tempalta', 15 * MIN, now))
        emit('temperatura_alta', 'warning', device, f.temp_sala, `Sala a ${f.temp_sala} C`);
      if (device === 'enchufe-twin' && f.power_w > 300 && cool('consumo', 15 * MIN, now))
        emit('consumo_alto', 'info', device, f.power_w, `El enchufe consume ${f.power_w} W`);
      if (device === 'api-openmeteo-aq' && f.us_aqi > 100 && cool('aqi', 60 * MIN, now))
        emit('aire_exterior_malo', 'warning', device, f.us_aqi, `AQI exterior ${f.us_aqi}`);
      if (device === 'puerta-twin') {
        if (f.door_open) { since.door ||= now; if (now - since.door > 10 * MIN && cool('puerta', 30 * MIN, now)) emit('puerta_abierta_larga', 'warning', device, Math.round((now - since.door) / MIN), 'Puerta abierta mas de 10 minutos'); }
        else since.door = 0;
        if (f.door_open && !f.pir && cool('intruso', 10 * MIN, now)) emit('movimiento_sospechoso', 'critical', device, 1, 'Puerta abierta sin presencia detectada');
      }
    },
    onBoss(b, now) {
      if (b.name === 'distracted') { since.dist ||= now; if (now - since.dist >= 60000 && cool('distraido', 5 * MIN, now)) emit('distraido_prolongado', 'warning', 'boss', Math.round((now - since.dist) / 1000), 'El jefe te ve distraido hace mas de 1 minuto'); }
      else since.dist = 0;
      if (b.name === 'absent') { since.abs ||= now; const h = hourFn(now); if (h >= 9 && h < 18 && now - since.abs > 30 * MIN && cool('ausente', 60 * MIN, now)) emit('ausente_largo', 'info', 'boss', Math.round((now - since.abs) / MIN), 'Escritorio vacio mas de 30 minutos en horario laboral'); }
      else since.abs = 0;
    }
  };
}
module.exports = { createBoss, createRules, STATE_CODE };
