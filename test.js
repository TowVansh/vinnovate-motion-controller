// End-to-end check: pairing, relay, reconnect, latency. Run: npm test
const { spawn } = require('child_process');
const fs = require('fs');
const WebSocket = require('ws');
const assert = require('assert');

const PORT = 18080;
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT, HTTPS_PORT: 18443, LEADERBOARD_FILE: require('path').join(require('os').tmpdir(), 'tiltmaze-test-lb.json') }, stdio: 'ignore' });
const open = () => new Promise((res, rej) => { const ws = new WebSocket(`ws://localhost:${PORT}`); ws.once('open', () => res(ws)); ws.once('error', rej); });
const next = (ws, t) => new Promise(res => ws.on('message', function h(d) { const m = JSON.parse(d); if (!t || m.t === t) { ws.off('message', h); res(m); } }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // the maze must be solvable from S to G
  const maze = JSON.parse('[' + fs.readFileSync('public/index.html', 'utf8').match(/const MAZE = \[([\s\S]*?)\];/)[1].replace(/'/g, '"').replace(/,\s*$/, '') + ']');
  const find = ch => { for (let y = 0; y < maze.length; y++) { const x = maze[y].indexOf(ch); if (x >= 0) return [x, y]; } };
  const seen = new Set([find('S').join()]), q = [find('S')];
  while (q.length) { const [x, y] = q.shift(); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = [x + dx, y + dy]; if (maze[n[1]][n[0]] !== '#' && !seen.has(n.join())) { seen.add(n.join()); q.push(n); } } }
  assert(seen.has(find('G').join()), 'maze has no path from S to G');

  await sleep(500);
  const host = await open();
  host.send(JSON.stringify({ t: 'host' }));
  const { code } = await next(host, 'room');
  assert.match(code, /^[A-Z]{4}$/);

  const pad = await open();
  pad.send(JSON.stringify({ t: 'join', code, id: 'phone-1', name: 'Tester' }));
  const joined = await next(pad, 'joined');
  assert(joined.host && joined.color);
  assert.equal((await next(host, 'player')).id, 'phone-1');

  // bad code is rejected
  const stray = await open();
  stray.send(JSON.stringify({ t: 'join', code: 'ZZZZ', id: 'x' }));
  assert.equal((await next(stray, 'error')).t, 'error');

  // sensor relay latency: pad -> server -> game, 500 samples
  const lat = [];
  for (let i = 0; i < 500; i++) {
    const t0 = performance.now();
    pad.send(JSON.stringify({ t: 's', x: i / 500, y: 0 }));
    const m = await next(host, 's');
    assert.equal(m.id, 'phone-1');
    lat.push(performance.now() - t0);
  }
  lat.sort((a, b) => a - b);
  const p50 = lat[250].toFixed(2), p95 = lat[475].toFixed(2), p99 = lat[495].toFixed(2);

  // haptics: game -> one pad
  host.send(JSON.stringify({ t: 'fx', to: 'phone-1', vibrate: 50 }));
  assert.equal((await next(pad, 'fx')).vibrate, 50);

  // leaderboard: game reports a finish, server ranks it and tells the phone
  host.send(JSON.stringify({ t: 'finish', id: 'phone-1', ms: 23456 }));
  const board = await next(host, 'leaderboard');
  assert(board.list.some(e => e.ms === 23456));
  const result = await next(pad, 'result');
  assert(result.rank >= 1 && result.ms === 23456);

  // pad reconnect keeps its color; host sees offline then online
  pad.close();
  assert.equal((await next(host, 'player')).on, false);
  const pad2 = await open();
  pad2.send(JSON.stringify({ t: 'join', code, id: 'phone-1' }));
  assert.equal((await next(pad2, 'joined')).color, joined.color);

  // game reload reclaims the same room code; the pad is told
  host.close();
  assert.equal((await next(pad2, 'host')).on, false);
  const host2 = await open();
  host2.send(JSON.stringify({ t: 'host', code }));
  assert.equal((await next(host2, 'room')).code, code);
  assert.equal((await next(pad2, 'host')).on, true);

  console.log(`all checks passed. local relay latency pad->game: p50 ${p50} ms, p95 ${p95} ms, p99 ${p99} ms`);
  srv.kill(); process.exit(0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
