import fs from 'fs';
const html = fs.readFileSync('public/index.html', 'utf8');
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];
let T = 0; // true time, ms
const rnd = (a, b) => a + Math.random() * (b - a);
const S0 = 1.7e12;                       // server clock = S0 + T
function makeDevice({ perfOff, ppm, lat, reportLat }) {
  const d = { perfOff, ppm, lat, plays: [] };
  const perf = { now: () => T + perfOff };
  const ctxTime = () => (T * (1 + ppm * 1e-6)) / 1000;           // audio clock (s)
  d.ctx = {
    state: 'running', destination: {}, baseLatency: 0.005, outputLatency: reportLat / 1000,
    get currentTime() { return ctxTime(); },
    getOutputTimestamp: () => ({ contextTime: ctxTime() - reportLat / 1000, performanceTime: perf.now() }),
    createBuffer: (c, N) => ({ N, getChannelData: () => new Float32Array(N) }),
    createBufferSource: () => ({ playbackRate: { value: 1 }, connect() {}, start(t) { d.plays.push({ t, rate: this.playbackRate.value, N: this.buffer.N, now: ctxTime(), T0: T }); } }),
  };
  const noop = () => ({});
  const api = new Function('document', 'location', 'performance', 'AudioContext', 'navigator', 'setInterval', 'WebSocket',
    src + '\nreturn {pong, play, st, setCtx:c=>{ctx=c}, get off(){return off}, get delay(){return delay}};')(
    { querySelector: () => ({ value: '', checked: false }) }, { hash: '', protocol: 'http:', host: '' }, perf, function () {}, {}, () => {}, function () {});
  api.setCtx(d.ctx); d.api = api; d.perf = perf;
  // audible true time of context time `t` (device plays context time t at speaker when ctxTime = t + lat)
  d.audibleAt = t => ((t + lat / 1000) * 1000) / (1 + ppm * 1e-6);
  return d;
}
// Simulates a host and several listeners on one virtual timeline, running the real pong()/play() code from public/index.html.
// Packets arrive in order per device (TCP), with jitter modelled as head-of-line delay.
function runFull(name, specs, opt = {}) {
  const { lanJitter = [3, 12], pingAsym = [1, 6], seconds = 120, hostPpm = 35, delay = 150 } = opt;
  const host = makeDevice({ perfOff: 5e5, ppm: hostPpm, lat: 0, reportLat: 0 });
  const L = specs.map(s => makeDevice(s));
  const ev = [];
  for (const d of [host, ...L]) { let t = rnd(0, 50), n = 0; while (t < seconds * 1000) { ev.push({ t, k: 'ping', d }); t += ++n < 30 ? 100 : 2000; } }
  const hs = { stamp: 0 }; let seq = 0;
  for (let t = 3000; t < seconds * 1000; t += 20 / (1 + hostPpm * 1e-6)) ev.push({ t: t + rnd(0, 3), k: 'cap', seq: seq++ });
  const pend = [];
  const push = e => { ev.push(e); };
  ev.sort((a, b) => a.t - b.t);
  const queue = ev; let i = 0;
  const heap = []; const addE = e => { heap.push(e); heap.sort((a, b) => a.t - b.t); };
  queue.forEach(e => addE(e));
  const MS = 20, audible = new Map(); // seq -> [times]
  while (heap.length) {
    const e = heap.shift(); T = e.t;
    if (e.k === 'ping') {
      const c = e.d.perf.now(), d1 = rnd(...pingAsym), d2 = rnd(...pingAsym);
      const s = Math.floor(S0 + T + d1);
      addE({ t: T + d1 + d2, k: 'pong', d: e.d, c, s });
    } else if (e.k === 'pong') e.d.api.pong({ c: e.c, s: e.s });
    else if (e.k === 'cap') {
      if (host.api.off === 0) continue;
      const measured = host.perf.now() + host.api.off - MS;
      hs.stamp = hs.stamp ? hs.stamp + MS + 0.002 * (measured - (hs.stamp + MS)) : measured;
      const b = new ArrayBuffer(16 + 3840), dv = new DataView(b);
      dv.setFloat64(0, hs.stamp, true); dv.setUint32(8, e.seq, true); dv.setUint16(12, delay, true);
      for (const d of L) { d._last = Math.max((d._last || 0) + 0.01, T + rnd(...lanJitter)); addE({ t: d._last, k: 'rx', d, b, seq: e.seq }); } // TCP: in-order, jitter = head-of-line delay
    } else if (e.k === 'rx') {
      const before = e.d.plays.length; e.d.api.play(e.b);
      if (e.d.plays.length > before) { const p = e.d.plays.at(-1); (audible.get(e.seq) || audible.set(e.seq, []).get(e.seq))[L.indexOf(e.d)] = e.d.audibleAt(p.t); }
    }
  }
  // metrics: spread of audible time among devices (those that played), after 10 s warmup
  const warm = 10 * 1000 + S0 * 0;
  const rows = [...audible.entries()].filter(([s, a]) => s > 500 && a.filter(x => x !== undefined).length === L.length);
  const dev = (idx) => rows.map(([, a]) => a[idx] - a[0]);
  console.log(`\n== ${name}`);
  specs.forEach((s, idx) => {
    const x = dev(idx); if (!x.length) return console.log(`  dev${idx}: no data`);
    const m = x.reduce((a, b) => a + b, 0) / x.length, sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length);
    const abs = x.map(v => Math.abs(v - m)).sort((a, b) => a - b);
    console.log(`  dev${idx} vs dev0: constant offset ${m.toFixed(2)} ms, wobble sd ${sd.toFixed(2)} ms, p99 ${abs[Math.floor(abs.length * .99)].toFixed(2)} ms | late=${L[idx].api.st.late} played=${L[idx].api.st.pk}`);
  });
  // drift over time: first 10% vs last 10% mean offset of dev1-dev0
  if (L.length > 1) { const x = dev(1), n = x.length, a = x.slice(0, n / 10), z = x.slice(-n / 10); const mm = v => v.reduce((p, q) => p + q, 0) / v.length; console.log(`  dev1-dev0 drift over run: start ${mm(a).toFixed(2)} ms -> end ${mm(z).toFixed(2)} ms`); }
  const trueOff = L.map(d => (S0 - d.perfOff)); L.forEach((d, i) => console.log(`  dev${i} clock-offset estimate error ${(d.api.off - (S0 - d.perfOff)).toFixed(2)} ms`));
}
runFull('Wi-Fi LAN, devices report their latency correctly, 120 s run',
  [{ perfOff: 123456, ppm: 40, lat: 12, reportLat: 12 }, { perfOff: -9876, ppm: -60, lat: 25, reportLat: 25 }, { perfOff: 4242, ppm: 15, lat: 8, reportLat: 8 }]);
runFull('Same, but dev2 under-reports its output latency by 60 ms (Bluetooth-like)',
  [{ perfOff: 123456, ppm: 40, lat: 12, reportLat: 12 }, { perfOff: -9876, ppm: -60, lat: 25, reportLat: 25 }, { perfOff: 4242, ppm: 15, lat: 160, reportLat: 100 }]);
runFull('Bad network: 5-40 ms jitter, 1-25 ms asymmetric ping paths',
  [{ perfOff: 123456, ppm: 40, lat: 12, reportLat: 12 }, { perfOff: -9876, ppm: -60, lat: 25, reportLat: 25 }],
  { lanJitter: [5, 40], pingAsym: [1, 25] });
runFull('Tight buffer: delay 150 ms but jitter up to 160 ms (expect late drops)',
  [{ perfOff: 1, ppm: 20, lat: 10, reportLat: 10 }, { perfOff: 2, ppm: -20, lat: 10, reportLat: 10 }],
  { lanJitter: [5, 160], seconds: 40 });
