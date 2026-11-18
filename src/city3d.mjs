// A2Z city: a live, clickable 3D operations map built with Three.js.
// Bundled into public/city3d.js by scripts/build-city.mjs (global A2ZCity). public/map.js stays as the 2D fallback.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const C = {
  slab: 0x141a2e, ground: 0x1f2a45, road: 0x323d5c, line: 0xf5c451, tree: 0x22b573, trunk: 0x7a5236,
  wall: 0xf2efe6, wall2: 0xe2e8f0, steel: 0x9aa6bd, skin: 0xe0ac7e, denim: 0x2f5fa8,
  ok: 0x2ee67a, warn: 0xffb020, bad: 0xff4d5e, off: 0x6b7591,
};
const COLORS = {
  hq: 0xffa940,
  leads: 0x35d0ba, proposals: 0x5aa9ff, wins: 0xffc531, labor: 0xff7a45,
  pipelines: 0xb57bff, workforce: 0xffd23f, runway: 0x3ee07f, system: 0x9fb4ff, mail: 0xe8aa79,
};
const HATS = [0xffd23f, 0xff7a1a, 0xffffff, 0x3fa9ff, 0xff4d8d, 0x46e08a];
const tone = s => ({ ok: C.ok, ready: C.ok, setup: C.warn, building: C.warn, enqueued: C.warn, processing: C.warn }[s] || C.bad);

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.08, ...o });
const glow = (color, i = 1) => mat(color, { emissive: color, emissiveIntensity: i });
const shade = o => { o.castShadow = true; o.receiveShadow = true; return o; };
const box = (w, h, d, m) => shade(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m));
const cyl = (rt, rb, h, m, seg = 24) => shade(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m));
const ball = (r, m, seg = 14) => shade(new THREE.Mesh(new THREE.SphereGeometry(r, seg, seg), m));
const at = (o, x, y, z) => { o.position.set(x, y, z); return o; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// Districts on a ring around A2Z HQ.
const R = 14.5;
const DISTRICTS = ['proposals', 'wins', 'pipelines', 'labor', 'mail', 'workforce', 'runway', 'system', 'leads'];
const SPOTS = Object.fromEntries(DISTRICTS.map((key, index) => {
  const angle = Math.PI - index * 2 * Math.PI / DISTRICTS.length;
  return [key, [Math.sin(angle) * R, Math.cos(angle) * R]];
}));
const HOME = new THREE.Vector3(0, 1.5, 0);

let S = null;
const now = () => (performance.now() - S.t0) / 1000;

export function supported() {
  try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'))); }
  catch { return false; }
}

export function mount(container, opts = {}) {
  unmount();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(1.75, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
  renderer.domElement.className = 'c3-canvas';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x1a1530, 70, 140);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  camera.position.set(40, 38, 40);
  const controls = new OrbitControls(camera, renderer.domElement);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, enablePan: false, minPolarAngle: 0.5, maxPolarAngle: 1.15, minZoom: 0.7, maxZoom: 3.4, autoRotate: true, autoRotateSpeed: 0.35 });
  controls.target.copy(HOME);
  controls.addEventListener('start', () => { controls.autoRotate = false; });

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x2a1e48, 1.7));
  const sun = new THREE.DirectionalLight(0xfff0d6, 2.6);
  sun.position.set(-16, 32, 18); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -28, right: 28, top: 28, bottom: -28, near: 1, far: 90 });
  sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0xff7ad9, 0.7); rim.position.set(20, 10, -20); scene.add(rim);

  const labels = document.createElement('div');
  labels.className = 'c3-labels';
  container.appendChild(labels);

  S = { container, renderer, scene, camera, controls, labels, opts, city: null, clickables: [], labelList: [], anim: [],
    hovered: null, selected: null, worker: null, raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(), t0: performance.now(), focus: null, frame: 0 };
  scenery(scene);
  S.traffic = new THREE.Group(); scene.add(S.traffic); S.cars = []; S.crewPos = new Map();
  S.mailFlights = new THREE.Group();
  S.mailArrivals = [];
  S.agentStates = new Map(); S.agentSpots = {}; S.agentColors = {}; S.agentLabels = {};
  S.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  scene.add(S.mailFlights);
  resize();
  S.ro = new ResizeObserver(resize); S.ro.observe(container);
  const el = renderer.domElement;
  el.addEventListener('pointermove', e => setHover(pick(e)));
  el.addEventListener('pointerleave', () => setHover(null));
  el.addEventListener('pointerdown', e => { S.down = [e.clientX, e.clientY]; });
  el.addEventListener('pointerup', e => {
    if (S.down && Math.hypot(e.clientX - S.down[0], e.clientY - S.down[1]) > 6) return;
    const hit = pick(e);
    if (hit) S.opts.onSelect?.(hit.key, hit.worker);
  });
  loop();
  return { update, select, reset, unmount, drive, deliverMail, agentState };
}

export function unmount() {
  if (!S) return;
  cancelAnimationFrame(S.frame); S.ro?.disconnect();
  S.scene.traverse(dispose);
  S.renderer.dispose(); S.renderer.domElement.remove(); S.labels.remove();
  S = null;
}
function dispose(o) { o.geometry?.dispose?.(); if (o.material) [].concat(o.material).forEach(m => m.dispose()); }

function resize() {
  if (!S) return;
  const w = S.container.clientWidth || 800, h = S.container.clientHeight || 600, aspect = w / h;
  const view = Math.max(36, (aspect < 1 ? 46 : 58) / aspect);
  Object.assign(S.camera, { left: -view * aspect / 2, right: view * aspect / 2, top: view / 2, bottom: -view / 2 });
  S.camera.updateProjectionMatrix();
  S.renderer.setSize(w, h, false);
  S.renderer.domElement.style.width = w + 'px'; S.renderer.domElement.style.height = h + 'px';
}

// ---------------- static scenery ----------------
function scenery(scene) {
  const g = new THREE.Group();
  g.add(at(box(44, 1.6, 44, mat(C.slab)), 0, -0.8, 0));
  const plate = at(box(42.6, 0.2, 42.6, mat(C.ground, { roughness: 0.95 })), 0, 0.1, 0); plate.castShadow = false; g.add(plate);
  const roadM = mat(C.road, { roughness: 0.9 }), lineM = glow(C.line, 0.35);
  for (const [x, z] of Object.values(SPOTS)) {
    const len = Math.hypot(x, z) - 3.6, ang = Math.atan2(x, z), mid = 3.6 + len / 2 - 0.2;
    const road = at(box(1.5, 0.06, len, roadM), Math.sin(ang) * mid, 0.23, Math.cos(ang) * mid);
    road.rotation.y = ang; road.castShadow = false; g.add(road);
    for (let i = 0.7; i < len - 0.6; i += 1.3) {
      const t = 3.6 + i - 0.2, d = at(box(0.1, 0.02, 0.55, lineM), Math.sin(ang) * t, 0.27, Math.cos(ang) * t);
      d.rotation.y = ang; d.castShadow = false; g.add(d);
    }
  }
  const ring = new THREE.Mesh(new THREE.RingGeometry(3.6, 5.1, 56), roadM);
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.22; ring.receiveShadow = true; g.add(ring);
  const treeCols = [C.tree, 0x2fd08a, 0x18a05f, 0xff8fc8];
  const spots = [];
  for (let i = -19.5; i <= 19.5; i += 3) spots.push([i, -20], [i, 20], [-20, i], [20, i]);
  [[-6.5, -6], [6.5, -6], [-6.5, 6.5], [6.5, 6.5], [-19, -12], [18, 12]].forEach(p => spots.push(p));
  for (const [x, z] of spots) {
    if (rnd() < 0.2) continue;
    const s = 0.55 + rnd() * 0.55, t = new THREE.Group();
    t.add(at(cyl(0.11 * s, 0.15 * s, 0.6 * s, mat(C.trunk), 6), 0, 0.3 * s, 0));
    t.add(at(shade(new THREE.Mesh(new THREE.IcosahedronGeometry(0.62 * s, 0), mat(treeCols[Math.floor(rnd() * 4)], { flatShading: true }))), 0, 1.05 * s, 0));
    t.position.set(x + (rnd() - 0.5) * 0.8, 0.2, z + (rnd() - 0.5) * 0.8); g.add(t);
  }
  // Streetlights around the ring road.
  for (let i = 0; i < 8; i++) {
    const a = (i + 0.5) * Math.PI / 4, x = Math.sin(a) * 5.6, z = Math.cos(a) * 5.6;
    g.add(at(cyl(0.05, 0.06, 1.4, mat(C.steel), 6), x, 0.9, z));
    g.add(at(ball(0.13, glow(0xfff1b8, 1.4), 8), x, 1.65, z));
  }
  scene.add(g);
}

