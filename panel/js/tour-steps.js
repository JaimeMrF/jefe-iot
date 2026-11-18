// Contenido del modo demostracion: capitulos, pasos, oradores y guion (campo notes).
// Solo datos y HTML estatico; el motor (tour.js) decide como mostrarlos y ejecuta las acciones locales.

export const AUTHORS = ['Jaime Alejandro Vega Barbosa', 'Juan Sebastian Jimenez Daza', 'David Santiago Gonzalez Nigrinis'];
export const LEMA = 'Un jefe virtual que vigila tu escritorio con una ESP32-CAM, piensa en la nube y te habla en 3D.';
export const SITE = 'jefeiot.duckdns.org';

export const SPEAKERS = {
  Santiago: { cls: 'sp-santiago' },
  Jaime: { cls: 'sp-jaime' },
  Juan: { cls: 'sp-juan' }
};

export const CHAPTERS = {
  1: 'La historia',
  2: 'Demo en vivo',
  3: 'Cómo funciona por dentro',
  4: 'Lo nuevo',
  5: 'Seguridad y despliegue',
  6: 'Cierre'
};

// ---------- Piezas reutilizables ----------
const authorsHtml = (cls = 't-authors') => `<ul class="${cls}">${AUTHORS.map((a, i) => `<li class="tz" style="--i:${i + 3}">${a}</li>`).join('')}</ul>`;

const EYE_SVG = `<svg class="t-eye" viewBox="0 0 200 200" aria-hidden="true" focusable="false">
  <defs><radialGradient id="t-eye-g" cx="50%" cy="45%" r="55%"><stop offset="0" stop-color="#19ffa0" stop-opacity=".35"/><stop offset="1" stop-color="#19ffa0" stop-opacity="0"/></radialGradient></defs>
  <circle cx="100" cy="100" r="96" fill="url(#t-eye-g)"/>
  <polygon class="t-eye-ico" points="100,22 168,61 168,139 100,178 32,139 32,61" />
  <polygon class="t-eye-ico t-eye-ico2" points="100,36 156,68 156,132 100,164 44,132 44,68" />
  <g class="t-eye-face"><rect x="62" y="70" width="30" height="7" rx="3"/><rect x="108" y="70" width="30" height="7" rx="3"/>
  <circle class="t-eye-pupil" cx="77" cy="96" r="10"/><circle class="t-eye-pupil" cx="123" cy="96" r="10"/>
  <path d="M76 132 Q100 148 124 132" fill="none" stroke-width="7" stroke-linecap="round"/></g>
</svg>`;

const ICON = {
  eye: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M4 24s7-13 20-13 20 13 20 13-7 13-20 13S4 24 4 24z" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="24" cy="24" r="6" fill="currentColor"/></svg>',
  brain: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M14 34a8 8 0 0 1-2-15.7A10 10 0 0 1 31 13a9 9 0 0 1 5 16.5V34z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M18 34v6M24 34v6M30 34v6" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M19 24h4l2-4 3 8 2-4h3" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  talk: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 10h32a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H22l-9 7v-7H8a3 3 0 0 1-3-3V13a3 3 0 0 1 3-3z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><circle cx="16" cy="21.5" r="2.6" fill="currentColor"/><circle cx="24" cy="21.5" r="2.6" fill="currentColor"/><circle cx="32" cy="21.5" r="2.6" fill="currentColor"/></svg>',
  lock: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="9" y="21" width="30" height="21" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M15 21v-6a9 9 0 0 1 18 0v6" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="24" cy="31" r="3" fill="currentColor"/></svg>',
  shield: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 5l16 6v11c0 10-7 18-16 21C15 40 8 32 8 22V11z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M17 24l5 5 9-10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  key: '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="16" cy="24" r="8" fill="none" stroke="currentColor" stroke-width="3"/><path d="M24 24h18M36 24v7M42 24v5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  box: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 5l17 9v20l-17 9-17-9V14z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M7 14l17 9 17-9M24 23v20" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>',
  head: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 12h36M6 24h24M6 36h30" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="38" cy="30" r="5" fill="none" stroke="currentColor" stroke-width="3"/></svg>',
  cam: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="13" width="28" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M33 21l10-6v18l-10-6z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>',
  ble: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M14 15l20 18-10 9V6l10 9-20 18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  wifi: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 19a26 26 0 0 1 36 0M12 26a17 17 0 0 1 24 0M18 33a8 8 0 0 1 12 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="24" cy="39" r="2.8" fill="currentColor"/></svg>',
  chip: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="13" y="13" width="22" height="22" rx="3" fill="none" stroke="currentColor" stroke-width="3"/><path d="M19 6v7M29 6v7M19 35v7M29 35v7M6 19h7M6 29h7M35 19h7M35 29h7" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  refresh: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M38 18A15 15 0 0 0 10 20M10 30a15 15 0 0 0 28-2" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M38 8v10H28M10 40V30h10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  test: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M18 5h12M20 5v13L9 39a3 3 0 0 0 3 4h24a3 3 0 0 0 3-4L28 18V5" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M14 31h20" stroke="currentColor" stroke-width="3"/></svg>'
};
const ico = (k) => `<span class="t-ico">${ICON[k]}</span>`;

// ---------- Diagrama de arquitectura (SVG con puntos que fluyen por las conexiones) ----------
const node = (x, y, w, h, title, sub = '', cls = '') => `<g class="t-node ${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14"/>
  <text x="${x + w / 2}" y="${y + (sub ? h / 2 - 6 : h / 2 + 8)}" class="t-n1">${title}</text>${sub ? `<text x="${x + w / 2}" y="${y + h / 2 + 24}" class="t-n2">${sub}</text>` : ''}</g>`;
