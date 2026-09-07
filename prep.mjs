// Build data/network.json from HDC's official GIS layers:
//   - CMP road centerlines (topology; snapped + noded, since the raw layer has
//     unsplit crossings and endpoints that hang a few metres off their junctions)
//   - LUP lot parcels (carriageway width, measured as the perpendicular gap
//     between the parcels flanking each road — no HDC layer stores width)
// Lanes/one-way aren't in any HDC layer either: lanes are estimated from width
// and both are user-editable in the app (data/overrides.json + localStorage).
// Usage: node prep.mjs [roads_hdc.json] [buildings.json]

import { readFileSync, writeFileSync } from 'fs';

const ROADS = process.argv[2] || '../fini-raasthaa/data/roads_hdc.json';
const LOTS = process.argv[3] || '../fini-raasthaa/web/data/buildings.json';

const LAT0 = 4.21, MPD = 111320, COS = Math.cos(LAT0 * Math.PI / 180);
const mx = lon => (lon - 73.54) * MPD * COS;
const my = lat => (lat - 4.21) * MPD;
const toM = p => [mx(p[0]), my(p[1])];
const toLL = m => [+(m[0] / (MPD * COS) + 73.54).toFixed(6), +(m[1] / MPD + 4.21).toFixed(6)];
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

// ---- load centerlines as metre-space polylines ----
const rj = JSON.parse(readFileSync(ROADS, 'utf8'));
let lines = [];
for (const f of rj.features) {
  const g = f.geometry;
  const parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
  for (const c of parts)
    lines.push({ pts: c.map(toM), name: (f.properties.Road_Names || '').trim(), phase: (f.properties.Phase || '').trim() });
}

// ---- noding pass 1: insert exact segment-segment intersections into both lines ----
function segInt(a, b, c, e) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [e[0] - c[0], e[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t < 1e-6 || t > 1 - 1e-6 || u < 1e-6 || u > 1 - 1e-6) return null;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}
for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
  const A = lines[i].pts, B = lines[j].pts;
  for (let s = 0; s < A.length - 1; s++) for (let t = 0; t < B.length - 1; t++) {
    const p = segInt(A[s], A[s + 1], B[t], B[t + 1]);
    if (p) { A.splice(s + 1, 0, p); B.splice(t + 1, 0, [...p]); s++; }
  }
}

// ---- noding pass 2: snap dangling endpoints (≤8 m) onto the nearest other line ----
const SNAP = 8;
function nearestOnLine(p, pts) {
  let best = null, bd = SNAP * SNAP, bi = -1, bt = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ab = [b[0] - a[0], b[1] - a[1]];
    const L2 = ab[0] ** 2 + ab[1] ** 2 || 1e-9;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / L2));
    const q = [a[0] + t * ab[0], a[1] + t * ab[1]];
    const dd = d2(p, q);
    if (dd < bd) { bd = dd; best = q; bi = i; bt = t; }
  }
  return best ? { q: best, i: bi, t: bt, d: Math.sqrt(bd) } : null;
}
for (const l of lines) {
  for (const end of [0, l.pts.length - 1]) {
    const p = l.pts[end];
    let hit = null, hl = null;
    for (const o of lines) {
      if (o === l) continue;
      const h = nearestOnLine(p, o.pts);
      if (h && (!hit || h.d < hit.d)) { hit = h; hl = o; }
    }
    if (hit && hit.d > 0.05) {
      l.pts[end] = [...hit.q];
      if (hit.t > 1e-3 && hit.t < 1 - 1e-3) hl.pts.splice(hit.i + 1, 0, [...hit.q]);
    }
  }
}

// ---- lot parcels -> spatial grid of boundary segments (for width probing) ----
const lj = JSON.parse(readFileSync(LOTS, 'utf8'));
const CELL = 30, grid = new Map();
const gk = (x, y) => Math.floor(x / CELL) + ':' + Math.floor(y / CELL);
function addSeg(a, b) {
  const minx = Math.min(a[0], b[0]), maxx = Math.max(a[0], b[0]);
  const miny = Math.min(a[1], b[1]), maxy = Math.max(a[1], b[1]);
  for (let x = minx; x <= maxx + CELL; x += CELL) for (let y = miny; y <= maxy + CELL; y += CELL) {
    const k = gk(x, y);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push([a, b]);
  }
}
for (const f of lj.features) {
  const rings = f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat();
  for (const ring of rings) {
    const m = ring.map(toM);
    for (let i = 1; i < m.length; i++) addSeg(m[i - 1], m[i]);
  }
}
function rayHit(p, dir, max) { // distance from p along dir to nearest lot boundary
  let best = max;
  const R = Math.ceil(max / CELL) + 1;
  const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
  const tested = new Set();
  for (let ix = cx - R; ix <= cx + R; ix++) for (let iy = cy - R; iy <= cy + R; iy++) {
    for (const seg of grid.get(ix + ':' + iy) || []) {
      if (tested.has(seg)) continue; tested.add(seg);
      const [a, b] = seg;
      const den = dir[0] * (a[1] - b[1]) - dir[1] * (a[0] - b[0]);
      if (Math.abs(den) < 1e-9) continue;
      const t = ((a[0] - p[0]) * (a[1] - b[1]) - (a[1] - p[1]) * (a[0] - b[0])) / den;
      if (t <= 0.01 || t >= best) continue;
      const q = [p[0] + dir[0] * t, p[1] + dir[1] * t];
      const abx = b[0] - a[0], aby = b[1] - a[1];
      const u = ((q[0] - a[0]) * abx + (q[1] - a[1]) * aby) / (abx * abx + aby * aby || 1e-9);
      if (u >= -0.001 && u <= 1.001) best = t;
    }
  }
  return best;
}
function measureWidth(pts, cum, len) {
  // min over samples: parcel gaps at cross-streets/parks overshoot, so the
  // tightest flanked section is the honest right-of-way estimate
  const MAXW = 25, ws = [];
  for (const f of [0.2, 0.35, 0.5, 0.65, 0.8]) {
    const sPos = f * len;
    let i = 0; while (i < cum.length - 2 && cum[i + 1] < sPos) i++;
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const ff = (sPos - cum[i]) / (cum[i + 1] - cum[i] || 1);
    const p = [a[0] + (b[0] - a[0]) * ff, a[1] + (b[1] - a[1]) * ff];
    const n = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
    const l = rayHit(p, n, MAXW), r = rayHit(p, [-n[0], -n[1]], MAXW);
    if (l < MAXW && r < MAXW) ws.push(l + r);
  }
  if (!ws.length) return 0; // unflanked (bridge, waterfront) — caller decides
  return Math.min(24, Math.max(4, Math.min(...ws)));
}