// ---------------- dynamic city ----------------
function update(report, tiles, palette = [], alerts = [], agents = []) {
  if (!S) return;
  if (S.city) { S.scene.remove(S.city); S.city.traverse(dispose); }
  S.labels.replaceChildren(); S.clickables = []; S.labelList = []; S.anim = []; S.hovered = null; S.workers = [];
  S.report = report; S.palette = palette; S.alerts = new Set(alerts);
  const city = new THREE.Group(); S.city = city;
  const tile = Object.fromEntries((tiles || []).map(t => [t.key, t]));
  seed = 11;
  hq(city, report);
  agentRing(city, agents);
  leads(city, report.kpis.funnel?.leads, tile.leads);
  proposals(city, report.kpis.funnel?.proposals, tile.proposals);
  wins(city, report.kpis.funnel?.wins, tile.wins);
  pipelines(city, report.kpis.pipelines, tile.pipelines);
  labor(city, report.kpis.labor, tile.labor);
  workforce(city, report.kpis.workforce, tile.workforce);
  runway(city, report.kpis.runway, tile.runway);
  system(city, report.system, tile.system);
  if (tile.mail) mailDistrict(city, tile.mail);
  flows(city, report);
  S.scene.add(city);
  highlight();
  // Cars follow the funnel: New leads to Proposals sent per new proposal, Proposals sent to Jobs won per new win.
  const f = report.kpis.funnel, range = report.range.from + '|' + report.range.to;
  if (f && S.last?.range === range) {
    if (f.proposals > S.last.proposals) drive('leads', 'proposals', Math.min(5, f.proposals - S.last.proposals));
    if (f.wins > S.last.wins) drive('proposals', 'wins', Math.min(5, f.wins - S.last.wins));
  }
  if (f) S.last = { range, proposals: f.proposals, wins: f.wins };
}

function route(from, to) {
  const lane = 0.35, r = 4.35, y = 0.2;
  const [fx, fz] = SPOTS[from], [tx, tz] = SPOTS[to];
  const aF = Math.atan2(fx, fz), aT = Math.atan2(tx, tz);
  let d = aT - aF; d = Math.atan2(Math.sin(d), Math.cos(d));
  const radial = (a, dist, side) => new THREE.Vector3(Math.sin(a) * dist + Math.cos(a) * side, y, Math.cos(a) * dist - Math.sin(a) * side);
  const pts = [radial(aF, 11, -lane), radial(aF, 8, -lane), radial(aF, 5.4, -lane)];
  for (let i = 0; i <= 8; i++) pts.push(radial(aF + d * i / 8, r, 0));
  pts.push(radial(aT, 5.4, lane), radial(aT, 8, lane), radial(aT, 11, lane));
  return new THREE.CatmullRomCurve3(pts);
}
// Proposal cars are blue with a sheet on the roof. Win cars are gold with a trophy flag.
function drive(from = 'leads', to = 'proposals', n = 1) {
  if (!S || !SPOTS[from] || !SPOTS[to]) return;
  const path = route(from, to), win = to === 'wins';
  for (let i = 0; i < n; i++) {
    const car = makeCar(win ? 0xffc531 : 0x5aa9ff); car.scale.setScalar(1.6);
    const beacon = at(ball(0.09, new THREE.MeshBasicMaterial({ color: win ? 0xff3b5c : 0xffffff }), 8), 0, 0.62, 0); car.add(beacon);
    if (win) {
      car.add(at(cyl(0.015, 0.015, 0.5, mat(0xdddddd), 4), 0.15, 0.72, -0.2));
      car.add(at(box(0.22, 0.14, 0.02, glow(0xff3b5c, 0.6)), 0.27, 0.9, -0.2));
    } else car.add(at(box(0.36, 0.03, 0.46, mat(0xffffff, { emissive: 0x5aa9ff, emissiveIntensity: 0.6 })), 0, 0.53, -0.05));
    S.traffic.add(car);
    S.cars.push({ car, beacon, path, start: now() + i * 1.4, duration: 7 });
  }
}
function traffic(t) {
  const dir = new THREE.Vector3();
  S.cars = S.cars.filter(c => {
    const q = (t - c.start) / c.duration;
    if (q < 0) { c.car.visible = false; return true; }
    if (q >= 1) { S.traffic.remove(c.car); c.car.traverse(dispose); return false; }
    c.car.visible = true;
    const e = q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2;
    c.car.position.copy(c.path.getPointAt(e));
    c.path.getTangentAt(e, dir);
    c.car.rotation.y = Math.atan2(dir.x, dir.z);
    c.beacon.visible = Math.sin(t * 12) > 0;
    // Arrive at Proposals sent, then shrink away.
    c.car.scale.setScalar(1.6 * (q > 0.88 ? Math.max(0, (1 - q) / 0.12) : 1));
    return true;
  });
}

function district(city, key, padColor = 0x26324f) {
  const [x, z] = SPOTS[key], g = new THREE.Group();
  g.position.set(x, 0.2, z); g.userData.key = key; city.add(g); S.clickables.push(g);
  const pad = at(box(7, 0.14, 7, mat(padColor, { roughness: 0.9 })), 0, 0.07, 0); pad.castShadow = false; g.add(pad);
  const edge = at(box(7.2, 0.06, 7.2, glow(COLORS[key], 0.35)), 0, 0.02, 0); edge.castShadow = false; edge.userData.edge = true; g.add(edge);
  const sel = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.07, 8, 64), new THREE.MeshBasicMaterial({ color: COLORS[key], transparent: true, opacity: 0 }));
  sel.rotation.x = Math.PI / 2; sel.position.y = 0.3; g.add(sel); g.userData.sel = sel;
  if (S.alerts.has(key)) {
    const siren = at(ball(0.28, new THREE.MeshBasicMaterial({ color: C.bad }), 12), 3.2, 0.5, 3.2); g.add(siren);
    const wave = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.05, 6, 32), new THREE.MeshBasicMaterial({ color: C.bad, transparent: true }));
    wave.rotation.x = Math.PI / 2; wave.position.copy(siren.position); g.add(wave);
    S.anim.push(t => { const q = (t * 0.9) % 1; wave.scale.setScalar(1 + q * 4); wave.material.opacity = 1 - q; siren.visible = Math.sin(t * 8) > -0.4; });
  }
  S.anim.push(t => {
    const on = S.selected === key, hot = S.hovered?.key === key;
    sel.material.opacity += ((on ? 0.9 : hot ? 0.45 : 0) - sel.material.opacity) * 0.15;
    sel.scale.setScalar(1 + Math.sin(t * 3) * 0.02);
    edge.material.emissiveIntensity = on || hot ? 1.1 + Math.sin(t * 4) * 0.3 : 0.35;
  });
  return g;
}
function label(key, anchor, title, value, small, always) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'c3-label' + (small ? ' tag' : '');
  el.dataset.key = key;
  const b = document.createElement('b'); b.textContent = title;
  el.append(b);
  if (value != null && small) { const s = document.createElement('span'); s.textContent = value; el.append(s); }
  if (!small && S.alerts.has(key)) { el.classList.add('alert'); el.setAttribute('aria-label', title + ', alert triggered'); }
  el.style.setProperty('--c', '#' + (COLORS[key] ?? S.agentColors[key] ?? 0xffffff).toString(16).padStart(6, '0'));
  if (S.agentColors[key] !== undefined) { el.classList.add('agent'); el.dataset.state = S.agentStates.get(key) || 'idle'; S.agentLabels[key] = el; }
  el.addEventListener('click', () => S.opts.onSelect?.(key));
  el.addEventListener('pointerenter', () => setHover({ key }));
  el.addEventListener('pointerleave', () => setHover(null));
  S.labels.append(el);
  S.labelList.push({ el, anchor, key, tag: small && !always });
}
const world = (g, x, y, z) => new THREE.Vector3(g.position.x + x, g.position.y + y, g.position.z + z);

