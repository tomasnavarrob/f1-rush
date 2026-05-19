/* ============================================================
   F1 RUSH — Motor principal del juego
   ============================================================ */

(() => {

// ============================================================
//  CONSTANTES
// ============================================================
const TRACK_W_WORLD = 1800;
const TRACK_H_WORLD = 1300;
const TRACK_WIDTH = 18;          // 18m (1.5× ancho F1 real)
const TRACK_ROAD  = 10;          // umbral off-track (fallback, en metros)
const ROAD_EDGE   = 1;           // grosor de la línea blanca del borde (m)
const VIEW_ZOOM   = 8;           // zoom base — 1m mundo = 8 pixels pantalla
const GHOST_SAMPLE_MS = 40;      // intervalo de muestreo del fantasma

// ---- Livreas seleccionables ----
const LIVERIES = [
  { id: 'ferrari',  name: 'Ferrari',   body: '#dc0000', dark: '#8a0000', accent: '#ffd400' },
  { id: 'mercedes', name: 'Mercedes',  body: '#9ba6ad', dark: '#3f4750', accent: '#00d2be' },
  { id: 'mclaren',  name: 'McLaren',   body: '#ff8000', dark: '#bb5a00', accent: '#0090d0' },
  { id: 'redbull',  name: 'Red Bull',  body: '#0a2240', dark: '#040d1c', accent: '#ed1c24' },
  { id: 'williams', name: 'Williams',  body: '#1948a8', dark: '#0a2a66', accent: '#ffffff' },
  { id: 'aston',    name: 'Aston Mt.', body: '#0d6e5a', dark: '#053b30', accent: '#cedc00' },
  { id: 'alpine',   name: 'Alpine',    body: '#ff48b0', dark: '#0d61c4', accent: '#ffffff' },
  { id: 'haas',     name: 'Haas',      body: '#ffffff', dark: '#9a9a9a', accent: '#ed1c24' },
];

// ============================================================
//  ESTADO GLOBAL
// ============================================================
const state = {
  scene: 'menu',                   // 'menu' | 'race'
  mode: 'tt',                      // 'tt' = time trial, 'race' = 3 vueltas vs IA
  livery: LIVERIES[0],
  track: null,
  car: null,
  ai: [],                          // coches IA (solo en modo race)
  inputs: { left: false, right: false, accelerate: false, brake: false },

  lastFrame: 0,
  lapStart: 0,
  bestLap: null,
  lapCount: 0,
  totalLapsRace: 3,                // vueltas en modo race
  finished: false,                 // carrera terminada
  raceResults: null,

  paused: false,
  segIndex: 0,
  segIndexPrev: 0,
  offTrack: false,
  cameraAngle: 0,
  racingLineMode: 'off',   // 'off' | 'hint' | 'guide'

  // Sectores
  sec1End: 0, sec2End: 0,
  currentSector: 1,
  sectorStarts: [0, 0, 0],         // ms desde lapStart en que empezó cada sector
  sectorTimes: [null, null, null], // tiempos del último sector cerrado
  bestSectorTimes: [null, null, null],

  // Efectos visuales
  sparks: [],          // {x, y, vx, vy, life, max}
  skidMarks: [],       // {x, y, ang, alpha} — limitado a SKID_MAX_MARKS

  // Fantasma
  recordSamples: [],               // muestras de la vuelta actual
  ghostSamples: null,              // muestras de la mejor vuelta
  lastSampleAt: 0,

  // Track limits — si se sale más de 5 veces, vuelta inválida
  offTrackCount: 0,
  lapInvalid: false,
  offTrackPrev: false,

  // Caja de cambios (para sonido de motor con shifts)
  gear: 1,

  // Semáforo de partida F1
  startLights: 0,                  // 0..5 luces rojas encendidas; -1 = ya largó
  startLightsStartedAt: 0,         // performance.now() cuando arrancó la secuencia
};

const engine = new EngineSound();
const music = new MenuMusic();

// ============================================================
//  ALMACENAMIENTO LOCAL
// ============================================================
const STORAGE_KEY    = 'f1rush.bestLaps.v1';
const SECTOR_KEY     = 'f1rush.bestSectors.v1';
const GHOST_KEY      = 'f1rush.ghosts.v1';
const STATS_KEY      = 'f1rush.stats.v1';
const BADGES_KEY     = 'f1rush.badges.v1';
const LEADERBOARD_KEY = 'f1rush.leaderboard.v1';
const LIVERY_KEY     = 'f1rush.livery';
const MODE_KEY       = 'f1rush.mode';
const MUSIC_KEY      = 'f1rush.musicOn';
const RACING_LINE_KEY = 'f1rush.racingLine';

function loadJSON(k, fallback) {
  try { return JSON.parse(localStorage.getItem(k)) || fallback; }
  catch { return fallback; }
}
function saveJSON(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
}

function loadBests() { return loadJSON(STORAGE_KEY, {}); }
function saveBest(trackId, ms) {
  const all = loadBests();
  if (!all[trackId] || ms < all[trackId]) {
    all[trackId] = ms;
    saveJSON(STORAGE_KEY, all);
    return true;
  }
  return false;
}
function loadBestSectors(trackId) {
  return loadJSON(SECTOR_KEY, {})[trackId] || [null, null, null];
}
function saveBestSectors(trackId, sectors) {
  const all = loadJSON(SECTOR_KEY, {});
  const current = all[trackId] || [null, null, null];
  const updated = current.map((cur, i) =>
    (sectors[i] != null && (cur == null || sectors[i] < cur)) ? sectors[i] : cur
  );
  all[trackId] = updated;
  saveJSON(SECTOR_KEY, all);
  return updated;
}
function loadGhost(trackId) {
  return loadJSON(GHOST_KEY, {})[trackId] || null;
}
function saveGhost(trackId, samples) {
  const all = loadJSON(GHOST_KEY, {});
  all[trackId] = samples;
  saveJSON(GHOST_KEY, all);
}

// ============================================================
//  STATS / BADGES / LEADERBOARD
// ============================================================
const DEFAULT_STATS = {
  totalLaps: 0,
  cleanLaps: 0,
  invalidLaps: 0,
  totalRaces: 0,
  wins: 0,
  podiums: 0,
  totalMeters: 0,
  totalDriveSec: 0,
  maxSpeedKmh: 0,
  uniqueTracks: [],
};
function loadStats() {
  const s = loadJSON(STATS_KEY, {});
  return { ...DEFAULT_STATS, ...s, uniqueTracks: s.uniqueTracks || [] };
}
function saveStats(s) { saveJSON(STATS_KEY, s); }

// Badges definitions: id, label, descripción y check(stats, ctx)
const BADGES = [
  { id: 'first_lap',    label: 'Primera vuelta',     desc: 'Completar tu primera vuelta válida' },
  { id: 'clean_5',      label: 'Limpieza',           desc: 'Encadená 5 vueltas limpias' },
  { id: 'veteran_100',  label: 'Veterano',           desc: '100 vueltas totales' },
  { id: 'first_win',    label: 'Primera victoria',   desc: 'Ganar una carrera' },
  { id: 'podium',       label: 'Podio',              desc: 'Terminar en el top 3' },
  { id: 'velocista',    label: 'Velocista',          desc: 'Superar 320 km/h' },
  { id: 'globetrotter', label: 'Globetrotter',       desc: 'Correr en las 24 pistas' },
  { id: 'monaco_master',label: 'Monaco Master',      desc: 'Bajar 1:15 en Mónaco' },
  { id: 'spa_master',   label: 'Spa Master',         desc: 'Bajar 1:50 en Spa' },
  { id: 'monza_master', label: 'Monza Master',       desc: 'Bajar 1:25 en Monza' },
];
function loadBadges() { return loadJSON(BADGES_KEY, {}); }
function awardBadge(id) {
  const all = loadBadges();
  if (all[id]) return false;
  all[id] = Date.now();
  saveJSON(BADGES_KEY, all);
  const b = BADGES.find(x => x.id === id);
  if (b) showToast('🏅 ' + b.label, 'purple');
  return true;
}

// Leaderboard: top 5 vueltas válidas por pista, con fecha
function loadLeaderboard() { return loadJSON(LEADERBOARD_KEY, {}); }
function pushLeaderboardEntry(trackId, lapMs) {
  const all = loadLeaderboard();
  const list = all[trackId] || [];
  list.push({ ms: lapMs, t: Date.now() });
  list.sort((a, b) => a.ms - b.ms);
  all[trackId] = list.slice(0, 5);
  saveJSON(LEADERBOARD_KEY, all);
}

// Hook después de completar una vuelta
function statsOnLapComplete(lapMs, trackId, invalid, lapMeters) {
  const s = loadStats();
  s.totalLaps++;
  if (invalid) {
    s.invalidLaps++;
    s.cleanStreak = 0;
  } else {
    s.cleanLaps++;
    s.cleanStreak = (s.cleanStreak || 0) + 1;
    pushLeaderboardEntry(trackId, lapMs);
    if (!s.uniqueTracks.includes(trackId)) s.uniqueTracks.push(trackId);
  }
  s.totalMeters += lapMeters || 0;
  s.totalDriveSec += lapMs / 1000;
  saveStats(s);
  // Badges
  if (!invalid) awardBadge('first_lap');
  if ((s.cleanStreak || 0) >= 5) awardBadge('clean_5');
  if (s.totalLaps >= 100) awardBadge('veteran_100');
  if (s.uniqueTracks.length >= 24) awardBadge('globetrotter');
  if (!invalid) {
    if (trackId === 'monaco' && lapMs < 75000) awardBadge('monaco_master');
    if (trackId === 'spa' && lapMs < 110000) awardBadge('spa_master');
    if (trackId === 'monza' && lapMs < 85000) awardBadge('monza_master');
  }
}

function statsOnSpeedTick(kmh) {
  if (kmh < 320) return;
  const s = loadStats();
  if (kmh > s.maxSpeedKmh) s.maxSpeedKmh = kmh;
  saveStats(s);
  awardBadge('velocista');
}

function statsOnRaceFinish(position, totalRacers) {
  const s = loadStats();
  s.totalRaces++;
  if (position === 1) { s.wins++; awardBadge('first_win'); }
  if (position <= 3) { s.podiums++; awardBadge('podium'); }
  saveStats(s);
}

// ============================================================
//  UTILIDADES
// ============================================================
function fmtTime(ms) {
  if (ms == null || !isFinite(ms)) return '--:--.---';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor(ms % 1000);
  return `${m}:${s.toString().padStart(2,'0')}.${cs.toString().padStart(3,'0')}`;
}
function fmtSector(ms) {
  if (ms == null || !isFinite(ms)) return '--.---';
  const s = Math.floor(ms / 1000);
  const cs = Math.floor(ms % 1000);
  return `${s}.${cs.toString().padStart(3,'0')}`;
}
function fmtDelta(ms) {
  if (ms == null) return '';
  const sign = ms >= 0 ? '+' : '-';
  const abs = Math.abs(ms);
  const s = Math.floor(abs / 1000);
  const cs = Math.floor(abs % 1000);
  return `${sign}${s}.${cs.toString().padStart(3,'0')}`;
}
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d >  Math.PI) d -= Math.PI*2;
  while (d < -Math.PI) d += Math.PI*2;
  return a + d * t;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dist2(a, b) { const dx=a[0]-b[0], dy=a[1]-b[1]; return dx*dx+dy*dy; }

function nearestSegment(point, smooth, hintIdx = -1) {
  let bestIdx = 0, bestD = Infinity;
  const n = smooth.length;
  if (hintIdx >= 0) {
    const window = 50;
    for (let i = -window; i <= window; i++) {
      const idx = ((hintIdx + i) % n + n) % n;
      const d = dist2(point, smooth[idx]);
      if (d < bestD) { bestD = d; bestIdx = idx; }
    }
    return { idx: bestIdx, dist: Math.sqrt(bestD) };
  }
  for (let i = 0; i < n; i++) {
    const d = dist2(point, smooth[i]);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  return { idx: bestIdx, dist: Math.sqrt(bestD) };
}

// Lleva un índice a [0..n)
function wrap(i, n) { return ((i % n) + n) % n; }

// Distancia total recorrida (en arclength) a partir de segIdx y lapCount
function arcLength(track, lapCount, segIdx) {
  return lapCount * track.total + track.dists[segIdx];
}

// ============================================================
//  MENÚ — RENDER
// ============================================================
function renderMenu() {
  const grid = document.getElementById('trackGrid');
  grid.innerHTML = '';
  const bests = loadBests();

  TRACKS.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'track-card';
    card.innerHTML = `
      <div class="round">RONDA ${t.round.toString().padStart(2,'0')}</div>
      <div class="flag">${t.flag}</div>
      <div class="country">${t.country}</div>
      <div class="name">${t.name}</div>
      <canvas class="preview" width="220" height="90"></canvas>
      <div class="meta">
        <span>${t.points.length} curvas</span>
        <span class="best">${bests[t.id] ? fmtTime(bests[t.id]) : '— sin tiempo —'}</span>
      </div>
    `;
    const cnv = card.querySelector('.preview');
    drawTrackPreview(cnv, t);
    card.addEventListener('click', () => startRace(t));
    grid.appendChild(card);
  });

  renderLiveryPicker();
  updateModeButton();
  updateMusicButton();
}

