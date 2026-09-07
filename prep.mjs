// Build data/network.json from fini-raasthaa's Overpass dump (Hulhumalé P1+P2).
// Usage: node prep.mjs [path-to-osm_roads.json]
import { readFileSync, writeFileSync } from 'fs';

const SRC = process.argv[2] || '../fini-raasthaa/data/osm_roads.json';
const raw = JSON.parse(readFileSync(SRC, 'utf8'));
const ways = raw.elements.filter(e => e.type === 'way' && e.geometry && e.tags?.highway);

// local metre projection (fini-raasthaa/prep.js convention)
const LAT0 = 4.21, MPD = 111320;
const mx = lon => (lon - 73.54) * MPD * Math.cos(LAT0 * Math.PI / 180);
const my = lat => (lat - 4.21) * MPD;
const dist = (a, b) => Math.hypot(mx(b[0]) - mx(a[0]), my(b[1]) - my(a[1]));

const MIN_LAT = 4.2; // clip off Malé/airport end of the bridge link

const VEH_HW = new Set(['primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','service','living_street']);
const PED_HW = new Set(['footway','path','pedestrian','cycleway','corridor','living_street']);

const SPEED_DEF = { primary: 50, primary_link: 40, secondary: 40, tertiary: 30, tertiary_link: 30, residential: 25, unclassified: 25, service: 15, living_street: 10 };
const WIDTH_DEF = { primary: 13, primary_link: 8, secondary: 10, tertiary: 9, tertiary_link: 6, residential: 7, unclassified: 6, service: 4.5, living_street: 5 };

function widthOf(t) {
  const w = parseFloat(t.width); if (w > 0) return w;
  const l = parseInt(t.lanes); if (l > 0) return l * 3.25 + 1.5;
  return WIDTH_DEF[t.highway] ?? 6;
}
function speedOf(t) {
  const s = parseFloat(t.maxspeed); if (s > 0) return s;
  return SPEED_DEF[t.highway] ?? 25;
}

function buildGraph(wayList) {
  const usage = new Map(); // "lon,lat" -> count
  const key = p => p[0].toFixed(7) + ',' + p[1].toFixed(7);
  for (const w of wayList) {
    const pts = w.geometry.map(g => [g.lon, g.lat]);
    pts.forEach((p, i) => {
      const k = key(p);
      usage.set(k, (usage.get(k) || 0) + (i === 0 || i === pts.length - 1 ? 2 : 1));
    });
  }
  const nodes = []; const nodeIdx = new Map();
  const nodeAt = p => {
    const k = key(p);
    if (!nodeIdx.has(k)) { nodeIdx.set(k, nodes.length); nodes.push([+p[0].toFixed(6), +p[1].toFixed(6)]); }
    return nodeIdx.get(k);
  };
  const edges = [];
  for (const w of wayList) {
    const t = w.tags;
    const pts = w.geometry.map(g => [g.lon, g.lat]);
    if (pts.every(p => p[1] < MIN_LAT)) continue;
    let seg = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      seg.push(pts[i]);
      const isJunction = usage.get(key(pts[i])) >= 2;
      if (isJunction || i === pts.length - 1) {
        let len = 0;
        for (let j = 1; j < seg.length; j++) len += dist(seg[j - 1], seg[j]);
        if (len >= 2) {
          const oneway = t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout' ? 1 : t.oneway === '-1' ? -1 : 0;
          const geo = (oneway === -1 ? [...seg].reverse() : seg).map(p => [+p[0].toFixed(6), +p[1].toFixed(6)]);
          edges.push({
            a: nodeAt(geo[0]), b: nodeAt(geo[geo.length - 1]),
            len: +len.toFixed(1), geo,
            hw: t.highway, name: t.name || '',
            speed: speedOf(t), width: +widthOf(t).toFixed(1),
            lanes: parseInt(t.lanes) || (widthOf(t) >= 9 ? 2 : 1),
            oneway: oneway !== 0 ? 1 : 0,
          });
        }
        seg = [pts[i]];
      }
    }
  }
  return { nodes, edges };
}

const vehWays = ways.filter(w => VEH_HW.has(w.tags.highway) && !['private','no'].includes(w.tags.access) && !['private','no'].includes(w.tags.motor_vehicle));
const pedWays = ways.filter(w => PED_HW.has(w.tags.highway) || (w.tags.sidewalk && w.tags.sidewalk !== 'no'));

const veh = buildGraph(vehWays);
const ped = buildGraph(pedWays);
for (const e of ped.edges) { delete e.speed; delete e.width; delete e.lanes; delete e.oneway; }

const crossings = ways
  .filter(w => w.tags.footway === 'crossing')
  .map(w => { const g = w.geometry[Math.floor(w.geometry.length / 2)]; return [+g.lon.toFixed(6), +g.lat.toFixed(6)]; });

const out = { veh, ped, crossings };
writeFileSync('data/network.json', JSON.stringify(out));

const km = es => (es.reduce((s, e) => s + e.len, 0) / 1000).toFixed(1);
console.log(`vehicle graph: ${veh.nodes.length} nodes, ${veh.edges.length} edges, ${km(veh.edges)} km (${veh.edges.filter(e => e.oneway).length} oneway)`);
console.log(`pedestrian graph: ${ped.nodes.length} nodes, ${ped.edges.length} edges, ${km(ped.edges)} km`);
console.log(`crossings: ${crossings.length}`);
const ws = {}; veh.edges.forEach(e => ws[e.hw] = (ws[e.hw] || 0) + 1); console.log('by class:', ws);
