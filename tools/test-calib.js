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
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { resolve(buf); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const events = [];

function listen(id, name, role) {
  const req = http.get({
    host: HOST, port: PORT,
    path: '/api/events?id=' + id + '&name=' + encodeURIComponent(name) + '&role=' + role
  }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let ev = null, data = null;
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) ev = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (ev && data) events.push({ ev, data: JSON.parse(data) });
      }
    });
  });
  req.on('error', () => {});
  return req;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c1 = listen('dev-host', '客厅电脑', 'host');
  const c2 = listen('dev-a', 'Android-A', 'listener');
  const c3 = listen('dev-b', 'iPhone-B', 'listener');
  await delay(600);

  const payload = await post('/api/calibrate', {});
  console.log('服务端返回时隙表:');
  console.log('  开始于 +' + (payload.startAt - Date.now()) + 'ms');
  payload.slots.forEach((s, i) => {
    console.log('  [' + i + '] ' + s.name + ' (' + s.role + ') at +' + (s.at - payload.startAt) + 'ms');
  });

  await delay(400);
  const calib = events.filter((e) => e.ev === 'calib');
  console.log('\n收到 calib 广播的设备数:', calib.length);
  console.log('三台收到的 slots 是否完全一致:',
    JSON.stringify(calib[0].data.slots) === JSON.stringify(calib[1].data.slots) &&
    JSON.stringify(calib[1].data.slots) === JSON.stringify(calib[2].data.slots));

  const applied = await post('/api/calibrate/apply', {
    offsets: { 'dev-host': 8, 'dev-a': 46, 'dev-b': -23 }
  });
  console.log('\n应用补偿后:', JSON.stringify(applied));

  await delay(400);
  const cr = events.filter((e) => e.ev === 'calibresult');
  console.log('calibresult 广播次数:', cr.length);
  console.log('最后一台设备收到的补偿表:', JSON.stringify(cr[cr.length - 1].data));

  c1.destroy();
  c2.destroy();
  c3.destroy();
  process.exit(0);
})();