function drawTrackPreview(canvas, trackDef) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const smooth = catmullRomClosed(trackDef.points, 8);
  const norm = normalizeTrack(smooth, w, h, 14);

  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(norm[0][0], norm[0][1] + 2);
  for (let i = 1; i < norm.length; i++) ctx.lineTo(norm[i][0], norm[i][1] + 2);
  ctx.closePath(); ctx.stroke();

  ctx.strokeStyle = '#3a3f4b';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(norm[0][0], norm[0][1]);
  for (let i = 1; i < norm.length; i++) ctx.lineTo(norm[i][0], norm[i][1]);
  ctx.closePath(); ctx.stroke();

  ctx.strokeStyle = trackDef.accent;
  ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(norm[0][0], norm[0][1]);
  for (let i = 1; i < norm.length; i++) ctx.lineTo(norm[i][0], norm[i][1]);
  ctx.closePath(); ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(norm[0][0], norm[0][1], 3, 0, Math.PI*2);
  ctx.fill();
}

function renderLiveryPicker() {
  const picker = document.getElementById('liveryPicker');
  if (!picker) return;
  picker.innerHTML = '';
  LIVERIES.forEach((liv) => {
    const el = document.createElement('button');
    el.className = 'livery-btn' + (liv.id === state.livery.id ? ' selected' : '');
    el.style.setProperty('--body', liv.body);
    el.style.setProperty('--dark', liv.dark);
    el.style.setProperty('--accent', liv.accent);
    el.innerHTML = `
      <div class="livery-swatch"></div>
      <div class="livery-name">${liv.name}</div>
    `;
    el.addEventListener('click', () => {
      state.livery = liv;
      saveJSON(LIVERY_KEY, liv.id);
      renderLiveryPicker();
    });
    picker.appendChild(el);
  });
}

function updateModeButton() {
  const btn = document.getElementById('modeBtn');
  if (!btn) return;
  btn.textContent = state.mode === 'tt' ? 'Contrarreloj' : 'Carrera · 3 vueltas';
  btn.classList.toggle('race-mode', state.mode === 'race');
}

function updateMusicButton() {
  const btn = document.getElementById('musicBtn');
  if (!btn) return;
  btn.textContent = music.isOn() ? '♪ Música ON' : '♪ Música OFF';
  btn.classList.toggle('off', !music.isOn());
}

// ============================================================
//  ARRANQUE DE CARRERA
// ============================================================
function startRace(trackDef) {
  document.getElementById('menu').classList.add('hidden');
  document.getElementById('game').classList.remove('hidden');

  // Preparar pista — usamos METROS REALES de OSM (sin normalizar para no distorsionar proporciones)
  const raw = preparedTrack(trackDef, 5);
  // Centrar puntos en (0,0) preservando escala real
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of raw.smooth) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const center = ([x, y]) => [x - cx, y - cy];
  const norm      = raw.smooth.map(center);
  const normLeft  = raw.leftEdge.map(center);
  const normRight = raw.rightEdge.map(center);

  state.track = {
    def:       trackDef,
    smooth:    norm,
    leftEdge:  normLeft,
    rightEdge: normRight,
    dists:     raw.dists,
    total:     raw.total,
    widths:    raw.widths,
  };
  state.track.decorations = generateTrackDecorations(state.track, trackDef);
  // Línea de carrera (computed after edges are set)
  state.track.racingLine = computeRacingLine(state.track);
  state.scene = 'race';

  // Sectores
  const n = norm.length;
  state.sec1End = Math.floor(n * 0.33);
  state.sec2End = Math.floor(n * 0.67);
  state.bestSectorTimes = loadBestSectors(trackDef.id);
  state.sectorTimes = [null, null, null];
  state.sectorStarts = [0, 0, 0];
  state.currentSector = 1;

  // Coche
  const start = norm[0];
  const next = norm[3];
  const angle = Math.atan2(next[1]-start[1], next[0]-start[0]);
  state.car = {
    x: start[0], y: start[1], angle,
    speed: 0,
    maxSpeed: 105,        // m/s (~378 km/h)
    accel: 75,            // m/s² (0→105 m/s en ~1.4s)
    coast: 35,            // m/s² deceleración al soltar gas (~3s a parar)
    brake: 110,           // m/s² deceleración con freno (~1s a parar)
    offDecel: 60,         // m/s² fricción en hierba
    steerRate: 3.6,
  };

  state.segIndex = 0;
  state.segIndexPrev = 0;
  state.lapCount = 1;
  state.lapStart = performance.now();
  state.bestLap = loadBests()[trackDef.id] || null;
  state.paused = false;
  state.finished = false;
  state.raceResults = null;

  // Fantasma
  state.recordSamples = [];
  state.ghostSamples = loadGhost(trackDef.id);
  state.lastSampleAt = state.lapStart;

  // Semáforo F1: 5 luces encendiéndose 1 por segundo, luego apagón aleatorio
  state.startLights = 0;
  state.startLightsStartedAt = performance.now();
  state._goAt = null;
  state._goShownAt = null;
  state.inputs.left = state.inputs.right = state.inputs.accelerate = state.inputs.brake = false;

  // Track limits
  state.offTrackCount = 0;
  state.lapInvalid = false;
  state.offTrackPrev = false;

  // Marcha inicial
  state.gear = 1;

  // IA (solo en modo carrera) — 10 oponentes con dos pilotos por equipo
  state.ai = [];
  if (state.mode === 'race') {
    const L = id => LIVERIES.find(x => x.id === id);
    const aiConfigs = [
      { livery: L('redbull'),  pace: 0.97, name: 'Verstappen' },
      { livery: L('mclaren'),  pace: 0.96, name: 'Norris' },
      { livery: L('ferrari'),  pace: 0.95, name: 'Leclerc' },
      { livery: L('mercedes'), pace: 0.94, name: 'Hamilton' },
      { livery: L('mclaren'),  pace: 0.93, name: 'Piastri' },
      { livery: L('ferrari'),  pace: 0.92, name: 'Sainz' },
      { livery: L('mercedes'), pace: 0.91, name: 'Russell' },
      { livery: L('redbull'),  pace: 0.89, name: 'Pérez' },
      { livery: L('aston'),    pace: 0.87, name: 'Alonso' },
      { livery: L('alpine'),   pace: 0.85, name: 'Gasly' },
    ];
    aiConfigs.forEach((cfg, i) => {
      state.ai.push({
        progress: -(i + 1) * 18, // ligeramente atrás del jugador en la parrilla
        speed: state.car.maxSpeed * cfg.pace,
        livery: cfg.livery,
        name: cfg.name,
        lapCount: 1,
        x: start[0], y: start[1], angle,
        finished: false,
        finishTime: null,
      });
    });
  }

  // UI
  document.getElementById('trackName').textContent = trackDef.name;
  document.getElementById('bestLap').textContent = fmtTime(state.bestLap);
  const bm = document.getElementById('bestLapMobile');
  if (bm) bm.textContent = 'MEJOR ' + fmtTime(state.bestLap);
  document.getElementById('lapCount').textContent =
    state.mode === 'race' ? `${state.lapCount} / ${state.totalLapsRace}` : `Vuelta ${state.lapCount}`;

  document.querySelector('.hud-pos').classList.toggle('hidden', state.mode !== 'race');

  // Audio
  music.stop();
  engine.init();
  engine.setRpm(0.2);

  resizeCanvas();
  state.lastFrame = performance.now();
  requestAnimationFrame(loop);
}

function exitRace() {
  state.scene = 'menu';
  document.getElementById('game').classList.add('hidden');
  document.getElementById('menu').classList.remove('hidden');
  document.getElementById('finishOverlay').classList.add('hidden');
  engine.stop();
  music.start();
  renderMenu();
}

// ============================================================
//  INPUT
// ============================================================
window.addEventListener('keydown', e => {
  if (state.scene !== 'race') return;
  if (e.key === 'ArrowLeft'  || e.key === 'a' || e.key === 'A') state.inputs.left = true;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') state.inputs.right = true;
  if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
    state.inputs.accelerate = true;
    e.preventDefault();
  }
  if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S' || e.key === 'Shift') {
    state.inputs.brake = true;
    e.preventDefault();
  }
  if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') togglePause();
  if (e.key === 'r' || e.key === 'R') restartLap();
});
window.addEventListener('keyup', e => {
  if (e.key === 'ArrowLeft'  || e.key === 'a' || e.key === 'A') state.inputs.left = false;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') state.inputs.right = false;
  if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') state.inputs.accelerate = false;
  if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S' || e.key === 'Shift') state.inputs.brake = false;
});

function bindTouch() {
  const map = [
    ['btnLeft',  'left'],
    ['btnRight', 'right'],
    ['btnGas',   'accelerate'],
    ['btnBrake', 'brake'],
  ];
  for (const [id, key] of map) {
    const el = document.getElementById(id);
    if (!el) continue;
    const press = (ev) => {
      ev.preventDefault();
      state.inputs[key] = true;
      el.classList.add('active');
    };
    const release = (ev) => {
      ev.preventDefault();
      state.inputs[key] = false;
      el.classList.remove('active');
    };
    el.addEventListener('touchstart', press,   { passive: false });
    el.addEventListener('touchend',   release, { passive: false });
    el.addEventListener('touchcancel',release, { passive: false });
    el.addEventListener('mousedown',  press);
    el.addEventListener('mouseup',    release);
    el.addEventListener('mouseleave', release);
  }
  // Evitar que el canvas haga zoom o scroll al tocar fuera de los botones
  const canvas = document.getElementById('canvas');
  canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  canvas.addEventListener('touchmove',  (e) => e.preventDefault(), { passive: false });
}

