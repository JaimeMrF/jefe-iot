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

export function createBossUI($, scene, log) {
  // ---------- Voz y sonido ----------
  let voiceOn = store.get('voice') === '1', soundOn = store.get('sound') === '1';
  let ac = null;
  const audio = () => { ac ||= new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); return ac; };
  const tone = (f, t0, dur, type = 'sine', vol = 0.14) => {
    const a = audio(), o = a.createOscillator(), g = a.createGain(), T = a.currentTime + t0;
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, T); g.gain.linearRampToValueAtTime(vol, T + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, T + dur);
    o.connect(g).connect(a.destination); o.start(T); o.stop(T + dur + 0.05);
  };
  const SFX = {
    alarm() { for (let i = 0; i < 3; i++) tone(880, i * 0.22, 0.16, 'square', 0.1); },
    chime() { tone(659, 0, 0.25); tone(880, 0.18, 0.4); },
    bell() { tone(523, 0, 1, 'triangle', 0.2); tone(784, 0.05, 1, 'triangle', 0.15); tone(1047, 0.1, 1.2, 'triangle', 0.12); }
  };
  const sound = (n) => { if (soundOn) { try { SFX[n](); } catch { /* sin audio */ } } };
  function pickVoice() {
    const vs = window.speechSynthesis?.getVoices() || [];
    return vs.find((v) => /^es[-_](CO|MX|US|419)/i.test(v.lang)) || vs.find((v) => /^es/i.test(v.lang));
  }
  function speak(text) {
    if (!voiceOn || !('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text), v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'es-ES';
      u.pitch = 0.6; u.rate = 1.05;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch { /* sin voz */ }
  }
  $('b-voice').checked = voiceOn; $('b-sound').checked = soundOn;
  $('b-voice').onchange = (e) => { voiceOn = e.target.checked; store.set('voice', voiceOn ? '1' : '0'); if (voiceOn) speak('Voz activada. Ahora sí te regaño en voz alta.'); else speechSynthesis?.cancel(); };
  $('b-sound').onchange = (e) => { soundOn = e.target.checked; store.set('sound', soundOn ? '1' : '0'); if (soundOn) sound('chime'); };

  // ---------- Decir algo: panel + bocadillo 3D + voz ----------
  const bubble = $('bubble'); let bubbleTimer = 0;
  function say(text, { voice = true } = {}) {
    if (!text) return;
    $('boss-say').textContent = text;
    bubble.textContent = text; bubble.hidden = false; bubble.classList.add('show');
    clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => bubble.classList.remove('show'), 9000);
    if (voice) speak(text);
  }
  (function followBubble() {
    requestAnimationFrame(followBubble);
    if (!bubble.classList.contains('show') || !scene?.getBossScreenPos) return;
    const p = scene.getBossScreenPos();
    bubble.style.opacity = p.visible ? '' : '0';
    bubble.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`;
  })();

  // ---------- Estadisticas del dia ----------
  let day = null;
  const emptyDay = () => ({ date: todayKey(), m: new Array(1440).fill(0), h: Array.from({ length: 24 }, () => [0, 0, 0]), best: 0, dists: 0 });
  function loadDay() {
    try { const j = JSON.parse(localStorage.getItem('jefe.day.' + todayKey())); if (j?.m?.length === 1440) return j; } catch { /* nada */ }
    return emptyDay();
  }
  const saveDay = () => { try { localStorage.setItem('jefe.day.' + day.date, JSON.stringify(day)); } catch { /* lleno */ } };
  day = loadDay();

  const hourly = $('day-hours').getContext('2d'), line = $('day-line').getContext('2d');
  function renderDay() {
    let f = 0, d = 0, a = 0;
    for (const h of day.h) { f += h[0]; d += h[1]; a += h[2]; }
    const tot = f + d + a || 1;
    $('day-f').textContent = `${Math.round(f / 60)} min`; $('day-d').textContent = `${Math.round(d / 60)} min`; $('day-a').textContent = `${Math.round(a / 60)} min`;
    $('day-pct').textContent = `${Math.round((f / tot) * 100)}%`; $('day-best').textContent = `${Math.round(day.best / 60)} min`; $('day-dists').textContent = day.dists;
    // barras por hora
    let W = $('day-hours').width, H = $('day-hours').height; hourly.clearRect(0, 0, W, H);
    const bw = W / 24;
    day.h.forEach((h, i) => {
      let y = H - 12; const sc = (H - 16) / 3600;
      [[0, COLORS[1]], [1, COLORS[2]], [2, COLORS[3]]].forEach(([k, c]) => { const bh = h[k] * sc; hourly.fillStyle = c; hourly.fillRect(i * bw + 1, y - bh, bw - 2, bh); y -= bh; });
    });
    hourly.fillStyle = '#7f8fb3'; hourly.font = '9px sans-serif';
    for (const hh of [0, 6, 12, 18]) hourly.fillText(`${hh}h`, hh * bw + 2, H - 2);
    // linea de tiempo del dia
    W = $('day-line').width; H = $('day-line').height; line.clearRect(0, 0, W, H);
    const mw = W / 1440;
    for (let i = 0; i < 1440; i++) { if (!day.m[i]) continue; line.fillStyle = COLORS[day.m[i]]; line.fillRect(i * mw, 0, Math.ceil(mw), H - 10); }
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    line.fillStyle = '#fff'; line.fillRect(nowMin * mw, 0, 1.5, H - 10);
    line.fillStyle = '#7f8fb3'; line.font = '9px sans-serif';
    for (const hh of [0, 6, 12, 18, 24]) line.fillText(`${hh}h`, Math.min(hh * 60 * mw, W - 14), H - 1);
  }

  // ---------- Pomodoro ----------
  const PM = { mode: 'idle', paused: false, left: 0, cfg: [25, 5], focusSec: 0, distSec: 0, absSec: 0, distractions: 0, cycles: +store.get('pomo.' + todayKey(), '0'), lastDistSay: 0 };
  const mmss = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  function renderPomo() {
    $('pomo-time').textContent = PM.mode === 'idle' ? mmss(PM.cfg[0] * 60) : mmss(PM.left);
    $('pomo-mode').textContent = PM.mode === 'idle' ? 'Pomodoro' : PM.paused ? 'En pausa' : PM.mode === 'focus' ? 'A TRABAJAR' : 'DESCANSO';
    $('pomo-mode').style.color = PM.mode === 'focus' && !PM.paused ? '#ff3355' : PM.mode === 'break' ? '#19ffa0' : '';
    $('pomo-go').textContent = PM.mode === 'idle' ? 'Iniciar' : 'Saltar';
    $('pomo-pause').textContent = PM.paused ? 'Seguir' : 'Pausa';
    $('pomo-stats').textContent = `Hoy: ${PM.cycles} pomodoro${PM.cycles === 1 ? '' : 's'}` + (PM.mode === 'focus' ? ` · distracciones: ${PM.distractions}` : '');
  }
  $('pomo-cfg').onchange = (e) => { PM.cfg = e.target.value.split('-').map(Number); renderPomo(); };
  $('pomo-go').onclick = () => {
    audio();
    if (PM.mode === 'idle') { Object.assign(PM, { mode: 'focus', paused: false, left: PM.cfg[0] * 60, focusSec: 0, distSec: 0, absSec: 0, distractions: 0 }); say(pickFrom('pstart', P.pomo.start)); sound('chime'); }
    else if (PM.mode === 'focus') { PM.mode = 'break'; PM.left = PM.cfg[1] * 60; say(pickFrom('pbs', P.pomo.breakStart)); }
    else { PM.mode = 'idle'; PM.paused = false; }
    renderPomo();
  };
  $('pomo-pause').onclick = () => { if (PM.mode === 'idle') return; PM.paused = !PM.paused; if (PM.paused) say(pickFrom('pp', P.pomo.paused), { voice: false }); renderPomo(); };
  $('pomo-reset').onclick = () => { PM.mode = 'idle'; PM.paused = false; renderPomo(); };
  function pomoTick(st) {
    if (PM.mode === 'idle' || PM.paused) return;
    PM.left--;
    if (PM.mode === 'focus') {
      if (st === 'focused') PM.focusSec++; else if (st === 'distracted') PM.distSec++; else if (st === 'absent') PM.absSec++;
    }
    if (PM.left <= 0) {
      if (PM.mode === 'focus') {
        const tot = PM.cfg[0] * 60, pct = Math.round((PM.focusSec / tot) * 100);
        PM.cycles++; store.set('pomo.' + todayKey(), String(PM.cycles));
        sound('bell');
        if (pct >= 70) scene?.burst?.();
        say(`${pickFrom('pdone', P.pomo.done)} Enfocado ${pct}% del tiempo, ${PM.distractions} distracciones.`);
        PM.mode = 'break'; PM.left = PM.cfg[1] * 60;
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
  let prev = 'unknown', stateSec = 0, streak = 0, lastAlarm = 0, lastSayAt = 0, lastChangeSay = 0, renderN = 0;
  const STREAKS = [300, 900, 1800, 3600];
  function phraseFor(st) {
    const h = hourNow(), s = P[st] || P.unknown;
    if (st === 'unknown') return pickFrom('unk', P.unknown);
    let pool = [...s.any];
    if (st === 'focused') pool.push(...(h < 12 ? s.morning : h < 19 ? s.afternoon : s.night));
    if (st === 'distracted') { if (stateSec >= 120) pool.push(...s.long); if (day.dists >= 3) pool.push(...s.repeat); }
    if (st === 'absent') { if (stateSec > 600) pool.push(...s.long); if (h >= 12 && h < 14) pool.push(...s.lunch); if (h >= 22 || h < 6) pool.push(...s.night); }
    return pickFrom('ph' + st, pool);
  }
  function tick(st) {
    const now = Date.now(); curState = st;
    if (todayKey() !== day.date) { saveDay(); day = emptyDay(); }
    // cambio de estado
    if (st !== prev) {
      const was = prev, wasSec = stateSec;
      prev = st; stateSec = 0;
      if (st === 'distracted') { day.dists++; if (PM.mode === 'focus' && !PM.paused) PM.distractions++; }
      if (was === 'focused' && streak >= 60) day.best = Math.max(day.best, streak);
      if (st !== 'focused') streak = 0;
      if (now - lastChangeSay > 8000 && st !== 'unknown') {
        lastChangeSay = now; lastSayAt = now;
        const pomoScold = st === 'distracted' && PM.mode === 'focus' && !PM.paused;
        say(was === 'absent' && wasSec >= 60 && st !== 'absent' ? pickFrom('back', P.back) : pomoScold ? pickFrom('pd', P.pomo.distracted) : phraseFor(st));
      }
    } else stateSec++;
    // minuto, hora y rachas
    if (st !== 'unknown') {
      const d = new Date(), idx = d.getHours() * 60 + d.getMinutes();
      day.m[idx] = day.m[idx] === 2 ? 2 : CODE[st]; // si hubo distraccion en ese minuto, se conserva
      day.h[d.getHours()][CODE[st] - 1]++;
    }
    if (st === 'focused') {
      streak++;
      if (STREAKS.includes(streak)) { say(pickFrom('st' + streak, P.streak[streak]), {}); sound('chime'); scene?.burst?.(); }
      day.best = Math.max(day.best, streak);
    }
    // alarma por distraccion sostenida (mas estricta en pomodoro)
    const limit = PM.mode === 'focus' && !PM.paused ? 20 : 60;
    if (st === 'distracted' && stateSec >= limit && now - lastAlarm > limit * 1000) { lastAlarm = now; sound('alarm'); say(pickFrom('long', stateSec >= 120 ? P.distracted.long : P.distracted.any)); }
    // frase periodica sin voz para que el panel no sea estatico
    if (now - lastSayAt > 30000 && st !== 'unknown') { lastSayAt = now; say(phraseFor(st), { voice: false }); }
    scene?.update?.({ fx: st === 'distracted' ? 'rage' : st === 'absent' ? 'sleep' : null });
    pomoTick(st);
    if (++renderN % 5 === 0) { renderDay(); saveDay(); }
  }

  renderPomo(); renderDay();
  if ('speechSynthesis' in window) speechSynthesis.getVoices();
  say(pickFrom('unk', P.unknown), { voice: false });
  return { tick, say };
}
