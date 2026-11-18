// Interfaz del jefe: frases, voz, sonidos, chat de excusas, pomodoro, resumen del dia y linea de tiempo.
// Todo vive en el navegador (el calculo de puntaje y las alertas oficiales estan en el servidor).
const store = {
  get: (k, d = '') => { try { return localStorage.getItem('jefe.' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('jefe.' + k, v); } catch { /* sin storage */ } }
};
const pad = (n) => String(n).padStart(2, '0');
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const CODE = { unknown: 0, focused: 1, distracted: 2, absent: 3 };
const COLORS = ['#26324d', '#19ffa0', '#ff3355', '#4a7dff'];

// ---------- Banco de frases ----------
const P = {
  focused: {
    any: ['Mmm... buen ritmo. No te acostumbres.', 'Veo trabajo. Qué sospechoso.', 'Sigue así y quizá te deje respirar.', 'Productividad detectada. Estoy casi emocionado.', 'Eso, así se hace. Pero más rápido.', 'No levantes la vista. Estás en racha.', 'Tecleas bonito. Sigue.', 'Interesante. Casi parece que te pagan por esto.'],
    morning: ['Madrugaste y rindes. Me caes bien, por ahora.', 'Con el café y el enfoque, el día es tuyo.', 'Buenos días, máquina. Sigue así.'],
    afternoon: ['La tarde es dura, pero tú sigues. Respeto.', 'Después del almuerzo y todavía enfocado. Impresionante.', 'Ni el sueño de la tarde te detiene.'],
    night: ['Trabajando de noche... el jefe aprueba y se preocupa.', 'A estas horas solo quedan los valientes y tú.', 'Productivo y trasnochado. Un clásico.']
  },
  distracted: {
    any: ['¿Eso es un celular?', 'Movimiento excesivo. ¿Estás bailando?', 'Vuelve a la pantalla. YA.', 'Te vi. Siempre te veo.', '¿Qué tanto te mueves? Esto no es zumba.', 'Detecto procrastinación de alto nivel.', 'Ese movimiento no es de trabajar, es de huir.', 'Atención: usuario fuera de la tarea.'],
    long: ['Llevas rato distraído. Mi paciencia tiene un límite y es este.', 'Dos minutos de distracción. Dos. Los conté.', 'Esto ya no es un descanso, es un viaje.'],
    repeat: ['Otra vez distraído. Ya perdí la cuenta de tus escapadas.', 'Tres distracciones hoy. El jefe está anotando.', 'Tienes más distracciones que productividad. Y eso es difícil.']
  },
  absent: {
    any: ['¿Dónde estás? El jefe pregunta.', 'Escritorio vacío. Se descuenta ánimo.', 'Silencio sospechoso...', 'Silla vacía detectada. Qué tristeza.', 'Estoy hablándole a una silla. Otra vez.', 'Cuando vuelvas, aquí estaré. Mirando.'],
    long: ['Llevas mucho rato fuera. ¿Te secuestraron o solo hay nevera?', 'Diez minutos sin ti. Mi sensor se siente solo.'],
    lunch: ['Hora de almuerzo, te lo concedo. Pero cronometrado.', 'Ve a comer. Un jefe bueno alimenta a su empleado.'],
    night: ['Qué bueno que descanses. Mañana te vigilo de nuevo.', 'Es tarde. Hasta el jefe se duerme.']
  },
  back: ['Ah, volviste. Te estaba extrañando... un poquito.', 'Bienvenido de vuelta. El trabajo no se hizo solo.', 'Regresó el empleado del mes. Del mes pasado.', 'Te esperaba. Siéntate y a trabajar.'],
  unknown: ['Conecta mi ojo para vigilarte.', 'No veo nada. ¿Está prendida la cámara?'],
  streak: {
    300: ['Cinco minutos seguidos. Un récord... para ti.', 'Cinco minutos de enfoque. Empieza a gustarme esto.'],
    900: ['Quince minutos sin distraerte. Alguien está en modo bestia.', 'Un cuarto de hora de pura productividad. Aplausos metálicos.'],
    1800: ['Media hora de enfoque. Voy a considerar darte un aumento imaginario.', 'Treinta minutos seguidos. Eres peligroso.'],
    3600: ['UNA HORA. El jefe está llorando de orgullo.', 'Una hora entera de enfoque. Eres una leyenda.']
  },
  pomo: {
    start: ['Pomodoro iniciado. Veinticinco minutos de gloria o de lágrimas.', 'A trabajar. Y ni se te ocurra mirar el celular.', 'Empieza el cronómetro. Yo te estoy mirando.'],
    breakStart: ['Descanso merecido. Estírate, toma agua. Cinco minutos.', 'Pausa activada. No me mires, descansa.'],
    breakEnd: ['Se acabó el descanso. De vuelta a la mina.', 'Descanso terminado. ¿Otro pomodoro o te rindes?'],
    done: ['Pomodoro completado. Eres un crack.', 'Ciclo terminado. El jefe aprueba, a regañadientes.'],
    distracted: ['¡En pleno pomodoro y te distraes! Eso cuenta.', 'Pomodoro en curso. Dije en curso. Vuelve.', 'Anotada la distracción. Se resta del resumen final.'],
    paused: ['Pomodoro en pausa. No tardes.']
  }
};
// ---------- Personalidades (contrato v2) ----------
// El banco P de arriba es el tono sarcastico original. Estricto y motivador sustituyen las frases de estado;
// pomodoro y excusas son comunes. Lo que una personalidad no define se toma de P.
export const PERSONALITIES = ['estricto', 'motivador', 'sarcastico'];
export const PERS_INFO = {
  estricto: { name: 'Estricto', limit: 30, voice: { pitch: 0.5, rate: 1.12 } },
  motivador: { name: 'Motivador', limit: 90, voice: { pitch: 1.15, rate: 1.02 } },
  sarcastico: { name: 'Sarcástico', limit: 60, voice: { pitch: 0.75, rate: 0.93 } }
};
const PB = {
  estricto: {
    focused: ['Así se trabaja. Sin pausas.', 'Correcto. Mantén el ritmo.', 'Bien. Ahora sostenlo.', 'Enfocado, como debe ser. No aflojes.', 'Ritmo aceptable. Lo quiero constante.', 'Nada de celebrar todavía. Sigue.', 'Una tarea a la vez. Esa. Termínala.'],
    distracted: ['Distracción detectada. Vuelve a la tarea.', 'Eso no estaba en el plan. A la pantalla.', 'Te quiero en la tarea en tres, dos, uno...', 'Concentración. Ahora.', 'Cada minuto cuenta. Ese no contó.', 'Fuera de la tarea. Corrige el rumbo.'],
    long: ['Demasiado tiempo fuera de la tarea. Retoma ya.', 'Esto pasó de pausa a desvío. Vuelve.', 'Treinta segundos era el límite. Lo superaste.'],
    absent: ['Puesto vacío. Queda anotado.', 'Sin ti en el escritorio no hay avance.', 'Tiempo fuera registrado.', 'El trabajo no avanza solo. Te espero.'],
    back: ['Regresaste. Retoma donde quedaste.', 'De vuelta. Sin rodeos: a trabajar.', 'Bien. El reloj sigue corriendo.'],
    streak: { 300: ['Cinco minutos. Es un comienzo.'], 900: ['Quince minutos. Ahora sostenlo.'], 1800: ['Media hora. Esto es lo que espero de ti.'], 3600: ['Una hora. Bien hecho. Sigue igual.'] },
    logro: ['Logro registrado. No te duermas en los laureles.', 'Objetivo cumplido. Siguiente objetivo.'],
    intro: 'Modo estricto. A los treinta segundos de distracción, te aviso.'
  },
  motivador: {
    focused: ['¡Vas muy bien! Sigue así.', 'Qué buen ritmo llevas. Me encanta verte así.', 'Cada minuto enfocado suma. ¡Tú puedes!', 'Estás construyendo algo grande, paso a paso.', 'Mira ese enfoque. Orgullo de jefe.', 'Respira, sonríe y sigue. Lo estás logrando.'],
    distracted: ['Ey, a todos nos pasa. Volvamos juntos.', 'Pequeña pausa, gran regreso. ¡Vamos!', 'Tu yo del futuro te agradecerá volver ahora.', 'Un respiro y de vuelta. Confío en ti.', 'No pasa nada. Lo importante es retomar.'],
    long: ['Llevas un ratito fuera. ¿Retomamos con algo pequeño?', 'Elige una tarea mini y empieza. Yo te acompaño.'],
    absent: ['Te guardo el puesto. Vuelve cuando estés listo.', 'Descansar también es parte del trabajo.', 'Aquí te espero con energía.'],
    back: ['¡Bienvenido de vuelta! Con todo.', '¡Volviste! Retomemos con energía.', 'Qué bueno verte. ¡A seguir sumando!'],
    streak: { 300: ['¡Cinco minutos seguidos! Buen arranque.'], 900: ['¡Quince minutos! Estás entrando en la zona.'], 1800: ['¡Media hora de foco! Eres imparable.'], 3600: ['¡Una hora entera! Esto merece aplausos.'] },
    logro: ['¡Logro desbloqueado! Te lo ganaste.', '¡Qué orgullo! Uno más para la colección.'],
    intro: 'Modo motivador. Aquí estoy para animarte.'
  },
  sarcastico: {
    logro: ['Un logro. Quién lo diría.', 'Logro desbloqueado. Lo voy a enmarcar... algún día.', 'Mira tú. Resulta que sí sabes trabajar.'],
    intro: 'Modo sarcástico. Prometo no reírme... mucho.'
  }
};
const EXCUSES = [
  [/ba[ñn]o|pip[ií]|caca/i, ['Cinco minutos. Los estoy contando.', 'Hasta el jefe sabe que la naturaleza llama. Pero rapidito.']],
  [/celular|whats|tiktok|insta|mensaje|llamada|telegram/i, ['El celular es el enemigo. Déjalo boca abajo.', 'Excusa rechazada. Eso era scroll, lo vi.', 'Una llamada, ya. Pero que no se vuelva una telenovela.']],
  [/caf[eé]|agua|sed|hambre|comer|almuerzo|desayuno|cena/i, ['Aprobado: hidratarse es productivo. Comer a las 3 am, no.', 'El café sí lo acepto. Es combustible.']],
  [/cansad|sue[ñn]o|dorm|siesta/i, ['El cansancio no es excusa, es un desafío. Pero te dejo parar diez minutos.', 'Si duermes, yo te veo dormir. Y te juzgo.']],
  [/reuni[oó]n|clase|profe|meet|zoom/i, ['Una reunión... que podría haber sido un correo. Aceptada.', 'Clase aprobada. Qué bueno que estudies.']],
  [/estudi|tarea|trabaj|proyecto|parcial|entrega/i, ['Eso sí es serio. Entonces enfócate, no me hables a mí.', 'Si de verdad estás en eso, demuéstralo con el puntaje.']],
  [/perd[oó]n|lo siento|sorry|disculp/i, ['Disculpa aceptada. La próxima no te la pasó.', 'Mmm. Perdonado. El puntaje, no.']],
  [/jaja|jsj|jeje|xd|lol/i, ['¿Te ríes? Yo no programé la risa.', 'Qué risa tan sospechosa. Vuelve al trabajo.']],
  [/odio|tonto|feo|malo|bobo|idiota/i, ['Tus insultos me llegan al circuito. Pero igual te vigilo.', 'Soy una esfera de polígonos. Tus palabras no me hieren. Un poco.']],
  [/hola|buenas|hey|ola/i, ['Hola. Ya te estaba vigilando.', 'Buenas. Qué bueno que vengas a hablar en vez de trabajar... espera.']],
  [/gracias|thx/i, ['De nada. Ahora produce.', 'No me agradezcas, agradece al puntaje.']]
];
const EXCUSE_DEFAULT = {
  focused: ['No te estaba regañando. Sigue así.', 'Hablas pero estás enfocado. Eso me gusta.'],
  distracted: ['Excusa rechazada. Vuelve al trabajo.', 'Qué elocuente para alguien distraído.', 'Interesante teoría. El puntaje dice otra cosa.'],
  absent: ['¿A quién le hablas? No estás.', 'Te escucho desde tu silla vacía. Qué misterio.'],
  unknown: ['No te veo. Pero te oigo. Mal asunto.']
};

// ---------- Utilidades ----------
const recent = new Map();
function pickFrom(key, arr) {
  if (!arr?.length) return '';
  const last = recent.get(key) || []; let c, n = 0;
  do { c = arr[(Math.random() * arr.length) | 0]; n++; } while (last.includes(c) && n < 8);
  last.push(c); if (last.length > Math.min(4, arr.length - 1)) last.shift();
  recent.set(key, last);
  return c;
}
const hourNow = () => new Date().getHours() + new Date().getMinutes() / 60;

// Ajusta el buffer de un canvas a su tamano CSS y a la densidad de pixeles (graficas nitidas, sin estirarse).
// Devuelve { ctx, w, h } en pixeles CSS, o null si el canvas no se ve (p. ej. pestana oculta en movil).
export function fitCanvas(cv) {
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function createBossUI($, scene, log) {
  // ---------- Voz y sonido ----------
  const synth = window.speechSynthesis; // puede no existir (Firefox Android, webviews)
  let voiceOn = store.get('voice') === '1', soundOn = store.get('sound') === '1';
  let ac = null;
  const audio = () => {
    try {
      ac ||= new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume().catch(() => {});
    } catch { ac = null; }
    return ac;
  };
  const tone = (f, t0, dur, type = 'sine', vol = 0.14) => {
    const a = audio(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain(), T = a.currentTime + t0;
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, T); g.gain.linearRampToValueAtTime(vol, T + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, T + dur);
    o.connect(g).connect(a.destination); o.start(T); o.stop(T + dur + 0.05);
  };
  const SFX = {
    alarm() { for (let i = 0; i < 3; i++) tone(880, i * 0.22, 0.16, 'square', 0.1); },
    chime() { tone(659, 0, 0.25); tone(880, 0.18, 0.4); },
    bell() { tone(523, 0, 1, 'triangle', 0.2); tone(784, 0.05, 1, 'triangle', 0.15); tone(1047, 0.1, 1.2, 'triangle', 0.12); },
    blip() { tone(740, 0, 0.12, 'sine', 0.08); },
    fanfare() { [523, 659, 784].forEach((f, i) => tone(f, i * 0.12, 0.16, 'triangle', 0.14)); tone(1047, 0.36, 0.7, 'triangle', 0.16); tone(1319, 0.42, 0.6, 'sine', 0.08); }
  };
  let pers = 'motivador';
  const sound = (n) => { if (soundOn) { try { SFX[n]?.(); } catch { /* sin audio */ } } };
  let voices = [];
  const loadVoices = () => { try { voices = synth?.getVoices() || []; } catch { voices = []; } };
  synth?.addEventListener?.('voiceschanged', loadVoices);
  loadVoices();
  function pickVoice() {
    return voices.find((v) => /^es[-_](CO|MX|US|419)/i.test(v.lang)) || voices.find((v) => /^es/i.test(v.lang));
  }
  function speak(text) {
    if (!voiceOn || !synth) return;
    try {
      const u = new SpeechSynthesisUtterance(text), v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'es-ES';
      const vc = PERS_INFO[pers].voice;
      u.pitch = vc.pitch; u.rate = vc.rate;
      synth.cancel(); synth.speak(u);
    } catch { /* sin voz */ }
  }
  if (!synth) { $('b-voice').disabled = true; $('b-voice').closest('label').title = 'Este navegador no tiene síntesis de voz'; voiceOn = false; }
  $('b-voice').checked = voiceOn; $('b-sound').checked = soundOn;
  $('b-voice').onchange = (e) => {
    voiceOn = e.target.checked; store.set('voice', voiceOn ? '1' : '0');
    if (voiceOn) speak('Voz activada. Ahora sí te regaño en voz alta.'); else { try { synth?.cancel(); } catch { /* nada */ } }
  };
  $('b-sound').onchange = (e) => { soundOn = e.target.checked; store.set('sound', soundOn ? '1' : '0'); if (soundOn) { audio(); sound('chime'); } };

  // ---------- Decir algo: panel + bocadillo 3D + voz ----------
  const bubble = $('bubble'); let bubbleTimer = 0, bubbleRaf = 0;
  function placeBubble() {
    if (!scene?.getBossScreenPos) return;
    const p = scene.getBossScreenPos();
    bubble.classList.toggle('off', !p.visible);
    // mantener el bocadillo dentro de la ventana (en movil o con zoom se salia por los bordes)
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight, m = 10;
    const x = Math.min(Math.max(p.x, bw / 2 + m), innerWidth - bw / 2 - m);
    const y = Math.min(Math.max(p.y, bh + m), innerHeight - m);
    bubble.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
  }
  function followBubble() { // el rAF solo corre mientras el bocadillo esta visible
    placeBubble();
    bubbleRaf = bubble.classList.contains('show') && !document.hidden ? requestAnimationFrame(followBubble) : 0;
  }
  function say(text, { voice = true } = {}) {
    if (!text) return;
    $('boss-say').textContent = text;
    if (scene) {
      bubble.textContent = text;
      placeBubble(); // posicionar antes de mostrar: evita el salto desde la esquina
      bubble.classList.add('show');
      if (!bubbleRaf) bubbleRaf = requestAnimationFrame(followBubble);
      clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => bubble.classList.remove('show'), 9000);
    }
    if (voice) speak(text);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && bubble.classList.contains('show') && !bubbleRaf) bubbleRaf = requestAnimationFrame(followBubble); });

  // ---------- Estadisticas del dia ----------
  let day = null;
  const emptyDay = () => ({ date: todayKey(), m: new Array(1440).fill(0), h: Array.from({ length: 24 }, () => [0, 0, 0]), best: 0, dists: 0 });
  function loadDay() {
    try { const j = JSON.parse(localStorage.getItem('jefe.day.' + todayKey())); if (j?.m?.length === 1440 && j?.h?.length === 24) return j; } catch { /* nada */ }
    return emptyDay();
  }
  const saveDay = () => { try { localStorage.setItem('jefe.day.' + day.date, JSON.stringify(day)); } catch { /* lleno */ } };
  // borrar dias de hace mas de una semana para no llenar el almacenamiento
  try {
    const cut = Date.now() - 7 * 864e5;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i), m = /^jefe\.(day|pomo)\.(\d{4}-\d{2}-\d{2})$/.exec(k || '');
      if (m && new Date(m[2]).getTime() < cut) localStorage.removeItem(k);
    }
  } catch { /* sin storage */ }
  day = loadDay();

  const TXT_DIM = '#8696bb';
  function renderDay() {
    let f = 0, d = 0, a = 0;
    for (const h of day.h) { f += h[0]; d += h[1]; a += h[2]; }
    const tot = f + d + a || 1;
    $('day-f').textContent = `${Math.round(f / 60)} min`; $('day-d').textContent = `${Math.round(d / 60)} min`; $('day-a').textContent = `${Math.round(a / 60)} min`;
    $('day-pct').textContent = `${Math.round((f / tot) * 100)}%`; $('day-best').textContent = `${Math.round(day.best / 60)} min`; $('day-dists').textContent = day.dists;
    $('day-hours').setAttribute('aria-label', `Hoy: ${Math.round(f / 60)} min enfocado, ${Math.round(d / 60)} distraído, ${Math.round(a / 60)} ausente`);
    // barras por hora
    const hc = fitCanvas($('day-hours'));
    if (hc) {
      const { ctx, w: W, h: H } = hc, bw = W / 24, sc = (H - 16) / 3600, curH = new Date().getHours();
      ctx.fillStyle = 'rgba(134,150,187,.08)'; ctx.fillRect(curH * bw, 0, bw, H - 12); // hora actual
      day.h.forEach((h, i) => {
        let y = H - 12;
        [[0, COLORS[1]], [1, COLORS[2]], [2, COLORS[3]]].forEach(([k, c]) => { const bh = h[k] * sc; if (bh <= 0) return; ctx.fillStyle = c; ctx.fillRect(i * bw + 1, y - bh, Math.max(1, bw - 2), bh); y -= bh; });
      });
      ctx.fillStyle = TXT_DIM; ctx.font = '9px system-ui, sans-serif'; ctx.textBaseline = 'alphabetic';
      for (const hh of [0, 6, 12, 18]) ctx.fillText(`${hh}h`, hh * bw + 2, H - 2);
    }
    // linea de tiempo del dia
    const lc = fitCanvas($('day-line'));
    if (lc) {
      const { ctx, w: W, h: H } = lc, mw = W / 1440;
      for (let i = 0; i < 1440; i++) { if (!day.m[i]) continue; ctx.fillStyle = COLORS[day.m[i]]; ctx.fillRect(i * mw, 0, Math.max(1, Math.ceil(mw)), H - 10); }
      const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
      ctx.fillStyle = '#fff'; ctx.fillRect(nowMin * mw, 0, 1.5, H - 10);
      ctx.fillStyle = TXT_DIM; ctx.font = '9px system-ui, sans-serif';
      for (const hh of [0, 6, 12, 18, 24]) ctx.fillText(`${hh}h`, Math.min(hh * 60 * mw, W - 14), H - 1);
    }
  }
  // redibujar al cambiar de tamano (rotar el movil, cambiar de pestana)
  new ResizeObserver(() => renderDay()).observe($('day-hours'));

  // ---------- Pomodoro (con reloj de pared: no se atrasa si el navegador frena los timers en segundo plano) ----------
  const PM = { mode: 'idle', paused: false, endAt: 0, left: 0, total: 0, cfg: [25, 5], focusSec: 0, distSec: 0, absSec: 0, distractions: 0, cycles: +store.get('pomo.' + todayKey(), '0') || 0 };
  const mmss = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  const secsLeft = () => (PM.paused ? PM.left : Math.max(0, Math.ceil((PM.endAt - Date.now()) / 1000)));
  function startPhase(mode, min) { PM.mode = mode; PM.paused = false; PM.total = min * 60; PM.left = PM.total; PM.endAt = Date.now() + PM.total * 1000; }
  function renderPomo() {
    const left = PM.mode === 'idle' ? PM.cfg[0] * 60 : secsLeft();
    $('pomo-time').textContent = mmss(left);
    $('pomo-mode').textContent = PM.mode === 'idle' ? 'Pomodoro' : PM.paused ? 'EN PAUSA' : PM.mode === 'focus' ? 'A TRABAJAR' : 'DESCANSO';
    const box = $('pomo'); box.dataset.mode = PM.mode; box.dataset.paused = PM.paused;
    $('pomo-bar').style.width = PM.mode === 'idle' || !PM.total ? '0%' : `${(100 * (PM.total - left)) / PM.total}%`;
    $('pomo-go').textContent = PM.mode === 'idle' ? 'Iniciar' : PM.mode === 'focus' ? 'Saltar a descanso' : 'Terminar descanso';
    $('pomo-pause').textContent = PM.paused ? 'Seguir' : 'Pausa';
    $('pomo-pause').disabled = $('pomo-reset').disabled = PM.mode === 'idle';
    $('pomo-cfg').disabled = PM.mode !== 'idle';
    $('pomo-stats').textContent = `Hoy: ${PM.cycles} pomodoro${PM.cycles === 1 ? '' : 's'}` + (PM.mode === 'focus' ? ` · distracciones: ${PM.distractions}` : '');
  }
  $('pomo-cfg').onchange = (e) => { PM.cfg = e.target.value.split('-').map(Number); renderPomo(); };
  $('pomo-go').onclick = () => {
    audio();
    if (PM.mode === 'idle') { startPhase('focus', PM.cfg[0]); Object.assign(PM, { focusSec: 0, distSec: 0, absSec: 0, distractions: 0 }); say(pickFrom('pstart', P.pomo.start)); sound('chime'); }
    else if (PM.mode === 'focus') { startPhase('break', PM.cfg[1]); say(pickFrom('pbs', P.pomo.breakStart)); }
    else { PM.mode = 'idle'; PM.paused = false; }
    renderPomo();
  };
  $('pomo-pause').onclick = () => {
    if (PM.mode === 'idle') return;
    if (!PM.paused) { PM.left = secsLeft(); PM.paused = true; say(pickFrom('pp', P.pomo.paused), { voice: false }); }
    else { PM.paused = false; PM.endAt = Date.now() + PM.left * 1000; }
    renderPomo();
  };
  $('pomo-reset').onclick = () => { PM.mode = 'idle'; PM.paused = false; renderPomo(); };
  function pomoTick(st, dt) {
    if (PM.mode === 'idle' || PM.paused) return;
    if (PM.mode === 'focus') {
      if (st === 'focused') PM.focusSec += dt; else if (st === 'distracted') PM.distSec += dt; else if (st === 'absent') PM.absSec += dt;
    }
    if (secsLeft() <= 0) {
      if (PM.mode === 'focus') {
        const pct = Math.min(100, Math.round((PM.focusSec / (PM.total || 1)) * 100));
        PM.cycles++; store.set('pomo.' + todayKey(), String(PM.cycles));
        sound('bell');
        if (pct >= 70) scene?.burst?.();
        say(`${pickFrom('pdone', P.pomo.done)} Enfocado ${pct}% del tiempo, ${PM.distractions} distracciones.`);
        startPhase('break', PM.cfg[1]);
      } else {
        sound('bell'); say(pickFrom('pbe', P.pomo.breakEnd)); PM.mode = 'idle';
      }
    }
    renderPomo();
  }

  // ---------- Chat de excusas ----------
  const chatLog = $('chat-log'); let curState = 'unknown';
  function chatAdd(who, text) {
    const d = document.createElement('div'); d.className = 'm ' + (who === 'Tú' ? 'me' : 'bo');
    const b = document.createElement('b'); b.textContent = who + ': '; d.append(b, document.createTextNode(text));
    chatLog.append(d); while (chatLog.children.length > 8) chatLog.firstChild.remove(); chatLog.scrollTop = chatLog.scrollHeight;
  }
  $('chat-form').onsubmit = (e) => {
    e.preventDefault();
    const inp = $('chat-in'), txt = inp.value.trim(); if (!txt) return;
    inp.value = ''; chatAdd('Tú', txt); audio();
    const hit = EXCUSES.find(([re]) => re.test(txt));
    const reply = hit ? pickFrom('ex' + EXCUSES.indexOf(hit), hit[1]) : pickFrom('exd' + curState, EXCUSE_DEFAULT[curState] || EXCUSE_DEFAULT.unknown);
    setTimeout(() => { chatAdd('Jefe', reply); say(reply); }, 500);
  };

  // ---------- Estado, rachas, alarmas y efectos (1 Hz) ----------
  let prev = 'unknown', stateSec = 0, streak = 0, lastAlarm = 0, lastSayAt = 0, lastChangeSay = 0, renderN = 0, lastTick = 0;
  const STREAKS = [300, 900, 1800, 3600];
  let liveState = null;
  function phraseFor(st) {
    const h = hourNow(), s = P[st] || P.unknown, b = PB[pers];
    if (st === 'unknown') return pickFrom('unk', P.unknown);
    const sarc = pers === 'sarcastico';
    const pool = [...(b[st] || s.any)];
    if (st === 'focused' && pers !== 'estricto') pool.push(...(h < 12 ? s.morning : h < 19 ? s.afternoon : s.night));
    if (st === 'distracted') { if (stateSec >= 120) pool.push(...(b.long || s.long)); if (sarc && day.dists >= 3) pool.push(...s.repeat); }
    if (st === 'absent') { if (sarc && stateSec > 600) pool.push(...s.long); if (h >= 12 && h < 14) pool.push(...s.lunch); if (h >= 22 || h < 6) pool.push(...s.night); }
    return pickFrom(pers + st, pool);
  }
  // record=false (simulacion de la demostracion): reacciona igual, pero no toca las estadisticas guardadas del dia
  function tick(st, { record = true } = {}) {
    const now = Date.now();
    // segundos reales desde el ultimo tick (los timers se frenan en segundo plano); tope para no inventar datos
    const dt = lastTick ? Math.max(1, Math.min(5, Math.round((now - lastTick) / 1000))) : 1;
    lastTick = now; curState = st;
    if (!record && !liveState) {
      liveState = { prev, stateSec, streak, lastAlarm, lastSayAt, lastChangeSay };
      prev = 'unknown'; stateSec = 0; streak = 0;
    } else if (record && liveState) {
      ({ prev, stateSec, streak, lastAlarm, lastSayAt, lastChangeSay } = liveState);
      liveState = null;
    }
    if (todayKey() !== day.date) { saveDay(); day = emptyDay(); }
    // cambio de estado
    if (st !== prev) {
      const was = prev, wasSec = stateSec;
      prev = st; stateSec = 0;
      if (st === 'distracted' && record) { day.dists++; if (PM.mode === 'focus' && !PM.paused) PM.distractions++; }
      if (was === 'focused' && streak >= 60 && record) day.best = Math.max(day.best, streak);
      if (st !== 'focused') streak = 0;
      if (now - lastChangeSay > 8000 && st !== 'unknown') {
        lastChangeSay = now; lastSayAt = now;
        const pomoScold = st === 'distracted' && PM.mode === 'focus' && !PM.paused;
        say(was === 'absent' && wasSec >= 60 && st !== 'absent' ? pickFrom(pers + 'back', PB[pers].back || P.back) : pomoScold ? pickFrom('pd', P.pomo.distracted) : phraseFor(st));
      }
    } else stateSec += dt;
    // minuto, hora y rachas
    if (st !== 'unknown' && record) {
      const d = new Date(), idx = d.getHours() * 60 + d.getMinutes();
      day.m[idx] = day.m[idx] === 2 ? 2 : CODE[st]; // si hubo distraccion en ese minuto, se conserva
      day.h[d.getHours()][CODE[st] - 1] += dt;
    }
    if (st === 'focused') {
      const before = streak; streak += dt;
      const hit = STREAKS.find((s) => before < s && streak >= s);
      if (hit) { say(pickFrom(pers + 'st' + hit, PB[pers].streak?.[hit] || P.streak[hit])); sound('chime'); scene?.burst?.(); }
      if (record) day.best = Math.max(day.best, streak);
    }
    // alarma por distraccion sostenida: el limite depende de la personalidad (como en el servidor) y es mas corto en pomodoro
    const plim = PERS_INFO[pers].limit, limit = PM.mode === 'focus' && !PM.paused ? Math.min(20, plim) : plim;
    if (st === 'distracted' && stateSec >= limit && now - lastAlarm > limit * 1000) {
      lastAlarm = now; sound('alarm');
      const b = PB[pers];
      say(pickFrom(pers + 'long', stateSec >= Math.max(120, limit * 2) ? (b.long || P.distracted.long) : (b.distracted || P.distracted.any)));
    }
    // frase periodica sin voz para que el panel no sea estatico
    if (now - lastSayAt > 30000 && st !== 'unknown') { lastSayAt = now; say(phraseFor(st), { voice: false }); }
    scene?.update?.({ fx: st === 'distracted' ? 'rage' : st === 'absent' ? 'sleep' : null });
    pomoTick(record ? st : 'unknown', dt);
    if (++renderN % 5 === 0 && record) { renderDay(); saveDay(); }
  }
  // Reclamo inmediato por distraccion sostenida (lo usa la demostracion; mismo efecto que la alarma del tick)
  function alarm() {
    lastAlarm = Date.now(); lastSayAt = lastAlarm; sound('alarm');
    const b = PB[pers];
    say(pickFrom(pers + 'long', b.long || P.distracted.long));
  }
  // guardar al cerrar u ocultar la pestana (antes se perdian hasta 5 s)
  const flush = () => saveDay();
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); else renderPomo(); });

  // Alerta del servidor (jefe/<id>/event): sonido segun severidad
  function notify(sev) {
    if (sev === 'critical') sound('alarm'); else if (sev === 'warning') sound('chime'); else sound('blip');
  }

  // ---------- Personalidad ----------
  function setPersonality(p, { announce = false } = {}) {
    if (!PERS_INFO[p]) return;
    pers = p;
    if (announce) { say(PB[p].intro); sound('blip'); }
  }

  // ---------- Logro desbloqueado (evento rule "logro") ----------
  function celebrate(name, { fx = true } = {}) {
    sound('fanfare');
    const line = pickFrom(pers + 'logro', PB[pers].logro || PB.sarcastico.logro);
    say(name ? `${line} «${name}».` : line);
    if (fx) scene?.burst?.(); // burst() ya respeta prefers-reduced-motion
  }

  // ---------- Reporte local (respaldo si el servidor aun no publica jefe/boss/report) ----------
  // Usa los dias guardados en este navegador (se conservan 7). Mismo formato Day del contrato v2.
  function localDay(date) {
    let d = null;
    if (date === day.date) d = day;
    else { try { d = JSON.parse(localStorage.getItem('jefe.day.' + date)); } catch { d = null; } }
    let f = 0, di = 0, a = 0;
    if (d?.h?.length === 24) for (const h of d.h) { f += h[0]; di += h[1]; a += h[2]; }
    const tot = f + di + a;
    return {
      date, focused_min: Math.round(f / 60), distracted_min: Math.round(di / 60), absent_min: Math.round(a / 60),
      focus_pct: tot >= 60 ? Math.round((f / tot) * 100) : 0, distractions: d?.dists || 0, // menos de 1 min: sin porcentaje engañoso
      best_focus_streak_min: Math.round((d?.best || 0) / 60), score_avg: null, xp: null
    };
  }
  function localReport() {
    saveDay();
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const t = new Date(); t.setHours(12, 0, 0, 0); t.setDate(t.getDate() - i);
      week.push(localDay(`${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`));
    }
    return { ts: Date.now(), today: week[6], week };
  }

  renderPomo(); renderDay();
  say(pickFrom('unk', P.unknown), { voice: false });
  return { tick, say, notify, setPersonality, celebrate, localReport, alarm };
}