// ---- graph build: node on shared coords (~1 m rounding), split at junctions ----
const usage = new Map();
const key = p => Math.round(p[0]) + ':' + Math.round(p[1]);
for (const l of lines) l.pts.forEach((p, i) => {
  const k = key(p);
  usage.set(k, (usage.get(k) || 0) + (i === 0 || i === l.pts.length - 1 ? 2 : 1));
});
const nodes = [], nodeIdx = new Map();
const nodeAt = p => {
  const k = key(p);
  if (!nodeIdx.has(k)) { nodeIdx.set(k, nodes.length); nodes.push(toLL(p)); }
  return nodeIdx.get(k);
};
const edges = [];
for (const l of lines) {
  let seg = [l.pts[0]];
  for (let i = 1; i < l.pts.length; i++) {
    seg.push(l.pts[i]);
    if (usage.get(key(l.pts[i])) >= 2 || i === l.pts.length - 1) {
      let len = 0, cum = [0];
      for (let j = 1; j < seg.length; j++) { len += Math.hypot(seg[j][0] - seg[j - 1][0], seg[j][1] - seg[j - 1][1]); cum.push(len); }
      if (len >= 3 && key(seg[0]) !== key(seg[seg.length - 1])) {
        let row = measureWidth(seg, cum, len);
        const isBridgeLink = seg.some(p => p[0] < mx(73.5335));
        if (!row) row = isBridgeLink ? 15 : 10; // unflanked fallback
        const width = row < 8 ? row : Math.max(4, row - 4); // carriageway ≈ ROW minus 2 m sidewalk each side
        const hw = isBridgeLink || width >= 14 ? 'primary' : width >= 10 ? 'tertiary' : width >= 6 ? 'residential' : 'service';
        edges.push({
          a: nodeAt(seg[0]), b: nodeAt(seg[seg.length - 1]),
          len: +len.toFixed(1), geo: seg.map(toLL),
          hw, name: l.name, phase: l.phase,
          speed: isBridgeLink ? 50 : width >= 14 ? 40 : width >= 10 ? 30 : 25,
          width: +width.toFixed(1),
          lanes: width >= 14 ? 4 : width >= 6 ? 2 : 1,
          oneway: 0,
        });
      }
      seg = [l.pts[i]];
    }
  }
}

// pedestrians walk the same streets (sidewalk offset handled in the app); keep them off the bridge link
const pedEdges = edges.filter(e => e.geo[0][0] > 73.5335 && e.geo[e.geo.length - 1][0] > 73.5335)
  .map(e => ({ a: e.a, b: e.b, len: e.len, geo: e.geo, width: e.width }));

writeFileSync('data/network.json', JSON.stringify({ veh: { nodes, edges }, ped: { nodes, edges: pedEdges }, crossings: [] }));

const km = es => (es.reduce((s, e) => s + e.len, 0) / 1000).toFixed(1);
console.log(`vehicle graph: ${nodes.length} nodes, ${edges.length} edges, ${km(edges)} km`);
console.log(`ped edges: ${pedEdges.length}`);
const wb = { '<6.5': 0, '6.5-10': 0, '10-14': 0, '14+': 0 };
for (const e of edges) wb[e.width < 6.5 ? '<6.5' : e.width < 10 ? '6.5-10' : e.width < 14 ? '10-14' : '14+']++;
console.log('width buckets (m):', wb);
const deg = new Map(); for (const e of edges) for (const n of [e.a, e.b]) deg.set(n, (deg.get(n) || 0) + 1);
console.log('dead-end nodes:', [...deg.values()].filter(v => v === 1).length, '/ junctions(3+):', [...deg.values()].filter(v => v >= 3).length);
