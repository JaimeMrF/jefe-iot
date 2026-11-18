'use strict';
// Personalidades del jefe: umbral de "distraido prolongado" y banco de frases en espanol.
// Con gracia, sin insultos. Funciones puras (el azar se inyecta).
const PERSONALITIES = {
  estricto: { label: 'Estricto', distractedMs: 30000 },
  motivador: { label: 'Motivador', distractedMs: 90000 },
  sarcastico: { label: 'Sarcástico', distractedMs: 60000 }
};
const DEFAULT_PERSONALITY = 'motivador';

// Acepta mayusculas, espacios y tildes ("Sarcástico") => clave canonica, o undefined
function normalizePersonality(v) {
  if (typeof v !== 'string') return undefined;
  const k = v.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return Object.prototype.hasOwnProperty.call(PERSONALITIES, k) ? k : undefined;
}

// Cada frase recibe el `value` del evento: segundos (distraido) o minutos (ausente)
const PHRASES = {
  estricto: {
    distraido_prolongado: [
      (v) => `Llevas ${v} s distraído. Vuelve a la tarea ahora mismo.`,
      (v) => `${v} segundos fuera de foco. Esto no es negociable: concéntrate.`,
      (v) => `Distracción detectada hace ${v} s. El trabajo no se hace solo.`,
      (v) => `Alto ahí: ${v} s sin foco. Cierra lo que no toca y sigue.`
    ],
    ausente_largo: [
      (v) => `Escritorio vacío hace ${v} min en horario laboral. Se espera tu regreso.`,
      (v) => `${v} minutos de ausencia registrados. Queda anotado en el informe.`,
      (v) => `Tu silla lleva ${v} min sola. Vuelve a tu puesto.`
    ],
    report: [
      () => 'Resumen de la jornada. Los números no mienten.',
      () => 'Informe del día. Mañana se exige más.',
      () => 'Balance del día, sin rodeos.'
    ],
    logro: [
      () => 'Correcto. Ahora mantén el nivel.',
      () => 'Logro registrado. No te relajes.'
    ]
  },
  motivador: {
    distraido_prolongado: [
      (v) => `¡Tú puedes! Llevas ${v} s distraído: respira y vuelve a lo tuyo.`,
      (v) => `Pausa de ${v} s detectada. ¡Un empujón más y recuperas el ritmo!`,
      (v) => `Te noto disperso hace ${v} s. Elige una sola tarea y dale, que vas bien.`,
      (v) => `¡Ánimo! ${v} s fuera de foco no borran todo lo que llevas hecho.`
    ],
    ausente_largo: [
      (v) => `Hace ${v} min que no te veo. Cuando vuelvas, retomamos con energía.`,
      (v) => `${v} min de pausa. ¡Descansar también cuenta! Te espero de vuelta.`,
      (v) => `El escritorio te extraña hace ${v} min. ¡A por la siguiente sesión!`
    ],
    report: [
      () => '¡Así va tu día! Cada minuto de foco suma.',
      () => '¡Buen trabajo! Mira todo lo que llevas.',
      () => 'Tu progreso de hoy. ¡Mañana, a por más!'
    ],
    logro: [
      () => '¡Enhorabuena! Te lo has ganado.',
      () => '¡Increíble! Sigue así.'
    ]
  },
  sarcastico: {
    distraido_prolongado: [
      (v) => `${v} s distraído. Seguro era algo urgentísimo, como mirar el techo.`,
      (v) => `Fascinante: ${v} segundos de productividad creativa. Ahora, la de verdad.`,
      (v) => `Llevas ${v} s distraído. El trabajo sigue ahí, por si te lo preguntabas.`,
      (v) => `Ah, ${v} s de "investigación" en el móvil. Muy enriquecedor.`
    ],
    ausente_largo: [
      (v) => `${v} min sin verte. ¿Teletrabajo desde la cafetería?`,
      (v) => `La silla lleva ${v} min trabajando sola. Le subiré el sueldo a ella.`,
      (v) => `${v} min de ausencia. Supongo que la reunión con la nevera se alargó.`
    ],
    report: [
      () => 'El informe que nadie pidió, pero aquí está.',
      () => 'Tus estadísticas. Prometo no enmarcarlas... todavía.',
      () => 'Resumen del día, con cariño y una ceja levantada.'
    ],
    logro: [
      () => 'Vaya, quién lo diría. Bien hecho.',
      () => 'Mira tú. Hasta me has sorprendido.'
    ]
  }
};

// Frase de la personalidad para una regla, o null si no hay banco para ella
function phrase(personality, rule, value, random = Math.random) {
  const bank = (PHRASES[personality] || PHRASES[DEFAULT_PERSONALITY])[rule];
  if (!bank || !bank.length) return null;
  const r = Number(random());
  const i = Math.min(bank.length - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * bank.length)));
  return bank[i](value);
}

const distractedMsFor = (p) => (PERSONALITIES[p] || PERSONALITIES[DEFAULT_PERSONALITY]).distractedMs;

module.exports = { PERSONALITIES, DEFAULT_PERSONALITY, PHRASES, normalizePersonality, phrase, distractedMsFor };