// A2Z HQ: glass tower with a glowing crown.
function hq(city, report) {
  const g = new THREE.Group(); g.position.set(0, 0.2, 0); g.userData.key = 'hq'; city.add(g); S.clickables.push(g);
  g.add(at(cyl(3.1, 3.4, 0.4, mat(0x2b3658)), 0, 0.2, 0));
  const tower = at(box(2.6, 5.6, 2.6, mat(0x3b4f8a, { roughness: 0.25, metalness: 0.4 })), 0, 3.2, 0); g.add(tower);
  const win = glow(0xffd27a, 0.9), dark = mat(0x22305a, { roughness: 0.2, metalness: 0.5 });
  const lit = [];
  for (let f = 0; f < 7; f++) for (let s = 0; s < 4; s++) for (let i = 0; i < 3; i++) {
    const on = rnd() < 0.65, w = box(0.5, 0.42, 0.04, on ? win.clone() : dark), a = s * Math.PI / 2, off = (i - 1) * 0.8;
    w.castShadow = false; w.position.set(Math.sin(a) * 1.32 + Math.cos(a) * off, 0.95 + f * 0.72, Math.cos(a) * 1.32 - Math.sin(a) * off);
    w.rotation.y = a; g.add(w); if (on) lit.push(w);
  }
  const crown = at(box(2.9, 0.5, 2.9, glow(COLORS.hq, 0.8)), 0, 6.25, 0); g.add(crown);
  const spire = at(cyl(0.05, 0.12, 2, mat(C.steel), 8), 0, 7.5, 0); g.add(spire);
  const beacon = at(ball(0.2, new THREE.MeshBasicMaterial({ color: 0xff3355 })), 0, 8.6, 0); g.add(beacon);
  const halo = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.06, 8, 64), new THREE.MeshBasicMaterial({ color: COLORS.hq, transparent: true, opacity: 0.8 }));
  halo.rotation.x = Math.PI / 2; halo.position.y = 6.9; g.add(halo);
  const light = new THREE.PointLight(COLORS.hq, 25, 14, 2); light.position.y = 6.5; g.add(light);
  S.anim.push(t => {
    beacon.visible = Math.sin(t * 4) > -0.3;
    halo.position.y = 6.9 + Math.sin(t * 1.4) * 0.35; halo.rotation.z = t * 0.6; halo.scale.setScalar(1 + Math.sin(t * 1.4) * 0.08);
    crown.material.emissiveIntensity = 0.7 + Math.sin(t * 2) * 0.25;
    lit.forEach((w, i) => { w.material.emissiveIntensity = 0.55 + 0.45 * Math.max(0, Math.sin(t * 0.7 + i * 1.7)); });
  });
  const urgent = (report.signals || []).filter(x => x.tone !== 'good').length;
  label('hq', new THREE.Vector3(0, 9.4, 0), 'A2Z HQ', urgent ? urgent + ' signal' + (urgent === 1 ? '' : 's') + ' to watch' : 'Ask Groq', true, true);
  S.anim.push(t => {
    const on = S.selected === 'hq' || S.hovered?.key === 'hq';
    halo.material.color.setHex(on ? 0xffffff : COLORS.hq);
    light.intensity = on ? 45 + Math.sin(t * 5) * 10 : 25;
  });
}

// JARVIS agents: one robot per agent on an inner ring around HQ, between the district roads. Click one to prompt it.
// agents: [{ id, name, color }]. Key is 'agent:<id>'. agentState(id, 'idle' | 'busy' | 'done' | 'error') drives the animation.
const AGENT_R = 7.6;
function agentRing(city, agents) {
  S.agentSpots = {}; S.agentColors = {}; S.agentLabels = {};
  const list = (agents || []).slice(0, DISTRICTS.length);
  list.forEach((agent, i) => {
    const key = 'agent:' + agent.id;
    const angle = Math.PI - (i + 0.5) * 2 * Math.PI / DISTRICTS.length;
    const x = Math.sin(angle) * AGENT_R, z = Math.cos(angle) * AGENT_R;
    const color = typeof agent.color === 'number' ? agent.color : parseInt(String(agent.color || '#ffffff').replace('#', ''), 16) || 0xffffff;
    S.agentSpots[key] = [x, z]; S.agentColors[key] = color;
    const lead = agent.id === 'main', size = lead ? 1.65 : 1.3;
    const g = new THREE.Group(); g.position.set(x, 0.2, z); g.rotation.y = angle; g.userData.key = key; city.add(g); S.clickables.push(g);
    const pad = at(cyl(0.75 * size, 0.85 * size, 0.1, mat(0x1b2240, { roughness: 0.8 }), 28), 0, 0.05, 0); pad.castShadow = false; g.add(pad);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.85 * size, 0.05, 8, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.12; g.add(ring);
    const bot = new THREE.Group(); bot.scale.setScalar(size); g.add(bot);
    const shell = mat(0xe9edf7, { roughness: 0.35, metalness: 0.25 }), trim = mat(color, { roughness: 0.4, emissive: color, emissiveIntensity: 0.25 });
    const eye = new THREE.MeshBasicMaterial({ color });
    bot.add(at(cyl(0.3, 0.22, 0.5, trim, 18), 0, 0.62, 0));
    bot.add(at(cyl(0.31, 0.31, 0.06, shell, 18), 0, 0.88, 0));
    const chest = at(box(0.2, 0.12, 0.04, glow(color, 0.9)), 0, 0.66, 0.29); chest.castShadow = false; bot.add(chest);
    const armL = at(box(0.09, 0.34, 0.11, shell), -0.38, 0.62, 0), armR = at(box(0.09, 0.34, 0.11, shell), 0.38, 0.62, 0);
    bot.add(armL, armR);
    const head = new THREE.Group(); head.position.y = 1.14; bot.add(head);
    head.add(box(0.56, 0.4, 0.46, shell));
    const visor = at(box(0.46, 0.2, 0.03, mat(0x0d1226, { roughness: 0.2, metalness: 0.6 })), 0, 0.01, 0.235); visor.castShadow = false; head.add(visor);
    const eyeL = at(ball(0.045, eye, 8), -0.1, 0.01, 0.255), eyeR = at(ball(0.045, eye, 8), 0.1, 0.01, 0.255);
    head.add(eyeL, eyeR);
    head.add(at(cyl(0.015, 0.015, 0.22, mat(C.steel), 6), 0, 0.31, 0));
    const tip = at(ball(0.06, new THREE.MeshBasicMaterial({ color }), 10), 0, 0.44, 0); head.add(tip);
    if (lead) head.add(at(box(0.6, 0.05, 0.5, glow(COLORS.hq, 0.7)), 0, 0.22, 0));
    const hit = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.2, 1.4), new THREE.MeshBasicMaterial({ visible: false })); hit.position.y = 1.1; g.add(hit);
    label(key, new THREE.Vector3(x, 0.2 + 2.1 * size, z), agent.name, null, true, true);
    const phase = i * 1.3;
    S.anim.push(t => {
      const state = S.agentStates.get(key) || 'idle', busy = state === 'busy', on = S.selected === key || S.hovered?.key === key;
      bot.position.y = 0.08 + Math.sin(t * (busy ? 6 : 1.6) + phase) * (busy ? 0.06 : 0.04);
      head.rotation.y = busy ? Math.sin(t * 5 + phase) * 0.45 : Math.sin(t * 0.5 + phase) * 0.15;
      armL.rotation.x = busy ? Math.sin(t * 9) * 0.7 : 0; armR.rotation.x = busy ? -Math.sin(t * 9) * 0.7 : 0;
      const tint = state === 'error' ? C.bad : state === 'done' ? C.ok : color;
      eye.color.setHex(tint); tip.material.color.setHex(tint); ring.material.color.setHex(on ? 0xffffff : tint);
      tip.visible = !busy || Math.sin(t * 14) > -0.2;
      const blink = !busy && (t + phase) % 4 < 0.12;
      eyeL.scale.y = eyeR.scale.y = blink ? 0.2 : 1;
      ring.rotation.z = busy ? t * 3 : t * 0.4;
      ring.material.opacity = on ? 0.95 : busy ? 0.6 + Math.sin(t * 8) * 0.3 : 0.45;
      ring.scale.setScalar(on ? 1.12 + Math.sin(t * 3) * 0.03 : 1);
    });
  });
}
function agentState(id, state = 'idle') {
  if (!S) return;
  const key = 'agent:' + id;
  S.agentStates.set(key, state);
  if (S.agentLabels[key]) S.agentLabels[key].dataset.state = state;
  if (state === 'done' || state === 'error') {
    clearTimeout(S['agentTimer' + key]);
    S['agentTimer' + key] = setTimeout(() => { if (S && S.agentStates.get(key) === state) agentState(id, 'idle'); }, state === 'done' ? 2500 : 6000);
  }
}

