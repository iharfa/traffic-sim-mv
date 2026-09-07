import { Sim, TYPES, GREEN, AMBER } from './sim.js';

const HDC_TILES = 'https://gis.hdc.mv/server/rest/services/Hosted/IMAGERY_HMLNOV2025/MapServer/tile/{z}/{y}/{x}';
const RASTERS = {
  esri: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], maxzoom: 19, attribution: 'Esri, Maxar, Earthstar Geographics' },
  hdc:  { tiles: [HDC_TILES], maxzoom: 21, attribution: 'HDC gis.hdc.mv drone orthomosaic' },
  osm:  { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19, attribution: '© OpenStreetMap contributors' },
};
const HW_COLOR = { primary: '#f8961e', tertiary: '#4cc9f0', tertiary_link: '#4cc9f0', residential: '#9ecbff', service: '#6e7681', living_street: '#9ecbff' };

const net = await (await fetch('data/network.json')).json();
const sim = new Sim(net);

// direction/lane overrides: committed file + this browser's edits on top
const ekey = e => e.geo[0].join(',') + '|' + e.geo[e.geo.length - 1].join(',');
const defaults = net.veh.edges.map(e => ({ ow: e.oneway || 0, lanes: e.lanes }));
let fileOvr = {};
try { const r = await fetch('data/overrides.json'); if (r.ok) fileOvr = await r.json(); } catch { }
const overrides = { ...fileOvr, ...JSON.parse(localStorage.getItem('tsmv-ovr') || '{}') };
net.veh.edges.forEach((e, i) => { const o = overrides[ekey(e)]; if (o) sim.configureEdge(i, o.ow ?? 0, o.lanes ?? e.lanes); });
const saveOvr = () => localStorage.setItem('tsmv-ovr', JSON.stringify(overrides));

// ---------- map ----------
const map = new maplibregl.Map({
  container: 'map',
  style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0d1117' } }] },
  center: [73.5405, 4.222], zoom: 14.2, maxBounds: [[73.45, 4.13], [73.65, 4.32]],
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
window.map = map;

map.on('load', () => {
  for (const [id, src] of Object.entries(RASTERS)) {
    map.addSource(id, { type: 'raster', tileSize: 256, ...src });
    map.addLayer({ id, type: 'raster', source: id, layout: { visibility: id === 'esri' ? 'visible' : 'none' }, paint: { 'raster-opacity': 0.85 } }, undefined);
  }
  map.addSource('roads', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: net.veh.edges.map(e => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: e.geo }, properties: { w: e.width, hw: e.hw } })),
    },
  });
  map.addLayer({
    id: 'roads', type: 'line', source: 'roads',
    paint: {
      'line-color': ['coalesce', ['get', ['get', 'hw'], ['literal', HW_COLOR]], '#9ecbff'],
      'line-opacity': 0.28,
      'line-width': ['interpolate', ['exponential', 2], ['zoom'], 13, ['*', ['get', 'w'], 0.07], 20, ['*', ['get', 'w'], 9]],
    },
  });
});

// ---------- canvas overlay ----------
const cv = document.getElementById('overlay');
const ctx = cv.getContext('2d');
function resize() {
  const dpr = window.devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resize).observe(cv); resize();

