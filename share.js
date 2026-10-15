// Works on any network (campus Wi-Fi that blocks device-to-device, phone on mobile data):
// opens a free Cloudflare quick tunnel, then starts the server with the QR code pointing at it.
// Needs cloudflared: https://github.com/cloudflare/cloudflared/releases (set CLOUDFLARED=path if not on PATH)
const { spawn } = require('child_process');

const bin = process.env.CLOUDFLARED || 'cloudflared';
const port = process.env.PORT_LOCAL || 5180;
const cf = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { windowsHide: true });
cf.on('error', () => { console.error(`cloudflared not found. Install it or set CLOUDFLARED=C:\\path\\cloudflared.exe`); process.exit(1); });

let started = false;
cf.stderr.on('data', d => {
  const url = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!url || started) return;
  started = true;
  process.env.PUBLIC_URL = url[0];
  require('./server');
  console.log(`\nphone link (any network): ${url[0]}/pad.html\nopen the game on this laptop: http://localhost:${port}\n`);
});
process.on('exit', () => cf.kill());
process.on('SIGINT', () => process.exit(0));
