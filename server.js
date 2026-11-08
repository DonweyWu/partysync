'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8080;
const LEAD_MS = 2800;
const SEEK_LEAD_MS = 900;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MUSIC_DIR = path.join(ROOT, 'music');

fs.mkdirSync(MUSIC_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm'
};

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|wav|flac|webm)$/i;

const clients = new Map();
const calibration = {};

const state = {
  trackId: null,
  playing: false,
  startAt: 0,
  position: 0,
  volume: 0.9
};

function currentPosition() {
  if (!state.playing) return state.position;
  const elapsed = (Date.now() - state.startAt) / 1000;
  if (elapsed <= 0) return state.position;
  return state.position + elapsed;
}

function snapshot() {
  return {
    trackId: state.trackId,
    playing: state.playing,
    startAt: state.startAt,
    position: state.position,
    volume: state.volume,
    serverNow: Date.now()
  };
}

function roster() {
  return [...clients.values()].map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    drift: c.drift,
    rtt: c.rtt
  }));
}

function broadcast(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of clients.values()) {
    try {
      c.res.write(msg);
    } catch (e) {
      /* client gone, cleaned up on close */
    }
  }
}

function pushSync() {
  broadcast('sync', snapshot());
}

function pushRoster() {
  broadcast('roster', roster());
}

function listTracks() {
  let files = [];
  try {
    files = fs.readdirSync(MUSIC_DIR);
  } catch (e) {
    return [];
  }
  return files
    .filter((f) => AUDIO_EXT.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(MUSIC_DIR, f));
      return {
        id: f,
        name: f.replace(/\.[^.]+$/, ''),
        size: st.size,
        url: '/audio/' + encodeURIComponent(f)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

function lanIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  const vpat = /vmware|virtualbox|vbox|vethernet|hyper-v|wsl|loopback|docker|tap|tun|zerotier|tailscale|npcap/i;
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({
        iface: name,
        address: a.address,
        virtual: vpat.test(name) || /^169\.254\./.test(a.address)
      });
    }
  }
  out.sort((x, y) => (x.virtual === y.virtual ? 0 : x.virtual ? 1 : -1));
  return out;
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const buf = await readBody(req, 1024 * 64);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return {};
  }
}

function isLocalReq(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function serveFile(req, res, filePath, withRange) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  if (st.isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = withRange ? req.headers.range : null;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (isNaN(start) || start >= st.size) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
      return res.end();
    }
    if (isNaN(end) || end >= st.size) end = st.size - 1;
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600'
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': withRange ? 'public, max-age=3600' : 'no-cache'
  });
  fs.createReadStream(filePath).pipe(res);
}