// Leads: a parking lot that fills with cars, plus a car that keeps arriving.
function leads(city, n, tile) {
  const g = district(city, 'leads', 0x24304a);
  const lot = at(box(5.6, 0.04, 5, mat(0x2d3550)), 0, 0.16, 0); lot.castShadow = false; g.add(lot);
  const stripe = glow(0xffffff, 0.15);
  for (let r = 0; r < 2; r++) for (let i = 0; i <= 6; i++) { const s = at(box(0.05, 0.02, 1.4, stripe), -2.4 + i * 0.8, 0.19, r ? 1.4 : -1.4); s.castShadow = false; g.add(s); }
  const cols = [0xff4d6d, 0x35d0ba, 0xffc531, 0x5aa9ff, 0xb57bff, 0xff7a45, 0xffffff, 0x46e08a];
  const count = clamp(Math.round(n || 0), 0, 12);
  for (let i = 0; i < count; i++) {
    const car = makeCar(cols[i % cols.length]);
    car.position.set(-2 + (i % 6) * 0.8, 0.18, i < 6 ? -1.4 : 1.4); car.rotation.y = i < 6 ? 0 : Math.PI; g.add(car);
  }
  const driver = makeCar(0xff3b8d); g.add(driver);
  S.anim.push(t => {
    const q = (t * 0.12) % 1, a = q * Math.PI * 2;
    driver.position.set(Math.cos(a) * 2.9, 0.18, Math.sin(a) * 0.35);
    driver.rotation.y = -a + Math.PI;
  });
  label('leads', world(g, 0, 2.6, 0), tile?.title || 'Leads', tile?.value);
}
function makeCar(color) {
  const c = new THREE.Group();
  c.add(at(box(0.5, 0.22, 0.95, mat(color, { roughness: 0.35, metalness: 0.3 })), 0, 0.2, 0));
  c.add(at(box(0.42, 0.18, 0.5, mat(0x9fd4ff, { roughness: 0.1, metalness: 0.5 })), 0, 0.4, -0.05));
  for (const [x, z] of [[-0.25, 0.3], [0.25, 0.3], [-0.25, -0.3], [0.25, -0.3]]) {
    const w = at(cyl(0.1, 0.1, 0.08, mat(0x111111), 10), x, 0.1, z); w.rotation.z = Math.PI / 2; c.add(w);
  }
  c.add(at(box(0.36, 0.06, 0.02, glow(0xfff6c0, 1.2)), 0, 0.22, 0.48));
  return c;
}

// Proposals: stacks of paper, one bundle per proposal, with a sheet floating down.
function proposals(city, n, tile) {
  const g = district(city, 'proposals', 0x22324e);
  const desk = at(box(4.6, 0.5, 3, mat(0x8a5a3b)), 0, 0.4, 0); g.add(desk);
  for (const [x, z] of [[-2, -1.2], [2, -1.2], [-2, 1.2], [2, 1.2]]) g.add(at(box(0.2, 0.3, 0.2, mat(0x6d462d)), x, 0.15, z));
  const count = clamp(Math.round(n || 0), 0, 36), bands = [0x5aa9ff, 0xff7a45, 0x35d0ba, 0xffc531, 0xb57bff];
  const per = 12, top = 0.68;
  let height = top;
  for (let i = 0; i < count; i++) {
    const stack = Math.floor(i / per), k = i % per, x = (stack - 1) * 1.35, y = top + k * 0.16 + 0.08;
    const sheet = at(box(1, 0.14, 1.3, mat(0xfbfbf6, { roughness: 0.9 })), x, y, 0);
    sheet.rotation.y = (rnd() - 0.5) * 0.25; g.add(sheet);
    const band = at(box(1.02, 0.04, 0.12, mat(bands[i % bands.length])), x, y, 0.35); band.rotation.y = sheet.rotation.y; g.add(band);
    height = Math.max(height, y + 0.1);
  }
  const floater = at(box(0.9, 0.02, 1.2, mat(0xffffff, { side: THREE.DoubleSide, emissive: 0x5aa9ff, emissiveIntensity: 0.25 })), 0, 3, 0); g.add(floater);
  const landing = count ? Math.min(height, top + per * 0.16) : top;
  S.anim.push(t => {
    const q = (t * 0.28) % 1, x = Math.floor(Math.max(count - 1, 0) / per) * 1.35 - 1.35;
    floater.position.set(x + Math.sin(q * 9) * 0.5, 4.2 - q * (4.2 - landing - 0.1), Math.cos(q * 7) * 0.3);
    floater.rotation.set(Math.sin(q * 11) * 0.5, q * 3, Math.cos(q * 9) * 0.4);
    floater.material.opacity = 1;
    floater.visible = q < 0.97;
  });
  label('proposals', world(g, 0, 4.8, 0), tile?.title || 'Proposals', tile?.value);
}

// Jobs won: a tower crane. Taller with more wins, one pennant per win.
function wins(city, n, tile) {
  const g = district(city, 'wins', 0x2c2c44);
  const count = clamp(Math.round(n || 0), 0, 14), H = 4.2 + Math.min(4, count * 0.35);
  const yellow = mat(COLORS.wins, { roughness: 0.4, metalness: 0.3 });
  g.add(at(box(1.5, 0.4, 1.5, mat(0x5b6276)), 0, 0.34, 0));
  for (const [x, z] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) g.add(at(box(0.08, H, 0.08, yellow), x, 0.5 + H / 2, z));
  for (let y = 0.9; y < H; y += 0.6) {
    g.add(at(box(0.66, 0.05, 0.05, yellow), 0, 0.5 + y, -0.3), at(box(0.66, 0.05, 0.05, yellow), 0, 0.5 + y, 0.3));
    g.add(at(box(0.05, 0.05, 0.66, yellow), -0.3, 0.5 + y, 0), at(box(0.05, 0.05, 0.66, yellow), 0.3, 0.5 + y, 0));
  }
  const head = new THREE.Group(); head.position.y = 0.5 + H; g.add(head);
  head.add(at(box(0.9, 0.7, 0.9, mat(0xffffff)), 0, 0.35, 0));
  head.add(at(box(0.7, 0.4, 0.05, mat(0x8fd3ff, { roughness: 0.1 })), 0, 0.42, 0.46));
  head.add(at(box(5.4, 0.18, 0.3, yellow), 1.4, 0.82, 0));
  head.add(at(box(1.1, 0.5, 0.6, mat(0x5b6276)), -1.6, 0.6, 0));
  head.add(at(cyl(0.04, 0.04, 1.2, yellow, 6), 0, 1.4, 0));
  const pennants = new THREE.Group(); head.add(pennants);
  for (let i = 0; i < count; i++) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.32, 3), mat([0xff4d6d, 0x35d0ba, 0x5aa9ff, 0xff7a45][i % 4], { flatShading: true }));
    f.rotation.z = Math.PI; f.position.set(-1.1 + i * (5 / Math.max(count, 1)), 0.6, 0); pennants.add(f);
  }
  const trolley = at(box(0.3, 0.15, 0.36, mat(0x333a4d)), 2.6, 0.66, 0); head.add(trolley);
  const cable = at(cyl(0.015, 0.015, 1, mat(0x222222), 4), 0, 0, 0); head.add(cable);
  const load = new THREE.Group(); head.add(load);
  load.add(at(box(1.2, 0.14, 0.2, mat(0xff4d3d, { metalness: 0.5 })), 0, 0, 0));
  load.add(at(box(0.1, 0.18, 0.1, mat(0x222222)), 0, 0.15, 0));
  const flag = at(box(0.5, 0.3, 0.02, glow(0xff3b5c, 0.5)), 0.26, 1.85, 0); head.add(flag);
  S.anim.push(t => {
    head.rotation.y = Math.sin(t * 0.25) * 1.3;
    const tx = 1.4 + Math.sin(t * 0.5) * 1.1, drop = 1.6 + Math.sin(t * 0.8) * 0.9;
    trolley.position.x = tx;
    cable.position.set(tx, 0.6 - drop / 2, 0); cable.scale.y = drop;
    load.position.set(tx, 0.6 - drop - 0.1, 0); load.rotation.y = Math.sin(t * 0.6) * 0.6;
    flag.rotation.y = Math.sin(t * 6) * 0.35;
    pennants.children.forEach((p, i) => { p.rotation.x = Math.sin(t * 5 + i) * 0.4; });
  });
  label('wins', world(g, 0, H + 3, 0), tile?.title || 'Jobs won', tile?.value);
}

