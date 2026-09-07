// sim.js — client-side traffic engine: IDM car-following on a directed road graph,
// per-lane queues, 2-phase signals, pedestrian random walk. Left-hand traffic.

export const TYPES = {
  motorcycle: { label: 'Motorcycles', color: '#ffd166', len: 2.0, w: 0.8, a: 3.0, b: 3.5, s0: 1.2, T: 1.0, vmax: 999, dflt: 400 },
  car:        { label: 'Cars',        color: '#4cc9f0', len: 4.4, w: 1.8, a: 2.0, b: 3.0, s0: 2.0, T: 1.4, vmax: 999, dflt: 120 },
  taxi:       { label: 'Taxis',       color: '#f72585', len: 4.4, w: 1.8, a: 2.2, b: 3.0, s0: 2.0, T: 1.3, vmax: 999, dflt: 50 },
  pickup:     { label: 'Pickups',     color: '#b5e48c', len: 5.5, w: 1.9, a: 1.6, b: 2.5, s0: 2.5, T: 1.6, vmax: 999, dflt: 40 },
  lorry:      { label: 'Lorries',     color: '#f8961e', len: 8.5, w: 2.4, a: 1.1, b: 2.0, s0: 3.0, T: 1.8, vmax: 40,  dflt: 15 },
  bus:        { label: 'Buses',       color: '#e63946', len: 11,  w: 2.5, a: 1.0, b: 2.0, s0: 3.0, T: 1.8, vmax: 40,  dflt: 8 },
  buggy:      { label: 'Buggies',     color: '#c77dff', len: 3.0, w: 1.4, a: 1.5, b: 2.5, s0: 1.5, T: 1.2, vmax: 25,  dflt: 12 },
  bicycle:    { label: 'Bicycles',    color: '#80ed99', len: 1.8, w: 0.6, a: 1.0, b: 2.0, s0: 1.0, T: 1.1, vmax: 18,  dflt: 25 },
};

const RANK = { primary: 5, primary_link: 4, secondary: 4, tertiary: 4, tertiary_link: 3, residential: 3, unclassified: 3, living_street: 2, service: 1.5 };
export const GREEN = 20, AMBER = 3; // signal phase seconds

function cumulate(geo, mx, my) {
  const cum = [0];
  for (let i = 1; i < geo.length; i++)
    cum.push(cum[i - 1] + Math.hypot(mx(geo[i][0]) - mx(geo[i - 1][0]), my(geo[i][1]) - my(geo[i - 1][1])));
  return cum;
}

export class Sim {
  constructor(net) {
    const LAT0 = 4.21, MPD = 111320;
    this.mx = lon => (lon - 73.54) * MPD * Math.cos(LAT0 * Math.PI / 180);
    this.my = lat => (lat - 4.21) * MPD;
    this.net = net;
    this.des = [];           // directed edges
    this.out = new Map();    // nodeIdx -> [directed edge]
    for (const e of net.veh.edges) {
      this.addDir(e, false);
      if (!e.oneway) this.addDir(e, true);
    }
    for (const de of this.des) de.outs = (this.out.get(de.to) || []);

    this.pdes = [];
    this.pout = new Map();
    for (const e of net.ped.edges) { this.addPedDir(e, false); this.addPedDir(e, true); }
    for (const de of this.pdes) de.outs = (this.pout.get(de.to) || []);

    this.vehicles = [];
    this.peds = [];
    this.signals = [];       // {node, lon, lat, axis, t}
    this.targets = {}; for (const k in TYPES) this.targets[k] = TYPES[k].dflt;
    this.pedTarget = 200;
    this.mult = 1;
    this.time = 0;
  }