function togglePause() {
  if (state.scene !== 'race' || state.finished) return;
  state.paused = !state.paused;
  document.getElementById('pauseOverlay').classList.toggle('hidden', !state.paused);
  if (state.paused) engine.setRpm(0);
  else {
    state.lastFrame = performance.now();
    requestAnimationFrame(loop);
  }
}
function restartLap() {
  if (!state.track) return;
  const start = state.track.smooth[0];
  const next = state.track.smooth[3];
  state.car.x = start[0];
  state.car.y = start[1];
  state.car.angle = Math.atan2(next[1]-start[1], next[0]-start[0]);
  state.car.speed = 0;
  state.lapStart = performance.now();
  state.lapCount = 1;
  // Re-activar semáforo de partida
  state.startLights = 0;
  state.startLightsStartedAt = performance.now();
  state._goAt = null;
  state._goShownAt = null;
  // Track limits
  state.offTrackCount = 0;
  state.lapInvalid = false;
  state.offTrackPrev = false;
  state.gear = 1;
  state.segIndex = 0;
  state.segIndexPrev = 0;
  state.recordSamples = [];
  state.sparks = [];
  state.skidMarks = [];
  state.currentSector = 1;
  state.sectorStarts = [0, 0, 0];
  state.sectorTimes = [null, null, null];
  state.finished = false;
  state.raceResults = null;
  document.getElementById('finishOverlay').classList.add('hidden');
  document.getElementById('lapCount').textContent =
    state.mode === 'race' ? `${state.lapCount} / ${state.totalLapsRace}` : `Vuelta ${state.lapCount}`;
  // Reiniciar IA
  if (state.mode === 'race') {
    state.ai.forEach((a, i) => {
      a.progress = -(i + 1) * 18;
      a.x = start[0]; a.y = start[1]; a.angle = state.car.angle;
      a.lapCount = 1;
      a.finished = false; a.finishTime = null;
    });
  }
}

function cycleRacingLine() {
  const modes = ['off', 'hint', 'guide'];
  const cur = modes.indexOf(state.racingLineMode);
  state.racingLineMode = modes[(cur + 1) % modes.length];
  saveJSON(RACING_LINE_KEY, state.racingLineMode);
  const labels = { off: 'Línea OFF', hint: 'Línea: pista', guide: 'Línea: guía' };
  showToast(labels[state.racingLineMode], '');
}

// ============================================================
//  CANVAS
// ============================================================
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const minimap = document.getElementById('minimap');
const mmCtx = minimap.getContext('2d');

// ============================================================
//  DECORACIONES — gradas, vallas, neumáticos, árboles
// ============================================================
const SPONSOR_COLORS = [
  '#dc0000', '#1e9e60', '#0090d0', '#ff8000', '#ffd400',
  '#3f9c35', '#bf0a30', '#bc002d', '#8a1538', '#00d2be',
];
const SPONSOR_NAMES = [
  'F1', 'PIRELLI', 'DHL', 'SHELL', 'ROLEX', 'HEINEKEN',
  'AWS', 'TAG', 'OAKLEY', 'EMIRATES', 'PUMA', 'TURBO',
];
const SEAT_COLORS = [
  '#3f87ff', '#ff5b5b', '#f8d040', '#56d97b', '#c66dff',
  '#ff8fbf', '#5fdcd4',
];

function generateTrackDecorations(prepared, def) {
  // Random determinista por pista para que las decoraciones sean estables
  let seed = 1469;
  for (const c of def.id) seed = ((seed * 31) + c.charCodeAt(0)) | 0;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const pick = arr => arr[Math.floor(rand() * arr.length)];

  const decorations = [];
  const smooth = prepared.smooth;
  const n = smooth.length;
  const step = 28;       // segmentos entre intentos de colocar decoración
  const minDist = 14;    // distancia mínima al borde del asfalto (m)
  const maxDist = 45;    // distancia máxima (m)

  for (let i = 0; i < n; i += step) {
    if (rand() < 0.30) continue;  // sólo coloca en ~70% de los puntos

    const p = smooth[i];
    const pNext = smooth[(i + 6) % n];
    const ang = Math.atan2(pNext[1] - p[1], pNext[0] - p[0]);
    const nx = -Math.sin(ang), ny = Math.cos(ang);

    // Coloca elementos en uno o ambos lados
    const sides = (rand() < 0.4) ? [1, -1] : [(rand() < 0.5 ? 1 : -1)];

    for (const side of sides) {
      const distance = minDist + rand() * (maxDist - minDist);
      const x = p[0] + nx * side * distance;
      const y = p[1] + ny * side * distance;
      const t = rand();

      let d;
      if (t < 0.32) {
        // Valla publicitaria
        d = {
          type: 'billboard',
          x, y, angle: ang + (side > 0 ? Math.PI : 0),
          color: pick(SPONSOR_COLORS),
          text: pick(SPONSOR_NAMES),
        };
      } else if (t < 0.62) {
        // Grada
        d = {
          type: 'grandstand',
          x, y, angle: ang + (side > 0 ? Math.PI : 0),
          rows: 4 + Math.floor(rand() * 4),
          width: 12 + rand() * 18,
          depth: 5 + rand() * 3,
          seatColor: pick(SEAT_COLORS),
        };
      } else if (t < 0.82) {
        // Pila de neumáticos
        d = {
          type: 'tires',
          x, y, angle: ang,
          count: 4 + Math.floor(rand() * 5),
        };
      } else if (t < 0.94) {
        // Árbol
        d = {
          type: 'tree',
          x, y,
          size: 2 + rand() * 2,
          shade: 0.85 + rand() * 0.3,
        };
      } else {
        // Bandera / poste de meta
        d = {
          type: 'flag',
          x, y, angle: ang,
          color: pick(SPONSOR_COLORS),
        };
      }
      decorations.push(d);
    }
  }

  return decorations;
}

function drawDecorations(decorations, cam) {
  for (const d of decorations) {
    // Culling por distancia
    const dx = d.x - cam.x, dy = d.y - cam.y;
    if (dx*dx + dy*dy > 800 * 800) continue;
    const [sx, sy] = worldToScreen(d.x, d.y, cam);
    const la = (d.angle != null) ? d.angle - cam.angle : 0;
    switch (d.type) {
      case 'billboard':  drawBillboard(d, sx, sy, la); break;
      case 'grandstand': drawGrandstand(d, sx, sy, la); break;
      case 'tires':      drawTires(d, sx, sy, la); break;
      case 'tree':       drawTree(d, sx, sy); break;
      case 'flag':       drawFlag(d, sx, sy, la); break;
    }
  }
}

function drawBillboard(d, sx, sy, ang) {
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(ang);
  // Sombra
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(-5, -1, 11, 3);
  // Cartel (~10m ancho × 2.5m alto, en escala real)
  ctx.fillStyle = d.color;
  ctx.fillRect(-5, -1.5, 11, 2.5);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.2;
  ctx.strokeRect(-5, -1.5, 11, 2.5);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 1.5px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(d.text, 0, -0.2);
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(-4, 1, 0.5, 1);
  ctx.fillRect( 3.5, 1, 0.5, 1);
  ctx.restore();
}

function drawGrandstand(d, sx, sy, ang) {
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(ang);
  const w = d.width, depth = d.depth;
  const hw = w / 2, hd = depth / 2;
  // Sombra
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(-hw + 3, -hd + 3, w, depth);
  // Estructura base (gris oscuro)
  ctx.fillStyle = '#2a2c33';
  ctx.fillRect(-hw, -hd, w, depth);
  // Techo (línea oscura al fondo)
  ctx.fillStyle = '#15171c';
  ctx.fillRect(-hw, -hd, w, 5);
  // Filas de asientos
  const seatArea = depth - 8;
  const rowH = seatArea / d.rows;
  for (let r = 0; r < d.rows; r++) {
    const y = -hd + 5 + r * rowH;
    ctx.fillStyle = (r % 2 === 0) ? d.seatColor : shade(d.seatColor, -25);
    ctx.fillRect(-hw + 2, y, w - 4, rowH - 0.5);
    // Espectadores (puntitos)
    ctx.fillStyle = 'rgba(255,224,180,0.55)';
    const peoplePerRow = Math.max(8, Math.floor((w - 4) / 5));
    for (let k = 0; k < peoplePerRow; k++) {
      const px = -hw + 4 + k * ((w - 8) / peoplePerRow);
      const py = y + rowH * 0.35 + (k % 2 === 0 ? 0 : rowH * 0.15);
      ctx.fillRect(px, py, 1.5, 1.5);
    }
  }
  // Barandilla frontal
  ctx.fillStyle = '#d8d8d8';
  ctx.fillRect(-hw, hd - 2, w, 2);
  // Pilares laterales
  ctx.fillStyle = '#1a1c20';
  ctx.fillRect(-hw - 2, -hd, 2, depth);
  ctx.fillRect( hw,     -hd, 2, depth);
  ctx.restore();
}