// Demo sales: one commercial building per pipeline. Height follows won value.
function pipelines(city, items, tile) {
  const g = district(city, 'pipelines', 0x2a2848);
  const list = (items || []).slice(0, 6), max = Math.max(1, ...list.map(p => p.amount));
  const slots = [[-1.9, -1.6], [1.9, -1.6], [-1.9, 1.7], [1.9, 1.7], [0, -0.1], [0, 2.6]];
  if (!list.length) g.add(at(box(2, 0.6, 2, mat(0x3a3f5c)), 0, 0.45, 0));
  list.forEach((p, i) => {
    const color = new THREE.Color(S.palette[i % S.palette.length] || '#b57bff').getHex();
    const h = 1.2 + 6.2 * Math.sqrt(p.amount / max), w = i > 3 ? 1.3 : 1.7, [x, z] = slots[i];
    const b = new THREE.Group(); b.position.set(x, 0.14, z); g.add(b);
    b.add(at(box(w, h, w, mat(new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.55), { roughness: 0.5 })), 0, h / 2, 0));
    b.add(at(box(w + 0.12, 0.18, w + 0.12, mat(color)), 0, h + 0.09, 0));
    b.add(at(box(w + 0.02, 0.35, w + 0.02, mat(color, { emissive: color, emissiveIntensity: 0.25 })), 0, 0.18, 0));
    const lit = glow(color, 0.9), off = mat(0x34405f, { roughness: 0.2, metalness: 0.5 });
    const panes = [];
    const floors = Math.floor((h - 0.6) / 0.45);
    for (let f = 0; f < floors; f++) for (let s = 0; s < 4; s++) {
      const a = s * Math.PI / 2, on = rnd() < 0.7, m = on ? lit.clone() : off;
      const strip = box(w * 0.82, 0.22, 0.03, m); strip.castShadow = false;
      strip.position.set(Math.sin(a) * (w / 2 + 0.01), 0.6 + f * 0.45, Math.cos(a) * (w / 2 + 0.01)); strip.rotation.y = a;
      b.add(strip); if (on) panes.push(strip);
    }
    const tank = at(cyl(0.22, 0.22, 0.4, mat(0x8b6b4a), 10), w * 0.25, h + 0.4, -w * 0.2); b.add(tank);
    const blink = at(ball(0.08, new THREE.MeshBasicMaterial({ color: 0xff3b5c }), 8), -w * 0.3, h + 0.3, w * 0.3); b.add(blink);
    S.anim.push(t => {
      blink.visible = Math.sin(t * 3 + i) > 0;
      panes.forEach((m, k) => { m.material.emissiveIntensity = 0.45 + 0.5 * (Math.sin(t * 0.9 + k * 2.3 + i) > -0.6 ? 1 : 0.1); });
    });
    label('pipelines', world(g, x, h + 1.1, z), p.name, money(p.amount), true);
  });
  const top = list.length ? 1.2 + 6.2 + 2.8 : 2;
  label('pipelines', world(g, 0, top, 0), tile?.title || 'Pipeline sales', tile?.value);
}

// Labor: one house per booking with smoke from the chimney.
function labor(city, sale, tile) {
  const g = district(city, 'labor', 0x24364a);
  const count = clamp(Math.round(sale?.count || 0), 0, 9);
  const roofs = [0xff7a45, 0x5aa9ff, 0xff4d8d, 0x35d0ba, 0xffc531, 0xb57bff];
  const walls = [0xfff4e0, 0xe6f0ff, 0xfde2e4, 0xe3fff2];
  for (let i = 0; i < 9; i++) {
    const x = (i % 3 - 1) * 2.1, z = (Math.floor(i / 3) - 1) * 2.1;
    if (i >= count) {
      const lot = at(box(1.5, 0.05, 1.5, mat(0x3a4b3c)), x, 0.17, z); lot.castShadow = false; g.add(lot);
      continue;
    }
    const h = new THREE.Group(); h.position.set(x, 0.14, z); h.rotation.y = (i % 2) * Math.PI / 2; g.add(h);
    h.add(at(box(1.4, 0.9, 1.2, mat(walls[i % walls.length])), 0, 0.45, 0));
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.12, 0.75, 4), mat(roofs[i % roofs.length], { flatShading: true }));
    roof.rotation.y = Math.PI / 4; roof.position.y = 1.27; shade(roof); h.add(roof);
    h.add(at(box(0.3, 0.5, 0.04, mat(0x6b4630)), 0, 0.25, 0.61));
    const win = glow(0xffd27a, 0.8); h.add(at(box(0.3, 0.26, 0.04, win), 0.42, 0.55, 0.61));
    h.add(at(box(0.18, 0.5, 0.18, mat(0x9a5a44)), 0.35, 1.45, -0.2));
    const puffs = Array.from({ length: 4 }, () => { const p = ball(0.12, mat(0xe8ecf5, { transparent: true, roughness: 1 }), 8); p.castShadow = false; h.add(p); return p; });
    S.anim.push(t => {
      puffs.forEach((p, k) => { const q = (t * 0.35 + k / 4 + i * 0.13) % 1; p.position.set(0.35 + q * 0.3, 1.75 + q * 1.3, -0.2); p.scale.setScalar(0.6 + q * 1.6); p.material.opacity = 0.75 * (1 - q); });
      win.emissiveIntensity = 0.5 + 0.35 * Math.sin(t * 1.3 + i);
    });
  }
  label('labor', world(g, 0, 3.4, 0), tile?.title || 'Labor sales', tile?.value);
}

// Workforce: booked crew (hi-vis, working) on the left, available crew (blue, waiting) on the right.
// Index i matches the app roster: booked first, then available. Each figure is clickable.
function workforce(city, wf, tile) {
  const g = district(city, 'workforce', 0x2c3148);
  const booked = (wf?.crew || []).slice(0, 40), bench = (wf?.bench || []).slice(0, 24);
  const fallback = booked.length ? 0 : clamp(Math.round(wf?.workers || 0), 0, 40);
  const people = [...booked.map(c => ({ ...c, status: 'booked' })), ...Array.from({ length: fallback }, () => ({ status: 'booked' })),
    ...bench.map(c => ({ ...c, status: 'available' }))];
  const jobs = [...new Set(booked.map(c => c.job))];
  const split = bench.length ? 0.9 : 3.3;
  if (bench.length) {
    const divider = at(box(0.06, 0.04, 6.4, glow(0xffffff, 0.3)), split, 0.17, 0); divider.castShadow = false; g.add(divider);
    const bench3d = at(box(Math.min(2.2, 3.3 - split), 0.18, 0.4, mat(0x8a5a3b)), split + 1.25, 0.32, 2.75); g.add(bench3d);
  }
  const areas = { booked: { x0: -3.3, x1: split - 0.3, list: people.filter(p => p.status === 'booked') }, available: { x0: split + 0.3, x1: 3.3, list: people.filter(p => p.status === 'available') } };
  const vests = { booked: mat(0xff7a1a, { emissive: 0xff7a1a, emissiveIntensity: 0.15 }), available: mat(0x2f9bff, { emissive: 0x2f9bff, emissiveIntensity: 0.2 }) };
  const stripe = glow(0xe8ff6b, 0.6), skin = mat(C.skin), pants = mat(C.denim), boot = mat(0x3b2a20);
  let i = 0;
  for (const status of ['booked', 'available']) {
    const { x0, x1, list } = areas[status], width = x1 - x0;
    const cols = Math.max(1, Math.min(Math.floor(width / 0.62), Math.ceil(Math.sqrt(list.length * width / 5)))), rows = Math.ceil(list.length / cols);
    const gap = Math.min(1.1, width / cols, 6 / Math.max(rows, 1));
    list.forEach((c, n) => {
      const index = i++, r = Math.floor(n / cols), k = n % cols, inRow = Math.min(cols, list.length - r * cols);
      const w = new THREE.Group();
      w.scale.setScalar(Math.min(1.45, gap * 1.3));
      w.position.set((x0 + x1) / 2 + (k - (inRow - 1) / 2) * gap, 0.14, (r - (rows - 1) / 2) * gap * 1.1);
      if (status === 'available') w.rotation.y = Math.sin(index * 2.3) * 0.6;
      w.userData = { key: 'workforce', worker: index };
      const hatFor = st => st === 'available' ? 0xd8e6ff : c.role === 'Foreman' ? 0xffffff : HATS[Math.max(0, jobs.indexOf(c.job)) % HATS.length];
      const hat = mat(hatFor(status), { roughness: 0.3, emissive: 0x000000 });
      // A worker whose status changed since the last refresh walks across from their old spot.
      let prev = c.key && S.crewPos.get(c.key); const home = { x: w.position.x, z: w.position.z };
      const from = prev && { x: prev.x - g.position.x, z: prev.z - g.position.z };
      const moved = from && Math.hypot(from.x - home.x, from.z - home.z) > 0.05;
      // Status change: a slow walk across the divider. Same status but a new slot: a short shuffle so nobody jumps.
      let walk = !moved ? null : prev.status !== status ? { from, prevStatus: prev.status, t0: now() + 0.4, dur: 4.5 } : { from, prevStatus: status, t0: now() + 0.2, dur: 1.2 };
      if (c.key) S.crewPos.set(c.key, { x: g.position.x + home.x, z: g.position.z + home.z, status });
      const vest = walk ? vests[walk.prevStatus].clone() : vests[status];
      if (walk) { hat.color.setHex(hatFor(walk.prevStatus)); w.position.set(walk.from.x, 0.14, walk.from.z); }
      const legL = at(box(0.12, 0.38, 0.14, pants), -0.08, 0.27, 0), legR = at(box(0.12, 0.38, 0.14, pants), 0.08, 0.27, 0);
      legL.add(at(box(0.13, 0.08, 0.2, boot), 0, -0.2, 0.03)); legR.add(at(box(0.13, 0.08, 0.2, boot), 0, -0.2, 0.03));
      const body = at(box(0.34, 0.4, 0.2, vest), 0, 0.66, 0);
      body.add(at(box(0.35, 0.05, 0.21, stripe), 0, -0.06, 0));
      const armL = at(box(0.09, 0.36, 0.1, vest), -0.22, 0.66, 0), armR = at(box(0.09, 0.36, 0.1, vest), 0.22, 0.66, 0);
      const head = at(ball(0.13, skin, 10), 0, 1.0, 0);
      const brim = at(cyl(0.2, 0.2, 0.03, hat, 14), 0, 1.07, 0.02), dome = at(shade(new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), hat)), 0, 1.07, 0);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.035, 6, 24), new THREE.MeshBasicMaterial({ color: status === 'booked' ? COLORS.workforce : 0x4fc3ff, transparent: true, opacity: 0 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.04;
      const hit = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.3, 0.6), new THREE.MeshBasicMaterial({ visible: false })); hit.position.y = 0.6;
      w.add(legL, legR, body, armL, armR, head, brim, dome, ring, hit);
      g.add(w); S.clickables.push(w);
      const phase = index * 0.7, busy = status === 'booked';
      const rest = w.rotation.y;
      S.anim.push(t => {
        if (walk) {
          const q = clamp((t - walk.t0) / walk.dur, 0, 1), e = q * q * (3 - 2 * q);
          w.position.x = walk.from.x + (home.x - walk.from.x) * e; w.position.z = walk.from.z + (home.z - walk.from.z) * e;
          if (q > 0 && q < 1) {
            const st = Math.sin(t * 11);
            w.rotation.y = Math.atan2(home.x - walk.from.x, home.z - walk.from.z);
            w.position.y = 0.14 + Math.abs(st) * 0.06;
            legL.rotation.x = st * 0.7; legR.rotation.x = -st * 0.7; armL.rotation.x = -st * 0.6; armR.rotation.x = st * 0.6;
            if (q > 0.5 && !walk.swapped) { walk.swapped = true; body.material = armL.material = armR.material = vests[status]; hat.color.setHex(hatFor(status)); }
            return;
          }
          if (q >= 1) { if (!walk.swapped) { body.material = armL.material = armR.material = vests[status]; hat.color.setHex(hatFor(status)); } w.rotation.y = rest; walk.done = true; walk = null; }
        }
        const on = S.worker === index, hot = S.hovered?.worker === index, s = Math.sin(t * (busy ? 3 : 1.2) + phase);
        w.position.y = 0.14 + (busy ? Math.max(0, s) * 0.05 : 0) + (on ? 0.12 + Math.sin(t * 6) * 0.05 : 0);
        if (busy) { armR.rotation.x = on ? -2.6 + Math.sin(t * 8) * 0.4 : s * 0.5; armL.rotation.x = -s * 0.5; legL.rotation.x = s * 0.25; legR.rotation.x = -s * 0.25; }
        else { armR.rotation.x = on ? -2.6 + Math.sin(t * 8) * 0.4 : 0.1; armL.rotation.z = 0.15; head.rotation.y = s * 0.5; }
        ring.material.opacity += ((on ? 1 : hot ? 0.6 : 0) - ring.material.opacity) * 0.2;
        hat.emissive.setHex(on || hot ? 0x665500 : 0x000000);
      });
    });
  }
  label('workforce', world(g, 0, 2.6, 0), tile?.title || 'Workforce');
  if (bench.length) {
    label('workforce', world(g, (-3.3 + split) / 2, 1.9, -3), 'Booked', String(areas.booked.list.length), true);
    label('workforce', world(g, (split + 3.3) / 2, 1.9, -3), 'Available', String(bench.length), true);
  }
}