const wire = (id, d, cls, dots = 2, dur = 2.4) => `<path id="${id}" d="${d}" class="t-wire ${cls}"/>` +
  Array.from({ length: dots }, (_, i) => `<circle r="6.5" class="t-dot ${cls}"><animateMotion dur="${dur}s" begin="${(-i * dur) / dots}s" repeatCount="indefinite" rotate="auto"><mpath href="#${id}"/></animateMotion></circle>`).join('');
const ARCH_SVG = `<svg class="t-arch" viewBox="0 0 1400 680" role="img" aria-label="Arquitectura: la ESP32-CAM y el panel entran al VPS solo por el puerto 443 (nginx por SNI). Dentro: Mosquitto, Caddy, el bridge en Node.js, Telegraf, InfluxDB 2 y Grafana. El bridge consulta Azure Maps, Open-Meteo, los datasets UCI y envía a Telegram.">
  <text x="150" y="34" class="t-col">BORDE</text>
  <text x="700" y="34" class="t-col">VPS · DOCKER COMPOSE</text>
  <text x="1245" y="34" class="t-col">EXTERNOS</text>
  <rect x="340" y="56" width="720" height="604" rx="24" class="t-vps"/>
  ${wire('tw-ble', 'M100 240 L100 430', 'ble', 2, 2.8)}
  <text x="114" y="342" class="t-wl ble" text-anchor="start">BLE GATT</text>
  <text x="114" y="366" class="t-wl dim" text-anchor="start">aprovisionamiento</text>
  ${wire('tw-c1', 'M280 175 C 330 175, 320 310, 370 310', 'mqtt')}
  ${wire('tw-c2', 'M280 495 C 330 495, 320 370, 370 370', 'wss')}
  ${wire('tw-c3', 'M560 310 C 590 310, 580 170, 610 170', 'mqtt')}
  ${wire('tw-c4', 'M560 370 C 590 370, 580 510, 610 510', 'wss')}
  ${wire('tw-c5', 'M710 450 L710 230', 'wss', 2, 2)}
  ${wire('tw-c6', 'M810 140 L850 140', 'mqtt', 1, 1.2)}
  ${wire('tw-c6b', 'M850 172 L810 172', 'mqtt', 1, 1.2)}
  ${wire('tw-c7', 'M810 205 C 832 205, 828 290, 850 290', 'mqtt', 1, 1.6)}
  ${wire('tw-c8', 'M945 330 L945 362', 'int', 1, 1)}
  ${wire('tw-c9', 'M945 440 L945 472', 'int', 1, 1)}
  ${wire('tw-c10', 'M810 520 L850 520', 'wss', 1, 1.2)}
  ${wire('tw-e1', 'M1040 112 C 1075 112, 1075 130, 1110 130', 'http', 1, 1.8)}
  ${wire('tw-e2', 'M1040 150 C 1075 150, 1075 230, 1110 230', 'http', 1, 1.8)}
  ${wire('tw-e3', 'M1110 330 C 1075 330, 1075 185, 1040 185', 'http', 1, 2)}
  ${wire('tw-e4', 'M1040 200 C 1090 220, 1070 520, 1110 520', 'http', 2, 2.6)}
  ${node(20, 110, 260, 130, 'ESP32-CAM', 'placa real', 'edge')}
  ${node(20, 430, 260, 130, 'Panel 3D', 'navegador', 'edge')}
  ${node(370, 270, 190, 140, 'nginx :443', 'enruta por SNI', 'hot')}
  <g class="t-pill"><rect x="380" y="222" width="170" height="34" rx="17"/><text x="465" y="245">1 puerto público</text></g>
  ${node(610, 110, 200, 120, 'Mosquitto', 'MQTT · ACL · TLS')}
  ${node(610, 450, 200, 120, 'Caddy', 'HTTPS · panel · WSS')}
  ${node(850, 90, 190, 120, 'bridge', 'Node.js · reglas')}
  ${node(850, 250, 190, 80, 'Telegraf')}
  ${node(850, 362, 190, 78, 'InfluxDB 2')}
  ${node(850, 472, 190, 100, 'Grafana', '37 paneles')}
  ${node(1110, 90, 270, 80, 'Azure Maps', '', 'ext')}
  ${node(1110, 190, 270, 80, 'Open-Meteo', '', 'ext')}
  ${node(1110, 290, 270, 80, 'Datasets UCI', '', 'ext')}
  ${node(1110, 470, 270, 100, 'Telegram', 'alertas · reportes', 'ext')}
  <text x="945" y="612" class="t-wl dim" text-anchor="middle">gemelos · jefe · alertas</text>
</svg>`;

// ---------- Datos de ejemplo (solo demostracion; nunca se publican) ----------
export function sampleProgress() {
  const pad = (n) => String(n).padStart(2, '0');
  const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = Date.now();
  const rows = [[180, 35, 40, 6, 72], [95, 50, 60, 11, 54], [240, 20, 25, 3, 84], [60, 15, 30, 4, 66], [130, 45, 70, 8, 61], [205, 25, 30, 4, 79], [252, 38, 34, 6, 81]];
  const week = rows.map(([f, d, a, n, sc], i) => {
    const t = new Date(); t.setHours(12, 0, 0, 0); t.setDate(t.getDate() - (6 - i));
    return { date: key(t), focused_min: f, distracted_min: d, absent_min: a, focus_pct: Math.round((f / (f + d + a)) * 100), distractions: n, best_focus_streak_min: Math.round(f / 4.8), score_avg: sc, xp: f + Math.floor(f / 25) * 5 };
  });
  const day = 864e5;
  return {
    stats: {
      ts: now, xp: 1180, level: 4, xp_next: 1500, streak_days: 3, best_streak_days: 5, current_focus_streak_min: 42, best_focus_streak_min: 87,
      achievements: [
        { id: 'primer_foco', ts: now - 6 * day }, { id: 'madrugador', ts: now - 4 * day },
        { id: 'maraton', ts: now - 2 * day }, { id: 'racha_3', ts: now - 3600e3 }
      ]
    },
    report: { ts: now, today: week[6], week }
  };
}