function drawTires(d, sx, sy, ang) {
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(ang);
  const r = 0.6;
  const spacing = r * 2 + 0.1;
  const totalW = d.count * spacing;
  // Sombra
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.ellipse(1.5, 2, totalW * 0.55, r + 2, 0, 0, Math.PI*2);
  ctx.fill();
  for (let i = 0; i < d.count; i++) {
    const tx = -totalW / 2 + spacing / 2 + i * spacing;
    // Goma negra
    ctx.fillStyle = '#141414';
    ctx.beginPath();
    ctx.arc(tx, 0, r, 0, Math.PI*2);
    ctx.fill();
    // Banda roja/blanca arriba
    ctx.fillStyle = (i % 2 === 0) ? '#dc0000' : '#ffffff';
    ctx.beginPath();
    ctx.arc(tx, 0, r * 0.55, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.restore();
}

function drawTree(d, sx, sy) {
  ctx.save();
  ctx.translate(sx, sy);
  // Sombra
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.beginPath();
  ctx.ellipse(d.size * 0.18, d.size * 0.22, d.size * 0.85, d.size * 0.55, 0, 0, Math.PI*2);
  ctx.fill();
  // Copa
  ctx.fillStyle = `rgba(34, 78, 38, ${d.shade})`;
  ctx.beginPath();
  ctx.arc(0, 0, d.size, 0, Math.PI*2);
  ctx.fill();
  // Highlight
  ctx.fillStyle = 'rgba(95, 150, 90, 0.55)';
  ctx.beginPath();
  ctx.arc(-d.size * 0.25, -d.size * 0.30, d.size * 0.55, 0, Math.PI*2);
  ctx.fill();
  // Detalle aún más claro
  ctx.fillStyle = 'rgba(140, 190, 120, 0.4)';
  ctx.beginPath();
  ctx.arc(-d.size * 0.38, -d.size * 0.42, d.size * 0.28, 0, Math.PI*2);
  ctx.fill();
  ctx.restore();
}

function drawFlag(d, sx, sy, ang) {
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(ang);
  ctx.fillStyle = '#9a9a9a';
  ctx.fillRect(-0.15, -0.3, 0.3, 4);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0.3, -2.5, 2.5, 1.5);
  ctx.fillStyle = d.color;
  ctx.beginPath();
  ctx.moveTo(0, -2.8);
  ctx.lineTo(2.8, -2.2);
  ctx.lineTo(0, -1.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function shade(hex, amount) {
  const r = clamp(parseInt(hex.slice(1,3), 16) + amount, 0, 255);
  const g = clamp(parseInt(hex.slice(3,5), 16) + amount, 0, 255);
  const b = clamp(parseInt(hex.slice(5,7), 16) + amount, 0, 255);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

// ============================================================
//  TEXTURA DE CÉSPED (pre-renderizada una sola vez)
// ============================================================
let grassPattern = null;
function initGrassPattern() {
  const tile = document.createElement('canvas');
  tile.width = 128; tile.height = 128;
  const t = tile.getContext('2d');
  // Base de hierba — más brillante para que se vea verde en pantallas con poco brillo
  t.fillStyle = '#2f6a3a';
  t.fillRect(0, 0, 128, 128);
  // Sombra orgánica suave
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * 128, y = Math.random() * 128;
    const r = 6 + Math.random() * 14;
    t.fillStyle = `rgba(20, 50, 25, ${0.04 + Math.random()*0.08})`;
    t.beginPath(); t.arc(x, y, r, 0, Math.PI*2); t.fill();
  }
  // Píxeles de hierba aleatorios — paleta más verde y vibrante
  for (let i = 0; i < 1400; i++) {
    const x = Math.floor(Math.random() * 128);
    const y = Math.floor(Math.random() * 128);
    const r = Math.random();
    if (r < 0.45)      t.fillStyle = `rgba(95, 165, 95, ${0.45 + Math.random()*0.45})`;
    else if (r < 0.75) t.fillStyle = `rgba(40, 90, 45, ${0.35 + Math.random()*0.35})`;
    else if (r < 0.92) t.fillStyle = `rgba(140, 200, 130, ${0.25 + Math.random()*0.30})`;
    else               t.fillStyle = `rgba(210, 225, 140, ${0.15 + Math.random()*0.25})`;
    t.fillRect(x, y, Math.random() < 0.25 ? 2 : 1, 1);
  }
  // Algunas matas
  for (let i = 0; i < 28; i++) {
    const x = Math.random() * 128, y = Math.random() * 128;
    t.fillStyle = `rgba(120, 190, 110, 0.6)`;
    for (let j = 0; j < 4; j++) {
      const angle = Math.random() * Math.PI * 2;
      t.fillRect(x + Math.cos(angle)*2, y + Math.sin(angle)*2, 1, 2);
    }
  }
  grassPattern = ctx.createPattern(tile, 'repeat');
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);

// ============================================================
//  PROYECCIÓN
// ============================================================
// Proyección top-down 2D (cámara rota para que el coche apunte arriba)
function worldToScreen(wx, wy, cam) {
  const dx = wx - cam.x;
  const dy = wy - cam.y;
  const ca = Math.cos(-cam.angle);
  const sa = Math.sin(-cam.angle);
  return [dx * ca - dy * sa, dx * sa + dy * ca];
}

// Dado un progreso (arc length), devuelve {x, y, angle} interpolados sobre la pista
function trackPointAtArc(track, arcLen) {
  const total = track.total;
  let len = arcLen % total;
  if (len < 0) len += total;
  const dists = track.dists;
  // Búsqueda binaria
  let lo = 0, hi = dists.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (dists[mid] <= len) lo = mid;
    else hi = mid;
  }
  const segLen = (dists[hi] - dists[lo]) || 1;
  const t = (len - dists[lo]) / segLen;
  const p1 = track.smooth[lo];
  const p2 = track.smooth[hi];
  const x = lerp(p1[0], p2[0], t);
  const y = lerp(p1[1], p2[1], t);
  const angle = Math.atan2(p2[1]-p1[1], p2[0]-p1[0]);
  return { x, y, angle, segIdx: lo };
}

// ============================================================
//  LOOP PRINCIPAL
// ============================================================
function loop(now) {
  if (state.scene !== 'race') return;
  if (state.paused) return;

  const dt = Math.min(0.05, (now - state.lastFrame) / 1000);
  state.lastFrame = now;

  if (!state.finished) update(dt, now);
  render(now);
  engine.update(dt);

  requestAnimationFrame(loop);
}

// ============================================================
//  UPDATE
// ============================================================
function update(dt, now) {
  const car = state.car;
  const tr = state.track;

  // ---- Semáforo de partida ----
  // 5 luces a 1/s, luego apagón aleatorio entre 0.4 y 1.6s. Hasta entonces
  // bloqueamos los inputs y reseteamos lapStart para que cuente desde el GO.
  if (state.startLights >= 0) {
    const elapsed = now - state.startLightsStartedAt;
    const lightInterval = 1000;
    const lightsOnDuration = 5 * lightInterval;
    if (elapsed < lightsOnDuration) {
      state.startLights = Math.min(5, Math.floor(elapsed / lightInterval) + 1);
    } else {
      if (state._goAt == null) state._goAt = state.startLightsStartedAt + lightsOnDuration + 400 + Math.random() * 1200;
      if (now >= state._goAt) {
        state.startLights = -1;
        state._goAt = null;
      }
    }
    if (state.startLights >= 0) {
      // Bloqueamos el coche pero NO los inputs: si el jugador mantiene el gas
      // durante la cuenta atrás, arrancará al instante en el GO.
      car.speed = 0;
      state.lapStart = now;
      state.lastSampleAt = now;
      updateHUD(now);
      return;
    }
    // GO!
    state.lapStart = now;
    state.lastSampleAt = now;
  }

  // ---- Off-track + segmento ----
  const near = nearestSegment([car.x, car.y], tr.smooth, state.segIndex);
  state.segIndexPrev = state.segIndex;
  state.segIndex = near.idx;
  // Distancia mínima al CENTERLINE en los segmentos vecinos (no solo el actual)
  // — evita falsos positivos en curvas donde el auto está entre waypoints.
  const nLen = tr.smooth.length;
  let bestDist = Infinity, bestHalfW = TRACK_ROAD;
  for (let off = -2; off <= 2; off++) {
    const i = ((state.segIndex + off) % nLen + nLen) % nLen;
    const j = (i + 1) % nLen;
    const a = tr.smooth[i], b = tr.smooth[j];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lenSq = dx*dx + dy*dy;
    let t = lenSq > 0 ? ((car.x - a[0]) * dx + (car.y - a[1]) * dy) / lenSq : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const px = a[0] + t * dx, py = a[1] + t * dy;
    const d = Math.hypot(car.x - px, car.y - py);
    if (d < bestDist) {
      bestDist = d;
      bestHalfW = tr.widths ? tr.widths[i] * 0.5 : TRACK_ROAD;
    }
  }
  // Histéresis: necesita 3m extra para entrar a off-track, y volver a < halfW+1m para salir.
  // Esto evita que el flag oscile en los bordes/kerbs y produzca cortes de velocidad.
  const enterOff  = bestHalfW + 3.0;
  const leaveOff  = bestHalfW + 1.0;
  if (state.offTrack) {
    if (bestDist < leaveOff) state.offTrack = false;
  } else {
    if (bestDist > enterOff) state.offTrack = true;
  }
  // Contar cada vez que se entra a off-track. Más de 5 → vuelta inválida (deleted).
  if (state.offTrack && !state.offTrackPrev) {
    state.offTrackCount++;
    if (state.offTrackCount > 5 && !state.lapInvalid) {
      state.lapInvalid = true;
      showToast('VUELTA ELIMINADA · límites de pista', 'red');
    }
  }
  state.offTrackPrev = state.offTrack;

  // ---- Detección de vuelta ----
  const n = tr.smooth.length;
  const wentForwardOverLine = (state.segIndexPrev > n - 40) && (state.segIndex < 40);
  if (wentForwardOverLine) {
    const lapMs = now - state.lapStart;
    onLapComplete(lapMs, now);
  }

  // ---- Detección de sectores ----
  detectSectorChange(now);

  // ---- Física del coche ----
  // Acelerador (gas) y freno: el jugador controla el throttle manualmente
  const offMax = car.maxSpeed * 0.42;
  let target, rate;

  if (state.inputs.brake) {
    // Frenando
    target = 0;
    rate = car.brake;
  } else if (state.inputs.accelerate) {
    if (state.offTrack && car.speed > offMax) {
      // Off-track: el coche pierde velocidad incluso pisando el gas
      target = offMax;
      rate = car.offDecel;
    } else {
      target = state.offTrack ? offMax : car.maxSpeed;
      rate = car.accel;
    }
  } else {
    // Soltó el gas: rueda libre (deceleración suave)
    target = 0;
    rate = car.coast + (state.offTrack ? 60 : 0);
  }

  const dv = target - car.speed;
  car.speed += clamp(dv, -rate * dt, rate * dt);
  if (car.speed < 0) car.speed = 0;

  if (state.offTrack && car.speed > 30 && Math.random() < 0.4) engine.scrape(0.6);

  // Dirección
  const speedFactor = clamp(car.speed / car.maxSpeed, 0.0, 1);
  const turn = car.steerRate * dt * (1.0 - speedFactor * 0.35);
  if (state.inputs.left)  car.angle -= turn;
  if (state.inputs.right) car.angle += turn;

  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;

  // ---- Chispas y marcas de neumáticos ----
  updateEffects(dt, now);

  // ---- Caja de cambios: 8 marchas tipo F1 ----
  // El cambio se siente a través del motor: al subir de marcha el RPM cae
  // de ~0.98 (redline) a ~0.25 (idle de la nueva marcha), creando el
  // característico "sube y cae" de un F1. Sin clicks extras.
  const GEAR_TOPS = [14, 28, 44, 60, 74, 87, 97, 105]; // m/s en cada redline
  let g = 0;
  while (g < GEAR_TOPS.length - 1 && car.speed > GEAR_TOPS[g]) g++;
  const gMin = g === 0 ? 0 : GEAR_TOPS[g - 1];
  const gMax = GEAR_TOPS[g];
  const gFrac = Math.max(0, Math.min(1, (car.speed - gMin) / (gMax - gMin)));
  const targetGear = g + 1;
  if (targetGear !== state.gear) {
    // Mini "corte" de combustible al cambiar: deja el RPM cayendo durante 80ms
    // para que se escuche claramente el cambio sin meter un sonido aparte.
    state.gearShiftCutUntil = now + 80;
    state.gear = targetGear;
  }
  const inCut = state.gearShiftCutUntil && now < state.gearShiftCutUntil;
  // RPM por marcha: 0.25 idle de la marcha → 0.98 redline
  const targetRpm = inCut ? 0.10 : (0.25 + gFrac * 0.73);
  engine.setRpm(targetRpm);

  // ---- Muestreo para fantasma ----
  if (now - state.lastSampleAt >= GHOST_SAMPLE_MS) {
    state.recordSamples.push({
      t: now - state.lapStart, x: car.x, y: car.y, angle: car.angle
    });
    state.lastSampleAt = now;
  }

  // ---- IA ----
  if (state.mode === 'race') {
    for (const a of state.ai) {
      if (a.finished) continue;
      a.progress += a.speed * dt;
      const pt = trackPointAtArc(tr, a.progress);
      // wiggle leve para que no se vea como un riel perfecto
      const wobble = Math.sin(a.progress * 0.03) * 6;
      const sideX = -Math.sin(pt.angle), sideY = Math.cos(pt.angle);
      a.x = pt.x + sideX * wobble;
      a.y = pt.y + sideY * wobble;
      a.angle = lerpAngle(a.angle, pt.angle, 0.3);
      // ¿completó una vuelta?
      const newLap = Math.floor(a.progress / tr.total) + 1;
      if (newLap > a.lapCount) {
        a.lapCount = newLap;
        if (a.lapCount > state.totalLapsRace) {
          a.finished = true;
          a.finishTime = now - state.lapStart + (a.lapCount - 1) * 60000; // placeholder
        }
      }
    }
  }

  // ---- HUD ----
  updateHUD(now);
}

function detectSectorChange(now) {
  const idx = state.segIndex;
  const prev = state.segIndexPrev;
  const t = now - state.lapStart;

  // S1 → S2
  if (state.currentSector === 1 && prev < state.sec1End && idx >= state.sec1End) {
    state.sectorTimes[0] = t - state.sectorStarts[0];
    state.sectorStarts[1] = t;
    state.currentSector = 2;
    flashSector(0, state.sectorTimes[0], state.bestSectorTimes[0]);
  }
  // S2 → S3
  else if (state.currentSector === 2 && prev < state.sec2End && idx >= state.sec2End) {
    state.sectorTimes[1] = t - state.sectorStarts[1];
    state.sectorStarts[2] = t;
    state.currentSector = 3;
    flashSector(1, state.sectorTimes[1], state.bestSectorTimes[1]);
  }
}

function flashSector(secIdx, time, best) {
  const isPurple = best == null || time < best;
  const el = document.getElementById(`sec${secIdx+1}`);
  if (!el) return;
  el.classList.remove('purple', 'green');
  el.classList.add(isPurple ? 'purple' : 'green');
  setTimeout(() => el.classList.remove('purple', 'green'), 1800);
}

function onLapComplete(lapMs, now) {
  const tr = state.track;
  // Cerrar S3
  state.sectorTimes[2] = (now - state.lapStart) - state.sectorStarts[2];
  flashSector(2, state.sectorTimes[2], state.bestSectorTimes[2]);

  // Stats + leaderboard + badges
  const lapMeters = tr.total;
  const trackIdForStats = tr.def.id;
  statsOnLapComplete(lapMs, trackIdForStats, state.lapInvalid, lapMeters);

  // Mejor vuelta (sólo si la vuelta es válida — track limits respetados)
  const trackId = tr.def.id;
  if (state.lapInvalid) {
    showToast('VUELTA ELIMINADA · ' + fmtTime(lapMs), 'red');
    engine.jingle(false);
  } else {
    const improvedLap = saveBest(trackId, lapMs);
    if (improvedLap) {
      state.bestLap = lapMs;
      document.getElementById('bestLap').textContent = fmtTime(lapMs);
      const bm2 = document.getElementById('bestLapMobile');
      if (bm2) bm2.textContent = 'MEJOR ' + fmtTime(lapMs);
      showToast('NUEVO RÉCORD PERSONAL · ' + fmtTime(lapMs), 'purple');
      engine.jingle(true);
      // Guardar fantasma
      state.ghostSamples = state.recordSamples.slice();
      saveGhost(trackId, state.ghostSamples);
      // Pedir nombre y subir al leaderboard global
      promptSubmitToGlobalLeaderboard(trackId, lapMs);
    } else {
      showToast('Vuelta ' + fmtTime(lapMs), 'green');
      engine.jingle(false);
    }
    // Mejores sectores sólo cuentan en vueltas válidas
    state.bestSectorTimes = saveBestSectors(trackId, state.sectorTimes);
  }
  // Reset de track limits para la próxima vuelta
  state.offTrackCount = 0;
  state.lapInvalid = false;

  // Resetear vuelta
  state.recordSamples = [];
  state.lapStart = now;
  state.lastSampleAt = now;
  state.sectorStarts = [0, 0, 0];
  state.sectorTimes = [null, null, null];
  state.currentSector = 1;
  state.lapCount++;

  // Modo carrera: ¿terminada?
  if (state.mode === 'race' && state.lapCount > state.totalLapsRace) {
    finishRace(now);
    return;
  }

  document.getElementById('lapCount').textContent =
    state.mode === 'race' ? `${state.lapCount} / ${state.totalLapsRace}` : `Vuelta ${state.lapCount}`;
}

function finishRace(now) {
  state.finished = true;

  // Calcular posiciones por arc length total recorrido
  const tr = state.track;
  const playerArc = state.totalLapsRace * tr.total; // ya cruzó la meta
  const standings = [
    { name: 'Tú', arc: playerArc, livery: state.livery, isPlayer: true },
    ...state.ai.map(a => ({
      name: a.name,
      arc: a.progress,
      livery: a.livery,
      isPlayer: false,
    })),
  ];
  standings.sort((a, b) => b.arc - a.arc);
  state.raceResults = standings;

  // Stats de carrera
  const playerPos = standings.findIndex(s => s.isPlayer) + 1;
  statsOnRaceFinish(playerPos, standings.length);

  // Mostrar overlay
  const overlay = document.getElementById('finishOverlay');
  const list = overlay.querySelector('.results-list');
  list.innerHTML = '';
  standings.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'result-row' + (s.isPlayer ? ' me' : '');
    row.innerHTML = `
      <span class="rpos">${i + 1}</span>
      <span class="rdot" style="background:${s.livery.body}"></span>
      <span class="rname">${s.name}</span>
    `;
    list.appendChild(row);
  });
  overlay.classList.remove('hidden');
  engine.jingle(true);
  engine.stop();
}