// Runway: a fuel tank with a glass gauge. Fill shows months of runway against a 6 month scale.
function runway(city, r, tile) {
  const g = district(city, 'runway', 0x24364a);
  const months = r?.months, fill = months == null ? 0 : clamp(months / 6, 0.03, 1);
  const level = months == null ? C.off : months >= 3 ? C.ok : months >= 1.5 ? C.warn : C.bad;
  const red = mat(0xff3b4f, { roughness: 0.35, metalness: 0.35 });
  const tank = new THREE.Group(); tank.position.set(-0.6, 1.35, 0); tank.rotation.y = Math.PI / 4; g.add(tank);
  const body = cyl(1, 1, 3.6, red, 32); body.rotation.z = Math.PI / 2; tank.add(body);
  for (const x of [-1.8, 1.8]) { const cap = ball(1, red, 24); cap.scale.set(0.35, 1, 1); cap.position.x = x; tank.add(cap); }
  for (const x of [-1, 0, 1]) { const band = cyl(1.03, 1.03, 0.1, mat(0xffffff), 32); band.rotation.z = Math.PI / 2; band.position.x = x; tank.add(band); }
  for (const x of [-1.2, 1.2]) tank.add(at(box(0.25, 0.9, 1.4, mat(0x5b6276)), x, -0.9, 0));
  tank.add(at(cyl(0.22, 0.22, 0.3, mat(0xdddddd), 12), 0, 1.1, 0));
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 4, 28, 1, true), mat(0xbfe3ff, { transparent: true, opacity: 0.22, roughness: 0.05, side: THREE.DoubleSide }));
  glass.position.set(2.2, 2.2, -1.3); g.add(glass);
  g.add(at(cyl(0.65, 0.7, 0.2, mat(0x5b6276)), 2.2, 0.24, -1.3), at(cyl(0.65, 0.6, 0.15, mat(0x5b6276)), 2.2, 4.25, -1.3));
  for (let i = 1; i < 6; i++) {
    const tick = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.02, 6, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
    tick.rotation.x = Math.PI / 2; tick.position.set(2.2, 0.2 + i * 4 / 6, -1.3); g.add(tick);
  }
  const fuel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 28), glow(level, 0.55));
  g.add(fuel);
  const bubbles = Array.from({ length: 6 }, () => { const b = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })); g.add(b); return b; });
  // Pump with a hose.
  g.add(at(box(0.7, 1.4, 0.5, mat(0xffffff)), 2.2, 0.84, 1.6), at(box(0.72, 0.3, 0.52, mat(COLORS.runway, { emissive: COLORS.runway, emissiveIntensity: 0.6 })), 2.2, 1.4, 1.6));
  const H = 4 * fill;
  S.anim.push(t => {
    const wob = 1 + Math.sin(t * 2.2) * 0.02;
    fuel.scale.y = Math.max(0.02, H * wob); fuel.position.set(2.2, 0.32 + (H * wob) / 2, -1.3);
    fuel.material.emissiveIntensity = 0.45 + Math.sin(t * 2) * 0.15;
    bubbles.forEach((b, k) => { const q = (t * 0.4 + k / 6) % 1; b.position.set(2.2 + Math.sin(k * 2.1) * 0.3, 0.35 + q * H, -1.3 + Math.cos(k * 1.7) * 0.3); b.visible = H > 0.2; });
  });
  label('runway', world(g, 0.8, 5.2, -0.6), tile?.title || 'Runway', tile?.value);
}

// System health: a gaming PC with a glass side panel.
// Front intake fans = deploys, RAM sticks = data feeds. Healthy parts glow in cycling RGB, setup parts slow down in amber, failures stall and flash red.
function fan(size, frame) {
  const g = new THREE.Group(), b = size * 0.08;
  for (const [x, y, w, h] of [[0, (size - b) / 2, size, b], [0, -(size - b) / 2, size, b], [(size - b) / 2, 0, b, size], [-(size - b) / 2, 0, b, size]]) g.add(at(box(w, h, 0.1, frame), x, y, 0));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(size * 0.42, 0.06, 8, 36), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  g.add(ring);
  const rotor = new THREE.Group(); g.add(rotor);
  const blade = mat(0x1a1d2b, { transparent: true, opacity: 0.85 });
  for (let i = 0; i < 7; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(size * 0.36, 0.07, 0.02), blade);
    b.position.set(Math.cos(i / 7 * Math.PI * 2) * size * 0.2, Math.sin(i / 7 * Math.PI * 2) * size * 0.2, 0.03);
    b.rotation.z = i / 7 * Math.PI * 2 + 0.5; rotor.add(b);
  }
  rotor.add(new THREE.Mesh(new THREE.CylinderGeometry(size * 0.1, size * 0.1, 0.06, 16), mat(0x2a2f44)).rotateX(Math.PI / 2));
  return { g, ring, rotor };
}
function envelope(color) {
  const letter = new THREE.Group();
  letter.add(box(4.15, 0.24, 2.75, mat(color)));
  const flap = new THREE.BufferGeometry();
  flap.setAttribute('position', new THREE.Float32BufferAttribute([
    -2.06, 0.132, -1.36, 0, 0.132, 0.58, 2.06, 0.132, -1.36,
  ], 3));
  flap.computeVertexNormals();
  letter.add(new THREE.Mesh(flap, mat(0xd4b08c)));
  const seam = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-2.05, 0.139, -1.35),
    new THREE.Vector3(0, 0.139, 0.58),
    new THREE.Vector3(2.05, 0.139, -1.35),
  ]);
  letter.add(new THREE.Line(seam, new THREE.LineBasicMaterial({ color: 0x8b624e })));
  letter.add(at(box(0.48, 0.02, 0.38, mat(0xd37c61)), 1.58, 0.14, -0.94));
  return letter;
}