// ---------- Pasos ----------
// type 'chapter': tarjeta a pantalla completa (html). type 'focus': resalta un elemento real (selector) con un globo (body).
// view: vista 3D · tab: pestana en movil · dim: full | light | none · place: lado preferido del globo
// run: escenario local del director (states | alerts | personality | achievement | report) · live: ofrecer "hacerlo en vivo"
export const STEPS = [
  // ===== Capitulo 1 · La historia =====
  {
    id: 'portada', ch: 1, speaker: 'Santiago', type: 'chapter', bare: true, view: 'overview', title: 'Jefe·IoT',
    html: `<div class="t-cover">
      ${EYE_SVG}
      <h1 class="t-brand tz" style="--i:0">JEFE<b>·</b>IOT</h1>
      <p class="t-lema tz" style="--i:1">${LEMA}</p>
      ${authorsHtml()}
      <p class="t-kicker tz" style="--i:7">Proyecto final · Internet de las Cosas</p>
    </div>`,
    notes: 'Les presentamos a nuestro nuevo jefe. No duerme, no se cansa y ahora mismo nos está mirando… Somos Jaime, Juan y Santiago, y en los próximos minutos les vamos a mostrar cómo un pedacito de hardware de pocos dólares se volvió un jefe con personalidad propia.'
  },
  {
    id: 'problema', ch: 1, speaker: 'Santiago', type: 'chapter', title: 'El problema',
    html: `<div class="t-problem">
      <p class="t-huge tz" style="--i:0">Trabajando solo, <em>nadie nota</em> cuándo te distraes.</p>
      <ul class="t-trio">
        <li class="tz" style="--i:2"><b>Ni cuánto</b> te enfocas de verdad.</li>
        <li class="tz" style="--i:3"><b>Ni cuándo</b> te levantas.</li>
        <li class="tz" style="--i:4"><b>Ni si</b> el cuarto se volvió irrespirable.</li>
      </ul>
      <p class="t-punch tz" style="--i:6">Sin datos, la productividad es pura sensación.</p>
    </div>`,
    notes: 'A todos nos ha pasado: uno se sienta a estudiar, abre el celular "un segundito" y de pronto ya pasó media hora. Trabajando solo nadie lo nota, ni siquiera uno mismo. Tampoco sabemos cuánto nos enfocamos de verdad ni si el cuarto ya está sin aire. Sin datos, todo es pura sensación.'
  },
  {
    id: 'idea', ch: 1, speaker: 'Santiago', type: 'chapter', title: 'La idea',
    html: `<div class="t-idea">
      <article class="t-card tz mint" style="--i:0">${ico('eye')}<h3>VE</h3><p>Una <b>ESP32-CAM</b> mide movimiento y brillo en tu escritorio.</p><p class="t-small">La imagen solo se transmite mientras alguien mira.</p></article>
      <span class="t-arrow tz" style="--i:1" aria-hidden="true"></span>
      <article class="t-card tz blue" style="--i:2">${ico('brain')}<h3>PIENSA</h3><p>El <b>servidor</b> decide si estás enfocado, distraído o ausente y lleva un puntaje de 0 a 100.</p><p class="t-small">Reglas y alertas en la nube.</p></article>
      <span class="t-arrow tz" style="--i:3" aria-hidden="true"></span>
      <article class="t-card tz amber" style="--i:4">${ico('talk')}<h3>REACCIONA</h3><p>Un <b>jefe 3D</b> con voz y gestos, alertas por Telegram, logros y niveles.</p><p class="t-small">Te regaña… o te anima.</p></article>
    </div>`,
    notes: 'Entonces se nos ocurrió: ¿y si le ponemos un jefe? La idea tiene tres partes. Ve: una ESP32-CAM mide el movimiento y el brillo. Piensa: el servidor decide si estás enfocado, distraído o ausente. Y reacciona: un jefe en 3D que te habla, te manda alertas a Telegram y hasta te da logros.'
  },

  // ===== Capitulo 2 · Demo en vivo =====
  {
    id: 'conectar', ch: 2, speaker: 'Jaime', type: 'focus', selector: '#btn-ble', card: true, tab: 'left', view: 'overview', place: 'right',
    title: 'Conectar la placa en 3 pasos',
    body: `<ol class="t-steps">
      <li><span><b>Bluetooth</b> a <span class="mono">JefeCAM</span>.</span></li>
      <li><span><b>Elegir el WiFi</b> y escribir la clave.</span></li>
      <li><span><b>Enviar.</b> Listo.</span></li>
    </ol>
    <p>Servidor, TLS y credenciales de la placa <b>se rellenan solos</b>: no hay que recompilar nada.</p>`,
    notes: 'Empecemos por lo práctico. Para conectar la placa no hay que tocar código: le damos a Conectar por Bluetooth, aparece JefeCAM, escogemos el WiFi, ponemos la clave y enviar. El servidor, el TLS y las credenciales de la placa se llenan solos.'
  },
  {
    id: 'chips', ch: 2, speaker: 'Jaime', type: 'focus', selector: '#top .chips', view: 'overview', place: 'bottom',
    title: 'Todo el estado, de un vistazo',
    body: `<ul class="t-chiplist">
      <li><span class="t-c">BLE</span><span>enlace Bluetooth con la placa</span></li>
      <li><span class="t-c">WiFi</span><span>la placa en la red</span></li>
      <li><span class="t-c">Servidor</span><span>MQTT seguro en la nube</span></li>
      <li><span class="t-c">Cámara</span><span>imagen en vivo</span></li>
    </ul>
    <p class="t-small">Verde: funcionando · ámbar: esperando · rojo: falla. Pasa el cursor para ver el detalle.</p>`,
    notes: 'Arriba tenemos cuatro chips que resumen todo: Bluetooth, WiFi de la placa, el servidor y la cámara. Verde es que todo va bien, ámbar que está esperando y rojo que algo falló. Así, si algo no funciona en plena demo, sabemos de una dónde está el problema.'
  },
  {
    id: 'monitor', ch: 2, speaker: 'Jaime', type: 'focus', view: 'monitor', tab: 'scene', dim: 'none', place: 'scene',
    title: 'El monitor muestra la cámara real',
    body: `<p>El monitor CRT de la escena muestra la <b>imagen real</b> de la ESP32-CAM; si no llega imagen, se ve estática.</p>
    <p>La cámara <b>solo transmite mientras alguien mira</b>: el panel la pide cada pocos segundos y, si nadie la pide, se apaga sola.</p>`,
    notes: 'Si nos acercamos al monitor de la escena, ahí está lo que ve la cámara, en tiempo real. Si no llega imagen se ve estática, como un televisor viejo. Y algo importante por privacidad: la cámara solo transmite mientras alguien tiene el panel abierto mirándola.'
  },
  {
    id: 'estados', ch: 2, speaker: 'Jaime', type: 'focus', view: 'boss', tab: 'scene', dim: 'none', place: 'scene-side', run: 'states', live: true,
    title: 'Enfocado → distraído → ausente',
    body: `<ul class="t-rules">
      <li><span class="t-st f">ENFOCADO</span><span>movimiento moderado</span></li>
      <li><span class="t-st d">DISTRAÍDO</span><span>media móvil (α = 0,3) <b>&gt; 12</b></span></li>
      <li><span class="t-st a">AUSENTE</span><span><b>&lt; 1,2</b> durante más de 20 s</span></li>
    </ul>
    <p class="t-small">El puntaje se acerca a su meta ~3 %/s (100, 0 o 50). La alerta llega a los 30, 60 o 90 s según la personalidad.</p>`,
    notes: 'Ahora sí, el jefe. Él calcula una media móvil del movimiento con alfa 0,3. Si pasa de 12, estás distraído; si baja de 1,2 por más de 20 segundos, estás ausente. El puntaje se va acercando poquito a poquito a su meta, más o menos un 3 % por segundo. Miren cómo cambia de cara y de color.'
  },
  {
    id: 'jefe-card', ch: 2, speaker: 'Jaime', type: 'focus', selector: '.boss-card', tab: 'right', view: 'boss', place: 'left', run: 'states', live: true, dim: 'light',
    title: 'La tarjeta del jefe',
    body: `<ul class="t-list">
      <li><b>Puntaje</b> de 0 a 100 y estado actual.</li>
      <li><b>Personalidad</b>: estricto, motivador o sarcástico.</li>
      <li><b>Voz</b> y sonidos del jefe.</li>
      <li><b>Pomodoro</b> integrado: en pleno bloque, regaña antes.</li>
      <li><b>Chat de excusas</b>: díganle «estaba en el baño».</li>
    </ul>`,
    notes: 'Acá a la derecha está la tarjeta del jefe: el puntaje, la personalidad, la voz, un pomodoro y un chat de excusas. Le pueden decir "estaba en el baño" y él les responde. Si quieren, después de la presentación lo prueban ustedes mismos.'
  },
  {
    id: 'alertas', ch: 2, speaker: 'Jaime', type: 'focus', view: 'boss', tab: 'scene', dim: 'none', place: 'top', run: 'alerts', live: true,
    title: 'Alertas al instante',
    body: `<p>Cuando una regla se dispara, el servidor publica un evento y el panel lo muestra como aviso, con sonido según la severidad.</p>
    <p class="t-small">Aquí: <b>Distracción prolongada</b> y <b>CO₂ alto</b>. Las mismas alertas llegan a Telegram.</p>
    <div class="t-actions"><button type="button" class="t-btn" data-act="alerts">Repetir alertas</button></div>`,
    notes: 'Y cuando algo se pasa de la raya, llegan las alertas. Por ejemplo, distracción prolongada, o que el CO₂ del cuarto subió de 1000 ppm. Cada una trae la regla, la severidad y la hora, y le suena distinto según qué tan grave es.'
  },

  // ===== Capitulo 3 · Como funciona por dentro =====
  {
    id: 'arquitectura', ch: 3, speaker: 'Juan', type: 'chapter', view: 'overview', title: 'Arquitectura',
    html: `<div class="t-archwrap tz" style="--i:0">${ARCH_SVG}</div>
    <ul class="t-legend tz" style="--i:2">
      <li><i class="mqtt"></i>MQTT/TLS por 443 <small>placa</small></li>
      <li><i class="wss"></i>MQTT sobre WebSocket seguro <small>panel</small></li>
      <li><i class="http"></i>HTTP REST <small>APIs</small></li>
      <li><i class="ble"></i>BLE GATT <small>aprovisionamiento</small></li>
    </ul>`,
    notes: 'Por dentro, esto es lo que hay. A la izquierda, el borde: la ESP32-CAM real y el panel en el navegador. En el centro, un VPS con Docker Compose: nginx recibe todo por el 443 y reparte por SNI a Mosquitto o a Caddy; el bridge en Node.js hace la lógica, y Telegraf, InfluxDB y Grafana guardan y grafican. A la derecha, los servicios externos. Un solo puerto público: el 443.'
  },
  {
    id: 'dispositivos', ch: 3, speaker: 'Juan', type: 'chapter', title: '11 fuentes de datos',
    html: `<div class="t-tblwrap tz" style="--i:0"><table class="t-tbl">
      <thead><tr><th scope="col">Dispositivo</th><th scope="col">Tipo</th><th scope="col">Protocolo</th><th scope="col">Qué aporta</th></tr></thead>
      <tbody>
        <tr class="hl"><th scope="row">esp32cam-01</th><td><span class="t-tag real">Real</span></td><td>MQTT/TLS · BLE</td><td>movimiento, brillo, RSSI, heap, temp. del chip</td></tr>
        <tr><th scope="row">cam-sala-twin</th><td><span class="t-tag twin">Gemelo</span></td><td>MQTT</td><td>cámara virtual de la sala</td></tr>
        <tr><th scope="row">termostato-twin</th><td><span class="t-tag twin">Gemelo</span></td><td>MQTT</td><td>temperatura y setpoint</td></tr>
        <tr><th scope="row">enchufe-twin</th><td><span class="t-tag twin">Gemelo</span></td><td>MQTT</td><td>consumo y relé</td></tr>
        <tr><th scope="row">puerta-twin</th><td><span class="t-tag twin">Gemelo</span></td><td>MQTT</td><td>puerta, ventana y PIR</td></tr>
        <tr><th scope="row">luz-twin</th><td><span class="t-tag twin">Gemelo</span></td><td>MQTT</td><td>luz inteligente</td></tr>
        <tr><th scope="row">api-azure-weather</th><td><span class="t-tag api">API</span></td><td>HTTP REST</td><td>clima exterior (Azure Maps)</td></tr>
        <tr><th scope="row">api-openmeteo-aq</th><td><span class="t-tag api">API</span></td><td>HTTP REST</td><td>calidad del aire (Open-Meteo)</td></tr>
        <tr><th scope="row">ds-energia</th><td><span class="t-tag ds">Dataset UCI</span></td><td>CSV → MQTT</td><td>consumo del hogar</td></tr>
        <tr><th scope="row">ds-co2</th><td><span class="t-tag ds">Dataset UCI</span></td><td>CSV → MQTT</td><td>CO₂ interior</td></tr>
        <tr><th scope="row">ds-ocupacion</th><td><span class="t-tag ds">Dataset UCI</span></td><td>CSV → MQTT</td><td>ocupación</td></tr>
      </tbody></table></div>
    <p class="t-note tz" style="--i:2">Los gemelos digitales <b>reaccionan a la presencia real</b>: lo que ve la ESP32-CAM cambia la sala virtual.</p>`,
    notes: 'En total el sistema maneja 11 fuentes de datos. Una es la placa real; cinco son gemelos digitales que reaccionan a la presencia real, o sea, si la cámara te ve, la sala virtual "se prende"; dos son APIs reales de clima y calidad del aire, y tres son datasets públicos de la UCI que reproducimos por MQTT.'
  },
  {
    id: 'devs-panel', ch: 3, speaker: 'Juan', type: 'focus', selector: '#devs', card: true, tab: 'right', view: 'overview', place: 'left',
    title: 'Control remoto de cada dispositivo',
    body: `<p>Desde el panel se enciende, apaga o ajusta cada gemelo, API o dataset.</p>
    <p>Cada orden viaja por <span class="mono">jefe/&lt;id&gt;/cmd</span>: es el <b>canal de retroceso</b>, y el dispositivo confirma en su <span class="mono">/state</span>.</p>`,
    notes: 'Y no solo los vemos: desde esta lista los podemos controlar. Apagar un gemelo, cambiar el intervalo, abrir la puerta virtual… Todo eso viaja por el tópico cmd de cada dispositivo, que es nuestro canal de retroceso, y el dispositivo responde con su estado.'
  },
  {
    id: 'topicos', ch: 3, speaker: 'Juan', type: 'chapter', title: 'Comunicación: el árbol de tópicos',
    html: `<div class="t-topics">
      <ul class="t-tree mono">
        <li class="root tz" style="--i:0">jefe/</li>
        <li class="tz" style="--i:1"><code>&lt;id&gt;/telemetry</code><span>datos periódicos</span></li>
        <li class="tz" style="--i:2"><code>&lt;id&gt;/cmd</code><span>retroceso: apagar, intervalo…</span></li>
        <li class="tz" style="--i:3"><code>&lt;id&gt;/state</code><span>estado (retenido)</span></li>
        <li class="tz" style="--i:4"><code>&lt;id&gt;/status</code><span>LWT: online / offline</span></li>
        <li class="tz" style="--i:5"><code>&lt;id&gt;/event</code><span>alertas: regla, severidad, ts, id</span></li>
        <li class="tz" style="--i:6"><code>esp32cam-01/snap</code><span>JPEG, solo mientras alguien mira</span></li>
        <li class="tz last" style="--i:7"><code>boss/stats · /report</code><span>gamificación y reportes</span></li>
      </ul>
    </div>`,
    notes: 'Toda la comunicación está ordenada en un árbol de tópicos. Cada dispositivo tiene telemetry para los datos, cmd para recibir órdenes, state retenido, status con el último testamento, o sea LWT, para saber si se cayó, y event para las alertas. La imagen va aparte por snap, y solo cuando alguien la está viendo.'
  },
  {
    id: 'firmware', ch: 3, speaker: 'Juan', type: 'chapter', title: 'Firmware ESP32-CAM 2.1.0',
    html: `<div class="t-grid2x2">
      <article class="t-card tz mint" style="--i:0">${ico('ble')}<h3>Aprovisionamiento BLE</h3><p>Con NimBLE: envía el WiFi desde el panel <b>sin recompilar</b>. En producción, el panel añade las credenciales MQTT de la placa.</p></article>
      <article class="t-card tz blue" style="--i:1">${ico('lock')}<h3>MQTT sobre TLS :443</h3><p>Reconexión con <b>backoff y jitter</b>: no satura el servidor.</p></article>
      <article class="t-card tz amber" style="--i:2">${ico('cam')}<h3>Movimiento robusto</h3><p>Compensa los <b>cambios de luz</b>: prender la lámpara no es moverse.</p></article>
      <article class="t-card tz violet" style="--i:3">${ico('refresh')}<h3>Se recupera sola</h3><p>Cámara reintenta de 30 s a 5 min, <b>watchdog</b>, ajustes en NVS.</p></article>
    </div>
    <div class="t-mem tz" style="--i:5">
      <div><span>RAM</span><div class="t-membar"><i style="--w:23.8%"></i></div><b class="mono">23,8 %</b></div>
      <div><span>Flash</span><div class="t-membar"><i style="--w:43%"></i></div><b class="mono">43,0 %</b></div>
    </div>`,
    notes: 'El firmware va en la versión 2.1.0. Se configura por Bluetooth con NimBLE, sin recompilar; habla MQTT sobre TLS por el 443 y, si se cae, reintenta con backoff y jitter. El detector de movimiento compensa los cambios de luz, y si algo falla se recupera sola con watchdog. Y todo eso ocupando apenas 23,8 % de RAM y 43 % de flash.'
  },
  {
    id: 'backend', ch: 3, speaker: 'Juan', type: 'chapter', title: 'Backend: el bridge en Node.js',
    html: `<div class="t-backend">
      <div class="t-grid2x2">
        <article class="t-card tz mint" style="--i:0">${ico('box')}<h3>Gemelos vivos</h3><p>Cinco dispositivos virtuales que <b>reaccionan a la presencia</b> real.</p></article>
        <article class="t-card tz amber" style="--i:1">${ico('refresh')}<h3>APIs resilientes</h3><p>Timeout, reintentos y caché <b>“stale”</b> si la API se cae.</p></article>
        <article class="t-card tz blue" style="--i:2">${ico('chip')}<h3>Real ↔ simulado</h3><p>Si la placa calla <b>90 s</b>, simula; cuando vuelve, usa la real.</p></article>
        <article class="t-card tz violet" style="--i:3">${ico('shield')}<h3>Comandos validados</h3><p>Cada orden se revisa antes de aplicarse.</p></article>
      </div>
      <div class="t-bignum tz" style="--i:5"><b data-count="192">192</b><span>tests automáticos</span></div>
    </div>`,
    notes: 'El cerebro es el bridge en Node.js. Mantiene vivos los gemelos, consume las APIs con timeout, reintentos y una caché por si se caen, y si la placa deja de hablar 90 segundos pasa solo a datos simulados y vuelve cuando la placa regresa. Todo eso lo cubren 192 tests automáticos.'
  },
  {
    id: 'reglas', ch: 3, speaker: 'Juan', type: 'chapter', title: '10 reglas que vigilan por ti',
    html: `<ul class="t-rulegrid">
      <li class="tz warn" style="--i:0"><code>distraido_prolongado</code><span>según la personalidad: 30, 60 o 90 s</span></li>
      <li class="tz warn" style="--i:1"><code>ausente_largo</code><span>&gt; 30 min, entre 9 y 18 h</span></li>
      <li class="tz bad" style="--i:2"><code>co2_alto</code><span>&gt; 1000 ppm · crítica &gt; 1500</span></li>
      <li class="tz warn" style="--i:3"><code>temperatura_alta</code><span>&gt; 28 °C</span></li>
      <li class="tz warn" style="--i:4"><code>consumo_alto</code><span>&gt; 300 W</span></li>
      <li class="tz warn" style="--i:5"><code>puerta_abierta_larga</code><span>&gt; 10 min</span></li>
      <li class="tz bad" style="--i:6"><code>movimiento_sospechoso</code><span>movimiento inesperado</span></li>
      <li class="tz warn" style="--i:7"><code>aire_exterior_malo</code><span>AQI &gt; 100</span></li>
      <li class="tz info" style="--i:8"><code>api_error / api_recuperada</code><span>una API cae o vuelve</span></li>
      <li class="tz ok" style="--i:9"><code>logro</code><span>nuevo logro desbloqueado</span></li>
    </ul>
    <p class="t-note tz" style="--i:11"><b>Antispam:</b> una misma alerta no se repite en ráfaga.</p>`,
    notes: 'Estas son las diez reglas. Distracción prolongada, ausencia larga en horario laboral, CO₂ alto, temperatura arriba de 28 grados, consumo arriba de 300 vatios, la puerta abierta más de 10 minutos, movimiento sospechoso, mal aire exterior, errores de las APIs y los logros. Y tienen antispam, para que el jefe no se vuelva cansón.'
  },
  {
    id: 'grafana', ch: 3, speaker: 'Juan', type: 'focus', selector: '#lnk-graf', view: 'overview', place: 'bottom',
    title: 'Gráficas en Grafana',
    body: `<p>Todo lo que pasa queda en <b>InfluxDB 2</b> y se ve en un tablero de <b>37 paneles</b>: productividad, sala, energía, clima, aire y salud de la placa.</p>
    <p class="t-small">Se abre en una pestaña aparte con este botón.</p>`,
    notes: 'Y si quieren ver la historia completa, este botón abre Grafana: un tablero de 37 paneles con la productividad, la sala, la energía, el clima y hasta la salud de la placa. Todo eso sale de InfluxDB, que va guardando cada dato.'
  },

  // ===== Capitulo 4 · Lo nuevo =====
  {
    id: 'personalidad', ch: 4, speaker: 'Santiago', type: 'focus', selector: '#pers', closest: '.pers', tab: 'right', view: 'boss', place: 'left', dim: 'light', run: 'personality', sim: 'focused',
    title: 'Tres personalidades',
    body: `<ul class="t-pers">
      <li data-p="estricto"><b>Estricto · 30 s</b><q>Alto ahí: 30 s sin foco. Cierra lo que no toca y sigue.</q></li>
      <li data-p="motivador"><b>Motivador · 90 s</b><q>¡Ánimo! 90 s fuera de foco no borran todo lo que llevas hecho.</q></li>
      <li data-p="sarcastico"><b>Sarcástico · 60 s</b><q>60 s distraído. Seguro era algo urgentísimo, como mirar el techo.</q></li>
    </ul>
    <p class="t-small">Cambia el gesto, la voz y el límite de alerta. (En la demo, solo en este panel.)</p>`,
    notes: 'Lo nuevo de esta versión: el jefe tiene tres personalidades. El estricto te avisa a los 30 segundos, el motivador te da 90 y te anima, y el sarcástico… bueno, a los 60 segundos te dice que seguro era algo urgentísimo, como mirar el techo. Fíjense cómo cambia la cara de una a otra.'
  },
  {
    id: 'progreso', ch: 4, speaker: 'Santiago', type: 'focus', selector: '#prog', tab: 'right', view: 'boss', place: 'left', dim: 'light', run: 'achievement', sim: 'focused',
    title: 'Progreso y logros',
    body: `<ul class="t-list">
      <li><b>+1 xp</b> por minuto enfocado y <b>+5</b> por bloque de 25 min.</li>
      <li>Nivel <i>n</i> a <span class="mono">100·n·(n+1)/2</span> xp.</li>
      <li><b>Racha de días</b>: ≥ 60 % de enfoque y ≥ 1 h.</li>
      <li><b>8 logros</b> por desbloquear.</li>
    </ul>
    <div class="t-actions"><button type="button" class="t-btn" data-act="achievement">Otro logro</button></div>`,
    notes: 'También le metimos gamificación. Ganas un punto de experiencia por cada minuto enfocado y cinco extra por cada bloque de 25 minutos. Los niveles suben con la fórmula 100 por n por n más uno, sobre dos. Hay rachas de días y ocho logros… y miren, ¡acabamos de desbloquear uno!'
  },
  {
    id: 'reporte', ch: 4, speaker: 'Santiago', type: 'focus', selector: '#report', tab: 'right', view: 'overview', place: 'right', run: 'report',
    title: 'Reportes diario y semanal',
    body: `<p>El servidor recalcula el reporte cada minuto: tiempo enfocado, distraído y ausente, distracciones, mejor racha, puntaje medio y xp.</p>
    <p>Se descarga en <b>CSV</b> o <b>JSON</b> para analizarlo donde quieran.</p>`,
    notes: 'Además hay reportes: el de hoy y el de los últimos siete días, con minutos enfocado, distraído y ausente, las distracciones y el puntaje medio. Y con un clic lo descargan en CSV o JSON para analizarlo en Excel o donde quieran.'
  },
  {
    id: 'telegram', ch: 4, speaker: 'Santiago', type: 'chapter', title: 'El jefe también escribe por Telegram',
    html: `<div class="t-tg">
      <div class="t-phone tz" style="--i:0" aria-label="Ejemplo de chat de Telegram con el bot del jefe">
        <div class="t-phone-head"><span class="t-ava" aria-hidden="true">J</span><div><b>Jefe IoT</b><small>bot</small></div></div>
        <div class="t-chat">
          <div class="t-msg warn tz" style="--i:2"><b>⚠️ Distracción prolongada</b><p>60 s distraído. Seguro era algo urgentísimo, como mirar el techo.</p><time>10:42</time></div>
          <div class="t-msg ok tz" style="--i:4"><b>🏆 Logro desbloqueado: Modo zen</b><p>1 h sin ninguna distracción · nivel 4</p><time>11:58</time></div>
          <div class="t-msg info tz" style="--i:6"><b>📊 Reporte diario</b><p>4 h 12 min enfocado · 78 % de enfoque · 6 distracciones · +268 xp</p><time>18:00</time></div>
          <div class="t-msg info tz" style="--i:8"><b>📅 Resumen semanal</b><p>21 h enfocado · 74 % de enfoque · racha de 3 días</p><time>vie. 18:00</time></div>
        </div>
      </div>
      <ul class="t-list lg">
        <li class="tz" style="--i:1"><b>Alertas</b> con la misma regla y severidad que el panel.</li>
        <li class="tz" style="--i:3"><b>Logros</b> apenas se desbloquean.</li>
        <li class="tz" style="--i:5"><b>Reporte diario</b> a las 18:00.</li>
        <li class="tz" style="--i:7"><b>Resumen semanal</b> los viernes.</li>
      </ul>
    </div>`,
    notes: 'Y como no siempre tenemos el panel abierto, el jefe también escribe por Telegram: las alertas, los logros apenas los desbloqueas, un reporte diario a las seis de la tarde y un resumen semanal los viernes. O sea, el jefe te persigue hasta el celular.'
  },

  // ===== Capitulo 5 · Seguridad y despliegue =====
  {
    id: 'seguridad', ch: 5, speaker: 'Jaime', type: 'chapter', title: 'Seguridad',
    html: `<div class="t-grid3x2">
      <article class="t-card tz mint" style="--i:0">${ico('lock')}<h3>TLS de punta a punta</h3><p>Certificados de Let's Encrypt para la placa, el panel y Grafana.</p></article>
      <article class="t-card tz blue" style="--i:1">${ico('shield')}<h3>ACL por usuario</h3><p>La placa solo publica lo suyo. <span class="t-small">Antes podía suplantar a otros.</span></p></article>
      <article class="t-card tz amber" style="--i:2">${ico('key')}<h3>Credenciales protegidas</h3><p>Las de la placa solo las lee el usuario del panel.</p></article>
      <article class="t-card tz violet" style="--i:3">${ico('box')}<h3>Contenedores sin root</h3><p>Cada servicio con el mínimo privilegio.</p></article>
      <article class="t-card tz mint" style="--i:4">${ico('head')}<h3>Cabeceras HTTPS</h3><p>HSTS, nosniff, sin marcos, permisos acotados.</p></article>
      <article class="t-card tz blue" style="--i:5">${ico('key')}<h3>Secretos fuera del repo</h3><p>Todo en <span class="mono">.env</span> del VPS.</p></article>
    </div>
    <p class="t-note tz" style="--i:7">${ico('cam')}La cámara <b>solo transmite</b> mientras un panel autenticado la pide.</p>`,
    notes: 'Como esto tiene una cámara, la seguridad era clave. Todo va cifrado con TLS de Let\'s Encrypt. Cada usuario MQTT tiene su ACL: la placa solo publica lo suyo, cosa que antes no pasaba y podía suplantar a otros. Los contenedores corren sin root, los secretos no están en el repositorio y la cámara solo transmite si un panel autenticado la pide.'
  },
  {
    id: 'cicd', ch: 5, speaker: 'Jaime', type: 'chapter', title: 'CI/CD con GitHub Actions',
    html: `<div class="t-pipe">
      <ol class="t-stages" data-seq="1100" data-fail="2">
        <li class="tz" style="--i:0"><span class="t-stage-dot" aria-hidden="true"></span><b>Validar</b><small>compose, Caddy, nginx, 192 tests, panel y tablero</small></li>
        <li class="tz" style="--i:1"><span class="t-stage-dot" aria-hidden="true"></span><b>Firmware</b><small>compila la ESP32-CAM</small></li>
        <li class="tz" style="--i:2"><span class="t-stage-dot" aria-hidden="true"></span><b>Integración</b><small>levanta el stack y ejecuta las consultas de Grafana</small></li>
        <li class="tz" style="--i:3"><span class="t-stage-dot" aria-hidden="true"></span><b>Desplegar</b><small>copia y despliega en el VPS</small></li>
      </ol>
      <p class="t-pipe-st mono tz" style="--i:4" aria-live="off" data-seq-status>Esperando un push…</p>
      <p class="t-punch sm tz" style="--i:5">Si un paso falla, <em>no se despliega</em>.</p>
    </div>`,
    notes: 'Y para no romper nada en producción, montamos un pipeline en GitHub Actions. Cada cambio pasa por validar, que incluye los 192 tests, compilar el firmware y una prueba de integración con todo el stack levantado. Solo si todo sale verde se despliega al VPS. Si algo falla, no se despliega.'
  },

  // ===== Capitulo 6 · Cierre =====
  {
    id: 'cifras', ch: 6, speaker: 'Santiago', type: 'chapter', title: 'En cifras',
    html: `<ul class="t-stats">
      <li class="tz" style="--i:0"><b data-count="11">11</b><span>fuentes de datos</span></li>
      <li class="tz" style="--i:1"><b data-count="4">4</b><span>protocolos</span></li>
      <li class="tz" style="--i:2"><b data-count="192">192</b><span>tests automáticos</span></li>
      <li class="tz" style="--i:3"><b data-count="37">37</b><span>paneles en Grafana</span></li>
      <li class="tz" style="--i:4"><b data-count="10">10</b><span>reglas</span></li>
      <li class="tz" style="--i:5"><b data-count="1">1</b><span>puerto público</span></li>
    </ul>`,
    notes: 'En cifras: 11 fuentes de datos, 4 protocolos, 192 tests automáticos, 37 paneles en Grafana, 10 reglas y un solo puerto público. Detrás de cada número hay bastantes noches de trabajo.'
  },
  {
    id: 'futuro', ch: 6, speaker: 'Juan', type: 'chapter', title: 'Próximos pasos',
    html: `<div class="t-idea three">
      <article class="t-card tz mint" style="--i:0">${ico('cam')}<h3>Varias placas</h3><p>Las ACL ya están listas: una cámara por escritorio.</p></article>
      <article class="t-card tz blue" style="--i:1">${ico('key')}<h3>Telegraf de solo lectura</h3><p>Un usuario MQTT que solo pueda suscribirse.</p></article>
      <article class="t-card tz amber" style="--i:2">${ico('talk')}<h3>Alertas nativas de Grafana</h3><p>Avisos definidos directo sobre las gráficas.</p></article>
    </div>`,
    notes: 'Y lo que sigue: soportar varias placas, que ya es fácil porque las ACL están listas; un usuario de solo lectura para Telegraf, y alertas nativas de Grafana para avisar directo desde las gráficas.'
  },
  {
    id: 'cierre', ch: 6, speaker: 'Jaime', type: 'chapter', bare: true, view: 'boss', title: 'El jefe nunca duerme',
    html: `<div class="t-cover end">
      ${EYE_SVG}
      <h1 class="t-brand tz" style="--i:0">El jefe nunca duerme.</h1>
      <p class="t-lema tz" style="--i:1">Hardware real, nube propia y un jefe con personalidad. <b>¿Preguntas?</b></p>
      <p class="t-url mono tz" style="--i:2">${SITE}</p>
      ${authorsHtml()}
      <div class="t-actions center tz" style="--i:7"><button type="button" class="t-btn primary xl" data-act="finish">Probar el panel</button></div>
    </div>`,
    notes: 'Y bueno, así es nuestro jefe: hardware real, una nube propia y un jefe con personalidad. Lo pueden probar en jefeiot.duckdns.org. El jefe nunca duerme… pero nosotros sí, entonces muchas gracias. ¿Preguntas?'
  }
];
