// Generate og.png (1200x630) from the real road network. Usage: node gen-og.mjs
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

const net = JSON.parse(readFileSync('data/network.json', 'utf8'));
const edges = net.veh.edges;

const W = 1200, H = 630;
const COS = Math.cos(4.21 * Math.PI / 180);
let bb = [1e9, 1e9, -1e9, -1e9];
for (const e of edges) for (const c of e.geo) {
  if (c[1] < 4.2035) continue; // skip the bridge stub for a tight island crop
  bb = [Math.min(bb[0], c[0]), Math.min(bb[1], c[1]), Math.max(bb[2], c[0]), Math.max(bb[3], c[1])];
}
const pad = 26, availH = H - 2 * pad;
const scale = availH / ((bb[3] - bb[1]) * 111320);
const islandW = (bb[2] - bb[0]) * 111320 * COS * scale;
const ox = 900 - islandW / 2, oy = H - pad;
const X = lon => ox + (lon - bb[0]) * 111320 * COS * scale;
const Y = lat => oy - (lat - bb[1]) * 111320 * scale;

const HW_COLOR = { primary: '#f8961e', tertiary: '#4cc9f0', tertiary_link: '#4cc9f0', residential: '#7da7d0', service: '#3d444d', living_street: '#7da7d0' };
let roads = '';
for (const e of edges) {
  if (e.geo.some(c => c[1] < 4.2035)) continue;
  const pts = e.geo.map(c => `${X(c[0]).toFixed(1)},${Y(c[1]).toFixed(1)}`).join(' ');
  roads += `<polyline points="${pts}" stroke="${HW_COLOR[e.hw] || '#7da7d0'}" stroke-width="${Math.max(1, e.width * scale * 0.6).toFixed(1)}" stroke-opacity="0.75" fill="none" stroke-linecap="round"/>`;
}

// scatter vehicles along random edges
const TYPE_COLORS = ['#ffd166', '#ffd166', '#ffd166', '#4cc9f0', '#4cc9f0', '#f72585', '#b5e48c', '#f8961e', '#e63946', '#c77dff', '#80ed99'];
let cars = '';
for (let i = 0; i < 420; i++) {
  const e = edges[(Math.random() * edges.length) | 0];
  if (e.geo[0][1] < 4.2035) continue;
  const j = 1 + ((Math.random() * (e.geo.length - 1)) | 0);
  const a = e.geo[j - 1], b = e.geo[j], f = Math.random();
  const x = X(a[0] + (b[0] - a[0]) * f), y = Y(a[1] + (b[1] - a[1]) * f);
  cars += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.9" fill="${TYPE_COLORS[(Math.random() * TYPE_COLORS.length) | 0]}"/>`;
}

const legend = [
  ['#ffd166', 'Motorcycles'], ['#4cc9f0', 'Cars'], ['#f72585', 'Taxis'], ['#b5e48c', 'Pickups'],
  ['#f8961e', 'Lorries'], ['#e63946', 'Buses'], ['#c77dff', 'Buggies'], ['#80ed99', 'Bicycles'],
].map(([c, l], i) => {
  const x = 84 + (i % 2) * 210, y = 404 + ((i / 2) | 0) * 42;
  return `<rect x="${x}" y="${y}" width="17" height="17" rx="4" fill="${c}"/>
          <text x="${x + 27}" y="${y + 14}" font-size="21" fill="#8b949e">${l}</text>`;
}).join('');

const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="Segoe UI, Arial, sans-serif">
  <rect width="${W}" height="${H}" fill="#0d1117"/>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <defs><radialGradient id="g" cx="0.72" cy="0.5" r="0.8">
    <stop offset="0" stop-color="#14324a" stop-opacity="0.55"/><stop offset="1" stop-color="#0d1117" stop-opacity="0"/>
  </radialGradient></defs>
  ${roads}${cars}${legend}
  <text x="82" y="205" font-size="78" font-weight="700" fill="#e6edf3">Traffic Sim MV</text>
  <text x="84" y="262" font-size="31" fill="#4cc9f0">Live traffic microsimulation</text>
  <text x="84" y="304" font-size="26" fill="#8b949e">Greater Malé Region · Hulhumalé Phase 1 + 2</text>
  <text x="84" y="586" font-size="22" fill="#565d68">traffic-sim-mv.vercel.app</text>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
writeFileSync('og.png', png);
console.log('og.png written,', png.length, 'bytes');