const MAIL_PAPER = [0xf8ebd2, 0xeed1a9, 0xf9ead5, 0xeac4a8, 0xffefd9];
const MAIL_TOP = 2.11;

function mailDistrict(city, tile) {
  const g = district(city, 'mail', 0x352744);
  g.add(at(box(5.7, 0.16, 4.8, mat(0x584963)), 0, 0.20, 0));
  for (const [index, paper] of MAIL_PAPER.entries()) {
    const letter = envelope(paper);
    letter.position.set(index % 2 ? 0.23 : -0.20, 0.43 + index * 0.31, 0);
    letter.rotation.y = index % 2 ? 0.13 : -0.18;
    g.add(letter);
  }
  label('mail', world(g, 0, 2.65, 0), tile?.short || 'Mail', null, false);
  if (tile?.value) label('mail', world(g, 0, 3.52, 0), 'Inbox', tile.value, true);
}

function deliverMail(count) {
  if (!S || S.reduceMotion.matches || !S.container.offsetParent || document.hidden) return;
  const flights = Math.min(count, 5, 5 - S.mailArrivals.length);
  for (let index = 0; index < flights; index++) {
    const letter = envelope(MAIL_PAPER[index]);
    letter.visible = false;
    S.mailFlights.add(letter);
    S.mailArrivals.push({ letter, starts: now() + index * 0.28 });
  }
}

function animateMail(time) {
  const [x, z] = SPOTS.mail;
  S.mailArrivals = S.mailArrivals.filter(({ letter, starts }) => {
    const progress = (time - starts) / 1.35;
    if (progress < 0) return true;
    if (progress >= 1) {
      letter.removeFromParent();
      letter.traverse(dispose);
      return false;
    }
    const ease = 1 - Math.pow(1 - progress, 2);
    letter.visible = true;
    letter.position.set(x + 5 * (1 - ease), MAIL_TOP + 8 * (1 - ease) + Math.sin(progress * Math.PI) * 2, z - 4 * (1 - ease));
    letter.rotation.set(-0.65 * (1 - ease), -0.18 + 2.9 * (1 - ease), 0.45 * (1 - ease));
    // The delivered envelope joins the stack instead of sitting on top of it.
    letter.scale.setScalar(progress > 0.92 ? Math.max(0.01, (1 - progress) / 0.08) : 1);
    return true;
  });
}

function system(city, sys, tile) {
  const g = district(city, 'system', 0x262a48);
  const deploys = Object.entries(sys.deploys).map(([n, d]) => d.state === 'ready' ? 'ok' : d.status === 'setup' ? 'setup' : 'bad');
  const feeds = Object.values(sys.sources).map(x => x.status === 'ok' ? 'ok' : x.status === 'setup' ? 'setup' : 'bad');
  const all = [...deploys, ...feeds], worst = all.includes('bad') ? 'bad' : all.includes('setup') ? 'setup' : 'ok';
  const pc = new THREE.Group(); pc.position.set(-0.3, 0.14, 0); pc.scale.setScalar(1.25); g.add(pc);
  const W = 2.4, H = 4.6, D = 4.4, caseM = mat(0x4a4d55, { roughness: 0.45, metalness: 0.5 }), dark = mat(0x16181f, { roughness: 0.6 });
  // Shell: back, top, bottom, far side. The near side is glass and the front is the drive bay panel.
  const top = at(box(W, 0.06, D, mat(0x111522, { transparent: true, opacity: 0.35, roughness: 0.2 })), 0, H + 0.03, 0); top.castShadow = false;
  pc.add(top, at(box(W, 0.12, D, caseM), 0, 0.12, 0));
  for (const x of [-W / 2 + 0.05, W / 2 - 0.05]) pc.add(at(box(0.1, 0.1, D, caseM), x, H, 0));
  pc.add(at(box(0.1, H, D, caseM), -W / 2, H / 2 + 0.06, 0), at(box(W, H, 0.1, caseM), 0, H / 2 + 0.06, -D / 2));
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) pc.add(at(box(0.3, 0.12, 0.3, dark), x * (W / 2 - 0.25), 0.04, z * (D / 2 - 0.3)));
  const glass = at(box(0.04, H - 0.1, D - 0.1, mat(0x9fd8ff, { transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.1 })), W / 2, H / 2 + 0.06, 0);
  glass.castShadow = false; pc.add(glass);
  pc.add(at(box(0.08, H, 0.08, caseM), W / 2, H / 2 + 0.06, -D / 2), at(box(0.08, H, 0.08, caseM), W / 2, H / 2 + 0.06, D / 2));
  // Front panel, like the reference tower: drive bays, LEDs, buttons and a vent.
  const front = new THREE.Group(); front.position.set(0, 0, D / 2); pc.add(front);
  front.add(at(box(W, H, 0.12, mat(0x3a3d45, { roughness: 0.5, metalness: 0.4 })), 0, H / 2 + 0.06, 0));
  for (let i = 0; i < 3; i++) front.add(at(box(W * 0.78, 0.36, 0.06, dark), 0, H - 0.45 - i * 0.46, 0.08));
  const power = at(ball(0.09, new THREE.MeshBasicMaterial({ color: tone(worst) }), 10), 0.2, H - 1.95, 0.1); front.add(power);
  front.add(at(ball(0.07, new THREE.MeshBasicMaterial({ color: 0x46e08a }), 10), -0.15, H - 1.95, 0.1));
  front.add(at(box(W * 0.5, 0.12, 0.05, dark), 0, H - 2.2, 0.08));
  front.add(at(cyl(0.16, 0.16, 0.06, mat(0xd9dce4), 18).rotateX(Math.PI / 2), 0, H - 2.75, 0.08));
  front.add(at(cyl(0.09, 0.09, 0.06, mat(0xffc531, { emissive: 0xffc531, emissiveIntensity: 0.5 }), 14).rotateX(Math.PI / 2), 0, H - 3.15, 0.08));
  front.add(at(box(W * 0.8, 0.5, 0.06, mat(0xd9dce4)), 0, 0.5, 0.08));
  const rgb = [];
  const strip = at(box(0.05, 0.05, D - 0.2, new THREE.MeshBasicMaterial({ color: 0xff00ff })), W / 2 - 0.08, H - 0.05, 0); pc.add(strip); rgb.push(strip.material);
  const strip2 = at(box(0.05, 0.05, D - 0.2, new THREE.MeshBasicMaterial({ color: 0x00ffff })), W / 2 - 0.08, 0.2, 0); pc.add(strip2); rgb.push(strip2.material);
  for (const z of [-D / 2 + 0.12, D / 2 - 0.12]) { const v = at(box(0.05, H - 0.3, 0.05, new THREE.MeshBasicMaterial({ color: 0xffffff })), W / 2 - 0.08, H / 2 + 0.06, z); pc.add(v); rgb.push(v.material); }
  // Inside: motherboard, CPU cooler, GPU, RAM, PSU and coolant loop.
  pc.add(at(box(0.06, H * 0.72, D * 0.7, mat(0x1d2433)), -W / 2 + 0.1, H * 0.6, -0.1));
  for (let i = 0; i < 6; i++) pc.add(at(box(0.02, 0.02, D * 0.6, glow(0x3fa9ff, 0.3)), -W / 2 + 0.14, H * 0.32 + i * 0.5, -0.1));
  const cpu = at(cyl(0.42, 0.42, 0.25, mat(0x22262f, { metalness: 0.6 }), 24).rotateZ(Math.PI / 2), -W / 2 + 0.3, H * 0.72, -0.4); pc.add(cpu);
  const cpuRing = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.04, 8, 36), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  cpuRing.rotation.y = Math.PI / 2; cpuRing.position.set(-W / 2 + 0.44, H * 0.72, -0.4); pc.add(cpuRing); rgb.push(cpuRing.material);
  const gpu = new THREE.Group(); gpu.position.set(-0.05, H * 0.4, -0.15); pc.add(gpu);
  gpu.add(box(1.7, 0.34, 2.6, mat(0x1b1e28, { metalness: 0.6 })));
  gpu.add(at(box(0.05, 0.08, 2.5, new THREE.MeshBasicMaterial({ color: 0xff3b8d })), 0.86, 0.1, 0));
  rgb.push(gpu.children[1].material);
  const gpuFans = [-0.75, 0.75].map(z => { const f = fan(1, dark); f.g.rotation.set(Math.PI / 2, Math.PI / 5, 0); f.g.position.set(0.15, -0.24, z); gpu.add(f.g); rgb.push(f.ring.material); return f; });
  const ram = feeds.map((st, i) => {
    const stick = new THREE.Group(); stick.position.set(-W / 2 + 0.35, H * 0.74, 0.3 + i * 0.17); pc.add(stick);
    stick.add(box(0.5, 1, 0.07, mat(0x2b2f3d, { metalness: 0.5 })));
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.16, 0.09), new THREE.MeshBasicMaterial({ color: tone(st) }));
    led.position.y = 0.56; stick.add(led);
    return { st, led, i };
  });
  pc.add(at(box(W - 0.3, 0.8, 1.6, mat(0x252833)), 0, 0.6, -D / 2 + 1));
  const intake = deploys.map((st, i) => {
    const f = fan(1.15, dark); f.g.rotation.x = -Math.PI / 2; f.g.position.set(0.2, H - 0.12, (i - (deploys.length - 1) / 2) * 1.3); pc.add(f.g); return { st, ...f, i };
  });
  const exhaust = fan(1.1, dark); exhaust.g.position.set(0.15, H - 1.1, -D / 2 + 0.18); exhaust.g.rotation.y = -0.5; pc.add(exhaust.g); rgb.push(exhaust.ring.material);
  const tubeM = mat(0xa0e9ff, { transparent: true, opacity: 0.35 });
  const path = new THREE.CatmullRomCurve3([new THREE.Vector3(-W / 2 + 0.45, H * 0.72, -0.4), new THREE.Vector3(0.2, H - 0.4, -0.6),
    new THREE.Vector3(0.2, H - 0.35, 1.2), new THREE.Vector3(0.1, H - 1.1, D / 2 - 0.5)]);
  pc.add(new THREE.Mesh(new THREE.TubeGeometry(path, 40, 0.07, 8, false), tubeM));
  const drops = Array.from({ length: 10 }, () => { const d = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), new THREE.MeshBasicMaterial({ color: 0x46f0ff })); pc.add(d); return d; });
  const glowLight = new THREE.PointLight(0xb57bff, 40, 9, 1.5); glowLight.position.set(0.4, H / 2, 0.4); pc.add(glowLight);
  const glowLight2 = new THREE.PointLight(0x46f0ff, 25, 7, 1.5); glowLight2.position.set(0.4, H * 0.8, -1); pc.add(glowLight2);
  const hue = new THREE.Color(), statusColor = st => st === 'ok' ? null : tone(st);
  const speed = { ok: 9, setup: 2, bad: 0 };
  S.anim.push(t => {
    rgb.forEach((m, k) => m.color.copy(hue.setHSL((t * 0.12 + k * 0.13) % 1, 1, 0.55)));
    glowLight.color.setHSL((t * 0.12) % 1, 0.9, 0.6); glowLight2.color.setHSL((t * 0.12 + 0.5) % 1, 0.9, 0.6);
    for (const f of intake) {
      f.rotor.rotation.z = t * speed[f.st] + f.i + (f.st === 'bad' ? Math.sin(t * 25) * 0.03 : 0);
      const c = statusColor(f.st);
      if (c) f.ring.material.color.setHex(f.st === 'bad' && Math.sin(t * 6) < 0 ? 0x330008 : c);
      else f.ring.material.color.setHSL((t * 0.12 + f.i * 0.2) % 1, 1, 0.55);
    }
    gpuFans.forEach((f, k) => { f.rotor.rotation.z = t * 11 + k; });
    exhaust.rotor.rotation.z = -t * 7;
    for (const r of ram) {
      const c = statusColor(r.st);
      if (!c) r.led.material.color.setHSL((t * 0.2 + r.i * 0.08) % 1, 1, 0.55);
      else r.led.material.color.setHex(r.st === 'bad' && Math.sin(t * 6 + r.i) < 0 ? 0x220006 : c);
    }
    drops.forEach((d, k) => { d.position.copy(path.getPointAt((t * 0.15 + k / drops.length) % 1)); });
    power.visible = worst === 'ok' || Math.sin(t * 5) > -0.2;
  });
  label('system', world(g, 0, 7.4, 0), tile?.title || 'System health');
}