  addDir(e, rev) {
    const geo = rev ? [...e.geo].reverse() : e.geo;
    const de = {
      id: this.des.length, geo, cum: cumulate(geo, this.mx, this.my), len: e.len,
      from: rev ? e.b : e.a, to: rev ? e.a : e.b,
      vmax: e.speed / 3.6, hw: e.hw, name: e.name, width: e.width,
      lanes: Math.max(1, e.oneway ? e.lanes : Math.ceil(e.lanes / 2)),
      twoWay: !e.oneway, rank: RANK[e.hw] || 2, q: [],
    };
    this.des.push(de);
    if (!this.out.has(de.from)) this.out.set(de.from, []);
    this.out.get(de.from).push(de);
    return de;
  }
  addPedDir(e, rev) {
    const geo = rev ? [...e.geo].reverse() : e.geo;
    const de = { geo, cum: cumulate(geo, this.mx, this.my), len: e.len, from: rev ? e.b : e.a, to: rev ? e.a : e.b };
    this.pdes.push(de);
    if (!this.pout.has(de.from)) this.pout.set(de.from, []);
    this.pout.get(de.from).push(de);
  }

  bearingIn(de) { // approach bearing at edge end, degrees
    const g = de.geo, n = g.length;
    return Math.atan2(this.mx(g[n - 1][0]) - this.mx(g[n - 2][0]), this.my(g[n - 1][1]) - this.my(g[n - 2][1])) * 180 / Math.PI;
  }

  addSignal(node) {
    if (this.signals.some(s => s.node === node)) return null;
    const ins = this.des.filter(d => d.to === node);
    if (ins.length < 3) return null;
    const axis = this.bearingIn(ins[0]);
    const [lon, lat] = this.net.veh.nodes[node];
    const s = { node, lon, lat, axis, t: 0 };
    this.signals.push(s);
    return s;
  }
  removeSignal(s) { this.signals = this.signals.filter(x => x !== s); }

  // signal state for a directed edge ending at signal node: 'g' | 'r'
  signalState(s, de) {
    const d = Math.abs((((this.bearingIn(de) - s.axis) % 180) + 180) % 180);
    const grp = (d < 45 || d > 135) ? 0 : 1;
    const period = 2 * (GREEN + AMBER);
    const ph = (this.time + s.t) % period;
    const mine = grp === 0 ? ph < GREEN : (ph >= GREEN + AMBER && ph < 2 * GREEN + AMBER);
    return mine ? 'g' : 'r';
  }

  nextEdge(de, prevFrom) {
    const outs = de.outs;
    if (!outs.length) return null;
    const cand = outs.filter(o => o.to !== de.from);
    const pool = cand.length ? cand : outs;
    let tot = 0; for (const o of pool) tot += o.rank * o.rank;
    let r = Math.random() * tot;
    for (const o of pool) { r -= o.rank * o.rank; if (r <= 0) return o; }
    return pool[pool.length - 1];
  }

  spawnVehicle(type) {
    const t = TYPES[type];
    for (let tries = 0; tries < 12; tries++) {
      const de = this.des[(Math.random() * this.des.length) | 0];
      if (de.hw === 'service' && Math.random() < 0.5) continue;
      const pos = Math.random() * Math.max(1, de.len - t.len);
      const lane = (Math.random() * de.lanes) | 0;
      if (this.vehicles.some(v => v.de === de && v.lane === lane && Math.abs(v.pos - pos) < t.len + v.t.len + 3)) continue;
      const v = { type, t, de, pos, lane, v: de.vmax * (0.4 + Math.random() * 0.4), next: this.nextEdge(de), seg: 0, vf: 0.85 + Math.random() * 0.3 };
      this.vehicles.push(v);
      return true;
    }
    return false;
  }
  spawnPed() {
    const de = this.pdes[(Math.random() * this.pdes.length) | 0];
    this.peds.push({ de, pos: Math.random() * de.len, v: 0.9 + Math.random() * 0.8, seg: 0, side: Math.random() < 0.5 ? -1 : 1 });
  }

  manageCounts() {
    const count = {}; for (const k in TYPES) count[k] = 0;
    for (const v of this.vehicles) count[v.type]++;
    for (const k in TYPES) {
      const tgt = Math.round(this.targets[k] * this.mult);
      let d = tgt - count[k];
      for (let i = 0; i < Math.min(d, 25); i++) this.spawnVehicle(k);
      if (d < 0) {
        let rm = -d;
        this.vehicles = this.vehicles.filter(v => v.type !== k || rm-- <= 0);
      }
    }
    const pt = Math.round(this.pedTarget * this.mult);
    for (let i = 0; i < Math.min(pt - this.peds.length, 40); i++) this.spawnPed();
    if (this.peds.length > pt) this.peds.length = pt;
  }