function handleSSE(req, res, query) {
  const id = query.get('id') || 'dev-' + Math.random().toString(36).slice(2, 8);
  const name = (query.get('name') || '设备').slice(0, 24);
  const role = query.get('role') === 'host' ? 'host' : 'listener';

  req.socket.setNoDelay(true);
  req.socket.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');

  const client = { id, name, role, res, drift: null, rtt: null, joinedAt: Date.now() };
  clients.set(id, client);

  res.write('event: sync\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
  res.write('event: calibresult\ndata: ' + JSON.stringify(calibration) + '\n\n');
  pushRoster();

  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (e) {
      /* ignore */
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(keepAlive);
    clients.delete(id);
    pushRoster();
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const q = url.searchParams;
  const method = req.method || 'GET';

  try {
    if (p === '/api/ping' && method === 'POST') {
      res.socket.setNoDelay(true);
      const body = await readJSON(req);
      return sendJSON(res, 200, { t0: body.t0, ts: Date.now() });
    }

    if (p === '/api/whoami') {
      return sendJSON(res, 200, { isLocal: isLocalReq(req), ips: lanIPs(), port: PORT });
    }

    if (p === '/api/tracks') {
      return sendJSON(res, 200, { tracks: listTracks() });
    }

    if (p === '/api/events') {
      return handleSSE(req, res, q);
    }

    if (p === '/api/report' && method === 'POST') {
      const body = await readJSON(req);
      const c = clients.get(body.id);
      if (c) {
        if (typeof body.drift === 'number') c.drift = body.drift;
        if (typeof body.rtt === 'number') c.rtt = body.rtt;
        pushRoster();
      }
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/upload' && method === 'POST') {
      const rawName = q.get('name') || 'untitled.mp3';
      let n = path.basename(rawName).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
      if (!n) n = 'track-' + Date.now() + '.mp3';
      if (!/\.[a-z0-9]{2,5}$/i.test(n)) n += '.mp3';
      let dest = path.join(MUSIC_DIR, n);
      if (fs.existsSync(dest)) {
        const ext = path.extname(n);
        dest = path.join(MUSIC_DIR, path.basename(n, ext) + '-' + Date.now() + ext);
      }
      const out = fs.createWriteStream(dest);
      await new Promise((resolve, reject) => {
        req.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        req.on('error', reject);
      });
      const name = path.basename(dest);
      broadcast('tracks', { tracks: listTracks() });
      return sendJSON(res, 200, { ok: true, id: name, url: '/audio/' + encodeURIComponent(name) });
    }

    if (p === '/api/calibrate' && method === 'POST') {
      const list = [...clients.values()].sort((a, b) =>
        a.role === 'host' ? -1 : b.role === 'host' ? 1 : 0
      );
      if (!list.length) return sendJSON(res, 400, { error: '还没有设备连接' });

      const GAP = 1300;
      const base = Date.now() + 3200;
      const slots = list.map((c, i) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        at: base + i * GAP
      }));

      const payload = {
        startAt: base,
        endAt: base + (list.length - 1) * GAP + 1500,
        slots
      };
      broadcast('calib', payload);
      return sendJSON(res, 200, payload);
    }

    if (p === '/api/calibrate/apply' && method === 'POST') {
      const body = await readJSON(req);
      const offs = body.offsets || {};
      for (const k of Object.keys(offs)) {
        const v = Number(offs[k]);
        if (isFinite(v)) {
          calibration[k] = Math.max(-800, Math.min(800, Math.round(v)));
        }
      }
      broadcast('calibresult', calibration);
      return sendJSON(res, 200, calibration);
    }

    if (p === '/api/play' && method === 'POST') {
      const body = await readJSON(req);
      state.trackId = body.trackId || null;
      state.position = Number(body.position) || 0;
      state.playing = true;
      state.startAt = Date.now() + LEAD_MS;
      pushSync();
      return sendJSON(res, 200, snapshot());
    }

    if (p === '/api/pause' && method === 'POST') {
      state.position = currentPosition();
      state.playing = false;
      state.startAt = 0;
      pushSync();
      return sendJSON(res, 200, snapshot());
    }

    if (p === '/api/seek' && method === 'POST') {
      const body = await readJSON(req);
      state.position = Math.max(0, Number(body.position) || 0);
      state.playing = !!body.playing;
      state.startAt = state.playing ? Date.now() + SEEK_LEAD_MS : 0;
      pushSync();
      return sendJSON(res, 200, snapshot());
    }

    if (p === '/api/volume' && method === 'POST') {
      const body = await readJSON(req);
      state.volume = Math.min(1, Math.max(0, Number(body.value)));
      pushSync();
      return sendJSON(res, 200, snapshot());
    }

    if (p === '/api/stop' && method === 'POST') {
      state.playing = false;
      state.position = 0;
      state.startAt = 0;
      pushSync();
      return sendJSON(res, 200, snapshot());
    }

    if (p.startsWith('/audio/')) {
      const name = decodeURIComponent(p.slice('/audio/'.length));
      const filePath = path.resolve(MUSIC_DIR, name);
      if (!filePath.startsWith(MUSIC_DIR)) {
        res.writeHead(403);
        return res.end();
      }
      return serveFile(req, res, filePath, true);
    }

    let rel = decodeURIComponent(p);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.resolve(PUBLIC_DIR, '.' + rel);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end();
    }
    return serveFile(req, res, filePath, false);
  } catch (err) {
    if (!res.headersSent) {
      sendJSON(res, 500, { error: String(err && err.message) });
    } else {
      res.end();
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n  端口 ' + PORT + ' 已被占用，换个端口启动：PORT=8081 node server.js\n');
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  const lines = [];
  lines.push('');
  lines.push('  一起放 · PartySync 已启动');
  lines.push('');
  lines.push('  主机控制台（本机打开）:  http://localhost:' + PORT + '/?host=1');
  if (ips.length) {
    lines.push('  手机接入地址:');
    for (const i of ips) {
      lines.push('      http://' + i.address + ':' + PORT);
    }
  } else {
    lines.push('  未检测到局域网 IP，手机可能连不上，请检查网络。');
  }
  lines.push('');
  lines.push('  手机和电脑连同一个 WiFi 即可。Ctrl+C 停止。');
  lines.push('');
  console.log(lines.join('\n'));

  if (process.argv.includes('--open')) {
    const url = 'http://localhost:' + PORT + '/?host=1';
    try {
      const { exec } = require('child_process');
      if (process.platform === 'win32') {
        exec('start "" "' + url + '"');
      } else if (process.platform === 'darwin') {
        exec('open "' + url + '"');
      } else {
        exec('xdg-open "' + url + '"');
      }
    } catch (e) {
      /* 打不开就算了，用户手动输入地址 */
    }
  }
});