// Packets flow from every district into HQ. More activity means more packets.
function flows(city, report) {
  const k = report.kpis, total = (k.pipelines || []).reduce((a, p) => a + p.amount, 0);
  const vol = { leads: k.funnel?.leads, proposals: k.funnel?.proposals, wins: k.funnel?.wins, labor: k.labor?.count,
    pipelines: total / 10000, workforce: k.workforce?.workers, runway: k.runway?.months, system: 3 };
  const geo = new THREE.SphereGeometry(0.14, 10, 10);
  for (const [key, [x, z]] of Object.entries(SPOTS)) {
    if (!vol[key]) continue;
    const n = clamp(Math.round(2 + Math.log2(1 + vol[key])), 2, 9);
    const len = Math.hypot(x, z), ux = -x / len, uz = -z / len, start = 3.8, end = len - 3.8;
    const m = new THREE.MeshBasicMaterial({ color: COLORS[key] });
    const dots = Array.from({ length: n }, () => { const d = new THREE.Mesh(geo, m); city.add(d); return d; });
    const px = -uz * 0.3, pz = ux * 0.3, speed = 0.12 + Math.min(0.15, n * 0.012);
    S.anim.push(t => dots.forEach((d, i) => {
      const q = (t * speed + i / n) % 1, dist = start + q * (end - start);
      d.position.set(x + ux * dist + px, 0.45 + Math.sin(q * Math.PI) * 0.25, z + uz * dist + pz);
      d.scale.setScalar(q > 0.9 ? (1 - q) * 10 : 1);
    }));
  }
}

// ---------------- interaction ----------------
function pick(e) {
  const r = S.renderer.domElement.getBoundingClientRect();
  S.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  S.raycaster.setFromCamera(S.pointer, S.camera);
  const hit = S.raycaster.intersectObjects(S.clickables, true)[0];
  let o = hit?.object;
  while (o && !o.userData.key) o = o.parent;
  return o ? { key: o.userData.key, worker: o.userData.worker } : null;
}
function setHover(hit) {
  if (S.hovered?.key === hit?.key && S.hovered?.worker === hit?.worker) return;
  S.hovered = hit;
  S.renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
  highlight();
}
function highlight() {
  for (const l of S.labelList) l.el.classList.toggle('hot', l.key === S.selected || l.key === S.hovered?.key);
}
function select(key, worker = null, fly = true) {
  if (!S) return;
  const changed = key !== S.selected && fly;
  S.selected = key; S.worker = key === 'workforce' ? worker : null;
  highlight();
  const agent = S.agentSpots[key];
  if (!changed || !(SPOTS[key] || key === 'hq' || agent)) return;
  S.controls.autoRotate = false;
  const [x, z] = SPOTS[key] || agent || [0, 0];
  S.focus = { target: agent ? new THREE.Vector3(x, 1.4, z) : new THREE.Vector3(x * 0.55, 1.8, z * 0.55), zoom: agent ? 2.4 : key === 'workforce' ? 1.9 : 1.5, t0: now(), from: S.controls.target.clone(), fromZoom: S.camera.zoom };
}
function reset() {
  if (!S) return;
  S.focus = { target: HOME.clone(), zoom: 1, t0: now(), from: S.controls.target.clone(), fromZoom: S.camera.zoom };
  S.controls.autoRotate = true;
}
const money = v => v == null ? '-' : Math.abs(v) >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : Math.abs(v) >= 1e4 ? '$' + Math.round(v / 1000) + 'k' : '$' + Math.round(v).toLocaleString('en-US');

// ---------------- render loop ----------------
const v3 = new THREE.Vector3();
function loop() {
  if (!S) return;
  S.frame = requestAnimationFrame(loop);
  if (document.hidden || !S.container.offsetParent) return;
  const t = now();
  if (S.focus) {
    const q = Math.min(1, (t - S.focus.t0) / 0.9), e = 1 - Math.pow(1 - q, 3);
    S.controls.target.lerpVectors(S.focus.from, S.focus.target, e);
    S.camera.zoom = S.focus.fromZoom + (S.focus.zoom - S.focus.fromZoom) * e; S.camera.updateProjectionMatrix();
    if (q >= 1) S.focus = null;
  }
  S.controls.update();
  for (const f of S.anim) f(t);
  traffic(t);
  animateMail(t);
  S.renderer.render(S.scene, S.camera);
  const w = S.container.clientWidth, h = S.container.clientHeight;
  for (const l of S.labelList) {
    v3.copy(l.anchor).project(S.camera);
    const x = (v3.x + 1) / 2 * w, y = (1 - v3.y) / 2 * h;
    l.el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    l.el.hidden = x < -60 || x > w + 60 || y < -20 || y > h + 60 || (l.tag && l.key !== S.selected && l.key !== S.hovered?.key);
  }
}

if (typeof window !== 'undefined') window.A2ZCity = { mount, supported, drive, version: '1.1.0' };
