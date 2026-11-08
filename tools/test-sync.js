'use strict';

const http = require('http');

const HOST = '127.0.0.1';
const PORT = 8080;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({
      host: HOST, port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve(JSON.parse(buf)));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: HOST, port: PORT, path }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve(JSON.parse(buf)));
    }).on('error', reject);
  });
}

const events = [];

function listenSse(id, name) {
  const req = http.get({
    host: HOST, port: PORT,
    path: '/api/events?id=' + id + '&name=' + encodeURIComponent(name) + '&role=listener'
  }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let ev = null;
        let data = null;
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) ev = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (ev && data) events.push({ at: Date.now(), ev, data: JSON.parse(data) });
      }
    });
  });
  req.on('error', () => {});
  return req;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c1 = listenSse('t1', 'Listener-A');
  const c2 = listenSse('t2', 'Listener-B');
  await delay(500);

  const tracks = await get('/api/tracks');
  const track = tracks.tracks[0];
  console.log('曲目:', track.name);

  const t0 = Date.now();
  const r = await post('/api/play', { trackId: track.id, position: 0 });
  const lead = r.startAt - r.serverNow;
  console.log('play 指令 -> startAt 领先 serverNow:', lead, 'ms');

  await delay(1200);

  const syncs = events.filter((e) => e.ev === 'sync');
  console.log('两台设备收到的 sync 事件数:', syncs.length);
  console.log('两台收到指令的时间差:', (syncs[1] ? syncs[1].at - syncs[0].at : 0), 'ms');
  console.log('两台收到的 startAt 是否一致:', syncs[0] && syncs[1] ? syncs[0].data.startAt === syncs[1].data.startAt : 'n/a');

  const roster = events.filter((e) => e.ev === 'roster').pop();
  console.log('在线设备:', roster ? roster.data.map((p) => p.name + '(' + p.role + ')').join(', ') : 'n/a');

  await post('/api/pause', {});
  await delay(400);
  const last = events.filter((e) => e.ev === 'sync').pop();
  console.log('pause 后 state:', JSON.stringify({
    playing: last.data.playing, position: Number(last.data.position.toFixed(2))
  }));

  await post('/api/seek', { position: 30, playing: true });
  await delay(300);
  const seeked = events.filter((e) => e.ev === 'sync').pop();
  console.log('seek 到 30s 后 startAt 领先:', seeked.data.startAt - seeked.data.serverNow, 'ms');

  await post('/api/stop', {});
  await delay(200);

  c1.destroy();
  c2.destroy();
  process.exit(0);
})();
