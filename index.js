const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '8080', 10);
const UUID = process.env.UUID || '';
const WS_PATH = '/' + (process.env.WSPATH || 'ws');
const XRAY_PORT = 10086;
const DIR = __dirname;
const XRAY_BIN = path.join(DIR, 'xray');

const DECOY = `<!doctype html><html><head><meta charset="utf-8"><title>Welcome</title></head>
<body style="font-family:sans-serif;margin:40px"><h1>Welcome</h1><p>This is a demo web service.</p></body></html>`;

function writeConfig() {
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [{
      listen: '127.0.0.1',
      port: XRAY_PORT,
      protocol: 'vless',
      settings: { clients: [{ id: UUID }], decryption: 'none' },
      streamSettings: { network: 'ws', wsSettings: { path: WS_PATH } }
    }],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }]
  };
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify(cfg));
}

async function ensureXray() {
  if (fs.existsSync(XRAY_BIN)) return;
  const AdmZip = require('adm-zip');
  const url = 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip';
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('download failed: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  zip.extractAllTo(DIR, true);
  fs.chmodSync(XRAY_BIN, 0o755);
  console.log('xray downloaded');
}

function startXray() {
  writeConfig();
  const p = spawn(XRAY_BIN, ['run', '-config', path.join(DIR, 'config.json')], { stdio: 'inherit' });
  p.on('exit', (c) => { console.log('core exited', c); setTimeout(startXray, 3000); });
}

async function setupCore() {
  for (let i = 1; ; i++) {
    try { await ensureXray(); startXray(); console.log('core started'); return; }
    catch (e) {
      console.error('core setup failed (try ' + i + '):', e.message);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(DECOY);
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith(WS_PATH)) { socket.destroy(); return; }
  let attempts = 0;
  const tryConnect = () => {
    const proxy = net.connect(XRAY_PORT, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`);
      proxy.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) proxy.write(head);
      socket.pipe(proxy);
      proxy.pipe(socket);
    });
    proxy.on('error', () => {
      attempts++;
      if (attempts <= 10 && !socket.destroyed) setTimeout(tryConnect, 1000);
      else socket.destroy();
    });
    socket.on('error', () => proxy.destroy());
  };
  tryConnect();
});

// Listen FIRST, before any download or core setup, so platform
// port discovery and health checks succeed from the first second.
server.listen(PORT, () => console.log('listening on ' + PORT));

if (!UUID) console.error('WARN: UUID env not set');
setupCore();
