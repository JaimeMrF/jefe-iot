'use strict';
// Personalidades: normalizacion, umbral por personalidad y banco de frases
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/personality');
const { createRules } = require('../src/logic');

test('normaliza nombres (mayusculas, espacios, tildes) y rechaza lo demas', () => {
  assert.equal(P.normalizePersonality('Sarcástico'), 'sarcastico');
  assert.equal(P.normalizePersonality('  ESTRICTO '), 'estricto');
  assert.equal(P.normalizePersonality('motivador'), 'motivador');
  for (const bad of ['', 'malvado', 5, null, undefined, {}, 'toString', '__proto__']) assert.equal(P.normalizePersonality(bad), undefined, String(bad));
  assert.equal(P.DEFAULT_PERSONALITY, 'motivador');
});

test('umbral de distraido_prolongado: estricto 30 s, sarcastico 60 s, motivador 90 s', () => {
  assert.equal(P.distractedMsFor('estricto'), 30000);
  assert.equal(P.distractedMsFor('sarcastico'), 60000);
  assert.equal(P.distractedMsFor('motivador'), 90000);
  assert.equal(P.distractedMsFor('otra'), 90000);
});

test('cambiar la personalidad cambia cuando salta la regla', () => {
  const firstAlertAt = (p) => {
    const ev = []; const r = createRules((rule, sev, dev, value) => ev.push({ rule, value }), () => 12);
    r.setThresholds({ distractedMs: P.distractedMsFor(p) });
    for (let s = 0; s <= 120; s += 10) { r.onBoss({ name: 'distracted' }, 1e9 + s * 1000); if (ev.length) return ev[0].value; }
    return null;
  };
  assert.equal(firstAlertAt('estricto'), 30);
  assert.equal(firstAlertAt('sarcastico'), 60);
  assert.equal(firstAlertAt('motivador'), 90);
});

test('setThresholds ignora claves desconocidas y valores no numericos', () => {
  const r = createRules(() => {}, () => 12);
  r.setThresholds({ distractedMs: 'mucho', inventado: 5 });
  assert.equal(r.thresholds.distractedMs, 60000);
  assert.equal('inventado' in r.thresholds, false);
});

test('banco de frases: cada personalidad tiene frases para las alertas del jefe, con el valor y sin insultos', () => {
  const PROHIBIDAS = /idiota|inutil|inútil|estupid|estúpid|tonto|imbecil|imbécil|vago|perdedor/i;
  for (const p of Object.keys(P.PERSONALITIES)) {
    for (const rule of ['distraido_prolongado', 'ausente_largo', 'report', 'logro']) {
      const bank = P.PHRASES[p][rule];
      assert.ok(bank.length >= 2, `${p}/${rule}`);
      for (const f of bank) {
        const s = f(42);
        assert.equal(typeof s, 'string'); assert.ok(s.length > 10);
        assert.equal(PROHIBIDAS.test(s), false, s);
        if (rule === 'distraido_prolongado' || rule === 'ausente_largo') assert.ok(s.includes('42'), s);
      }
    }
  }
  // las tres personalidades suenan distinto
  const first = Object.keys(P.PERSONALITIES).map((p) => P.phrase(p, 'distraido_prolongado', 30, () => 0));
  assert.equal(new Set(first).size, 3);
});

test('phrase: azar inyectable, extremos seguros y null para reglas sin banco', () => {
  const bank = P.PHRASES.estricto.distraido_prolongado;
  assert.equal(P.phrase('estricto', 'distraido_prolongado', 31, () => 0), bank[0](31));
  assert.equal(P.phrase('estricto', 'distraido_prolongado', 31, () => 0.9999), bank.at(-1)(31));
  assert.equal(P.phrase('estricto', 'distraido_prolongado', 31, () => 1), bank.at(-1)(31));
  assert.equal(P.phrase('estricto', 'distraido_prolongado', 31, () => NaN), bank[0](31));
  assert.equal(P.phrase('estricto', 'co2_alto', 1), null);
  assert.equal(P.phrase('desconocida', 'ausente_largo', 5, () => 0), P.PHRASES.motivador.ausente_largo[0](5));
});
