// Escena 3D del panel: escritorio, monitor CRT con la imagen real de la ESP32-CAM, jefe holografico,
// teclado reactivo y campo de particulas. Incluye calidad adaptativa segun FPS.
import * as THREE from 'three';

const QUALITY = [
  { pr: 2, particles: 6000, fps: 60 },
  { pr: 1.5, particles: 3500, fps: 60 },
  { pr: 1, particles: 2000, fps: 60 },
  { pr: 0.75, particles: 800, fps: 30 }
];
const MOODS = {
  focused: { color: 0x19ffa0, mood: 0.8, eyes: 1 },
  distracted: { color: 0xff3355, mood: -1, eyes: 1 },
  absent: { color: 0x4a7dff, mood: 0, eyes: 0.08 },
  unknown: { color: 0x8892a8, mood: 0, eyes: 0.6 }
};
const VIEWS = {
  overview: { pos: [0.9, 2.7, 8.6], look: [1.1, 1.1, 0] },
  monitor: { pos: [0.5, 1.5, 3.4], look: [0.5, 1.3, 0] },
  boss: { pos: [2.0, 1.8, 3.6], look: [2.0, 1.55, 0.2] }
};
const SEGMENTS = 48;

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x04060c);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x04060c, 0.045);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 80);
  const camPos = new THREE.Vector3(...VIEWS.overview.pos);
  const camLook = new THREE.Vector3(...VIEWS.overview.look);
  const wantPos = camPos.clone();
  const wantLook = camLook.clone();

  // ---------- Luces ----------
  scene.add(new THREE.HemisphereLight(0x5a6aa0, 0x0a0c14, 1.3));
  const lamp = new THREE.PointLight(0xffb070, 30, 12, 2);
  lamp.position.set(-1.6, 2.2, 0.6);
  scene.add(lamp);
  const bossLight = new THREE.PointLight(0x19ffa0, 14, 8, 2);
  bossLight.position.set(2.6, 1.7, 1.2);
  scene.add(bossLight);
  const screenLight = new THREE.PointLight(0x8fd0ff, 7, 6, 2);
  screenLight.position.set(0, 1.3, 1.3);
  scene.add(screenLight);

  // ---------- Piso con rejilla procedural ----------
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.ShaderMaterial({
      transparent: true,
      uniforms: { c: { value: new THREE.Color(0x19ffa0) } },
      vertexShader: 'varying vec3 vP; void main(){ vP=(modelMatrix*vec4(position,1.)).xyz; gl_Position=projectionMatrix*viewMatrix*vec4(vP,1.); }',
      fragmentShader: `varying vec3 vP; uniform vec3 c;
        void main(){ vec2 p=vP.xz; vec2 g=abs(fract(p-.5)-.5)/fwidth(p);
          float l=1.-min(min(g.x,g.y),1.); float d=smoothstep(22.,2.,length(p-vec2(1.,0.)));
          gl_FragColor=vec4(c*l*0.5, l*d*0.55); }`
    })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // ---------- Escritorio ----------
  const wood = new THREE.MeshStandardMaterial({ color: 0x3a2c20, roughness: 0.75, metalness: 0.1 });
  const desk = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.1, 1.5), wood);
  desk.position.set(0, 0.8, 0.1);
  scene.add(desk);
  const legGeo = new THREE.BoxGeometry(0.09, 0.8, 0.09);
  for (const [x, z] of [[-1.7, -0.55], [1.7, -0.55], [-1.7, 0.75], [1.7, 0.75]]) {
    const leg = new THREE.Mesh(legGeo, new THREE.MeshStandardMaterial({ color: 0x0c0e14, metalness: 0.6, roughness: 0.4 }));
    leg.position.set(x, 0.4, z);
    scene.add(leg);
  }

  // ---------- Monitor CRT con la camara ----------
  const monitor = new THREE.Group();
  monitor.position.set(0, 0.86, -0.1);
  const bezel = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 1.3, 0.14),
    new THREE.MeshStandardMaterial({ color: 0x0b0d14, metalness: 0.7, roughness: 0.3 })
  );
  bezel.position.y = 0.75;
  monitor.add(bezel);
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.22, 0.12, 24), bezel.material);
  stand.position.y = 0.06;
  monitor.add(stand);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.1), bezel.material);
  neck.position.set(0, 0.13, 0);
  monitor.add(neck);

  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;
  const screenMat = new THREE.ShaderMaterial({
    toneMapped: false,
    uniforms: {
      map: { value: blank },
      time: { value: 0 },
      noise: { value: 1 },
      live: { value: 0 },
      tint: { value: new THREE.Color(0x19ffa0) },
      flash: { value: 0 }
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec2 vUv; uniform sampler2D map; uniform float time,noise,live,flash; uniform vec3 tint;
      float h(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
      void main(){
        vec2 u=vUv*2.-1.; u*=vec2(1.+pow(abs(u.y)/5.,2.),1.+pow(abs(u.x)/4.,2.)); u=u*.5+.5;
        if(u.x<0.||u.x>1.||u.y<0.||u.y>1.){ gl_FragColor=vec4(0.,0.,0.,1.); return; }
        float ab=.003*(1.+flash*3.);
        vec3 col=vec3(texture2D(map,u+vec2(ab,0.)).r, texture2D(map,u).g, texture2D(map,u-vec2(ab,0.)).b)*live;
        col*=.86+.14*sin(u.y*240.+time*3.);
        float n=h(u*vec2(320.,240.)+fract(time)*17.);
        col=mix(col,vec3(n*.55),noise);
        col*=mix(vec3(1.),tint,.22);
        col+=tint*.04*(sin(time*1.7)*.5+.5)*(1.-live);
        col*=smoothstep(1.,.25,length(vUv-.5))*1.12;
        gl_FragColor=vec4(col,1.);
      }`
  });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.72, 1.12), screenMat);
  screen.position.set(0, 0.75, 0.075);
  monitor.add(screen);
  scene.add(monitor);

  // ---------- Teclado con teclas reactivas ----------
  const KEY_COLS = 14, KEY_ROWS = 5, KEYS = KEY_COLS * KEY_ROWS;
  const keysMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.085, 0.03, 0.085),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.2 }),
    KEYS
  );
  const keyBase = new THREE.Color(0x151a26);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < KEYS; i++) {
    const c = i % KEY_COLS, r = Math.floor(i / KEY_COLS);
    m4.setPosition(-0.64 + c * 0.098, 0.88, 0.62 + r * 0.098);
    keysMesh.setMatrixAt(i, m4);
    keysMesh.setColorAt(i, keyBase);
  }
  scene.add(keysMesh);
  const tmpC = new THREE.Color();

  // ---------- Jefe holografico ----------
  const boss = new THREE.Group();
  boss.position.set(2.6, 1.55, 0.2);
  scene.add(boss);
  const head = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.55, 1),
    new THREE.MeshStandardMaterial({ color: 0x0b1220, emissive: 0x19ffa0, emissiveIntensity: 0.25, flatShading: true, metalness: 0.6, roughness: 0.35 })
  );
  boss.add(head);
  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.6, 1)),
    new THREE.LineBasicMaterial({ color: 0x19ffa0, transparent: true, opacity: 0.5 })
  );
  boss.add(wire);
  const faceMat = new THREE.MeshBasicMaterial({ color: 0x19ffa0, toneMapped: false });
  const eyeGeo = new THREE.SphereGeometry(0.09, 16, 12);
  const eyeL = new THREE.Mesh(eyeGeo, faceMat), eyeR = new THREE.Mesh(eyeGeo, faceMat);
  eyeL.position.set(-0.2, 0.08, 0.5); eyeR.position.set(0.2, 0.08, 0.5);
  const browGeo = new THREE.BoxGeometry(0.28, 0.05, 0.05);
  const browL = new THREE.Mesh(browGeo, faceMat), browR = new THREE.Mesh(browGeo, faceMat);
  browL.position.set(-0.2, 0.27, 0.52); browR.position.set(0.2, 0.27, 0.52);
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.025, 8, 24, Math.PI), faceMat);
  mouth.position.set(0, -0.2, 0.52);
  boss.add(eyeL, eyeR, browL, browR, mouth);

  const ring = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.06, 0.05), new THREE.MeshBasicMaterial({ toneMapped: false }), SEGMENTS);
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2 - Math.PI / 2;
    const o = new THREE.Object3D();
    o.position.set(Math.cos(-a) * 0.95, Math.sin(-a) * 0.95, 0);
    o.rotation.z = -a + Math.PI / 2;
    o.updateMatrix();
    ring.setMatrixAt(i, o.matrix);
    ring.setColorAt(i, keyBase);
  }
  boss.add(ring);

  // ---------- Particulas ----------
  const MAXP = QUALITY[0].particles;
  const pPos = new Float32Array(MAXP * 3), pSize = new Float32Array(MAXP), pSeed = new Float32Array(MAXP);
  for (let i = 0; i < MAXP; i++) {
    pPos[i * 3] = (Math.random() - 0.5) * 16;
    pPos[i * 3 + 1] = Math.random() * 5;
    pPos[i * 3 + 2] = (Math.random() - 0.5) * 12 - 1;
    pSize[i] = 0.5 + Math.random() * 1.2;
    pSeed[i] = Math.random() * 100;
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('size', new THREE.BufferAttribute(pSize, 1));
  pGeo.setAttribute('seed', new THREE.BufferAttribute(pSeed, 1));
  const pMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { time: { value: 0 }, energy: { value: 0 }, color: { value: new THREE.Color(0x19ffa0) }, scale: { value: 300 } },
    vertexShader: `attribute float size; attribute float seed; uniform float time,energy,scale; varying float vA;
      void main(){ vec3 p=position; float e=.15+energy*1.6;
        p.x+=sin(time*.4*e+seed)*.5*e; p.y+=sin(time*.3*e+seed*1.7)*.4*e+mod(time*.05*(1.+energy*4.)+seed,5.)*.0;
        p.z+=cos(time*.35*e+seed*.6)*.5*e;
        vec4 mv=modelViewMatrix*vec4(p,1.); gl_Position=projectionMatrix*mv;
        gl_PointSize=size*scale/-mv.z; vA=.25+.55*fract(seed); }`,
    fragmentShader: 'uniform vec3 color; varying float vA; void main(){ float d=length(gl_PointCoord-.5); if(d>.5) discard; gl_FragColor=vec4(color,smoothstep(.5,0.,d)*vA); }'
  });
  const points = new THREE.Points(pGeo, pMat);
  points.frustumCulled = false;
  scene.add(points);

  // ---------- Estado y animacion ----------
  let level = 1, auto = true, lastLevelChange = 0, fps = 60, accStats = 0, paused = false, raf = 0;
  let camTex = null, camCanvas = null, camCtx = null, view = 'overview';
  const target = { color: new THREE.Color(0x8892a8), mood: 0, eyes: 0.6 };
  const cur = { color: new THREE.Color(0x8892a8), mood: 0, eyes: 0.6, energy: 0, shake: 0 };
  let st = { motion: 0, mood: 'unknown', score: 0, flash: false, camLive: false };
  let lastLit = -1, lastRingColor = -1, keyTimer = 0, lastRender = 0;
  const mouse = new THREE.Vector2();
  const statsCbs = [];

  function applyLevel(l) {
    level = Math.max(0, Math.min(QUALITY.length - 1, l));
    lastLevelChange = performance.now();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY[level].pr));
    pGeo.setDrawRange(0, QUALITY[level].particles);
    resize();
    statsCbs.forEach((cb) => cb({ fps, level, auto }));
  }

  function resize() {
    const w = canvas.clientWidth || 800, h = canvas.clientHeight || 600;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // en pantallas angostas alejamos la camara para que entre la escena
    camera.fov = w / h < 1 ? 62 : 42;
    camera.updateProjectionMatrix();
    pMat.uniforms.scale.value = (h * (window.devicePixelRatio ? Math.min(window.devicePixelRatio, QUALITY[level].pr) : 1)) * 0.055;
  }
  new ResizeObserver(resize).observe(canvas);

  function setRing(score, color) {
    const lit = Math.round((score / 100) * SEGMENTS);
    const key = color.getHex();
    if (lit === lastLit && key === lastRingColor) return;
    lastLit = lit; lastRingColor = key;
    for (let i = 0; i < SEGMENTS; i++) ring.setColorAt(i, i < lit ? color : keyBase);
    ring.instanceColor.needsUpdate = true;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (paused) return;
    const cap = 1000 / QUALITY[level].fps;
    if (now - lastRender < cap - 2) return;
    const dt = Math.min((now - (lastRender || now)) / 1000, 0.1);
    lastRender = now;
    const t = now / 1000;
    if (dt > 0) fps = fps * 0.95 + (1 / dt) * 0.05;

    // adaptacion de calidad
    accStats += dt;
    if (accStats > 2) {
      accStats = 0;
      if (auto) {
        if (fps < 38 && level < QUALITY.length - 1) applyLevel(level + 1);
        else if (fps > 57 && level > 0 && now - lastLevelChange > 15000) applyLevel(level - 1);
      }
      statsCbs.forEach((cb) => cb({ fps, level, auto }));
    }

    // mood suavizado
    const k = 1 - Math.exp(-dt * 4);
    cur.color.lerp(target.color, k);
    cur.mood += (target.mood - cur.mood) * k;
    cur.eyes += (target.eyes - cur.eyes) * Math.min(1, k * 2);
    cur.energy += (Math.min(st.motion / 40, 1) - cur.energy) * k;
    cur.shake = st.mood === 'distracted' ? 1 : cur.shake * (1 - k);

    faceMat.color.copy(cur.color);
    head.material.emissive.copy(cur.color);
    wire.material.color.copy(cur.color);
    bossLight.color.copy(cur.color);
    pMat.uniforms.color.value.copy(cur.color);
    screenMat.uniforms.tint.value.copy(cur.color);
    eyeL.scale.y = eyeR.scale.y = Math.max(0.08, cur.eyes);
    const brow = -cur.mood; // enojado: ceja interior hacia abajo
    browL.rotation.z = -brow * 0.45; browR.rotation.z = brow * 0.45;
    browL.position.y = browR.position.y = 0.27 - brow * 0.04;
    mouth.rotation.z = cur.mood >= 0 ? Math.PI : 0;
    mouth.scale.set(1, 0.25 + Math.abs(cur.mood) * 0.9, 1);
    mouth.position.y = cur.mood >= 0 ? -0.12 : -0.28;
    boss.position.y = 1.55 + Math.sin(t * 1.3) * 0.06;
    wire.rotation.y = t * 0.2;
    boss.rotation.y = Math.sin(t * 0.5) * 0.15 + mouse.x * 0.35 + (cur.shake ? Math.sin(t * 40) * 0.05 : 0);
    boss.rotation.x = -mouse.y * 0.2;
    head.material.emissiveIntensity = 0.2 + cur.energy * 0.3 + (cur.shake ? 0.25 + Math.sin(t * 30) * 0.15 : 0);
    setRing(st.score, new THREE.Color().copy(cur.color));

    // pantalla
    screenMat.uniforms.time.value = t;
    screenMat.uniforms.live.value += ((st.camLive ? 1 : 0) - screenMat.uniforms.live.value) * k;
    screenMat.uniforms.noise.value = st.camLive ? 0.025 : 0.9;
    screenMat.uniforms.flash.value = st.flash ? 1 : 0;
    lamp.intensity = st.flash ? 90 : 30;
    pMat.uniforms.time.value = t;
    pMat.uniforms.energy.value = cur.energy;

    // teclas reactivas (10 Hz)
    keyTimer += dt;
    if (keyTimer > 0.1) {
      keyTimer = 0;
      const n = Math.floor(cur.energy * 14);
      for (let i = 0; i < KEYS; i++) keysMesh.setColorAt(i, keyBase);
      for (let j = 0; j < n; j++) keysMesh.setColorAt((Math.random() * KEYS) | 0, tmpC.copy(cur.color));
      keysMesh.instanceColor.needsUpdate = true;
    }

    // camara con transicion + paralaje
    camPos.lerp(wantPos, 1 - Math.exp(-dt * 3));
    camLook.lerp(wantLook, 1 - Math.exp(-dt * 3));
    camera.position.set(camPos.x + mouse.x * 0.35, camPos.y + mouse.y * 0.18, camPos.z);
    camera.lookAt(camLook);

    renderer.render(scene, camera);
  }

  // interaccion
  const ray = new THREE.Raycaster();
  window.addEventListener('pointermove', (e) => {
    mouse.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1));
  });
  canvas.addEventListener('pointerdown', (e) => {
    ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1)), camera);
    const hit = ray.intersectObjects([bezel, head], false)[0];
    if (hit) setView(hit.object === head ? 'boss' : 'monitor');
    else setView('overview');
  });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); paused = true; });
  canvas.addEventListener('webglcontextrestored', () => { paused = false; });
  document.addEventListener('visibilitychange', () => { paused = document.hidden; lastRender = 0; });

  function setView(name) {
    if (!VIEWS[name]) return;
    view = name;
    wantPos.set(...VIEWS[name].pos);
    wantLook.set(...VIEWS[name].look);
  }

  applyLevel(1);
  raf = requestAnimationFrame(frame);

  return {
    setView,
    getView: () => view,
    setQuality(l) { // 'auto' o 0..3
      if (l === 'auto') { auto = true; return; }
      auto = false;
      applyLevel(l);
    },
    onStats(cb) { statsCbs.push(cb); },
    setCameraImage(img) {
      // Se copia cada cuadro a un canvas propio: el <img> queda "incompleto" mientras llega el siguiente
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (!w || !h) return;
      if (!camCanvas || camCanvas.width !== w || camCanvas.height !== h) {
        camCanvas = document.createElement('canvas');
        camCanvas.width = w; camCanvas.height = h;
        camCtx = camCanvas.getContext('2d');
        camTex?.dispose();
        camTex = new THREE.CanvasTexture(camCanvas);
        camTex.colorSpace = THREE.NoColorSpace;
        camTex.generateMipmaps = false;
        camTex.minFilter = camTex.magFilter = THREE.LinearFilter;
        screenMat.uniforms.map.value = camTex;
      }
      camCtx.drawImage(img, 0, 0);
      camTex.needsUpdate = true;
    },
    update(s) {
      st = { ...st, ...s };
      const m = MOODS[st.mood] || MOODS.unknown;
      target.color.setHex(m.color);
      target.mood = m.mood;
      target.eyes = m.eyes;
    },
    dispose() { cancelAnimationFrame(raf); renderer.dispose(); }
  };
}
