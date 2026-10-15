// Motion controller relay: serves the game + phone pad, pairs them by room code, relays WebSocket messages.
// Laptop: http://localhost:5180   Phone: https://<lan-ip>:5443/pad.html?room=CODE (phones need HTTPS for motion sensors)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const HTTP_PORT = +process.env.PORT || 5180;
const HTTPS_PORT = +process.env.HTTPS_PORT || 5443;
const CLOUD = !!process.env.PORT; // on a host like Render the platform terminates TLS for us
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.css': 'text/css' };

function lanIp() { // the Wi-Fi/Ethernet address a phone can reach, not a WSL/VM virtual adapter
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const i of list)
      if (i.family === 'IPv4' && !i.internal && !/vethernet|wsl|virtual|vmware|hyper-v|docker/i.test(name)) found.push(i.address);
  return process.env.LAN_IP || found.find(a => a.startsWith('192.168.')) || found[0] || 'localhost';
}

function serve(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    // opened through a tunnel/proxy (e.g. cloudflared): the phone uses that same public HTTPS origin
    const proxied = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
    return res.end(JSON.stringify({ padBase: process.env.PUBLIC_URL || (CLOUD || proxied ? '' : `https://${lanIp()}:${HTTPS_PORT}`) }));
  }
  const file = path.join(PUBLIC, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- rooms: one host (game) and up to 8 pads (phones) each
const rooms = new Map(); // code -> { host, pads: Map(id -> ws), colors: Map(id -> color) }
const COLORS = ['#facc15', '#38bdf8', '#f472b6', '#4ade80', '#fb923c', '#a78bfa', '#f87171', '#2dd4bf'];
const send = (ws, msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));

function newCode() {
  let c;
  do c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join('');
  while (rooms.has(c));
  return c;
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false }); // no compression: lower latency
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const room = rooms.get(ws.room);

    if (m.t === 'host') { // game opens (or reconnects to) a room
      let code = m.code && rooms.has(m.code) ? m.code : newCode();
      if (!rooms.has(code)) rooms.set(code, { pads: new Map(), colors: new Map() });
      const r = rooms.get(code);
      r.host = ws; ws.room = code; ws.role = 'host';
      send(ws, { t: 'room', code });
      for (const [id] of r.pads) send(ws, { t: 'player', id, color: r.colors.get(id), on: true });
      for (const p of r.pads.values()) send(p, { t: 'host', on: true });
      return;
    }
    if (m.t === 'join') { // phone joins with a stable id so a reconnect keeps its ball and color
      const code = String(m.code || '').toUpperCase();
      const r = rooms.get(code);
      if (!r) return send(ws, { t: 'error', msg: 'No game with that code' });
      if (typeof m.id !== 'string' || !m.id || m.id.length > 64) return send(ws, { t: 'error', msg: 'Bad device id' });
      if (!r.pads.has(m.id) && r.pads.size >= 8) return send(ws, { t: 'error', msg: 'Room full (8 phones)' });
      const old = r.pads.get(m.id);
      if (old && old !== ws) old.close();
      if (!r.colors.has(m.id)) r.colors.set(m.id, COLORS[r.colors.size % COLORS.length]);
      r.pads.set(m.id, ws);
      ws.room = code; ws.role = 'pad'; ws.id = m.id;
      send(ws, { t: 'joined', color: r.colors.get(m.id), host: !!(r.host && r.host.readyState === 1) });
      send(r.host, { t: 'player', id: m.id, name: m.name, color: r.colors.get(m.id), on: true });
      return;
    }
    if (!room) return;
    if (ws.role === 'pad') { m.id = ws.id; send(room.host, m); }          // sensor data, jumps, pings: pad -> game
    else if (ws.role === 'host') {                                         // haptics, pongs: game -> one pad or all
      if (m.to) send(room.pads.get(m.to), m);
      else for (const p of room.pads.values()) send(p, m);
    }
  });
  ws.on('close', () => {
    const r = rooms.get(ws.room);
    if (!r) return;
    if (ws.role === 'pad' && r.pads.get(ws.id) === ws) {
      r.pads.delete(ws.id);
      send(r.host, { t: 'player', id: ws.id, on: false });
    }
    if (ws.role === 'host' && r.host === ws) {
      r.host = null;
      for (const p of r.pads.values()) send(p, { t: 'host', on: false });
      // keep the room 2 min so a reloading game gets its code back
      setTimeout(() => { const x = rooms.get(ws.room); if (x && !x.host && !x.pads.size) rooms.delete(ws.room); }, 120000);
    }
  });
});

// heartbeat: drop dead sockets so the other side sees "disconnected" fast
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 5000);

function attach(server) {
  server.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req)));
}

const plain = http.createServer(serve);
attach(plain);
plain.listen(HTTP_PORT, () => console.log(`game:  http://localhost:${HTTP_PORT}`));

if (!CLOUD) {
  const certFile = path.join(__dirname, '.cert.json');
  let pems;
  try { pems = JSON.parse(fs.readFileSync(certFile)); } catch {
    pems = require('selfsigned').generate([{ name: 'commonName', value: 'motion-controller' }], { days: 365, keySize: 2048 });
    fs.writeFileSync(certFile, JSON.stringify(pems));
  }
  const secure = https.createServer({ key: pems.private, cert: pems.cert }, serve);
  attach(secure);
  secure.listen(HTTPS_PORT, () => console.log(`phone: https://${lanIp()}:${HTTPS_PORT}/pad.html  (accept the certificate warning once)`));
}