function updateHUD(now) {
  // Semáforo: mostrar mientras esté activo, ocultar al GO
  const lightsEl = document.getElementById('startLights');
  if (state.startLights >= 0) {
    lightsEl.classList.remove('hidden');
    const lights = lightsEl.querySelectorAll('.light');
    lights.forEach((el, i) => el.classList.toggle('on', i < state.startLights));
    document.getElementById('startLightsGo').classList.remove('visible');
  } else if (state._goShownAt == null) {
    // Mostrar "¡VAMOS!" brevemente
    state._goShownAt = now;
    const lights = lightsEl.querySelectorAll('.light');
    lights.forEach(el => el.classList.remove('on'));
    document.getElementById('startLightsGo').classList.add('visible');
  } else if (now - state._goShownAt > 700) {
    lightsEl.classList.add('hidden');
  }

  // Mientras corren las luces, mostramos el reloj en 0
  const tShown = state.startLights >= 0 ? 0 : Math.max(0, now - state.lapStart);
  const lapStr = fmtTime(tShown);
  const lapEl = document.getElementById('currentLap');
  lapEl.textContent = lapStr;
  lapEl.classList.toggle('invalid', state.lapInvalid);
  const mEl = document.getElementById('currentLapMobile');
  if (mEl) {
    mEl.textContent = lapStr;
    mEl.classList.toggle('invalid', state.lapInvalid);
  }
  // Mostrar contador de límites de pista
  const tlEl = document.getElementById('trackLimits');
  if (tlEl) {
    if (state.offTrackCount > 0 || state.lapInvalid) {
      tlEl.textContent = state.lapInvalid ? 'TL ELIMINADA' : `TL ${state.offTrackCount}/5`;
      tlEl.classList.remove('hidden');
      tlEl.classList.toggle('invalid', state.lapInvalid);
    } else {
      tlEl.classList.add('hidden');
    }
  }
  const kmh = Math.round(state.car.speed * 3.6);
  document.getElementById('speed').textContent = kmh;
  statsOnSpeedTick(kmh);
  // Marcha actual: 'N' parado, 1..8 en movimiento
  const gearEl = document.getElementById('gearIndicator');
  if (gearEl) {
    const newG = state.car.speed < 1 ? 'N' : String(state.gear);
    if (gearEl.textContent !== newG) {
      gearEl.textContent = newG;
      gearEl.classList.add('flash');
      setTimeout(() => gearEl.classList.remove('flash'), 200);
    }
  }

  // Sectores
  for (let i = 0; i < 3; i++) {
    const cur = state.sectorTimes[i];
    const best = state.bestSectorTimes[i];
    const valEl = document.getElementById(`sec${i+1}-val`);
    const deltaEl = document.getElementById(`sec${i+1}-delta`);
    if (cur != null) {
      valEl.textContent = fmtSector(cur);
      if (best != null) {
        const d = cur - best;
        deltaEl.textContent = fmtDelta(d);
        deltaEl.className = 'sec-delta ' + (d <= 0 ? 'good' : 'bad');
      } else {
        deltaEl.textContent = '';
      }
    } else if (state.currentSector === i + 1) {
      valEl.textContent = fmtSector(now - state.lapStart - state.sectorStarts[i]);
      deltaEl.textContent = '';
    } else {
      valEl.textContent = '--.---';
      deltaEl.textContent = '';
    }
  }

  // Posición en carrera
  if (state.mode === 'race') {
    const tr = state.track;
    const playerArc = (state.lapCount - 1) * tr.total + tr.dists[state.segIndex];
    let pos = 1;
    for (const a of state.ai) if (a.progress > playerArc) pos++;
    document.getElementById('position').textContent = `P${pos} / ${state.ai.length + 1}`;
  }

  // Indicador DRS
  const drsEl = document.getElementById('drsIndicator');
  if (drsEl && state.track && state.track.def.drs) {
    const frac = state.track.dists[state.segIndex] / state.track.total;
    const inDRS = state.track.def.drs.some(z => {
      if (z.from <= z.to) return frac >= z.from && frac <= z.to;
      return frac >= z.from || frac <= z.to;
    });
    drsEl.classList.toggle('active', inDRS);
    drsEl.classList.toggle('hidden', !inDRS);
  }
}

function showToast(text, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.className = `toast ${kind}`;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2400);
}

// ============================================================
//  RENDER
// ============================================================
function render(now) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  ctx.clearRect(0, 0, W, H);

  // Fondo de césped (textura tileable)
  if (grassPattern) {
    ctx.fillStyle = grassPattern;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = '#2f6a3a';
    ctx.fillRect(0, 0, W, H);
  }

  const car = state.car;
  const tr = state.track;
  const cam = {
    x: car.x, y: car.y,
    angle: car.angle + Math.PI / 2,
  };
  state.cameraAngle += (cam.angle - state.cameraAngle) * 0.18;
  cam.angle = state.cameraAngle;

  const cx = W * 0.5;
  const cy = H * 0.55;
  const zoom = VIEW_ZOOM - (car.speed / car.maxSpeed) * 0.15;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(zoom, zoom);

  // Decoraciones (gradas, vallas, neumáticos, árboles) — fuera de la pista
  if (tr.decorations) drawDecorations(tr.decorations, cam);

  // Pista (top-down 2D limpio, con bordes blancos y anchura variable)
  drawTrack(tr, cam, 'shadow');
  drawTrack(tr, cam, 'whiteEdge');
  drawTrack(tr, cam, 'asphalt');
  drawKerbs(tr, cam);
  drawSkidMarks(cam);
  drawStartLine(tr, cam);

  // Fantasma de la mejor vuelta — siempre visible si existe (modo contrarreloj)
  if (state.ghostSamples && state.mode === 'tt') {
    drawGhost(now, cam);
  }

  // IA
  if (state.mode === 'race') {
    for (const a of state.ai) {
      drawAICar(a, cam);
    }
  }

  // Coche jugador
  drawCar(car.x, car.y, car.angle, cam, state.livery, false);

  // Chispas encima del auto
  drawSparks(cam);

  ctx.restore();

  drawMinimap();
}

