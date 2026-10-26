const URL_ = 'ws://localhost:8799/ws/testroom';
const open = (role) => new Promise((res, rej) => {
  const w = new WebSocket(`${URL_}?role=${role}`); w.binaryType = 'arraybuffer';
  w.msgs = []; w.onmessage = e => w.msgs.push(e.data); w.onopen = () => res(w); w.onerror = rej;
  w.onclose = e => { w.closed = e.code; };
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + m); };

const host = await open('host'), l1 = await open('listener'), l2 = await open('listener');

// 1. clock ping/pong
const t0 = performance.now(); l1.send(JSON.stringify({ t: 'p', c: t0 })); await sleep(150);
const pong = l1.msgs.map(m => typeof m === 'string' && JSON.parse(m)).find(j => j && j.t === 'q');
ok(pong && pong.c === t0 && Math.abs(pong.s - Date.now()) < 500, `pong echoes client time and returns server clock (s-now=${pong ? pong.s - Date.now() : 'n/a'} ms)`);

// 2. host binary reaches both listeners, intact, in order
for (let i = 0; i < 100; i++) { const b = new ArrayBuffer(16 + 3840); const dv = new DataView(b); dv.setUint32(8, i, true); host.send(b); }
await sleep(400);
const got = l => l.msgs.filter(m => typeof m !== 'string');
const seqOk = l => got(l).every((m, i) => new DataView(m).getUint32(8, true) === i);
ok(got(l1).length === 100 && got(l2).length === 100, `both listeners received 100/100 packets (${got(l1).length}, ${got(l2).length})`);
ok(seqOk(l1) && seqOk(l2) && got(l1)[0].byteLength === 3856, 'packets arrive in order, size intact (3856 B)');
ok(got(host).length === 0, 'host does not get its own packets echoed back');

// 3. listener cannot inject audio
l1.send(new ArrayBuffer(3856)); await sleep(200);
ok(got(l2).length === 100 && got(host).length === 0, 'listener binary is ignored (no injection)');

// 4. new host replaces old
const host2 = await open('host'); await sleep(200);
ok(host.closed === 1000, `old host closed with 1000 on replacement (${host.closed})`);
host2.send(new ArrayBuffer(3856)); await sleep(200);
ok(got(l2).length === 101, 'new host relays to listeners');

// 5. latency of relay over loopback and clock-sync estimate quality
const rtts = [], offs = [];
for (let i = 0; i < 60; i++) {
  const c = performance.now(); const before = l2.msgs.length;
  l2.send(JSON.stringify({ t: 'p', c }));
  while (l2.msgs.length === before) await sleep(1);
  const j = JSON.parse(l2.msgs.at(-1)); const n = performance.now(), r = n - c;
  rtts.push(r); offs.push({ r, o: j.s + r / 2 - n });
}
const best = offs.sort((a, b) => a.r - b.r).slice(0, 8);
const o = best.map(x => x.o), spread = Math.max(...o) - Math.min(...o);
console.log(`INFO  loopback rtt min=${Math.min(...rtts).toFixed(2)} ms, median=${rtts.sort((a,b)=>a-b)[30].toFixed(2)} ms; 8-best offset spread=${spread.toFixed(2)} ms`);
ok(spread < 3, `offset estimates from best-8 samples agree within 3 ms (spread ${spread.toFixed(2)})`);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