function render() {
  ctx.clearRect(0, 0, cv.clientWidth, cv.clientHeight);
  const c = map.getCenter();
  const p0 = map.project([c.lng, c.lat]), p1 = map.project([c.lng + 0.0005, c.lat]);
  const ppm = Math.hypot(p1.x - p0.x, p1.y - p0.y) / (0.0005 * 111320 * Math.cos(c.lat * Math.PI / 180));
  const mapBrg = map.getBearing() * Math.PI / 180;

  // pedestrians
  ctx.fillStyle = '#ffffff';
  const pr = Math.max(1.1, 0.3 * ppm);
  for (const p of sim.peds) {
    const l = sim.locate(p);
    const s = map.project([l.lon, l.lat]);
    if (s.x < -20 || s.y < -20 || s.x > cv.clientWidth + 20 || s.y > cv.clientHeight + 20) continue;
    const ang = l.hdg - mapBrg, tx = Math.sin(ang), ty = -Math.cos(ang);
    const off = p.side * (p.de.walkOff || 1.8) * ppm;
    ctx.beginPath(); ctx.arc(s.x + ty * off, s.y - tx * off, pr, 0, 7); ctx.fill();
  }

  // vehicles
  for (const v of sim.vehicles) {
    const l = sim.locate(v);
    const s = map.project([l.lon, l.lat]);
    if (s.x < -30 || s.y < -30 || s.x > cv.clientWidth + 30 || s.y > cv.clientHeight + 30) continue;
    const ang = l.hdg - mapBrg, tx = Math.sin(ang), ty = -Math.cos(ang);
    const de = v.de;
    let lat = (de.twoWay ? de.width / 4 : 0) + (v.lane - (de.lanes - 1) / 2) * 2.8;
    lat = Math.min(lat, de.width / 2 - 0.9);
    const off = lat * ppm;
    const x = s.x + ty * off, y = s.y - tx * off;
    const lpx = Math.max(2.6, v.t.len * ppm), wpx = Math.max(1.6, v.t.w * ppm);
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = v.t.color;
    ctx.fillRect(-wpx / 2, -lpx / 2, wpx, lpx);
    if (lpx > 9) { ctx.fillStyle = '#0d1117aa'; ctx.fillRect(-wpx / 2, -lpx / 2, wpx, lpx * 0.22); } // windshield hint
    ctx.restore();
  }

  // road editor decorations
  if (editing) {
    if (selIdx >= 0) {
      const g = net.veh.edges[selIdx].geo;
      ctx.strokeStyle = '#4cc9f0'; ctx.lineWidth = 4; ctx.beginPath();
      g.forEach((c, i) => { const s = map.project(c); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
      ctx.stroke();
    }
    ctx.fillStyle = '#4cc9f0';
    for (const e of net.veh.edges) {
      if (!e.oneway) continue;
      const g = e.geo, mi = Math.max(1, (g.length / 2) | 0);
      const a = g[mi - 1], b = g[mi];
      const s = map.project([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      if (s.x < 0 || s.y < 0 || s.x > cv.clientWidth || s.y > cv.clientHeight) continue;
      let ang = Math.atan2(b[0] - a[0], (b[1] - a[1]) / Math.cos(4.21 * Math.PI / 180)) - mapBrg;
      if (e.oneway === -1) ang += Math.PI;
      ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5, 4); ctx.lineTo(-5, 4); ctx.fill();
      ctx.restore();
    }
  }

  // signals
  const period = 2 * (GREEN + AMBER);
  for (const s of sim.signals) {
    const p = map.project([s.lon, s.lat]);
    const ph = (sim.time + s.t) % period;
    const g0 = ph < GREEN, g1 = ph >= GREEN + AMBER && ph < 2 * GREEN + AMBER;
    ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, 7); ctx.fillStyle = '#161b22'; ctx.fill();
    ctx.strokeStyle = g0 ? '#3ddc84' : '#e63946'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(p.x, p.y, 6.5, 0, 7); ctx.stroke();
    ctx.fillStyle = g1 ? '#3ddc84' : '#e63946';
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill();
  }
}

// ---------- sim loop ----------
let running = true, simSpeed = 1, last = performance.now(), acc = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (running) {
    acc += dt * simSpeed;
    let steps = 0;
    while (acc >= 0.05 && steps++ < 10) { sim.step(0.05); acc -= 0.05; }
    acc = Math.min(acc, 0.2);
  }
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

setInterval(() => {
  const s = sim.stats();
  document.getElementById('stats').innerHTML =
    `<b>${s.vehicles}</b> vehicles · <b>${s.peds}</b> pedestrians · avg <b>${s.avgKmh.toFixed(0)}</b> km/h · ${sim.signals.length} signals`;
}, 500);

// ---------- controls ----------
const store = JSON.parse(localStorage.getItem('tsmv') || '{}');
if (store.targets) Object.assign(sim.targets, store.targets);
if (store.pedTarget != null) sim.pedTarget = store.pedTarget;
if (store.mult != null) sim.mult = store.mult;
const save = () => localStorage.setItem('tsmv', JSON.stringify({
  targets: sim.targets, pedTarget: sim.pedTarget, mult: sim.mult,
  signals: sim.signals.map(s => [s.lon, s.lat]),
}));

const MAXES = { motorcycle: 1500, car: 600, taxi: 300, pickup: 200, lorry: 100, bus: 50, buggy: 100, bicycle: 300 };
const typesEl = document.getElementById('types');
const lastOn = {};
for (const [k, t] of Object.entries(TYPES)) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label><input type="checkbox" ${sim.targets[k] > 0 ? 'checked' : ''}>
    <span class="sw" style="background:${t.color}"></span>${t.label}</label>
    <input type="range" min="0" max="${MAXES[k]}" value="${sim.targets[k]}"><span class="n">${sim.targets[k]}</span>`;
  const [chk, rng] = row.querySelectorAll('input');
  const n = row.querySelector('.n');
  rng.oninput = () => { sim.targets[k] = +rng.value; n.textContent = rng.value; chk.checked = +rng.value > 0; save(); };
  chk.onchange = () => {
    if (chk.checked) { sim.targets[k] = lastOn[k] || TYPES[k].dflt; } else { lastOn[k] = sim.targets[k]; sim.targets[k] = 0; }
    rng.value = sim.targets[k]; n.textContent = rng.value; save();
  };
  typesEl.appendChild(row);
}

const peds = document.getElementById('peds'), pedsn = document.getElementById('pedsn');
peds.value = sim.pedTarget; pedsn.textContent = sim.pedTarget;
peds.oninput = () => { sim.pedTarget = +peds.value; pedsn.textContent = peds.value; save(); };

const mult = document.getElementById('mult'), multn = document.getElementById('multn');
mult.value = sim.mult * 100; multn.textContent = Math.round(sim.mult * 100) + '%';
mult.oninput = () => { sim.mult = mult.value / 100; multn.textContent = mult.value + '%'; save(); };

const play = document.getElementById('play');
play.onclick = () => { running = !running; play.textContent = running ? '⏸' : '▶'; play.classList.toggle('on', running); };
for (const b of document.querySelectorAll('.spd'))
  b.onclick = () => { simSpeed = +b.dataset.spd; document.querySelectorAll('.spd').forEach(x => x.classList.toggle('on', x === b)); };

document.getElementById('basemap').onchange = e => {
  for (const id of Object.keys(RASTERS)) map.setLayoutProperty(id, 'visibility', id === e.target.value ? 'visible' : 'none');
};
document.getElementById('roads').onchange = e =>
  map.setLayoutProperty('roads', 'visibility', e.target.checked ? 'visible' : 'none');

const collapse = document.getElementById('collapse'), panel = document.getElementById('panel');
collapse.onclick = () => { panel.classList.toggle('min'); collapse.textContent = panel.classList.contains('min') ? '▸' : '▾'; };

// ---------- road editor ----------
let editing = false, selIdx = -1;
const editBtn = document.getElementById('editroads'), pop = document.getElementById('pop');
const MXm = lon => (lon - 73.54) * 111320 * Math.cos(4.21 * Math.PI / 180), MYm = lat => (lat - 4.21) * 111320;

function nearestEdgeIdx(ll) {
  const p = [MXm(ll.lng), MYm(ll.lat)];
  let best = -1, bd = 15 * 15;
  net.veh.edges.forEach((e, i) => {
    for (let j = 1; j < e.geo.length; j++) {
      const a = [MXm(e.geo[j - 1][0]), MYm(e.geo[j - 1][1])], b = [MXm(e.geo[j][0]), MYm(e.geo[j][1])];
      const abx = b[0] - a[0], aby = b[1] - a[1], L2 = abx * abx + aby * aby || 1e-9;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / L2));
      const dx = p[0] - a[0] - t * abx, dy = p[1] - a[1] - t * aby, dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = i; }
    }
  });
  return best;
}

function showPop(i, px) {
  selIdx = i;
  const e = net.veh.edges[i];
  pop.innerHTML = `<b>${e.name || 'unnamed road'}</b>
    <div class="hint">${e.width} m carriageway${e.phase ? ' · ' + e.phase : ''}</div>
    <div class="row"><label>Direction</label><select id="poww">
      <option value="0">⇆ Two-way</option><option value="1">One-way ▲</option><option value="-1">One-way ▼</option></select></div>
    <div class="row"><label>Lanes</label><select id="poln"><option>1</option><option>2</option><option>3</option><option>4</option></select></div>
    <div class="ctrls"><button id="porst">Reset</button><button id="pocls">Close</button></div>`;
  const ow = pop.querySelector('#poww'), ln = pop.querySelector('#poln');
  ow.value = String(e.oneway || 0); ln.value = String(e.lanes);
  const apply = () => {
    sim.configureEdge(i, +ow.value, +ln.value);
    overrides[ekey(e)] = { ow: +ow.value, lanes: +ln.value };
    saveOvr();
  };
  ow.onchange = apply; ln.onchange = apply;
  pop.querySelector('#porst').onclick = () => {
    delete overrides[ekey(e)]; saveOvr();
    sim.configureEdge(i, defaults[i].ow, defaults[i].lanes);
    ow.value = String(defaults[i].ow); ln.value = String(defaults[i].lanes);
  };
  pop.querySelector('#pocls').onclick = () => { pop.hidden = true; selIdx = -1; };
  pop.style.left = Math.min(px.x + 12, innerWidth - 230) + 'px';
  pop.style.top = Math.min(px.y + 12, innerHeight - 190) + 'px';
  pop.hidden = false;
}

editBtn.onclick = () => {
  editing = !editing;
  editBtn.classList.toggle('on', editing);
  if (!editing) { pop.hidden = true; selIdx = -1; }
  map.getCanvas().style.cursor = editing ? 'pointer' : '';
};
document.getElementById('exportovr').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(overrides, null, 1)], { type: 'application/json' }));
  a.download = 'overrides.json'; a.click();
};

// ---------- signals ----------
let placing = false;
const addsig = document.getElementById('addsig'), sighint = document.getElementById('sighint'), siglist = document.getElementById('siglist');

function nearestJunction(lngLat) {
  let best = null, bd = 1e9;
  const degree = new Map();
  for (const de of sim.des) degree.set(de.to, (degree.get(de.to) || 0) + 1);
  net.veh.nodes.forEach((n, i) => {
    if ((degree.get(i) || 0) < 3) return;
    const d = Math.hypot((n[0] - lngLat.lng) * 111320 * 0.997, (n[1] - lngLat.lat) * 111320);
    if (d < bd) { bd = d; best = i; }
  });
  return bd < 80 ? best : null;
}
function refreshSigs() {
  siglist.innerHTML = '';
  sim.signals.forEach((s, i) => {
    const d = document.createElement('div');
    const name = sim.des.find(e => e.to === s.node && e.name)?.name || `junction ${s.node}`;
    d.innerHTML = `<span>🚦 ${name}</span><button title="Remove">✕</button>`;
    d.querySelector('button').onclick = () => { sim.removeSignal(s); refreshSigs(); save(); };
    siglist.appendChild(d);
  });
}
addsig.onclick = () => {
  placing = !placing;
  addsig.classList.toggle('on', placing);
  sighint.textContent = placing ? 'Now click a junction on the map…' : 'Click the button, then click a junction on the map.';
  map.getCanvas().style.cursor = placing ? 'crosshair' : '';
};
map.on('click', e => {
  if (editing && !placing) {
    const i = nearestEdgeIdx(e.lngLat);
    if (i >= 0) showPop(i, e.point); else { pop.hidden = true; selIdx = -1; }
    return;
  }
  if (!placing) return;
  const node = nearestJunction(e.lngLat);
  if (node != null && sim.addSignal(node)) { refreshSigs(); save(); }
  placing = false; addsig.classList.remove('on');
  sighint.textContent = 'Click the button, then click a junction on the map.';
  map.getCanvas().style.cursor = '';
});
for (const [lon, lat] of store.signals || []) {
  const node = nearestJunction({ lng: lon, lat });
  if (node != null) sim.addSignal(node);
}
refreshSigs();