// Render por trazo (stroke) — limpia, sin artefactos en curvas cerradas.
// Una sola lineWidth para toda la pista = ancho uniforme garantizado.
function drawTrack(tr, cam, layer) {
  const smooth = tr.smooth;
  const n = smooth.length;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const [sx, sy] = worldToScreen(smooth[i][0], smooth[i][1], cam);
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  }
  ctx.closePath();

  if (layer === 'shadow') {
    ctx.strokeStyle = 'rgba(0,0,0,0.30)';
    ctx.lineWidth = TRACK_WIDTH + 3;
    ctx.stroke();
  } else if (layer === 'whiteEdge') {
    ctx.strokeStyle = '#f0f0f0';
    ctx.lineWidth = TRACK_WIDTH + ROAD_EDGE * 2;
    ctx.stroke();
  } else if (layer === 'asphalt') {
    ctx.strokeStyle = '#4a4f5c';
    ctx.lineWidth = TRACK_WIDTH;
    ctx.stroke();
  }
}

// ============================================================
//  KERBS — segmentos rojo/blanco en la cara exterior de las curvas
// ============================================================
function drawKerbs(tr, cam) {
  const smooth = tr.smooth;
  const n = smooth.length;
  const innerOff = TRACK_WIDTH * 0.5;        // borde interior del kerb (filo del asfalto)
  const outerOff = TRACK_WIDTH * 0.5 + 1.6;  // borde exterior (1.6m de ancho de kerb)
  const KERB_LEN = 1.8;                      // largo de cada banda en metros

  // Pre-clasificar curvas con dirección de giro
  const sideArr = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const p0 = smooth[(i - 1 + n) % n];
    const p1 = smooth[i];
    const p2 = smooth[(i + 1) % n];
    const a1 = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
    const a2 = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
    let da = a2 - a1;
    while (da >  Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    if (Math.abs(da) > 0.010) sideArr[i] = da < 0 ? -1 : 1;
  }
  // Dilate ±3 para suavizar
  const dilated = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    for (let k = -3; k <= 3; k++) {
      const s = sideArr[(i + k + n) % n];
      if (s) { dilated[i] = s; break; }
    }
  }

  // Dibujo: cada segmento del kerb es un cuadrilátero (rectángulo a lo largo de la pista)
  let acc = 0;
  let bandIdx = 0;
  for (let i = 0; i < n; i++) {
    const side = dilated[i];
    if (!side) { acc = 0; continue; }

    const p1 = smooth[i];
    const p2 = smooth[(i + 1) % n];
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    acc += segLen;
    if (acc >= KERB_LEN) { bandIdx++; acc = 0; }

    const a1 = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
    const nx = -Math.sin(a1) * side;
    const ny =  Math.cos(a1) * side;

    // 4 esquinas del cuadrilátero (interior p1, exterior p1, exterior p2, interior p2)
    const c1 = worldToScreen(p1[0] + nx * innerOff, p1[1] + ny * innerOff, cam);
    const c2 = worldToScreen(p1[0] + nx * outerOff, p1[1] + ny * outerOff, cam);
    const c3 = worldToScreen(p2[0] + nx * outerOff, p2[1] + ny * outerOff, cam);
    const c4 = worldToScreen(p2[0] + nx * innerOff, p2[1] + ny * innerOff, cam);

    ctx.fillStyle = (bandIdx % 2 === 0) ? '#dc2626' : '#f5f5f5';
    ctx.beginPath();
    ctx.moveTo(c1[0], c1[1]);
    ctx.lineTo(c2[0], c2[1]);
    ctx.lineTo(c3[0], c3[1]);
    ctx.lineTo(c4[0], c4[1]);
    ctx.closePath();
    ctx.fill();
  }
}

// ============================================================
//  EFECTOS: chispas + marcas de neumáticos
// ============================================================
const SKID_MAX_MARKS = 400;
const SPARK_LIFE = 0.4;       // s
const TIRE_BACK_OFF = 1.7;    // m detrás del centro del auto (eje trasero)
const TIRE_HALF_SEP = 0.85;   // m separación lateral entre neumáticos

function updateEffects(dt, now) {
  const car = state.car;
  const tr = state.track;

  // Actualizar chispas existentes
  const sparks = state.sparks;
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.life -= dt;
    if (s.life <= 0) { sparks.splice(i, 1); continue; }
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vx *= 0.92;
    s.vy *= 0.92;
  }

  // Detectar si está en kerb (cerca del borde) y a alta velocidad
  const near = nearestSegment([car.x, car.y], tr.smooth, state.segIndex);
  const idx = near.idx;
  const halfW = tr.widths ? tr.widths[idx] * 0.5 : TRACK_ROAD;
  const a = tr.smooth[idx];
  const b = tr.smooth[(idx + 1) % tr.smooth.length];
  const sx = b[0] - a[0], sy = b[1] - a[1];
  const lenSq = sx*sx + sy*sy;
  let t = lenSq > 0 ? ((car.x - a[0]) * sx + (car.y - a[1]) * sy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const px = a[0] + t * sx, py = a[1] + t * sy;
  const offCenter = Math.hypot(car.x - px, car.y - py);
  // En kerb: entre el borde del asfalto y 1.6m más afuera
  const onKerb = offCenter > halfW * 0.85 && offCenter < halfW + 1.8 && car.speed > 45;

  if (onKerb && Math.random() < 0.6) {
    // Emitir chispas detrás del auto
    const rearX = car.x - Math.cos(car.angle) * TIRE_BACK_OFF;
    const rearY = car.y - Math.sin(car.angle) * TIRE_BACK_OFF;
    const dirSide = ((car.x - px) * (-sy) + (car.y - py) * sx) > 0 ? 1 : -1;
    const wheelX = rearX + Math.sin(car.angle) * dirSide * TIRE_HALF_SEP;
    const wheelY = rearY - Math.cos(car.angle) * dirSide * TIRE_HALF_SEP;
    for (let k = 0; k < 3; k++) {
      const vx = (Math.random() - 0.5) * 20 - Math.cos(car.angle) * 12;
      const vy = (Math.random() - 0.5) * 20 - Math.sin(car.angle) * 12;
      sparks.push({ x: wheelX, y: wheelY, vx, vy, life: SPARK_LIFE * (0.6 + Math.random()*0.4), max: SPARK_LIFE });
    }
  }

  // Detectar derrape: frenando fuerte O girando rápido a alta velocidad
  const braking = state.inputs.brake && car.speed > 25;
  const turning = (state.inputs.left || state.inputs.right) && car.speed > 50;
  if (braking || turning) {
    // Marcar posiciones de cada neumático trasero
    const rearX = car.x - Math.cos(car.angle) * TIRE_BACK_OFF;
    const rearY = car.y - Math.sin(car.angle) * TIRE_BACK_OFF;
    const sxL = Math.sin(car.angle) * TIRE_HALF_SEP;
    const syL = -Math.cos(car.angle) * TIRE_HALF_SEP;
    const intensity = braking ? 0.55 : 0.35;
    state.skidMarks.push({ x: rearX + sxL, y: rearY + syL, alpha: intensity });
    state.skidMarks.push({ x: rearX - sxL, y: rearY - syL, alpha: intensity });
    // Limitar tamaño
    while (state.skidMarks.length > SKID_MAX_MARKS) state.skidMarks.shift();
  }
}