  step(dt) {
    this.time += dt;
    // rebuild per-edge, per-lane queues
    for (const de of this.des) de.q.length = 0;
    for (const v of this.vehicles) v.de.q.push(v);
    for (const de of this.des) if (de.q.length > 1) de.q.sort((a, b) => a.pos - b.pos);

    const sigByNode = new Map(this.signals.map(s => [s.node, s]));

    for (const v of this.vehicles) {
      const de = v.de, q = de.q;
      // leader in same lane on this edge
      let gap = 1e9, dv = 0;
      const i = q.indexOf(v);
      for (let j = i + 1; j < q.length; j++) {
        if (q[j].lane === v.lane) { gap = q[j].pos - q[j].t.len - v.pos; dv = v.v - q[j].v; break; }
      }
      if (gap > 1e8 && v.next) { // look across the junction
        const nq = v.next.q;
        let best = null;
        for (const o of nq) if (o.lane === v.lane % v.next.lanes && (!best || o.pos < best.pos)) best = o;
        if (best) { gap = (de.len - v.pos) + best.pos - best.t.len; dv = v.v - best.v; }
      }
      // signal at edge end
      const s = sigByNode.get(de.to);
      if (s && this.signalState(s, de) === 'r') {
        const stopGap = de.len - v.pos - 1;
        if (stopGap < gap && stopGap > -2) { gap = Math.max(stopGap, 0.01); dv = v.v; }
      }
      // IDM
      const t = v.t;
      const vdes = Math.min(de.vmax, t.vmax / 3.6) * v.vf;
      const sStar = t.s0 + Math.max(0, v.v * t.T + v.v * dv / (2 * Math.sqrt(t.a * t.b)));
      const acc = t.a * (1 - Math.pow(v.v / vdes, 4) - (gap < 1e8 ? (sStar / Math.max(gap, 0.1)) ** 2 : 0));
      v.v = Math.max(0, v.v + acc * dt);
      v.pos += v.v * dt;
    }

    // edge transitions
    for (const v of this.vehicles) {
      let guard = 0;
      while (v.pos >= v.de.len && guard++ < 4) {
        if (!v.next) { v.pos = v.de.len - 0.1; v.v = 0; break; }
        v.pos -= v.de.len;
        v.de = v.next;
        v.lane = v.lane % v.de.lanes;
        v.next = this.nextEdge(v.de);
        v.seg = 0;
      }
    }

    // pedestrians
    for (const p of this.peds) {
      p.pos += p.v * dt;
      let guard = 0;
      while (p.pos >= p.de.len && guard++ < 4) {
        const outs = p.de.outs;
        if (!outs.length) { p.pos = 0; p.seg = 0; continue; }
        const cand = outs.filter(o => o.to !== p.de.from);
        const nx = (cand.length ? cand : outs)[(Math.random() * (cand.length ? cand.length : outs.length)) | 0];
        p.pos -= p.de.len; p.de = nx; p.seg = 0;
      }
    }

    this.manageCounts();
  }

  // world position + heading for an entity on a directed edge
  locate(ent) {
    const { geo, cum } = ent.de;
    let s = ent.seg || 0;
    const pos = Math.min(ent.pos, cum[cum.length - 1]);
    while (s < cum.length - 2 && cum[s + 1] < pos) s++;
    while (s > 0 && cum[s] > pos) s--;
    ent.seg = s;
    const d = cum[s + 1] - cum[s] || 1;
    const f = Math.min(1, Math.max(0, (pos - cum[s]) / d));
    const a = geo[s], b = geo[s + 1];
    return {
      lon: a[0] + (b[0] - a[0]) * f, lat: a[1] + (b[1] - a[1]) * f,
      hdg: Math.atan2(this.mx(b[0]) - this.mx(a[0]), this.my(b[1]) - this.my(a[1])),
    };
  }

  stats() {
    let n = this.vehicles.length, sum = 0;
    for (const v of this.vehicles) sum += v.v;
    return { vehicles: n, peds: this.peds.length, avgKmh: n ? (sum / n) * 3.6 : 0 };
  }
}