function drawSkidMarks(cam) {
  const marks = state.skidMarks;
  if (marks.length === 0) return;
  ctx.fillStyle = 'rgba(20,20,20,0.55)';
  for (const m of marks) {
    const [sx, sy] = worldToScreen(m.x, m.y, cam);
    ctx.globalAlpha = m.alpha * 0.7;
    ctx.beginPath();
    ctx.arc(sx, sy, 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawSparks(cam) {
  const sparks = state.sparks;
  if (sparks.length === 0) return;
  for (const s of sparks) {
    const [sx, sy] = worldToScreen(s.x, s.y, cam);
    const t = s.life / s.max;
    ctx.globalAlpha = t * 0.85;
    ctx.fillStyle = t > 0.6 ? '#fff7c2' : (t > 0.3 ? '#ffb84a' : '#cc4810');
    ctx.beginPath();
    ctx.arc(sx, sy, 0.25 + (1 - t) * 0.15, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ============================================================
//  DRS ZONES
// ============================================================
function drawDRSZones(tr, cam) {
  const drsZones = tr.def.drs;
  if (!drsZones || drsZones.length === 0) return;
  const smooth = tr.smooth;
  const n = smooth.length;

  ctx.strokeStyle = 'rgba(0, 210, 255, 0.55)';
  ctx.lineWidth = 0.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);

  for (const zone of drsZones) {
    let { from, to } = zone;
    // Convertir fracciones a índices
    const iFrom = Math.floor(from * n);
    const iTo   = Math.floor(to   * n);

    ctx.beginPath();
    let started = false;
    if (iFrom <= iTo) {
      for (let i = iFrom; i <= iTo; i++) {
        const [sx, sy] = worldToScreen(smooth[i][0], smooth[i][1], cam);
        if (!started) { ctx.moveTo(sx, sy); started = true; } else ctx.lineTo(sx, sy);
      }
    } else {
      // Zone crosses the start/finish line
      for (let i = iFrom; i < n; i++) {
        const [sx, sy] = worldToScreen(smooth[i][0], smooth[i][1], cam);
        if (!started) { ctx.moveTo(sx, sy); started = true; } else ctx.lineTo(sx, sy);
      }
      for (let i = 0; i <= iTo; i++) {
        const [sx, sy] = worldToScreen(smooth[i][0], smooth[i][1], cam);
        ctx.lineTo(sx, sy);
      }
    }
    ctx.stroke();
  }
}

// ============================================================
//  RACING LINE
// ============================================================
function drawRacingLine(tr, cam) {
  const mode = state.racingLineMode;
  if (mode === 'off' || !tr.racingLine) return;
  const rl = tr.racingLine;
  const n = rl.length;

  ctx.strokeStyle = mode === 'guide'
    ? 'rgba(0, 200, 255, 0.38)'
    : 'rgba(255, 255, 255, 0.13)';
  ctx.lineWidth = mode === 'guide' ? 3.5 : 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash(mode === 'hint' ? [9, 16] : []);

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const [sx, sy] = worldToScreen(rl[i][0], rl[i][1], cam);
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
}

// ============================================================
//  CHEVRONS DIRECCIONALES (flechas dentro de la pista)
// ============================================================
function drawChevrons(tr, cam) {
  const smooth = tr.smooth;
  const n = smooth.length;
  const step = 22;  // segmentos entre grupos de chevrons

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = TRACK_WIDTH * 0.06;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const armX = TRACK_WIDTH * 0.26;
  const armY = TRACK_WIDTH * 0.18;
  const spacing = TRACK_WIDTH * 0.18;

  for (let i = 0; i < n; i += step) {
    const p = smooth[i];
    const pNext = smooth[(i + 4) % n];
    const ang = Math.atan2(pNext[1] - p[1], pNext[0] - p[0]);
    const [sx, sy] = worldToScreen(p[0], p[1], cam);

    ctx.save();
    ctx.translate(sx, sy);
    // V default apunta hacia -y. Lo rotamos para que apunte en la dirección
    // de la pista en coordenadas de pantalla.
    ctx.rotate(ang - cam.angle + Math.PI / 2);
    for (let k = 0; k < 3; k++) {
      const yOff = -k * spacing;
      ctx.beginPath();
      ctx.moveTo(-armX, yOff + armY);
      ctx.lineTo(0, yOff);
      ctx.lineTo(armX, yOff + armY);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawStartLine(tr, cam) {
  const p1 = tr.smooth[0];
  const p2 = tr.smooth[2];
  const a = Math.atan2(p2[1]-p1[1], p2[0]-p1[0]);
  const nx = -Math.sin(a), ny = Math.cos(a);
  const halfW = TRACK_WIDTH * 0.5;
  const squares = 14;
  const sq = (halfW * 2) / squares;
  for (let i = 0; i < squares; i++) {
    for (let row = 0; row < 2; row++) {
      const t = (i / squares - 0.5) * 2 + (1 / squares);
      const longOff = (row === 0 ? -sq * 0.5 : sq * 0.5);
      const cxw = p1[0] + nx * t * halfW + Math.cos(a) * longOff;
      const cyw = p1[1] + ny * t * halfW + Math.sin(a) * longOff;
      const [sx, sy] = worldToScreen(cxw, cyw, cam);
      const isWhite = ((i + row) % 2 === 0);
      ctx.fillStyle = isWhite ? '#ffffff' : '#1a1a1a';
      const size = sq * 0.55;
      ctx.fillRect(sx - size, sy - size, size * 2, size * 2);
    }
  }
}

// ============================================================
//  DIBUJAR COCHE (top-down 2D con rotación basada en cámara)
// ============================================================
// Calculamos los vectores base "forward" y "side" en el sistema
// de coordenadas de pantalla tras la rotación de cámara, y los
// aplicamos como matriz. Así el coche queda perfectamente
// orientado independientemente de hacia dónde apunte la cámara.
function drawCar(wx, wy, angle, cam, livery, isGhost) {
  const [sx, sy] = worldToScreen(wx, wy, cam);

  // Vectores base de pantalla (top-down 2D, sin compresión vertical)
  const la = angle - cam.angle;
  const fwdX  =  Math.cos(la);
  const fwdY  =  Math.sin(la);
  const sideX = -Math.sin(la);
  const sideY =  Math.cos(la);

  ctx.save();


  // Matriz local del coche: +x = forward, +y = lado derecho
  ctx.translate(sx, sy);
  ctx.transform(fwdX, fwdY, sideX, sideY, 0, 0);

  if (isGhost) ctx.globalAlpha = 0.45;

  // --- Dimensiones del coche en unidades locales (metros) ---
  // F1 real: 5.5m largo × 2m ancho (semianchura chasis 0.5, sidepods 0.85, alerones 1.0)
  const L = 2.75;  // semilongitud
  const W = 0.85;  // semianchura "ancha" del chasis (sidepods)

  const wheelW   = 0.62;   // ancho rueda (m) — bien gruesas
  const wheelL_f = 0.75;   // diámetro rueda delantera
  const wheelL_r = 0.85;   // rueda trasera (la más grande)
  const wingT    = 0.12;   // grosor alerón

  // ---- Difusor (rejilla oscura trasera, debajo de todo) ----
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(-L * 0.95, -W * 0.55, L * 0.18, W * 1.1);

  // ---- Alerón trasero (estrecho, con endplates) ----
  ctx.fillStyle = livery.dark;
  ctx.fillRect(-L * 0.92, -W * 1.25, wingT * 1.4, W * 2.5);     // ala principal
  ctx.fillStyle = livery.accent;
  ctx.fillRect(-L * 0.92, -W * 1.25, wingT * 0.5, W * 2.5);     // tira de acento
  // Endplates verticales (placas laterales)
  ctx.fillStyle = livery.dark;
  ctx.fillRect(-L * 0.95, -W * 1.30, wingT * 2.2, W * 0.30);    // endplate izq
  ctx.fillRect(-L * 0.95,  W * 1.00, wingT * 2.2, W * 0.30);    // endplate der

  // ---- Ruedas traseras (anchas) ----
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(-L * 0.75,  W * 1.00,                    wheelL_r, wheelW);   // RR
  ctx.fillRect(-L * 0.75, -W * 1.00 - wheelW,           wheelL_r, wheelW);   // RL
  // Llantas plateadas centradas
  ctx.fillStyle = '#666';
  ctx.fillRect(-L * 0.55,  W * 1.00 + wheelW * 0.35, wheelL_r * 0.35, wheelW * 0.3);
  ctx.fillRect(-L * 0.55, -W * 1.00 - wheelW * 0.65, wheelL_r * 0.35, wheelW * 0.3);

  // ---- Carrocería con silueta F1 real ----
  // 1) Engine cover + cola (parte trasera): se afina de adelante hacia atrás
  ctx.fillStyle = livery.body;
  ctx.beginPath();
  ctx.moveTo(-L * 0.92,  W * 0.30);       // cola muy estrecha
  ctx.lineTo(-L * 0.55,  W * 0.55);       // engine cover
  ctx.lineTo(-L * 0.20,  W * 0.95);       // sidepod más ancho aquí (detrás del piloto)
  ctx.lineTo( L * 0.05,  W * 1.00);       // sidepod widest (al lado del cockpit)
  ctx.lineTo( L * 0.18,  W * 0.75);       // bargeboard inicio
  ctx.lineTo( L * 0.28,  W * 0.45);       // pinch entre sidepod y nose
  ctx.lineTo( L * 0.32,  W * 0.20);       // arranque del nose
  ctx.lineTo( L * 0.97,  W * 0.13);       // nose tube (largo, casi paralelo)
  ctx.lineTo( L * 1.00,  W * 0.08);       // punta del morro
  // Espejo a la izquierda
  ctx.lineTo( L * 1.00, -W * 0.08);
  ctx.lineTo( L * 0.97, -W * 0.13);
  ctx.lineTo( L * 0.32, -W * 0.20);
  ctx.lineTo( L * 0.28, -W * 0.45);
  ctx.lineTo( L * 0.18, -W * 0.75);
  ctx.lineTo( L * 0.05, -W * 1.00);
  ctx.lineTo(-L * 0.20, -W * 0.95);
  ctx.lineTo(-L * 0.55, -W * 0.55);
  ctx.lineTo(-L * 0.92, -W * 0.30);
  ctx.closePath();
  ctx.fill();

  // ---- Estela oscura central (engine cover spine) ----
  ctx.fillStyle = livery.dark;
  ctx.beginPath();
  ctx.moveTo(-L * 0.85,  W * 0.18);
  ctx.lineTo(-L * 0.30,  W * 0.30);
  ctx.lineTo( L * 0.05,  W * 0.18);
  ctx.lineTo( L * 0.05, -W * 0.18);
  ctx.lineTo(-L * 0.30, -W * 0.30);
  ctx.lineTo(-L * 0.85, -W * 0.18);
  ctx.closePath();
  ctx.fill();

  // ---- Línea de acento sobre el engine cover ----
  ctx.fillStyle = livery.accent;
  ctx.fillRect(-L * 0.78, -W * 0.10, L * 0.85, W * 0.20);

  // ---- Sidepod inlet (entrada de aire oscura) ----
  ctx.fillStyle = '#080808';
  ctx.fillRect( L * 0.05,  W * 0.65, L * 0.15, W * 0.35);
  ctx.fillRect( L * 0.05, -W * 1.00, L * 0.15, W * 0.35);

  // ---- Cockpit (oscuro, con halo) ----
  ctx.fillStyle = '#080808';
  ctx.beginPath();
  ctx.ellipse(L * 0.18, 0, L * 0.13, W * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();

  // Halo arco
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 0.12;
  ctx.beginPath();
  ctx.arc(L * 0.18, 0, W * 0.55, -Math.PI * 0.55, Math.PI * 0.55);
  ctx.stroke();
  // Pilar central del halo (delante del piloto)
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(L * 0.45, -W * 0.06, 0.10, W * 0.12);

  // ---- T-cam (cámara sobre el airbox) ----
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(-L * 0.15, -W * 0.10, L * 0.08, W * 0.20);
  ctx.fillStyle = livery.accent;
  ctx.fillRect(-L * 0.13, -W * 0.06, L * 0.04, W * 0.12);

  // ---- Ruedas delanteras (afuera del chasis, separadas del cuerpo) ----
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(L * 0.45,  W * 1.10,                  wheelL_f, wheelW);   // FR
  ctx.fillRect(L * 0.45, -W * 1.10 - wheelW,         wheelL_f, wheelW);   // FL
  ctx.fillStyle = '#666';
  ctx.fillRect(L * 0.55,  W * 1.10 + wheelW * 0.35, wheelL_f * 0.35, wheelW * 0.3);
  ctx.fillRect(L * 0.55, -W * 1.10 - wheelW * 0.65, wheelL_f * 0.35, wheelW * 0.3);

  // ---- Alerón delantero (ancho, multi-elemento) ----
  // Plano principal
  ctx.fillStyle = livery.dark;
  ctx.fillRect(L * 0.88, -W * 1.18, wingT, W * 2.36);
  // Segundo elemento (más adelante)
  ctx.fillStyle = livery.body;
  ctx.fillRect(L * 0.98, -W * 1.18, wingT * 0.5, W * 2.36);
  // Tira de acento sobre el ala
  ctx.fillStyle = livery.accent;
  ctx.fillRect(L * 0.88, -W * 0.30, wingT * 1.5, W * 0.60);
  // Endplates verticales del ala delantera
  ctx.fillStyle = livery.dark;
  ctx.fillRect(L * 0.85, -W * 1.20, wingT * 2.5, W * 0.18);
  ctx.fillRect(L * 0.85,  W * 1.02, wingT * 2.5, W * 0.18);

  ctx.restore();
}

function drawAICar(ai, cam) {
  drawCar(ai.x, ai.y, ai.angle, cam, ai.livery, false);
}

// ============================================================
//  FANTASMA
// ============================================================
function drawGhost(now, cam) {
  const t = now - state.lapStart;
  const samples = state.ghostSamples;
  if (!samples || samples.length === 0) return;
  const last = samples[samples.length - 1];
  // Si el fantasma ya terminó su vuelta, lo dejamos parado en la línea de meta
  if (t > last.t) {
    drawCar(last.x, last.y, last.angle, cam, { body:'#9ec5fe', dark:'#3c5a8a', accent:'#fff' }, true);
    return;
  }

  // Búsqueda binaria del sample
  let lo = 0, hi = samples.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const s1 = samples[lo], s2 = samples[hi];
  const span = s2.t - s1.t || 1;
  const k = clamp((t - s1.t) / span, 0, 1);
  const gx = lerp(s1.x, s2.x, k);
  const gy = lerp(s1.y, s2.y, k);
  const ga = lerpAngle(s1.angle, s2.angle, k);

  drawCar(gx, gy, ga, cam, { body:'#9ec5fe', dark:'#3c5a8a', accent:'#fff' }, true);
}

// ============================================================
//  MINIMAPA
// ============================================================
function drawMinimap() {
  const W = minimap.width, H = minimap.height;
  mmCtx.clearRect(0, 0, W, H);
  if (!state.track) return;

  const smooth = state.track.smooth;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x,y] of smooth) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const tw = maxX - minX, th = maxY - minY;
  const pad = 10;
  const scale = Math.min((W - pad*2) / tw, (H - pad*2) / th);
  const ox = (W - tw * scale) / 2 - minX * scale;
  const oy = (H - th * scale) / 2 - minY * scale;

  mmCtx.strokeStyle = '#3a3f4b';
  mmCtx.lineWidth = 5;
  mmCtx.lineCap = 'round'; mmCtx.lineJoin = 'round';
  mmCtx.beginPath();
  for (let i = 0; i < smooth.length; i++) {
    const sx = smooth[i][0] * scale + ox;
    const sy = smooth[i][1] * scale + oy;
    if (i === 0) mmCtx.moveTo(sx, sy); else mmCtx.lineTo(sx, sy);
  }
  mmCtx.closePath();
  mmCtx.stroke();

  mmCtx.strokeStyle = state.track.def.accent;
  mmCtx.lineWidth = 1.5;
  mmCtx.stroke();

  // Coches IA
  if (state.mode === 'race') {
    for (const a of state.ai) {
      const ax = a.x * scale + ox;
      const ay = a.y * scale + oy;
      mmCtx.fillStyle = a.livery.body;
      mmCtx.beginPath();
      mmCtx.arc(ax, ay, 3, 0, Math.PI*2);
      mmCtx.fill();
    }
  }

  // Jugador
  const cx = state.car.x * scale + ox;
  const cy = state.car.y * scale + oy;
  mmCtx.fillStyle = '#fff';
  mmCtx.beginPath();
  mmCtx.arc(cx, cy, 4.5, 0, Math.PI*2);
  mmCtx.fill();
  mmCtx.fillStyle = state.livery.body;
  mmCtx.beginPath();
  mmCtx.arc(cx, cy, 3, 0, Math.PI*2);
  mmCtx.fill();
}

// ============================================================
//  EVENTOS DE UI
// ============================================================
document.getElementById('backBtn').addEventListener('click', exitRace);
const pauseBtnMobile = document.getElementById('pauseBtnMobile');
if (pauseBtnMobile) pauseBtnMobile.addEventListener('click', togglePause);
document.getElementById('resumeBtn').addEventListener('click', togglePause);
document.getElementById('restartBtn').addEventListener('click', () => { togglePause(); restartLap(); });
document.getElementById('exitBtn').addEventListener('click', () => { togglePause(); exitRace(); });

document.getElementById('modeBtn').addEventListener('click', () => {
  state.mode = state.mode === 'tt' ? 'race' : 'tt';
  saveJSON(MODE_KEY, state.mode);
  updateModeButton();
});

document.getElementById('musicBtn').addEventListener('click', () => {
  music.toggle();
  saveJSON(MUSIC_KEY, music.isOn());
  updateMusicButton();
});

// ============================================================
//  STATS PANEL UI
// ============================================================
function fmtDuration(sec) {
  if (sec < 60) return Math.round(sec) + 's';
  if (sec < 3600) return Math.round(sec/60) + 'm';
  return (sec/3600).toFixed(1) + 'h';
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString();
}
function renderStatsTab() {
  const s = loadStats();
  const km = (s.totalMeters / 1000).toFixed(1);
  return `<div class="stat-grid">
    <div class="stat-card"><div class="stat-label">Vueltas totales</div><div class="stat-value">${s.totalLaps}</div></div>
    <div class="stat-card"><div class="stat-label">Vueltas limpias</div><div class="stat-value">${s.cleanLaps}</div></div>
    <div class="stat-card"><div class="stat-label">Vueltas eliminadas</div><div class="stat-value">${s.invalidLaps}</div></div>
    <div class="stat-card"><div class="stat-label">Carreras</div><div class="stat-value">${s.totalRaces}</div></div>
    <div class="stat-card"><div class="stat-label">Victorias</div><div class="stat-value">${s.wins}</div></div>
    <div class="stat-card"><div class="stat-label">Podios</div><div class="stat-value">${s.podiums}</div></div>
    <div class="stat-card"><div class="stat-label">Distancia</div><div class="stat-value">${km} km</div></div>
    <div class="stat-card"><div class="stat-label">Tiempo en pista</div><div class="stat-value">${fmtDuration(s.totalDriveSec)}</div></div>
    <div class="stat-card"><div class="stat-label">Velocidad máxima</div><div class="stat-value">${s.maxSpeedKmh} km/h</div></div>
    <div class="stat-card"><div class="stat-label">Pistas únicas</div><div class="stat-value">${s.uniqueTracks.length}/24</div></div>
  </div>`;
}
function renderBadgesTab() {
  const owned = loadBadges();
  return '<div class="badge-grid">' + BADGES.map(b => `
    <div class="badge ${owned[b.id] ? 'unlocked' : ''}">
      <div class="badge-label">${owned[b.id] ? '🏅' : '🔒'} ${b.label}</div>
      <div class="badge-desc">${b.desc}</div>
    </div>`).join('') + '</div>';
}
function renderLeaderboardTab() {
  const lb = loadLeaderboard();
  const trackIds = Object.keys(lb);
  if (trackIds.length === 0) return '<p style="color:var(--fg-dim);text-align:center;padding:24px">Todavía no hay tiempos registrados. ¡Andá a correr!</p>';
  return trackIds.map(id => {
    const track = TRACKS.find(t => t.id === id);
    const name = track ? track.name : id;
    const rows = lb[id].map((e, i) => `
      <div class="lb-row">
        <span class="lb-pos">${i+1}.</span>
        <span class="lb-ms">${fmtTime(e.ms)}</span>
        <span class="lb-date">${fmtDate(e.t)}</span>
      </div>`).join('');
    return `<div class="lb-track"><h4>${name}</h4>${rows}</div>`;
  }).join('');
}
function renderStatsPanel(tab) {
  const body = document.getElementById('statsBody');
  if (!body) return;
  if (tab === 'badges') body.innerHTML = renderBadgesTab();
  else if (tab === 'leaderboard') body.innerHTML = renderLeaderboardTab();
  else if (tab === 'global') renderGlobalLeaderboardTab(body);
  else body.innerHTML = renderStatsTab();
  document.querySelectorAll('.stats-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
}

// ============================================================
//  LEADERBOARD GLOBAL (cliente)
// ============================================================
const PLAYER_NAME_KEY = 'f1rush.playerName';
function getPlayerCountry() {
  // Inferimos por timezone (sin pedir permisos de geolocalización)
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const map = {
      'Europe/Madrid':'ES','Europe/London':'GB','Europe/Paris':'FR','Europe/Berlin':'DE','Europe/Rome':'IT',
      'America/Argentina/Buenos_Aires':'AR','America/Sao_Paulo':'BR','America/Santiago':'CL','America/Mexico_City':'MX',
      'America/New_York':'US','America/Los_Angeles':'US','America/Chicago':'US','America/Lima':'PE',
      'America/Bogota':'CO','America/Caracas':'VE','America/Montevideo':'UY','America/Asuncion':'PY',
      'Asia/Tokyo':'JP','Asia/Singapore':'SG','Australia/Sydney':'AU',
    };
    return map[tz] || tz.split('/').pop().slice(0,3).toUpperCase();
  } catch { return ''; }
}
async function submitGlobalLap(trackId, lapMs, name) {
  try {
    const r = await fetch('/api/leaderboard', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ trackId, ms: lapMs, name, country: getPlayerCountry() }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    return { error: e.message };
  }
}
async function fetchGlobalLap(trackId) {
  try {
    const r = await fetch('/api/leaderboard?track=' + encodeURIComponent(trackId));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    return { error: e.message, entries: [] };
  }
}
function promptSubmitToGlobalLeaderboard(trackId, lapMs) {
  const overlay = document.getElementById('lbSubmitOverlay');
  const input = document.getElementById('lbName');
  const msg = document.getElementById('lbSubmitMsg');
  const timeEl = document.getElementById('lbSubmitTime');
  if (!overlay) return;
  timeEl.textContent = fmtTime(lapMs);
  input.value = localStorage.getItem(PLAYER_NAME_KEY) || '';
  msg.textContent = '';
  overlay.classList.remove('hidden');
  setTimeout(() => input.focus(), 100);

  const submit = async () => {
    const name = (input.value || '').trim();
    if (name.length < 2) { msg.textContent = 'Nombre muy corto (mín 2 caracteres)'; return; }
    localStorage.setItem(PLAYER_NAME_KEY, name);
    msg.textContent = 'Subiendo...';
    const result = await submitGlobalLap(trackId, lapMs, name);
    if (result.error) {
      msg.textContent = '⚠️ ' + result.error;
    } else {
      msg.textContent = '✓ Subido' + (result.rank ? ` · puesto #${result.rank}` : '');
      setTimeout(() => overlay.classList.add('hidden'), 1200);
    }
  };
  document.getElementById('lbSubmitBtn').onclick = submit;
  document.getElementById('lbSkipBtn').onclick = () => overlay.classList.add('hidden');
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

async function renderGlobalLeaderboardTab(body) {
  body.innerHTML = '<p style="color:var(--fg-dim);padding:24px;text-align:center">Cargando…</p>';
  // Mostrar las 24 pistas y dejar al usuario expandir
  const sections = await Promise.all(TRACKS.map(async t => {
    const data = await fetchGlobalLap(t.id);
    if (data.error || !data.entries || data.entries.length === 0) return null;
    const rows = data.entries.slice(0, 10).map((e, i) => `
      <div class="lb-row">
        <span class="lb-pos">${i+1}.</span>
        <span class="lb-name">${(e.name||'?')}${e.country ? ' <span style="color:var(--fg-dim);font-size:10px">'+e.country+'</span>' : ''}</span>
        <span class="lb-ms">${fmtTime(e.ms)}</span>
      </div>`).join('');
    return `<div class="lb-track"><h4>${t.flag||''} ${t.name}</h4>${rows}</div>`;
  }));
  const valid = sections.filter(Boolean);
  if (valid.length === 0) {
    body.innerHTML = '<p style="color:var(--fg-dim);padding:24px;text-align:center">Aún no hay tiempos en el leaderboard global. ¡Sé el primero!</p>';
  } else {
    body.innerHTML = valid.join('');
  }
}
document.getElementById('statsBtn').addEventListener('click', () => {
  const panel = document.getElementById('statsPanel');
  const isHidden = panel.classList.toggle('hidden');
  if (!isHidden) renderStatsPanel('stats');
});
document.getElementById('statsCloseBtn').addEventListener('click', () => {
  document.getElementById('statsPanel').classList.add('hidden');
});
document.querySelectorAll('.stats-tab').forEach(tab => {
  tab.addEventListener('click', () => renderStatsPanel(tab.dataset.tab));
});

document.getElementById('finishContinue').addEventListener('click', () => {
  document.getElementById('finishOverlay').classList.add('hidden');
  exitRace();
});

// ============================================================
//  INIT
// ============================================================
function init() {
  // Restaurar preferencias
  const savedLivery = loadJSON(LIVERY_KEY, 'ferrari');
  const liv = LIVERIES.find(l => l.id === savedLivery);
  if (liv) state.livery = liv;
  state.mode = loadJSON(MODE_KEY, 'tt');
  state.racingLineMode = loadJSON(RACING_LINE_KEY, 'off') || 'off';
  const musicPref = loadJSON(MUSIC_KEY, true);
  music.setEnabled(musicPref);

  renderMenu();
  resizeCanvas();
  initGrassPattern();
  bindTouch();

  // Iniciar música tras primer gesto
  document.addEventListener('click', () => {
    if (state.scene === 'menu' && music.isOn()) music.start();
  }, { once: true });

  // Debug: exponer state para inspección en consola
  window.__f1__ = state;
}

init();

})();
